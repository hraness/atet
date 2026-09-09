"""Fixed ATET Blender adapter. Authored Python is explicitly trusted current-user code.

Python bundles may execute at module scope or define build(context), followed by
bake(context) for bake jobs. The adapter never infers or silently runs a bake for
render jobs. Declared .blend snapshots preserve the authored scene and caches.
"""

import argparse
import hashlib
import json
import os
from pathlib import Path
import runpy
import sys


def read_request(path):
    with Path(path).open("rb") as stream:
        data = stream.read(2 * 1024 * 1024 + 1)
    if len(data) > 2 * 1024 * 1024:
        raise ValueError("Driver request exceeds its byte bound")
    request = json.loads(data)
    for key in ("sourceRoot", "outputRoot", "workingRoot"):
        root = Path(request[key])
        if not root.is_absolute() or not root.is_dir() or root.is_symlink() or root.resolve() != root:
            raise ValueError("Driver roots must be existing absolute physical directories")
    roots = [Path(request[key]) for key in ("sourceRoot", "outputRoot", "workingRoot")]
    if any(a == b or a in b.parents or b in a.parents for index, a in enumerate(roots) for b in roots[index + 1:]):
        raise ValueError("Driver source, output and scratch roots must be disjoint")
    if any(Path(request["outputRoot"]).iterdir()):
        raise ValueError("Blender requires a fresh owned output directory")
    if request["bundle"]["engine"] != "blender" or request["job"]["engine"]["engine"] != "blender":
        raise ValueError("Blender driver requires a Blender bundle and job")
    return request


def child_path(root, relative):
    if not isinstance(relative, str) or not relative or "\\" in relative:
        raise ValueError("Expected a normalized relative artifact path")
    parts = relative.split("/")
    if any(part in ("", ".", "..") for part in parts) or Path(relative).is_absolute():
        raise ValueError("Artifact path escapes its retained root")
    path = Path(root).joinpath(*parts)
    if not path.resolve().is_relative_to(Path(root).resolve()):
        raise ValueError("Artifact path crosses an external symlink")
    return path


def verify_bundle(request):
    for item in request["bundle"]["files"]:
        path = child_path(request["sourceRoot"], item["path"])
        if path.is_symlink() or not path.is_file():
            raise ValueError("Retained source is not a regular file: " + item["path"])
        digest = hashlib.sha256()
        count = 0
        with path.open("rb") as stream:
            while data := stream.read(1024 * 1024):
                digest.update(data)
                count += len(data)
        if count != item["bytes"] or digest.hexdigest() != item["sha256"]:
            raise ValueError("Retained source bytes changed: " + item["path"])


def context_for(request):
    job = request["job"]
    return json.loads(json.dumps({"parameters": job["parameters"], "stage": job["stage"],
            "render": job.get("render"), "sourceRoot": request["sourceRoot"],
            "outputRoot": request["outputRoot"], "workingRoot": request["workingRoot"]}))


def check_output_budget(request):
    count, size = 0, 0
    for parent, directories, files in os.walk(request["outputRoot"], followlinks=False):
        for name in directories:
            if (Path(parent) / name).is_symlink():
                raise ValueError("An output directory became a symlink")
        for name in files:
            path = Path(parent) / name
            if path.is_symlink() or not path.is_file():
                raise ValueError("An output is not a regular file")
            count += 1
            size += path.stat().st_size
    limits = request["job"]["limits"]
    if count > limits["maximumOutputFiles"] or size > limits["maximumOutputBytes"]:
        raise ValueError("Blender exceeded the declared output budget")


def configure_scene(bpy, job):
    scene = bpy.context.scene
    render = job.get("render")
    if render:
        scene.render.resolution_x = render["width"]
        scene.render.resolution_y = render["height"]
        scene.render.resolution_percentage = 100
        numerator = render["frameRate"]["numerator"]
        denominator = render["frameRate"]["denominator"]
        # Blender stores integer FPS plus a floating base; retain the exact
        # rational in result metadata, and use the ratio for scene evaluation.
        fps = min(32767, max(1, round(numerator / denominator)))
        scene.render.fps = fps
        scene.render.fps_base = fps * denominator / numerator
        scene.frame_start = render["startFrame"]
        scene.frame_end = render["endFrameExclusive"] - 1
        scene.frame_step = 1
    options = job["engine"]
    scene.render.engine = "CYCLES" if options["renderer"] == "cycles" else "BLENDER_EEVEE"
    scene.render.film_transparent = options["transparent"]
    scene.display_settings.display_device = "sRGB"
    scene.view_settings.view_transform = options["viewTransform"]
    scene.render.image_settings.color_management = "FOLLOW_SCENE"
    if options["renderer"] == "cycles":
        scene.cycles.samples = options["samples"]
        scene.cycles.use_denoising = options["denoise"]
        scene.cycles.seed = options["seed"]
        scene.cycles.use_animated_seed = False
    elif hasattr(scene, "eevee"):
        scene.eevee.taa_render_samples = options["samples"]
    return scene


