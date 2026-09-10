"""Validate the fixed driver's lower profile without importing native packages."""

from copy import deepcopy
from fractions import Fraction
import json
from pathlib import Path
import tempfile
import unittest

from driver import bounded_json, create_output, physical_directory, relative_path, source_context, validate_request


def request():
    interpretation = {"kind": "raster", "colorSpace": "srgb", "alpha": "opaque", "dataType": "uint8", "channels": ["R", "G", "B"], "semantic": "color", "unit": "unitless"}
    return {"bundle": {"kind": "slopcamera.studio-source-bundle", "schemaVersion": 1, "engine": "manim", "entrypoint": {"kind": "python", "path": "scene.py"}, "files": [{"path": "scene.py", "sha256": "a"*64, "bytes": 20}]},
            "job": {"kind": "slopcamera.studio-job", "schemaVersion": 1, "stage": "render", "parameters": {},
                    "execution": {"trust": "trusted-current-user", "isolation": "none", "hermetic": False},
                    "engine": {"engine": "manim", "scene": "Example", "renderer": "cairo", "transparent": False},
                    "render": {"width": 480, "height": 854, "frameRate": {"numerator": 24, "denominator": 1}, "startFrame": 0, "endFrameExclusive": 240},
                    "limits": {"maximumOutputFiles": 241, "maximumOutputBytes": 100000000},
                    "outputs": [{"id": "frames", "role": "beauty", "format": "png", "kind": "sequence", "pathPattern": "frames/%06d.png", "interpretation": interpretation}, {"id": "film", "role": "beauty", "format": "mp4", "kind": "file", "path": "lesson.mp4", "interpretation": deepcopy(interpretation)}]},
            "sourceRoot": "/source", "outputRoot": "/output", "workingRoot": "/working"}


class DriverTests(unittest.TestCase):
    def test_source_cannot_mutate_the_admitted_render_clock_or_parameter_snapshot(self):
        value = request()
        value["job"]["parameters"] = {"nested": [1, {"text": "original"}]}
        before = deepcopy(value)
        context = source_context(value)
        context["render"]["width"] = 2
        context["render"]["endFrameExclusive"] = 1
        context["render"]["frameRate"]["numerator"] = 60
        context["parameters"]["nested"][1]["text"] = "changed"
        self.assertEqual(value, before)
        self.assertEqual(set(context), {"parameters", "stage", "render", "sourceRoot", "outputRoot", "workingRoot"})

    def test_exact_rational_clock_and_nonzero_frame_interval(self):
        value = request()
        self.assertEqual(validate_request(value), (Fraction(24, 1), 0, 240))
        value["job"]["render"].update(frameRate={"numerator": 24000, "denominator": 1001}, startFrame=17, endFrameExclusive=29)
        self.assertEqual(validate_request(value), (Fraction(24000, 1001), 17, 29))

    def test_lower_profile_rejects_unsupported_jobs_before_native_imports(self):
        mutations = (
            lambda data: data["job"].update(stage="bake"),
            lambda data: data["job"].update(schemaVersion=True),
            lambda data: data["job"]["engine"].update(renderer="opengl"),
            lambda data: data["job"]["engine"].update(scene="Scene();print(1)"),
            lambda data: data["job"]["engine"].update(scene="Äuthor"),
            lambda data: data["job"]["render"].update(endFrameExclusive=14401),
            lambda data: data["job"]["render"].update(width=2049),
            lambda data: data["job"]["render"].update(width=True),
            lambda data: data["job"]["render"].update(width=479),
            lambda data: data["job"]["render"].update(frameRate={"numerator": 61, "denominator": 1}),
            lambda data: data["job"]["limits"].update(maximumOutputFiles=240),
            lambda data: data["job"]["outputs"][0].update(pathPattern="frames/%07d.png"),
            lambda data: data["job"]["outputs"][0].update(pathPattern="../%06d.png"),
            lambda data: data["job"]["outputs"][0]["interpretation"].update(colorSpace="linear-rec709"),
            lambda data: data["bundle"].update(files=[]),
            lambda data: data["job"]["execution"].update(hermetic=True),
        )
        for index, mutation in enumerate(mutations):
            with self.subTest(index=index), self.assertRaises(ValueError):
                data = request()
                mutation(data)
                validate_request(data)

    def test_transparency_is_explicit_and_png_only(self):
        value = request()
        value["job"]["engine"]["transparent"] = True
        value["job"]["outputs"] = value["job"]["outputs"][:1]
        value["job"]["outputs"][0]["interpretation"].update(alpha="straight", channels=["R", "G", "B", "A"])
        self.assertEqual(validate_request(value), (Fraction(24), 0, 240))
        value["job"]["outputs"][0].update(kind="file", format="mp4", path="film.mp4")
        with self.assertRaises(ValueError):
            validate_request(value)

    def test_paths_cannot_escape_or_alias_their_declared_root(self):
        for path in ("", "/tmp/out", "../out", "one/../out", "./out", "one//out", "one\\out", "out\0.png"):
            with self.subTest(path=path), self.assertRaises(ValueError):
                relative_path(path)
        self.assertEqual(relative_path("frames/000001.png"), "frames/000001.png")
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory).resolve()
            self.assertEqual(physical_directory(str(root)), root)
            alias = root/"alias"
            alias.symlink_to(root, target_is_directory=True)
            with self.assertRaises(ValueError):
                physical_directory(str(alias))
            with self.assertRaises(ValueError):
                create_output(root, "alias/escape.png")
            with create_output(root, "frames/000001.png") as target:
                target.write(b"retained")
            with self.assertRaises(FileExistsError):
                create_output(root, "frames/000001.png")
            self.assertEqual((root/"frames/000001.png").read_bytes(), b"retained")

    def test_request_reads_are_bounded_physical_and_inert(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            path = root/"request.json"
            path.write_text(json.dumps({"inert": "__import__('os').system('false')"}))
            self.assertEqual(bounded_json(path)["inert"], "__import__('os').system('false')")
            alias = root/"alias.json"
            alias.symlink_to(path)
            with self.assertRaises(ValueError):
                bounded_json(alias)
            path.write_bytes(b" "*(2*1024*1024+1))
            with self.assertRaises(ValueError):
                bounded_json(path)


if __name__ == "__main__":
    unittest.main()
