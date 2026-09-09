"""Small liquid splash with an explicit Mantaflow bake and retained cache."""

import json
import os
from pathlib import Path
import bpy
from studio_scene import reset, material, cube, sphere, camera, floor, studio_lights


def build(context):
    scene = reset()
    floor(size=15)
    stone = material("Basin ceramic", (0.18, 0.26, 0.28), roughness=0.24)
    for name, center, size in (
        ("Basin bottom", (0, 0, 0.05), (1.3, 1.1, 0.10)),
        ("Basin back", (0, 0.52, 0.18), (1.3, 0.10, 0.30)),
        ("Basin front", (0, -0.52, 0.14), (1.3, 0.10, 0.22)),
        ("Basin left", (-0.60, 0, 0.18), (0.10, 1.0, 0.30)),
        ("Basin right", (0.60, 0, 0.18), (0.10, 1.0, 0.30)),
    ):
        wall = cube(name, center, size, stone, 0.02)
        modifier = wall.modifiers.new("Liquid collision", "FLUID")
        modifier.fluid_type = "EFFECTOR"
        modifier.effector_settings.surface_distance = 0.001
    liquid = material("Clear turquoise water", (0.25, 0.70, 0.74), roughness=0.09, transmission=0.88)
    domain = cube("Liquid domain", (0, 0, 0.66), (1.45, 1.25, 1.35), liquid)
    modifier = domain.modifiers.new("Authored liquid solver", "FLUID")
    modifier.fluid_type = "DOMAIN"
    settings = modifier.domain_settings
    settings.domain_type = "LIQUID"
    settings.resolution_max = int(context["parameters"].get("resolution", 24))
    if not 16 <= settings.resolution_max <= 48:
        raise ValueError("Fluid fixture resolution must stay between 16 and 48")
    settings.cache_frame_start = 1
    settings.cache_frame_end = 32
    settings.cache_type = "ALL"
    settings.cache_directory = str(Path(context["outputRoot"]) / "cache" / "fluid")
    settings.cache_data_format = "UNI"
    settings.use_mesh = True
    settings.mesh_scale = 2
    settings.timesteps_min = 1
    settings.timesteps_max = 4
    source = sphere("Initial liquid volume", (0, 0, 0.89), (0.30, 0.30, 0.27), liquid)
    source.hide_render = True
    flow = source.modifiers.new("Liquid source", "FLUID")
    flow.fluid_type = "FLOW"
    flow.flow_settings.flow_type = "LIQUID"
    flow.flow_settings.flow_behavior = "GEOMETRY"
    studio_lights(scale=0.8)
    camera((2.3, -2.7, 1.9), (0, 0, 0.35), lens=55, fstop=8)
    scene.frame_start, scene.frame_end = 1, 32
    scene.frame_set(1)


def bake(context):
    scene = bpy.context.scene
    domain = bpy.data.objects["Liquid domain"]
    settings = domain.modifiers["Authored liquid solver"].domain_settings
    bpy.context.view_layer.objects.active = domain
    bpy.ops.object.select_all(action="DESELECT")
    domain.select_set(True)
    with bpy.context.temp_override(scene=scene, active_object=domain, object=domain):
        bpy.ops.fluid.bake_all()
    if not settings.has_cache_baked_data or not settings.has_cache_baked_mesh:
        raise RuntimeError("Liquid solver did not complete data and surface-mesh bakes")
    facts = []
    for frame in (1, 12, 24, 32):
        scene.frame_set(frame)
        evaluated = domain.evaluated_get(bpy.context.evaluated_depsgraph_get())
        mesh = evaluated.to_mesh()
        facts.append({"frame": frame, "vertices": len(mesh.vertices), "polygons": len(mesh.polygons)})
        evaluated.to_mesh_clear()
    cache_root = Path(context["outputRoot"]) / "cache" / "fluid"
    (cache_root / "bake-evidence.json").write_text(json.dumps({"dataBaked": True, "meshBaked": True, "frames": facts}, indent=2) + "\n")
    # The native scene stays movable with its declared cache dependency tree.
    if bpy.data.filepath:
        settings.cache_directory = "//" + os.path.relpath(cache_root, Path(bpy.data.filepath).parent)
    scene.frame_set(24)
