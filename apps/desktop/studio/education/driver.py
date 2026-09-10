"""Fixed Manim Community render adapter. Source executes only with --request.

This is trusted current-user Python, not an operating-system security sandbox.
The SLOPCAMERA host owns consent, source hashes, process custody and authoritative receipts.
"""

import argparse
from fractions import Fraction
import importlib.metadata
import json
import os
from pathlib import Path, PurePosixPath
import re
import runpy
import sys


def bounded_json(path):
    path = Path(path)
    if path.is_symlink() or not path.is_file():
        raise ValueError("Driver request must be a physical regular file.")
    with path.open("rb") as source:
        data = source.read(2*1024*1024+1)
    if len(data) > 2*1024*1024:
        raise ValueError("Driver request exceeds its byte bound.")
    return json.loads(data)


def relative_path(value):
    if not isinstance(value, str) or not value or "\\" in value or "\x00" in value:
        raise ValueError("Expected a normalized relative output path.")
    path = PurePosixPath(value)
    if path.is_absolute() or any(part in (".", "..", "") for part in value.split("/")):
        raise ValueError("Driver path escapes its declared root.")
    return value


def integer(value, minimum, maximum):
    if type(value) is not int or not minimum <= value <= maximum:
        raise ValueError("Driver integer exceeds the supported render profile.")
    return value


def validate_request(request):
    if type(request) is not dict or set(request) != {"bundle", "job", "sourceRoot", "outputRoot", "workingRoot"}:
        raise ValueError("Invalid fixed driver request envelope.")
    job, bundle = request["job"], request["bundle"]
    if job["kind"] != "slopcamera.studio-job" or type(job["schemaVersion"]) is not int or job["schemaVersion"] != 1 or bundle["kind"] != "slopcamera.studio-source-bundle" or type(bundle["schemaVersion"]) is not int or bundle["schemaVersion"] != 1:
        raise ValueError("Unsupported studio protocol.")
    if job["stage"] != "render" or bundle["engine"] != "manim" or bundle["entrypoint"]["kind"] != "python":
        raise ValueError("The Manim adapter supports explicit Python render jobs only.")
    if job["execution"] != {"trust": "trusted-current-user", "isolation": "none", "hermetic": False}:
        raise ValueError("Manim source requires the declared trusted current-user execution model.")
    engine = job["engine"]
    if set(engine) != {"engine", "scene", "renderer", "transparent"} or engine["engine"] != "manim" or engine["renderer"] != "cairo" or type(engine["transparent"]) is not bool or re.fullmatch(r"[A-Za-z_]\w*", engine["scene"], flags=re.ASCII) is None:
        raise ValueError("The Manim profile requires Cairo and an exact Scene class name.")
    render = job["render"]
    width, height = integer(render["width"], 1, 2048), integer(render["height"], 1, 2048)
    if width*height > 4_194_304:
        raise ValueError("The Manim profile permits at most four megapixels.")
    fps = Fraction(integer(render["frameRate"]["numerator"], 1, 240_000), integer(render["frameRate"]["denominator"], 1, 100_000))
    start, end = integer(render["startFrame"], 0, 14_399), integer(render["endFrameExclusive"], 1, 14_400)
    if fps > 60 or start >= end:
        raise ValueError("The Manim profile requires <=60fps and a positive interval ending by frame14400.")
    limits = job["limits"]
    integer(limits["maximumOutputBytes"], 1, 64*1024**3)
    maximum_files = integer(limits["maximumOutputFiles"], 1, 25_000)
    outputs = job["outputs"]
    if type(outputs) is not list or not 1 <= len(outputs) <= 16:
        raise ValueError("Manim requires one to sixteen declared raster outputs.")
    movies, count = 0, 0
    for output in outputs:
        kind, format_name = output["kind"], output["format"]
        if output["role"] not in ("beauty", "auxiliary") or (kind, format_name) not in (("sequence", "png"), ("file", "png"), ("file", "mp4")):
            raise ValueError("Manim supports PNG sequences/stills and opaque lossless RGB MP4 output.")
        value = relative_path(output["pathPattern"] if kind == "sequence" else output["path"])
        if kind == "sequence" and (value.count("%06d") != 1 or "%" in value.replace("%06d", "")):
            raise ValueError("PNG sequences require one exact %06d token.")
        if not value.endswith("."+format_name):
            raise ValueError("Raster output path and format differ.")
        interpretation = output["interpretation"]
        alpha = "straight" if engine["transparent"] else "opaque"
        channels = ["R", "G", "B", "A"] if engine["transparent"] else ["R", "G", "B"]
        if interpretation != {"kind": "raster", "colorSpace": "srgb", "alpha": alpha, "dataType": "uint8", "channels": channels, "semantic": "color", "unit": "unitless"}:
            raise ValueError("Manim output must explicitly describe its sRGB uint8 color pixels and alpha.")
        if format_name == "mp4":
            movies += 1
            if engine["transparent"] or width % 2 or height % 2:
                raise ValueError("RGB MP4 requires opaque, even-sized frames; use PNG for alpha.")
        count += end-start if kind == "sequence" else 1
    if movies > 1 or count > maximum_files:
        raise ValueError("Manim permits one movie and must fit the declared output-file budget.")
    entry = relative_path(bundle["entrypoint"]["path"])
    if not any(file["path"] == entry and file["bytes"] > 0 for file in bundle["files"]):
        raise ValueError("The Scene entrypoint is not a declared nonempty source file.")
    return fps, start, end


