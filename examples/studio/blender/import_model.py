"""Light and photograph one retained GLB, glTF or OBJ/MTL dependency set."""

from pathlib import Path
import bpy
from mathutils import Vector
from bpy_extras.object_utils import world_to_camera_view
from studio_scene import reset, floor, studio_lights, camera, aim


def build(context):
    reset()
    relative = context["parameters"].get("input", "assets/bracket.glb")
    source = (Path(context["sourceRoot"]) / relative).resolve(strict=True)
    if not source.is_relative_to(Path(context["sourceRoot"]).resolve()):
        raise ValueError("Imported asset must be a declared retained bundle input")
    if source.suffix.lower() in (".glb", ".gltf"):
        bpy.ops.import_scene.gltf(filepath=str(source))
    elif source.suffix.lower() == ".obj":
        bpy.ops.wm.obj_import(filepath=str(source))
    else:
        raise ValueError("This fixture accepts GLB, glTF or OBJ; STEP uses the CadQuery adapter")
    environment = context["parameters"].get("environment")
    if environment:
        environment_path = (Path(context["sourceRoot"]) / environment).resolve(strict=True)
        if not environment_path.is_relative_to(Path(context["sourceRoot"]).resolve()) or environment_path.suffix.lower() not in (".hdr", ".exr"):
            raise ValueError("Environment must be an explicit retained linear HDR/EXR input")
        world = bpy.context.scene.world
        texture = world.node_tree.nodes.new("ShaderNodeTexEnvironment")
        texture.image = bpy.data.images.load(str(environment_path), check_existing=True)
        texture.image.colorspace_settings.name = "Linear Rec.709"
        world.node_tree.links.new(texture.outputs["Color"], world.node_tree.nodes["Background"].inputs["Color"])
        world.node_tree.nodes["Background"].inputs["Strength"].default_value = 0.5
    # Preserve explicitly imported image bytes inside the published native scene.
    # Simulation caches remain separately declared files in their relative tree.
    for image in bpy.data.images:
        if image.source == "FILE" and not image.packed_file:
            image.pack()
    objects = [obj for obj in bpy.context.scene.objects if obj.type == "MESH"]
    if not objects:
        raise ValueError("Imported asset contains no meshes")
    points = [obj.matrix_world @ Vector(corner) for obj in objects for corner in obj.bound_box]
    minimum = Vector(tuple(min(p[axis] for p in points) for axis in range(3)))
    maximum = Vector(tuple(max(p[axis] for p in points) for axis in range(3)))
    center = (minimum + maximum) / 2
    span = max(maximum - minimum)
    if span <= 0:
        raise ValueError("Imported mesh has empty bounds")
    floor(size=span * 25, z=minimum.z, color=(0.04, 0.065, 0.09))
    studio_lights(scale=span)
    shot = camera(center + Vector((1.5 * span, -2 * span, span)), center, lens=60, fstop=8)
    def frame_bounds():
        # Use the admitted aspect ratio and projected imported bounds, including
        # assembly transforms. A fixed camera distance clips tall or round assets.
        for _ in range(12):
            bpy.context.view_layer.update()
            projected = [world_to_camera_view(bpy.context.scene, shot, point) for point in points]
            factor = max(max(abs(point.x - 0.5), abs(point.y - 0.5)) / 0.41 for point in projected)
            if min(point.z for point in projected) > 0 and factor <= 1:
                shot.data.dof.focus_distance = (shot.location - center).length
                return
            shot.location = center + (shot.location - center) * max(1.05, factor * 1.03)
        raise RuntimeError("Unable to fit imported asset bounds into the admitted camera frame")
    frame_bounds()
    interval = context.get("render")
    if interval:
        shot.keyframe_insert("location", frame=interval["startFrame"])
        shot.keyframe_insert("rotation_euler", frame=interval["startFrame"])
        shot.location = center + Vector((span, -2.3 * span, span * 0.8))
        aim(shot, center)
        frame_bounds()
        end = max(interval["startFrame"] + 1, interval["endFrameExclusive"] - 1)
        shot.keyframe_insert("location", frame=end)
        shot.keyframe_insert("rotation_euler", frame=end)
        bpy.context.scene.frame_set(interval["startFrame"])
