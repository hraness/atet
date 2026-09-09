"""Original, deterministic shaded-street film set and native character.

Bundle this file with character.py and studio_scene.py. Parameters select a
reference shot or a sampled three-second camera move; cityOnly excludes the
live rig for the portable static mesh export. speakingEnvelope optionally
keyframes amplitude-driven mouth motion; it is not phoneme or viseme synthesis. No downloads or provider calls.
"""

import hashlib
import json
import math
from pathlib import Path, PurePosixPath
import random

import bpy
from mathutils import Matrix, Vector

import character
from studio_scene import aim, area, cube, cylinder, finish, material, reset, sphere, torus


def ink(name, rgb, metal=0.0, rough=0.5):
    value = material(name, rgb, metallic=metal, roughness=rough)
    # Default glTF dielectric parameters avoid optional material extensions.
    value.node_tree.nodes["Principled BSDF"].inputs["IOR"].default_value = 1.5
    return value


def city_palette():
    return {
        "sand": ink("Pale limestone", (0.56, 0.46, 0.32), rough=0.8),
        "cream": ink("Warm lime plaster", (0.67, 0.61, 0.47), rough=0.85),
        "ochre": ink("Sun-warmed ochre", (0.54, 0.27, 0.105), rough=0.82),
        "rose": ink("Dusty terracotta", (0.53, 0.28, 0.20), rough=0.83),
        "teal": ink("Painted oxidized teal", (0.035, 0.19, 0.20), metal=0.12, rough=0.42),
        "glass": ink("Deep blue window glass", (0.024, 0.068, 0.086), metal=0.25, rough=0.19),
        "copper": ink("Brushed copper trim", (0.47, 0.19, 0.065), metal=0.75, rough=0.28),
        "road": ink("Warm asphalt", (0.105, 0.106, 0.096), rough=0.95),
        "paver": ink("Plaza paving", (0.43, 0.40, 0.31), rough=0.88),
        "paver2": ink("Plaza paving variation", (0.47, 0.445, 0.35), rough=0.9),
        "bark": ink("Tree bark", (0.14, 0.071, 0.032), rough=0.9),
        "leaf": ink("Canopy sage", (0.105, 0.235, 0.08), rough=0.87),
        "leaf2": ink("Sunward leaves", (0.22, 0.32, 0.10), rough=0.89),
        "line": ink("Street marking ivory", (0.60, 0.57, 0.43), rough=0.9),
        "dark": ink("Graphite metal", (0.028, 0.043, 0.046), metal=0.28, rough=0.36),
    }


def tree(location, palette, rng, scale=1):
    x, y = location
    cylinder("Tree trunk", (x, y, 1.35 * scale), .16 * scale, 2.7 * scale, palette["bark"], vertices=12)
    for index in range(7):
        angle = index * math.tau / 7
        center = (x + math.cos(angle) * .66 * scale,
                  y + math.sin(angle) * .66 * scale,
                  (2.65 + rng.uniform(-.18, .24)) * scale)
        bpy.ops.mesh.primitive_ico_sphere_add(subdivisions=2, radius=1, location=center)
        obj = bpy.context.object
        obj.scale = (1.02 * scale, .90 * scale, (.86 + rng.random() * .20) * scale)
        bpy.ops.object.transform_apply(location=False, rotation=False, scale=True)
        finish(obj, "Sculpted canopy cluster", palette["leaf2" if index % 3 == 0 else "leaf"], smooth=True)
    cube("Tree planter", (x, y, .20), (1.25, 1.25, .40), palette["sand"], .06)
    cube("Planter soil", (x, y, .408), (1.05, 1.05, .025), palette["bark"], .02)