def select_device(bpy, options):
    if options["renderer"] == "eevee":
        if options["device"] != "gpu":
            raise ValueError("EEVEE is a GPU renderer; select device gpu explicitly")
        import gpu
        gpu.init()
        return {"requested": "gpu", "backend": gpu.platform.backend_type_get(),
                "devices": [{"name": gpu.platform.renderer_get(), "type": "GPU"}],
                "evidence": "initialized-eevee-gpu-context"}
    scene = bpy.context.scene
    preferences = bpy.context.preferences.addons["cycles"].preferences
    if options["device"] == "cpu":
        scene.cycles.device = "CPU"
        for device in preferences.devices:
            device.use = device.type == "CPU"
        return {"requested": "cpu", "backend": "CPU", "devices": [],
                "evidence": "configured-cycles-cpu"}
    failures = []
    for backend in ("METAL", "OPTIX", "CUDA", "HIP", "ONEAPI"):
        try:
            preferences.compute_device_type = backend
            preferences.refresh_devices()
            devices = [device for device in preferences.devices if device.type == backend]
            if not devices:
                continue
            for device in preferences.devices:
                device.use = device.type == backend
            scene.cycles.device = "GPU"
            return {"requested": "gpu", "backend": backend,
                    "devices": [{"name": d.name, "id": d.id, "type": d.type} for d in devices],
                    "evidence": "cycles-device-discovery-and-selection"}
        except (TypeError, RuntimeError, ValueError) as error:
            failures.append(type(error).__name__)
    raise RuntimeError("Requested Cycles GPU is unavailable; no CPU fallback was authorized")


def output_file(request, output, frame=None):
    relative = output["pathPattern"].replace("%06d", f"{frame:06d}") if frame is not None else output["path"]
    path = child_path(request["outputRoot"], relative)
    path.parent.mkdir(parents=True, exist_ok=True)
    return path


def require_fresh(path):
    if path.exists() or path.is_symlink():
        raise ValueError("Refusing to overwrite a preexisting output: " + path.name)


def export_models(bpy, request):
    for output in request["job"]["outputs"]:
        if output["role"] != "model":
            continue
        if output["kind"] != "file":
            raise ValueError("Model export requires a file output")
        path = output_file(request, output)
        require_fresh(path)
        if output["format"] == "glb":
            if output["interpretation"].get("sourceSpace") != {"units": "meters", "upAxis": "y", "handedness": "right"}:
                raise ValueError("Blender GLB export requires meter, right-handed Y-up declaration")
            bpy.ops.export_scene.gltf(filepath=str(path), export_format="GLB", check_existing=False)
        elif output["format"] in ("usd", "usda", "usdc"):
            if output["interpretation"].get("sourceSpace") != {"units": "meters", "upAxis": "z", "handedness": "right"} or bpy.context.scene.unit_settings.scale_length != 1:
                raise ValueError("Automatic USD export requires meter-scale, right-handed Z-up scene and declaration")
            bpy.ops.wm.usd_export(filepath=str(path), check_existing=False,
                                  export_animation=bool(request["job"].get("render")))
        else:
            raise ValueError("Blender automatic model export supports GLB and USD only")
        check_output_budget(request)


