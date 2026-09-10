"""Native projection qualification. Run Blender factory startup with --python and -- cases.json output.json."""
import hashlib
import importlib.util
import json
from pathlib import Path
import sys
sys.dont_write_bytecode = True

import bpy
from bpy_extras.object_utils import world_to_camera_view
from mathutils import Vector

driver_path = Path(__file__).with_name("blender_driver.py")
spec = importlib.util.spec_from_file_location("slopcamera_fixed_blender_driver", driver_path)
driver = importlib.util.module_from_spec(spec)
spec.loader.exec_module(driver)
source, destination = [Path(value) for value in sys.argv[sys.argv.index("--") + 1:]]
cases = json.loads(source.read_text())
assert 1 <= len(cases) <= 256
results = []
for case in cases:
    camera = driver.apply_spatial_camera(bpy, case["camera"])
    bpy.context.view_layer.update()
    projection = case["camera"]["projection"]
    errors = []
    for point in case["points"]:
        x, y, z = point["world"]
        projected = world_to_camera_view(bpy.context.scene, camera, Vector((x, -z, y)))
        pixel = [projected.x * projection["width"], (1 - projected.y) * projection["height"]]
        error = max(abs(a - b) for a, b in zip(pixel, point["pixel"]))
        errors.append(error)
        assert error <= 0.05, (case["id"], pixel, point["pixel"], error)
    results.append({"id": case["id"], "points": len(errors), "maximumPixelError": max(errors)})
    data = camera.data
    bpy.data.objects.remove(camera, do_unlink=True)
    bpy.data.cameras.remove(data)
receipt = {"kind": "slopcamera.spatial-camera-native-qualification", "schemaVersion": 1,
           "blenderVersion": bpy.app.version_string, "buildHash": bpy.app.build_hash.decode(),
           "driverSha256": hashlib.sha256(driver_path.read_bytes()).hexdigest(),
           "casesSha256": hashlib.sha256(source.read_bytes()).hexdigest(),
           "projection": "bpy_extras.object_utils.world_to_camera_view", "results": results}
with destination.open("x") as stream:
    json.dump(receipt, stream, indent=2)
print("SLOPCAMERA_CAMERA_QUALIFIED=" + json.dumps({"cases": len(results), "maximumPixelError": max(result["maximumPixelError"] for result in results)}))