def building(side, y, floors, tint, palette, rng):
    x, width, depth, height = side * 6.7, 4.2, 4.15, floors * 2.15
    cube("City facade", (x, y, height / 2), (width, depth, height), palette[tint], .07)
    cube("Stone plinth", (x, y, .28), (width + .16, depth + .12, .56), palette["sand"], .025)
    cube("Roof cornice", (x, y, height - .12), (width + .26, depth + .22, .25), palette["cream"], .035)
    cube("Flat roof", (x, y, height + .045), (width - .10, depth - .10, .10), palette["dark"], .01)
    cube("Roof plant housing", (x + side * .7, y + .5, height + .45), (.8, 1.15, .7), palette["teal"], .035)
    face = side * (abs(x) - width / 2)
    for floor in range(floors):
        z = .95 + floor * 2.15
        for offset in (-1.25, 0, 1.25):
            cube("Window limestone reveal", (face - side * .04, y + offset, z), (.10, .93, 1.34), palette["cream"], .02)
            cube("Inset blue window", (face - side * .102, y + offset, z + .015), (.028, .75, 1.13), palette["glass"], .012)
            cube("Window vertical mullion", (face - side * .123, y + offset, z + .015), (.027, .035, 1.12), palette["teal"], .003)
            cube("Window crossbar", (face - side * .125, y + offset, z + .08), (.028, .74, .033), palette["teal"], .003)
            cube("Window sill", (face - side * .16, y + offset, z - .67), (.34, 1.0, .09), palette["sand"], .012)
        if floor > 0 and floor % 2 == 1:
            cube("Facade string course", (face - side * .06, y, z - 1.0), (.16, depth + .07, .10), palette["cream"], .01)
    for yy in (-1.0, 1.0):
        cube("Shop awning", (face - side * .42, y + yy, 1.91), (.9, 1.65, .14), palette["teal"], .025)
    # A few roof details give the approach real depth without downloaded assets.
    if floors >= 4:
        cylinder("Roof water vessel", (x, y - .65, height + .65), .52, 1.15, palette["copper"], .035, vertices=24)


def city(canopy=False):
    palette, rng = city_palette(), random.Random(20260909)
    cube("City ground", (0, 10, -.19), (34, 48, .32), palette["sand"], .03)
    cube("Street asphalt", (0, 15, -.004), (6.4, 32, .08), palette["road"], .01)
    for side in (-1, 1):
        cube("Sidewalk", (side * 3.89, 14, .055), (1.36, 33, .18), palette["paver"], .025)
        cube("Street curb", (side * 3.23, 14, .065), (.12, 33, .21), palette["cream"], .018)
        for index, yy in enumerate((5.4, 10.0, 14.6, 19.2, 23.8)):
            building(side, yy, (3, 4, 3, 5, 4)[(index + (1 if side == 1 else 0)) % 5],
                     ("cream", "rose", "ochre", "sand", "cream")[(index + (2 if side == 1 else 0)) % 5], palette, rng)
    # A clean foreground plaza provides a calm speaking frame and physical floor.
    for row in range(9):
        for column in range(12):
            cube("Plaza stone", ((column - 5.5) * .80, -4.0 + row * .80, .018),
                 (.78, .78, .10), palette["paver2" if rng.random() < .25 else "paver"], .012)
    for yy in range(5, 29, 4):
        cube("Dashed center line", (0, yy, .042), (.085, 1.45, .012), palette["line"], .003)
    for xx in (-2.2, -1.3, -.4, .5, 1.4, 2.3):
        cube("Crosswalk stone stripe", (xx, 3.0, .046), (.43, 1.10, .018), palette["line"], .003)
    for side in (-1, 1):
        for yy in (6, 15, 24):
            cylinder("Street lamp stem", (side * 3.66, yy, 1.72), .045, 3.44, palette["dark"], vertices=12)
            cube("Street lamp head", (side * 3.66, yy, 3.46), (.43, .30, .12), palette["copper"], .02)
    # The base city already includes distant green; the comparative street stays exposed.
    for location in ((-3.65, 24.7), (3.65, 20.2), (-4.0, -1.6)):
        tree(location, palette, rng, .92)
    if canopy:
        for side in (-1, 1):
            for yy in (5.5, 10.8, 16.1):
                tree((side * 3.67, yy), palette, rng, 1.35)
    # Original small electric tram: roof, glazing, inset wheels and fine trim.
    cube("Teal electric tram", (0, 14.4, .89), (1.65, 3.4, 1.25), palette["teal"], .17)
    cube("Tram roof", (0, 14.4, 1.57), (1.71, 3.43, .14), palette["cream"], .08)
    cube("Tram front glazing", (0, 12.682, 1.06), (1.30, .022, .62), palette["glass"], .04)
    for side in (-1, 1):
        for yy in (13.5, 14.4, 15.3):
            cube("Tram side glazing", (side * .834, yy, 1.08), (.025, .71, .60), palette["glass"], .02)
        for yy in (13.3, 15.4):
            cylinder("Tram wheel", (side * .70, yy, .34), .28, .14, palette["dark"], rotation=(0, math.pi / 2, 0), vertices=24)
    return palette