def render_outputs(bpy, request):
    job = request["job"]
    scene = bpy.context.scene
    render = job["render"]
    if scene.camera is None:
        raise ValueError("The authored Blender scene has no active camera")
    raster_outputs = [output for output in job["outputs"] if output["role"] == "beauty"]
    if not raster_outputs and not any(output["role"] == "auxiliary" for output in job["outputs"]):
        return []
    for output in raster_outputs:
        if output["format"] not in ("png", "exr") or output["kind"] not in ("file", "sequence"):
            raise ValueError("Blender beauty output supports PNG/EXR files or sequences; encode video through ATET")
        if output["kind"] == "file" and render["endFrameExclusive"] - render["startFrame"] != 1:
            raise ValueError("A beauty file requires a single-frame interval; use a sequence for animation")
        if output["interpretation"]["kind"] != "raster" or output["interpretation"]["semantic"] != "color":
            raise ValueError("Automatic beauty outputs require color raster interpretation")
        interpretation = output["interpretation"]
        expected_alpha = ("straight" if output["format"] == "png" else "premultiplied") if job["engine"]["transparent"] else "opaque"
        expected_channels = ["R", "G", "B", "A"] if job["engine"]["transparent"] else ["R", "G", "B"]
        if interpretation["alpha"] != expected_alpha or interpretation["channels"] != expected_channels or interpretation["unit"] != "unitless":
            raise ValueError("Beauty interpretation must match the selected encoding's channels and alpha convention")
    captured = []
    # Render once per frame; save each declared encoding from the same result.
    # Compositor-authored auxiliary files remain explicit source-owned outputs.
    for frame in range(render["startFrame"], render["endFrameExclusive"]):
        scene.frame_set(frame)
        bpy.ops.render.render(write_still=False)
        image = bpy.data.images.get("Render Result")
        if image is None:
            raise RuntimeError("Blender did not produce Render Result")
        for output in raster_outputs:
            path = output_file(request, output, frame if output["kind"] == "sequence" else None)
            require_fresh(path)
            interpretation = output["interpretation"]
            scene.render.image_settings.file_format = "PNG" if output["format"] == "png" else "OPEN_EXR"
            scene.render.image_settings.color_mode = "RGBA" if job["engine"]["transparent"] else "RGB"
            if output["format"] == "png":
                scene.render.image_settings.color_management = "FOLLOW_SCENE"
                if interpretation["colorSpace"] != "srgb" or interpretation["dataType"] not in ("uint8", "uint16"):
                    raise ValueError("PNG beauty requires sRGB uint8 or uint16 interpretation")
                scene.render.image_settings.color_depth = "16" if interpretation["dataType"] == "uint16" else "8"
            else:
                if interpretation["colorSpace"] != "linear-rec709" or interpretation["dataType"] not in ("float16", "float32"):
                    raise ValueError("EXR beauty requires linear-rec709 float16 or float32 interpretation")
                scene.render.image_settings.color_depth = "16" if interpretation["dataType"] == "float16" else "32"
                scene.render.image_settings.exr_codec = "ZIP"
                scene.render.image_settings.color_management = "OVERRIDE"
                scene.render.image_settings.linear_colorspace_settings.name = "Linear Rec.709"
            image.save_render(str(path), scene=scene)
        check_output_budget(request)
        captured.append(frame)
    return captured


def scene_summary(bpy):
    scene = bpy.context.scene
    objects = []
    for obj in list(scene.objects)[:512]:
        item = {"name": obj.name, "type": obj.type,
                "location": [round(float(x), 7) for x in obj.matrix_world.translation],
                "modifiers": [modifier.type for modifier in obj.modifiers]}
        if obj.type == "MESH":
            item["vertices"] = len(obj.data.vertices)
            item["polygons"] = len(obj.data.polygons)
            item["shapeKeys"] = [key.name for key in obj.data.shape_keys.key_blocks] if obj.data.shape_keys else []
        elif obj.type == "ARMATURE":
            item["bones"] = [bone.name for bone in obj.data.bones]
        objects.append(item)
    return {"objectCount": len(scene.objects), "objects": objects,
            "activeCamera": scene.camera.name if scene.camera else None,
            "frameStart": scene.frame_start, "frameEndInclusive": scene.frame_end,
            "fps": scene.render.fps, "fpsBase": scene.render.fps_base,
            "viewTransform": scene.view_settings.view_transform,
            "workingSpace": bpy.data.colorspace.working_space,
            "linearOutputSpace": "Linear Rec.709",
            "displayDevice": scene.display_settings.display_device}


def validate_blend_images(bpy, request):
    # Blender can return exit 0 with missing external images and a wrong render.
    # Native entrypoints therefore require packed image bytes or exact retained
    # FILE dependencies. Trusted Python authors remain responsible for their
    # wider, explicitly nonhermetic runtime dependencies.
    root = Path(request["sourceRoot"])
    declared = {item["path"] for item in request["bundle"]["files"]}
    for image in bpy.data.images:
        if image.source != "FILE" or image.packed_file:
            continue
        source = Path(os.path.normpath(bpy.path.abspath(image.filepath, library=image.library)))
        if not source.is_absolute() or source.is_symlink() or not source.is_file() or source.resolve() != source:
            raise ValueError("Native scene image requires a physical retained file or packed bytes: " + image.name)
        if not source.is_relative_to(root) or source.relative_to(root).as_posix() not in declared:
            raise ValueError("Native scene image is outside its declared source bundle: " + image.name)