def physical_directory(value):
    path = Path(value)
    if not path.is_absolute() or not path.is_dir() or path.is_symlink() or path.resolve() != path:
        raise ValueError("Driver roots must be existing absolute physical directories.")
    return path


def create_output(root, relative):
    relative_path(relative)
    target = root / relative
    parent = root
    for part in PurePosixPath(relative).parts[:-1]:
        parent = parent / part
        parent.mkdir(mode=0o700, exist_ok=True)
        if parent.is_symlink() or parent.resolve() != parent:
            raise ValueError("Output parent changed to an indirect path.")
    return target.open("xb")


def source_context(request):
    """Author-visible data cannot mutate the already admitted driver request."""
    context = {key: request[key] for key in ("sourceRoot", "outputRoot", "workingRoot")}
    context.update({key: request["job"].get(key) for key in ("parameters", "stage", "render")})
    return json.loads(json.dumps(context, allow_nan=False))


def probe():
    import manim
    import av
    from PIL import Image
    from manim.renderer.cairo_renderer import CairoRenderer
    versions = {}
    for distribution in ("manim", "av", "numpy", "Pillow", "manimpango", "typst"):
        try:
            versions[distribution] = importlib.metadata.version(distribution)
        except importlib.metadata.PackageNotFoundError:
            pass
    capabilities = ["python-authoring", "render", "image-sequence"] if manim.__version__.startswith("0.21.") else []
    try:
        av.codec.Codec("libx264rgb", "w")
        if capabilities:
            capabilities.append("beauty-video")
    except av.error.FFmpegError:
        pass
    return {"name": "Manim Community", "version": manim.__version__, "packages": versions, "capabilities": capabilities}