def presenter():
    character.build({"render": {"startFrame": 1}})
    scene = bpy.context.scene
    for obj in list(scene.objects):
        if obj.type in ("LIGHT", "CAMERA") or obj.name == "Seamless studio floor":
            bpy.data.objects.remove(obj, do_unlink=True)
    for obj in scene.objects:
        if obj.animation_data:
            obj.animation_data_clear()
        if obj.type == "MESH" and obj.data.shape_keys:
            obj.data.shape_keys.animation_data_clear()
            for block in obj.data.shape_keys.key_blocks:
                if block.name != "Basis":
                    block.value = .34 if block.name == "Smile" else 0
    goal = bpy.data.objects.get("Right hand IK goal")
    goal.location = (.72, -.13, 1.16)
    copper = bpy.data.materials["Copper joint collars"]
    porcelain = bpy.data.materials["Warm porcelain shell"]
    dark = bpy.data.materials["Graphite facial details"]
    # Native geometric details distinguish the guide from a stock primitive rig.
    torus("Copper neck ring", (0, 0, 1.218), .133, .019, copper)
    cylinder("Sun medallion base", (0, -.160, 1.035), .085, .028, copper,
             rotation=(math.pi / 2, 0, 0), vertices=40)
    sphere("Sun medallion center", (0, -.183, 1.035), (.039, .012, .039), porcelain, segments=24)
    for angle in [index * math.tau / 8 for index in range(8)]:
        ray = cube("Medallion ray", (math.sin(angle) * .060, -.185, 1.035 + math.cos(angle) * .060),
                   (.010, .008, .021), porcelain, .003)
        ray.rotation_euler.y = angle
    for side in (-1, 1):
        cylinder("Copper ear dial", (side * .268, -.012, 1.47), .056, .022, copper,
                 rotation=(0, math.pi / 2, 0), vertices=32)
        sphere("Eye catchlight", (side * .095 - .009, -.205, 1.532), (.007, .003, .010), porcelain, segments=16)
        cube("Expressive brow", (side * .095, -.18, 1.590), (.080, .018, .017), dark, .007)
    return scene


def speaking_animation(parameters):
    """Optional explicit audio-amplitude samples, one per native frame at 24fps.

    The caller retains the audio/envelope derivation. These are ordinary saved
    shape-key curves, with no handler or audio decoder required during reload.
    """
    values = parameters.get("speakingEnvelope")
    if values is None:
        return None
    first = parameters.get("speakingStartFrame", 1)
    if not isinstance(values, list) or not 2 <= len(values) <= 480:
        raise ValueError("speakingEnvelope requires 2..480 amplitude samples")
    if type(first) is not int or first < 1 or first + len(values) > 481:
        raise ValueError("speakingStartFrame and envelope must fit frames 1..480")
    if any(type(value) not in (int, float) or not math.isfinite(value) or not 0 <= value <= 1 for value in values):
        raise ValueError("speakingEnvelope values must be finite amplitudes in [0, 1]")
    if parameters.get("cityOnly"):
        raise ValueError("speakingEnvelope requires the native presenter")
    for obj in bpy.context.scene.objects:
        if obj.type != "MESH" or not obj.data.shape_keys:
            continue
        blocks = obj.data.shape_keys.key_blocks
        for index, amplitude in enumerate(values):
            frame = first + index
            for name, scale in (("MouthOpen", .80), ("JawOpen", .25)):
                if name in blocks:
                    blocks[name].value = amplitude * scale
                    blocks[name].keyframe_insert("value", frame=frame)
            if "Blink" in blocks:
                # A restrained native blink, independent of the speech envelope.
                phase = index % 85
                blocks["Blink"].value = {49: .45, 50: 1.0, 51: .45}.get(phase, 0)
                blocks["Blink"].keyframe_insert("value", frame=frame)
    return {"kind": "amplitude-mouth-v1", "startFrame": first,
            "endFrameExclusive": first + len(values), "frameRate": {"numerator": 24, "denominator": 1},
            "samples": values, "limitations": "Audio-amplitude mouth motion, not phoneme-aligned lip sync."}