def run(bpy, request):
    verify_bundle(request)
    os.chdir(request["workingRoot"])
    sys.dont_write_bytecode = True
    job = request["job"]
    context = context_for(request)
    entrypoint = request["bundle"]["entrypoint"]
    source = child_path(request["sourceRoot"], entrypoint["path"])
    namespace = {}
    if entrypoint["kind"] == "blend":
        if job["stage"] != "render":
            raise ValueError("Native .blend entrypoints support render only")
        bpy.ops.wm.open_mainfile(filepath=str(source), load_ui=False, use_scripts=False)
        validate_blend_images(bpy, request)
    else:
        configure_scene(bpy, job)
        sys.path.insert(0, request["sourceRoot"])
        namespace = runpy.run_path(str(source), init_globals={"ATET_CONTEXT": context}, run_name="__atet_studio__")
        if callable(namespace.get("build")):
            namespace["build"](context)
    scene = configure_scene(bpy, job)
    device = select_device(bpy, job["engine"])
    native_outputs = [o for o in job["outputs"] if o["role"] == "native-source" and o["format"] == "blend"]
    native_paths = []
    bpy.context.preferences.filepaths.save_version = 0
    for output in native_outputs:
        if output["kind"] != "file":
            raise ValueError("Native blend output must be a file")
        path = output_file(request, output)
        require_fresh(path)
        bpy.ops.wm.save_as_mainfile(filepath=str(path), check_existing=False)
        native_paths.append(path)
    bake_hook_ran = False
    if job["stage"] == "bake" and callable(namespace.get("bake")):
        namespace["bake"](context)
        bake_hook_ran = True
        for path in native_paths:
            bpy.ops.wm.save_as_mainfile(filepath=str(path), check_existing=False)
    check_output_budget(request)
    export_models(bpy, request)
    captured = render_outputs(bpy, request) if job["stage"] == "render" else []
    verify_bundle(request)
    result = {"kind": "atet.studio-blender-result", "schemaVersion": 1,
              "version": bpy.app.version_string, "buildHash": bpy.app.build_hash.decode("ascii"),
              "stage": job["stage"], "renderer": scene.render.engine, "device": device,
              "render": job.get("render"), "renderedFrames": captured,
              "bakeHookRan": bake_hook_ran, "scene": scene_summary(bpy),
              "trust": "trusted-current-user", "hermetic": False}
    result_path = Path(request["workingRoot"]) / "result.json"
    with result_path.open("x", encoding="utf-8") as stream:
        json.dump(result, stream, indent=2, allow_nan=False)
        stream.write("\n")


def main():
    import bpy
    parser = argparse.ArgumentParser()
    group = parser.add_mutually_exclusive_group(required=True)
    group.add_argument("--probe", action="store_true")
    group.add_argument("--request")
    arguments = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else sys.argv[1:]
    args = parser.parse_args(arguments)
    if args.probe:
        # The factory scene leaves the output-space enum unset until an EXR
        # override is selected. Verify the adapter's actual supported selection.
        settings = bpy.context.scene.render.image_settings
        settings.file_format = "OPEN_EXR"
        settings.color_management = "OVERRIDE"
        settings.linear_colorspace_settings.name = "Linear Rec.709"
        capabilities = ["python-authoring", "blend-authoring", "build", "bake", "render",
                        "image-sequence", "model-export", "native-cache", "auxiliary-passes"]
        packages = {"blender": bpy.app.version_string, "python": sys.version.split()[0],
                    "working-space": bpy.data.colorspace.working_space,
                    "linear-output-space": bpy.context.scene.render.image_settings.linear_colorspace_settings.name,
                    "display-device": bpy.context.scene.display_settings.display_device}
        try:
            selected = select_device(bpy, {"renderer": "cycles", "device": "gpu"})
            capabilities.append("gpu-render")
            packages["cycles-backend"] = selected["backend"]
            packages["cycles-devices"] = ", ".join(device["name"] for device in selected["devices"])
        except RuntimeError:
            packages["cycles-backend"] = "unavailable"
        print("ATET_STUDIO_PROBE=" + json.dumps({"name": "Blender", "version": bpy.app.version_string,
                          "packages": packages, "capabilities": capabilities}))
        return
    run(bpy, read_request(args.request))


if __name__ == "__main__":
    main()
