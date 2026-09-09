"""Opt-in native qualification. Invoke only inside the admitted host compute lane."""

import argparse
from fractions import Fraction
import hashlib
import json
from pathlib import Path
import shutil
import subprocess
import sys


HERE = Path(__file__).resolve().parent
REPOSITORY = HERE.parents[3]
DRIVER = HERE/"driver.py"
FIXTURE = '''from manim import Scene, Square, RED, BLUE
class ClockFixture(Scene):
    def construct(self):
        square = Square(fill_color=RED, fill_opacity=1).set_stroke(width=0)
        self.add(square)
        self.wait(1)
        square.set_color(BLUE)
        self.wait(1)
'''


def digest(path):
    with path.open("rb") as source:
        return hashlib.file_digest(source, "sha256").hexdigest()


def write_json(path, value):
    with path.open("x", encoding="utf8") as output:
        json.dump(value, output, indent=2, ensure_ascii=False)
        output.write("\n")


def prepare(root, name, scene, width, height, start, end, numerator, denominator, sample=False, byte_limit=536870912, transparent=False):
    run = root/name
    run.mkdir()
    for folder in ("source", "output", "working"):
        (run/folder).mkdir()
    if sample:
        for source in (REPOSITORY/"examples/studio/education/scene.py", REPOSITORY/"examples/studio/education/lesson.json", HERE/"lesson.py", HERE/"toolkit.py"):
            shutil.copyfile(source, run/"source"/source.name)
    else:
        (run/"source/scene.py").write_text(FIXTURE)
    files = [{"path": path.name, "sha256": digest(path), "bytes": path.stat().st_size} for path in sorted((run/"source").iterdir())]
    bundle = {"kind": "atet.studio-source-bundle", "schemaVersion": 1, "engine": "manim", "entrypoint": {"kind": "python", "path": "scene.py"}, "files": files}
    canonical = json.dumps({"domain": "atet.studio-source-bundle/v1", "value": bundle}, sort_keys=True, ensure_ascii=False, separators=(",", ":"))
    interpretation = {"kind": "raster", "colorSpace": "srgb", "alpha": "straight" if transparent else "opaque", "dataType": "uint8", "channels": ["R", "G", "B", "A"] if transparent else ["R", "G", "B"], "semantic": "color", "unit": "unitless"}
    outputs = [{"id": "frames", "kind": "sequence", "role": "beauty", "format": "png", "pathPattern": "frames/%06d.png", "interpretation": interpretation}]
    if not transparent:
        outputs.append({"id": "film", "kind": "file", "role": "beauty", "format": "mp4", "path": "lesson.mp4", "interpretation": interpretation})
    if not sample:
        outputs.append({"id": "still", "kind": "file", "role": "beauty", "format": "png", "path": "last.png", "interpretation": interpretation})
    job = {"kind": "atet.studio-job", "schemaVersion": 1, "jobId": "studio_"+name, "bundleSha256": hashlib.sha256(canonical.encode()).hexdigest(),
           "stage": "render", "parameters": {"lessonFile": "lesson.json"} if sample else {},
           "engine": {"engine": "manim", "scene": scene, "renderer": "cairo", "transparent": transparent},
           "render": {"width": width, "height": height, "frameRate": {"numerator": numerator, "denominator": denominator}, "startFrame": start, "endFrameExclusive": end},
           "outputs": sorted(outputs, key=lambda output: output["id"]), "limits": {"timeoutSeconds": 180, "maximumOutputBytes": byte_limit, "maximumOutputFiles": end-start+len(outputs)-1},
           "execution": {"trust": "trusted-current-user", "isolation": "none", "hermetic": False}}
    request = {"bundle": bundle, "job": job, "sourceRoot": str(run/"source"), "outputRoot": str(run/"output"), "workingRoot": str(run/"working")}
    write_json(run/"bundle.json", bundle)
    write_json(run/"job.json", job)
    write_json(run/"request.json", request)
    return run, request


def execute(run, expected_success=True):
    try:
        result = subprocess.run([sys.executable, "-B", str(run.parent/"driver.py"), "--request", str(run/"request.json")], stdout=subprocess.PIPE, stderr=subprocess.STDOUT, timeout=180)
    except subprocess.TimeoutExpired as error:
        (run/"driver.log").write_bytes(error.stdout or b"")
        write_json(run/"timeout.json", {"timeoutSeconds": 180, "success": False})
        raise
    (run/"driver.log").write_bytes(result.stdout)
    print(run.name, "exit", result.returncode, flush=True)
    if (result.returncode == 0) != expected_success:
        raise AssertionError(result.stdout.decode(errors="replace")[-6000:])
    return result