POSES = {
    "establish": ((-8.2, -10.0, 11.8), (0, 8.0, 2.2)),
    "approach": ((-1.7, -5.0, 3.8), (0, .6, 1.2)),
    "speaker": ((.05, -1.60, 1.53), (0, -.015, 1.24)),
    "street": ((.35, -4.6, 3.3), (0, 12.0, 2.0)),
    "panel": ((3.5, -5.4, 2.4), (.9, .1, 1.35)),
    "final": ((5.0, -8.0, 5.1), (0, 3.3, 1.4)),
}


def camera_record(name, position, target, width, height):
    rotation = (Vector(target) - Vector(position)).to_track_quat("-Z", "Y")
    conversion = Matrix.Rotation(-math.pi / 2, 4, "X")
    transform = conversion @ Matrix.LocRotScale(Vector(position), rotation, Vector((1, 1, 1)))
    quaternion = transform.to_quaternion()
    return {"cameraId": "camera_shaded_street", "name": name,
            "pose": {"position": list(transform.translation),
                     "rotation": [quaternion.x, quaternion.y, quaternion.z, quaternion.w]},
            "projection": {"kind": "perspective", "width": width, "height": height,
                           "fx": width * 1100 / 720, "fy": height * 1100 / 1280,
                           "cx": width / 2, "cy": height / 2, "near": .05, "far": 120}}


def install_camera(record, native_position, native_target):
    data = bpy.data.cameras.new("Shaded street portrait camera")
    camera = bpy.data.objects.new("Shaded street portrait camera", data)
    bpy.context.collection.objects.link(camera)
    bpy.context.scene.camera = camera
    apply = globals().get("ATET_APPLY_SPATIAL_CAMERA")
    if apply:
        apply(record, camera)
    else:
        # Exact centered, square-pixel fallback for initial fixed reference jobs.
        # The calibrated injected helper owns arbitrary/off-center projections.
        projection = record["projection"]
        camera.location = native_position
        aim(camera, native_target)
        data.sensor_fit = "VERTICAL"
        data.sensor_height = 24
        data.lens = projection["fy"] / projection["height"] * data.sensor_height
        data.clip_start, data.clip_end = projection["near"], projection["far"]
    data.dof.use_dof = True
    data.dof.focus_distance = (Vector(native_target) - Vector(native_position)).length
    data.dof.aperture_fstop = 5.6 if record["name"] == "speaker" else 11
    data.dof.aperture_blades = 8
    return camera


def merge_static_city():
    """Explicit preview LOD: omit tiny bevels, retain larger single-segment ones."""
    bpy.context.view_layer.update()
    graph = bpy.context.evaluated_depsgraph_get()
    meshes = [obj for obj in bpy.context.scene.objects if obj.type == "MESH"]
    for obj in meshes:
        for modifier in list(obj.modifiers):
            if modifier.type == "BEVEL":
                if modifier.width <= .04:
                    obj.modifiers.remove(modifier)
                else:
                    modifier.segments = 1
        bpy.context.view_layer.update()
        evaluated = bpy.data.meshes.new_from_object(obj.evaluated_get(graph), depsgraph=graph)
        obj.modifiers.clear()
        obj.data = evaluated
    bpy.ops.object.select_all(action="DESELECT")
    for obj in meshes:
        obj.select_set(True)
    bpy.context.view_layer.objects.active = meshes[0]
    bpy.ops.object.join()
    obj = bpy.context.object
    obj.name = "Original shaded street — static city geometry"
    bpy.ops.object.transform_apply(location=True, rotation=True, scale=True)