def render_request(request):
    fps, start, end = validate_request(request)
    job = request["job"]
    source_root, output_root, working_root = (physical_directory(request[key]) for key in ("sourceRoot", "outputRoot", "workingRoot"))
    roots = (source_root, output_root, working_root)
    if any(a == b or a in b.parents or b in a.parents for index, a in enumerate(roots) for b in roots[index+1:]):
        raise ValueError("Source, output and scratch roots must be disjoint.")
    if any(output_root.iterdir()):
        raise ValueError("Native rendering requires a fresh owned output directory.")
    entrypoint = source_root / request["bundle"]["entrypoint"]["path"]
    if entrypoint.is_symlink() or entrypoint.resolve() != entrypoint or not entrypoint.is_file():
        raise ValueError("Declared Python entrypoint is not a physical regular file.")
    os.chdir(working_root)
    sys.dont_write_bytecode = True
    import manim
    import numpy as np
    from PIL import Image
    from manim import Scene, tempconfig
    from manim.renderer.cairo_renderer import CairoRenderer
    from manim.scene.scene_file_writer import SceneFileWriter
    from manim.utils.exceptions import EndSceneEarlyException
    if not manim.__version__.startswith("0.21."):
        raise ValueError("This driver is qualified for the Manim Community0.21 profile only.")
    dimensions = job["render"]
    transparent = job["engine"]["transparent"]
    maximum_bytes = job["limits"]["maximumOutputBytes"]
    written_bytes = 0
    selected = 0
    movie_handle = container = stream = None
    movie_output = next((output for output in job["outputs"] if output["format"] == "mp4"), None)
    def budget():
        movie_bytes = max(movie_handle.tell(), os.fstat(movie_handle.fileno()).st_size) if movie_handle is not None else 0
        if written_bytes + movie_bytes > maximum_bytes:
            raise ValueError("Manim exceeded the declared output-byte budget.")

    class RetainedFileWriter(SceneFileWriter):
        # The owned sink below handles every frame and codec. Starting an upstream
        # partial encoder would leave a worker waiting when an exact frame stop
        # interrupts an animation, even with write_to_movie=False in CE0.21.
        def begin_animation(self, *args, **kwargs):
            pass

        def end_animation(self, *args, **kwargs):
            pass

        def finish(self):
            pass

        def add_sound(self, *args, **kwargs):
            raise ValueError("Compose retained narration and sound effects in the SLOPCAMERA project audio layer.")

        def add_audio_segment(self, *args, **kwargs):
            raise ValueError("Compose retained audio in the SLOPCAMERA project audio layer.")

    class RetainedCairoRenderer(CairoRenderer):
        raw_frames = 0

        def add_frame(self, frame, num_frames=1):
            nonlocal selected, written_bytes
            if self.skip_animations:
                return
            if not isinstance(frame, np.ndarray) or frame.dtype != np.uint8 or frame.shape[:2] != (dimensions["height"], dimensions["width"]) or frame.shape[2] not in (3, 4):
                raise ValueError("Manim returned pixels outside the declared uint8 frame geometry.")
            if self.camera.frame_rate != float(fps):
                raise ValueError("Source changed the admitted frame rate.")
            for _ in range(num_frames):
                index = self.raw_frames
                if start <= index < end:
                    image = Image.fromarray(frame).convert("RGBA" if transparent else "RGB")
                    for output in job["outputs"]:
                        if output["format"] != "png" or output["kind"] == "file" and index != end-1:
                            continue
                        target = output["pathPattern"].replace("%06d", f"{index:06d}") if output["kind"] == "sequence" else output["path"]
                        with create_output(output_root, target) as destination:
                            image.save(destination, format="PNG")
                            written_bytes += destination.tell()
                        budget()
                    if stream is not None:
                        video_frame = av.VideoFrame.from_ndarray(np.asarray(image), format="rgb24")
                        video_frame.pts, video_frame.time_base = selected, Fraction(fps.denominator, fps.numerator)
                        for packet in stream.encode(video_frame):
                            container.mux(packet)
                        budget()
                    selected += 1
                self.raw_frames += 1
                self.time = self.raw_frames/float(fps)
                if self.raw_frames >= end:
                    raise EndSceneEarlyException()

    try:
        if movie_output is not None:
            import av
            movie_handle = create_output(output_root, movie_output["path"])
            container = av.open(movie_handle, mode="w", format="mp4")
            stream = container.add_stream("libx264rgb", rate=fps)
            stream.width, stream.height = dimensions["width"], dimensions["height"]
            stream.pix_fmt = "rgb24"
            stream.options = {"crf": "0", "preset": "ultrafast", "threads": "1"}
            stream.time_base = Fraction(fps.denominator, fps.numerator)
        scratch = working_root / "manim"
        scratch.mkdir(mode=0o700)
        settings = {"renderer": "cairo", "pixel_width": dimensions["width"], "pixel_height": dimensions["height"],
                    "frame_width": 8.0, "frame_height": 8.0*dimensions["height"]/dimensions["width"], "frame_rate": float(fps),
                    "transparent": transparent, "write_to_movie": False, "save_last_frame": False, "save_pngs": False,
                    "format": "png", "disable_caching": True, "disable_caching_warning": True,
                    "media_dir": str(scratch), "text_dir": str(scratch/"texts"), "tex_dir": str(scratch/"tex"),
                    "video_dir": str(scratch/"videos"), "images_dir": str(scratch/"images"),
                    "partial_movie_dir": str(scratch/"partial"), "log_dir": str(scratch/"logs"),
                    "preview": False, "show_in_file_browser": False, "notify_outdated_version": False,
                    "progress_bar": "none", "verbosity": "ERROR", "seed": 0}
        with tempconfig(settings):
            context = source_context(request)
            sys.path.insert(0, str(source_root))
            namespace = runpy.run_path(str(entrypoint), init_globals={"SLOPCAMERA_CONTEXT": context}, run_name="__slopcamera_studio_source__")
            scene_class = namespace.get(job["engine"]["scene"])
            if not isinstance(scene_class, type) or not issubclass(scene_class, Scene):
                raise ValueError("The selected source entrypoint did not declare a Manim Scene.")
            renderer = RetainedCairoRenderer(file_writer_class=RetainedFileWriter)
            scene_class(renderer=renderer).render()
        if selected != end-start:
            raise ValueError("The Scene ended before covering the exact requested frame interval.")
        if stream is not None:
            for packet in stream.encode():
                container.mux(packet)
            finished_container = container
            container = None
            finished_container.close()
            budget()
        report = {"engine": "manim", "version": manim.__version__, "renderer": "cairo", "scene": job["engine"]["scene"],
                  "frameRate": dimensions["frameRate"], "width": dimensions["width"], "height": dimensions["height"],
                  "startFrame": start, "endFrameExclusive": end, "selectedFrames": selected,
                  "color": "srgb-uint8", "alpha": "straight" if transparent else "opaque",
                  "movieEncoding": "lossless-libx264rgb" if movie_output else None, "audio": "host-owned"}
        with (working_root/"result.json").open("x", encoding="utf8") as target:
            json.dump(report, target, separators=(",", ":"))
            target.write("\n")
    finally:
        primary_error = sys.exception()
        cleanup_errors = []
        for resource in (container, movie_handle):
            if resource is not None:
                try:
                    resource.close()
                except BaseException as error:
                    cleanup_errors.append(error)
        if cleanup_errors:
            raise BaseExceptionGroup("Manim rendering and output cleanup failed.", ([primary_error] if primary_error is not None else []) + cleanup_errors)


def main():
    parser = argparse.ArgumentParser(description="SLOPCAMERA fixed Manim Community driver")
    mode = parser.add_mutually_exclusive_group(required=True)
    mode.add_argument("--probe", action="store_true")
    mode.add_argument("--request")
    arguments = parser.parse_args()
    if arguments.probe:
        print("SLOPCAMERA_STUDIO_PROBE="+json.dumps(probe(), separators=(",", ":")))
    else:
        render_request(bounded_json(arguments.request))


if __name__ == "__main__":
    main()