def inspect(run, request):
    import av
    import numpy as np
    from PIL import Image
    render = request["job"]["render"]
    start, end = render["startFrame"], render["endFrameExclusive"]
    fps = Fraction(render["frameRate"]["numerator"], render["frameRate"]["denominator"])
    paths = sorted((run/"output/frames").glob("*.png"))
    assert [path.name for path in paths] == [f"{frame:06d}.png" for frame in range(start, end)]
    for path in paths:
        with Image.open(path) as image:
            image.load()
            assert image.size == (render["width"], render["height"])
    movie = run/"output/lesson.mp4"
    times = []
    if movie.exists():
        with av.open(str(movie)) as container:
            assert not container.streams.audio
            for index, frame in enumerate(container.decode(video=0)):
                times.append(frame.pts*frame.time_base)
                assert times[-1] == index/fps, (index, times[-1], index/fps)
                with Image.open(paths[index]) as png:
                    assert np.array_equal(frame.to_ndarray(format="rgb24"), np.asarray(png.convert("RGB"))), index
        assert len(times) == end-start
    last = run/"output/last.png"
    if last.exists():
        assert digest(last) == digest(paths[-1])
    artifacts = [{"path": str(path.relative_to(run/"output")), "bytes": path.stat().st_size, "sha256": digest(path)} for path in sorted((run/"output").rglob("*")) if path.is_file()]
    evidence = {"sourceBundleSha256": request["job"]["bundleSha256"], "driverSha256": digest(run.parent/"driver.py"), "width": render["width"], "height": render["height"], "startFrame": start, "endFrameExclusive": end,
                "frameCount": len(paths), "movieFrameCount": len(times), "cadence": f"{fps.numerator}/{fps.denominator}", "duration": str((end-start)/fps), "moviePixelsEqualPng": bool(times), "bytes": sum(item["bytes"] for item in artifacts), "artifacts": artifacts}
    write_json(run/"evidence.json", evidence)
    return evidence


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--output", required=True)
    arguments = parser.parse_args()
    root = Path(arguments.output).resolve()
    root.mkdir()
    shutil.copyfile(DRIVER, root/"driver.py")
    probe = subprocess.run([sys.executable, "-B", str(root/"driver.py"), "--probe"], capture_output=True, check=True, timeout=60)
    (root/"probe.txt").write_bytes(probe.stdout)
    print(probe.stdout.decode(), flush=True)
    evidence = []
    run, request = prepare(root, "static_rational", "ClockFixture", 96, 144, 7, 17, 24000, 1001)
    execute(run)
    evidence.append(inspect(run, request))
    assert len({digest(path) for path in (run/"output/frames").glob("*.png")}) == 1
    run, request = prepare(root, "transparent", "ClockFixture", 96, 144, 7, 9, 24, 1, transparent=True)
    execute(run)
    evidence.append(inspect(run, request))
    from PIL import Image
    with Image.open(run/"output/frames/000007.png") as frame:
        assert frame.mode == "RGBA" and frame.getextrema()[-1] == (0, 255)
    run, request = prepare(root, "short_scene", "ClockFixture", 96, 144, 0, 49, 24, 1)
    execute(run, expected_success=False)
    assert "Scene ended before covering" in (run/"driver.log").read_text()
    assert not (run/"working/result.json").exists()
    run, request = prepare(root, "byte_budget", "ClockFixture", 96, 144, 7, 17, 24, 1, byte_limit=1)
    execute(run, expected_success=False)
    assert "output-byte budget" in (run/"driver.log").read_text()
    assert not (run/"working/result.json").exists()
    run, request = prepare(root, "portrait", "PythagoreanLesson", 480, 854, 0, 240, 24, 1, sample=True)
    execute(run)
    evidence.append(inspect(run, request))
    contact = Image.new("RGB", (480*4, 854), "#101B2B")
    for column, frame in enumerate((30, 105, 162, 225)):
        with Image.open(run/f"output/frames/{frame:06d}.png") as image:
            contact.paste(image, (column*480, 0))
    contact.save(root/"contact.png")
    write_json(root/"qualification.json", {"kind": "atet.studio-native-qualification-observation", "authoritativeStudioReceipt": False, "probe": probe.stdout.decode().strip(), "checks": ["nonzero-native-indices", "static-frame-repeats", "rational-decoded-PTS", "lossless-movie-pixels", "transparent-PNG", "short-scene-fails", "byte-budget-fails", "portrait-Manim-render"], "renders": evidence})
    print("Native education qualification passed", flush=True)


if __name__ == "__main__":
    main()