def apply_panel_texture(context, relative_path):
    """Explicit opaque PNG source -> packed unit-emission world-space surface.

    The panel is a display: its sRGB pixels emit light without scene-light
    multiplication. Geometry still controls perspective, occlusion and focus.
    Closest texture sampling keeps source pixels crisp; oblique views still
    depend on the native renderer sampling/antialiasing quality.
    """
    if not isinstance(relative_path, str) or not relative_path or "\\" in relative_path:
        raise ValueError("panelTexture must be a relative explicit bundle PNG path")
    relative = PurePosixPath(relative_path)
    if relative.is_absolute() or str(relative) != relative_path or any(part in (".", "..") for part in relative.parts):
        raise ValueError("panelTexture must stay inside the explicit source bundle")
    root = Path(context["sourceRoot"]).resolve()
    candidate = root / relative_path
    if candidate.is_symlink():
        raise ValueError("panelTexture requires a regular retained file, not a symlink")
    source = candidate.resolve()
    if not source.is_relative_to(root) or not source.is_file() or source.suffix.lower() != ".png":
        raise ValueError("panelTexture requires a retained bundle PNG file")
    source_bytes = source.stat().st_size
    if not 33 <= source_bytes <= 64 * 1024 * 1024:
        raise ValueError("panelTexture PNG bytes exceed the explicit bound")
    with source.open("rb") as stream:
        data = stream.read(64 * 1024 * 1024 + 1)
    if len(data) != source_bytes or len(data) < 33 or data[:8] != b"\x89PNG\r\n\x1a\n" or data[12:16] != b"IHDR" or data[24] != 8 or data[25] not in (2, 6):
        raise ValueError("panelTexture requires a bounded RGB/RGBA8 PNG")
    width, height = int.from_bytes(data[16:20], "big"), int.from_bytes(data[20:24], "big")
    if not 1 <= width <= 4096 or not 1 <= height <= 4096 or width * 16 != height * 9:
        raise ValueError("panelTexture must have exact portrait9:16 dimensions <=4096")
    image = bpy.data.images.load(str(source), check_existing=False)
    image.colorspace_settings.name = "sRGB"
    if tuple(image.size) != (width, height):
        raise ValueError("panelTexture decoded dimensions disagree")
    if data[25] == 6:
        from array import array
        pixels = array("f", [0]) * (width * height * 4)
        image.pixels.foreach_get(pixels)
        if any(abs(pixels[index] - 1) > 1e-6 for index in range(3, len(pixels), 4)):
            raise ValueError("panelTexture must be opaque; flatten alpha explicitly")
    image.pack()
    placeholder = bpy.data.objects.get("Inset media surface")
    if placeholder is None:
        raise ValueError("panelTexture requires the original native panel mount")
    bpy.data.objects.remove(placeholder, do_unlink=True)
    x, y, z, panel_width, panel_height = 2.3, .837, 1.47, 1.35, 2.4
    mesh = bpy.data.meshes.new("Exact retained panel image surface")
    mesh.from_pydata([(x-panel_width/2, y, z-panel_height/2), (x+panel_width/2, y, z-panel_height/2),
                     (x+panel_width/2, y, z+panel_height/2), (x-panel_width/2, y, z+panel_height/2)], [], [(0, 1, 2, 3)])
    mesh.update()
    uv = mesh.uv_layers.new(name="Full raster UV")
    for loop, coordinate in zip(mesh.loops, [(0, 0), (1, 0), (1, 1), (0, 1)]):
        uv.data[loop.index].uv = coordinate
    plane = bpy.data.objects.new("Retained world-panel raster", mesh)
    bpy.context.scene.collection.objects.link(plane)
    display = bpy.data.materials.new("Display-referred panel raster")
    display.use_nodes = True
    nodes = display.node_tree.nodes
    nodes.clear()
    texture = nodes.new("ShaderNodeTexImage")
    texture.image, texture.interpolation, texture.extension = image, "Closest", "EXTEND"
    emission = nodes.new("ShaderNodeEmission")
    emission.inputs["Strength"].default_value = 1
    output = nodes.new("ShaderNodeOutputMaterial")
    display.node_tree.links.new(texture.outputs["Color"], emission.inputs["Color"])
    display.node_tree.links.new(emission.outputs[0], output.inputs["Surface"])
    mesh.materials.append(display)
    return {"path": relative_path, "sha256": hashlib.sha256(data).hexdigest(), "bytes": len(data),
            "width": width, "height": height, "packed": True, "canonicalCenter": [x, z, -y],
            "nativeCenter": [x, y, z], "panelWidth": panel_width, "panelHeight": panel_height,
            "uv": "full raster, bottom-left origin", "color": "opaque sRGB -> linear emission1 -> Standard view",
            "contentTime": "held retained raster, not a live runtime inside Blender"}


