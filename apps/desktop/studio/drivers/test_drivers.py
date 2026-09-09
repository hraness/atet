"""Portable driver-boundary tests; no Blender/CadQuery process or native imports."""

import copy
import hashlib
import importlib.util
import json
from pathlib import Path
import tempfile
from types import SimpleNamespace
import unittest


def load(name):
    spec = importlib.util.spec_from_file_location(name, Path(__file__).with_name(name + ".py"))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


BLENDER = load("blender_driver")
CAD = load("cadquery_driver")


class DriverBoundaryTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary.name).resolve()
        for name in ("source", "output", "working"):
            (self.root / name).mkdir()
        source = b"def build(context):\n    return None\n"
        (self.root / "source" / "scene.py").write_bytes(source)
        self.request = {"sourceRoot": str(self.root / "source"), "outputRoot": str(self.root / "output"),
                        "workingRoot": str(self.root / "working"),
                        "bundle": {"engine": "blender", "entrypoint": {"kind": "python", "path": "scene.py"},
                                   "files": [{"path": "scene.py", "sha256": hashlib.sha256(source).hexdigest(), "bytes": len(source)}]},
                        "job": {"engine": {"engine": "blender"}, "parameters": {"array": [1]}, "stage": "build",
                                "render": {"width": 320}, "limits": {"maximumOutputBytes": 20, "maximumOutputFiles": 2}}}

    def tearDown(self):
        self.temporary.cleanup()

    def test_source_identity_rejects_same_size_modified_bytes(self):
        for module in (BLENDER, CAD):
            module.verify_bundle(self.request)
        path = self.root / "source" / "scene.py"
        path.write_bytes(path.read_bytes().replace(b"None", b"True"))
        for module in (BLENDER, CAD):
            with self.subTest(driver=module.__name__), self.assertRaisesRegex(ValueError, "changed"):
                module.verify_bundle(self.request)

    def test_source_identity_rejects_changed_length(self):
        (self.root / "source" / "scene.py").write_bytes(b"pass\n")
        for module in (BLENDER, CAD):
            with self.subTest(driver=module.__name__), self.assertRaises(ValueError):
                module.verify_bundle(self.request)

    def test_rejects_traversal_and_symlink_escape(self):
        (self.root / "source" / "outside").symlink_to(self.root / "working", target_is_directory=True)
        for module in (BLENDER, CAD):
            for path in ("../scene.py", "/tmp/scene.py", "a/../scene.py", "a\\scene.py", "a//scene.py", "outside/asset.png"):
                with self.subTest(driver=module.__name__, path=path), self.assertRaises(ValueError):
                    module.child_path(self.request["sourceRoot"], path)

    def test_rejects_symlink_leaf_even_when_target_inside_root(self):
        original = self.root / "source" / "scene.py"
        original.rename(self.root / "source" / "retained.py")
        original.symlink_to(self.root / "source" / "retained.py")
        for module in (BLENDER, CAD):
            with self.subTest(driver=module.__name__), self.assertRaises(ValueError):
                module.verify_bundle(self.request)

    def test_authored_context_cannot_mutate_admitted_job(self):
        previous = copy.deepcopy(self.request)
        context = BLENDER.context_for(self.request)
        context["parameters"]["array"].append(2)
        context["render"]["width"] = 8192
        self.assertEqual(self.request, previous)

    def test_automatic_render_budget_checks_bytes_and_count(self):
        output = self.root / "output"
        (output / "one.png").write_bytes(b"x" * 10)
        BLENDER.check_output_budget(self.request)
        (output / "two.png").write_bytes(b"x" * 11)
        with self.assertRaisesRegex(ValueError, "budget"):
            BLENDER.check_output_budget(self.request)
        (output / "two.png").write_bytes(b"x")
        (output / "three.png").write_bytes(b"x")
        with self.assertRaisesRegex(ValueError, "budget"):
            BLENDER.check_output_budget(self.request)

    def test_indirect_output_rejected(self):
        (self.root / "output" / "cache").symlink_to(self.root / "working", target_is_directory=True)
        with self.assertRaisesRegex(ValueError, "symlink"):
            BLENDER.check_output_budget(self.request)

    def test_preexisting_output_not_overwritten(self):
        path = self.root / "output" / "frame.png"
        path.write_bytes(b"retained")
        with self.assertRaisesRegex(ValueError, "overwrite"):
            BLENDER.require_fresh(path)
        self.assertEqual(path.read_bytes(), b"retained")

    def test_auxiliary_only_job_executes_exact_frame_interval(self):
        frames, rendered = [], []
        self.request["job"]["render"] = {"startFrame": 7, "endFrameExclusive": 10}
        self.request["job"]["outputs"] = [{"role": "auxiliary"}]
        fake_bpy = SimpleNamespace(
            context=SimpleNamespace(scene=SimpleNamespace(camera=object(), frame_set=frames.append)),
            ops=SimpleNamespace(render=SimpleNamespace(render=lambda **kwargs: rendered.append(kwargs))),
            data=SimpleNamespace(images={"Render Result": object()}),
        )
        self.assertEqual(BLENDER.render_outputs(fake_bpy, self.request), [7, 8, 9])
        self.assertEqual(frames, [7, 8, 9])
        self.assertEqual(rendered, [{"write_still": False}] * 3)

    def test_native_image_dependencies_require_packed_or_exact_retained_files(self):
        image = SimpleNamespace(source="FILE", packed_file=None, filepath=str(self.root / "source" / "scene.py"), library=None, name="Environment")
        fake_bpy = SimpleNamespace(data=SimpleNamespace(images=[image]), path=SimpleNamespace(abspath=lambda value, **kwargs: value))
        BLENDER.validate_blend_images(fake_bpy, self.request)
        image.filepath = str(self.root / "source" / ".." / "source" / "scene.py")
        BLENDER.validate_blend_images(fake_bpy, self.request)
        image.filepath = str(self.root / "source" / "missing.hdr")
        with self.assertRaisesRegex(ValueError, "physical retained"):
            BLENDER.validate_blend_images(fake_bpy, self.request)
        image.filepath = str(self.root / "working" / "ambient.hdr")
        Path(image.filepath).write_bytes(b"ambient image")
        with self.assertRaisesRegex(ValueError, "outside its declared"):
            BLENDER.validate_blend_images(fake_bpy, self.request)
        image.packed_file = object()
        BLENDER.validate_blend_images(fake_bpy, self.request)

    def test_request_rejects_oversized_json_and_aliased_roots(self):
        request_path = self.root / "request.json"
        request_path.write_bytes(b" " * (2 * 1024 * 1024 + 1))
        with self.assertRaisesRegex(ValueError, "byte bound"):
            BLENDER.read_request(request_path)
        alias = self.root / "alias"
        alias.symlink_to(self.root / "source", target_is_directory=True)
        self.request["sourceRoot"] = str(alias)
        request_path.write_text(json.dumps(self.request))
        with self.assertRaisesRegex(ValueError, "physical"):
            BLENDER.read_request(request_path)

    def test_request_rejects_overlapping_or_nonempty_roots(self):
        request_path = self.root / "request.json"
        self.request["workingRoot"] = self.request["outputRoot"]
        request_path.write_text(json.dumps(self.request))
        with self.assertRaisesRegex(ValueError, "disjoint"):
            BLENDER.read_request(request_path)
        self.request["workingRoot"] = str(self.root / "working")
        (self.root / "output" / "old").write_bytes(b"retained")
        request_path.write_text(json.dumps(self.request))
        with self.assertRaisesRegex(ValueError, "fresh"):
            BLENDER.read_request(request_path)


if __name__ == "__main__":
    unittest.main()