def camera_motion(camera, motion, width, height, global_start_frame):
    """Sample a three-second native move; every integer frame has an exact pose."""
    if motion not in ("approach", "return"):
        raise ValueError("Unknown shaded street motion")
    begin = POSES["establish"] if motion == "approach" else ((2.3, -1.2255, 1.47), (2.3, .837, 1.47))
    end = POSES["speaker"] if motion == "approach" else POSES["final"]
    camera.rotation_mode = "QUATERNION"
    apply = globals().get("ATET_APPLY_SPATIAL_CAMERA")
    samples, calibrated = [], []
    # Calibrate every pose before adding animation owners. The injected helper
    # deliberately rejects cameras whose constraints/animation could override it.
    for index in range(73):
        u = min(1, index / (64 if motion == "approach" else 72))
        weight = u * u * u * (10 + u * (-15 + 6 * u))
        position, target = [tuple(a + (b - a) * weight for a, b in zip(start, finish)) for start, finish in zip(begin, end)]
        record = camera_record(motion, position, target, width, height)
        if apply:
            apply(record, camera)
        else:
            camera.location = position
            camera.rotation_quaternion = (Vector(target) - Vector(position)).to_track_quat("-Z", "Y")
        focus_weight = max(0, min(1, (index - 48) / 16)) if motion == "approach" else 0
        focus_weight = focus_weight * focus_weight * (3 - 2 * focus_weight)
        calibrated.append((camera.matrix_world.copy(), (Vector(target) - Vector(position)).length,
                           11 + (5.6 - 11) * focus_weight))
        samples.append({"frameIndex": index, "nativeFrame": index + 1,
                        "exactTimeUs": {"numerator": index * 1000000, "denominator": 24},
                        "globalFrameIndex": index + global_start_frame, "camera": record})
    for index, (matrix, focus_distance, fstop) in enumerate(calibrated):
        camera.matrix_world = matrix
        camera.data.dof.focus_distance = focus_distance
        camera.data.dof.aperture_fstop = fstop
        camera.keyframe_insert("location", frame=index + 1)
        camera.keyframe_insert("rotation_quaternion", frame=index + 1)
        camera.data.keyframe_insert("dof.focus_distance", frame=index + 1)
        camera.data.keyframe_insert("dof.aperture_fstop", frame=index + 1)
    return samples


def build(context):
    parameters = context["parameters"]
    city_only = bool(parameters.get("cityOnly", False))
    if city_only and parameters.get("panelTexture") is not None:
        raise ValueError("panelTexture requires a native panel; cityOnly exports exclude it")
    # The reused studio reset names an AgX-only look. Enter that view while it
    # builds, then explicitly pin Standard/None for this display-referred set.
    bpy.context.scene.view_settings.view_transform = "AgX"
    scene = reset() if city_only else presenter()
    speaking = speaking_animation(parameters)
    palette = city(bool(parameters.get("canopy", False)))
    if city_only:
        merge_static_city()
    # A blank physical panel is an authored mounting point for later exact media.
    if not city_only:
        cube("Copper media frame", (2.3, .90, 1.47), (1.49, .095, 2.54), palette["copper"], .07)
        cube("Inset media surface", (2.3, .837, 1.47), (1.35, .032, 2.40), palette["teal"], .045)
        for xx in (1.83, 2.77):
            cube("Panel support", (xx, .95, .20), (.08, .12, .40), palette["dark"], .015)
    panel_raster = apply_panel_texture(context, parameters["panelTexture"]) if parameters.get("panelTexture") is not None else None
    scene.world.node_tree.nodes["Background"].inputs["Color"].default_value = (.31, .43, .60, 1)
    scene.world.node_tree.nodes["Background"].inputs["Strength"].default_value = .38
    sunlight = bpy.data.lights.new("Golden afternoon sun", "SUN")
    sunlight.energy = 1.8
    sunlight.color = (1.0, .77, .50)
    sunlight.angle = math.radians(3)
    sun = bpy.data.objects.new("Golden afternoon sun", sunlight)
    bpy.context.collection.objects.link(sun)
    sun.location = (-12, -10, 18)
    aim(sun, (0, 7, 0))
    area("Soft open-sky portrait fill", (1.5, -4, 4), (0, 0, 1.2), 100, (.65, .82, 1), 4)
    area("Warm presenter rim", (-2.5, 2, 4), (0, 0, 1.1), 130, (1, .64, .34), 2)
    scene.view_settings.view_transform = "Standard"
    scene.view_settings.look = "None"
    scene.view_settings.exposure = 0
    scene.view_settings.gamma = 1
    scene.render.image_settings.color_mode = "RGB"
    scene.render.resolution_percentage = 100
    scene.render.pixel_aspect_x = scene.render.pixel_aspect_y = 1
    shot = parameters.get("shot", "speaker")
    if shot not in POSES:
        raise ValueError("Unknown shaded street reference shot")
    render = context.get("render") or {"width": 720, "height": 1280}
    position, target = POSES[shot]
    record = camera_record(shot, position, target, render["width"], render["height"])
    camera = install_camera(record, position, target)
    motion = parameters.get("motion")
    samples = camera_motion(camera, motion, render["width"], render["height"],
                            parameters.get("globalStartFrame", 0 if motion == "approach" else 312)) if motion else []
    scene.frame_set(render.get("startFrame", 1))
    # This ledger is a retained working observation, not a claimed output format.
    observation = {"kind": "atet.shaded-street-reference", "schemaVersion": 1,
                   "shot": shot, "cityOnly": city_only, "canopy": bool(parameters.get("canopy", False)),
                   "camera": record, "nativeCameraMatrix": [list(row) for row in camera.matrix_world],
                   "motion": motion, "cameraSamples": samples, "speaking": speaking, "panelRaster": panel_raster,
                   "panel": {"position": [2.3, 1.47, -.837], "rotation": [0, 0, 0, 1], "width": 1.35, "height": 2.4},
                   "geometryPolicy": "static-preview-lod-v1: omit cosmetic bevels <=4cm; larger bevels one segment; static world transforms baked" if city_only else "native authored geometry and live rig",
                   "coordinates": "Blender right-handed Z-up meters; camera record right-handed Y-up meters",
                   "intendedFilm": {"frameRate": {"numerator": 24, "denominator": 1}, "frames": 432,
                                    "shots": [{"name": name, "startFrame": start, "endFrameExclusive": end}
                                              for name, start, end in [("city", 0, 72), ("speaker", 72, 216),
                                                                      ("diagram", 216, 312), ("return", 312, 384), ("end-hold", 384, 432)]]},
                   "meshes": len([obj for obj in scene.objects if obj.type == "MESH"])}
    bpy.context.view_layer.update()
    observation["nativeCameraMatrix"] = [list(row) for row in camera.matrix_world]
    points = [obj.matrix_world @ Vector(corner) for obj in scene.objects if obj.type == "MESH" for corner in obj.bound_box]
    observation["nativeMeshBounds"] = {"min": [min(point[axis] for point in points) for axis in range(3)],
                                       "max": [max(point[axis] for point in points) for axis in range(3)]}
    scene["atet_shaded_street_reference"] = json.dumps(observation, separators=(",", ":"))
    with (Path(context["workingRoot"]) / "creative-metadata.json").open("x") as stream:
        json.dump(observation, stream, indent=2)
        stream.write("\n")
