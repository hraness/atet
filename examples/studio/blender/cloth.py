"""Bake a woven cloth over a rounded pedestal; render its retained native scene."""

import json
from pathlib import Path
import bpy
from studio_scene import reset, material, cube, sphere, camera, floor, studio_lights


def build(context):
    scene = reset()
    floor(size=15)
    pedestal = sphere("Cloth collision pedestal", (0, 0, 0.53), (0.40, 0.38, 0.43),
                      material("Porcelain pedestal", (0.58, 0.63, 0.59), roughness=0.28))
    pedestal.modifiers.new("Cloth collider", "COLLISION")
    pedestal.collision.thickness_outer = 0.015
    bpy.ops.mesh.primitive_grid_add(x_subdivisions=33, y_subdivisions=33, size=1.6, location=(0, 0, 1.12))
    cloth = bpy.context.object
    cloth.name = "Woven cloth"
    cloth.data.materials.append(material("Copper velvet weave", (0.38, 0.10, 0.025), roughness=0.64, texture=True))
    for polygon in cloth.data.polygons:
        polygon.use_smooth = True
    modifier = cloth.modifiers.new("Authored cloth solver", "CLOTH")
    modifier.settings.quality = 6
    modifier.settings.mass = 0.3
    modifier.settings.tension_stiffness = 18
    modifier.settings.compression_stiffness = 18
    modifier.settings.shear_stiffness = 8
    modifier.settings.bending_stiffness = 0.4
    modifier.collision_settings.use_collision = True
    modifier.collision_settings.distance_min = 0.012
    modifier.collision_settings.use_self_collision = True
    modifier.collision_settings.self_distance_min = 0.012
    modifier.point_cache.frame_start = 1
    modifier.point_cache.frame_end = 40
    modifier.point_cache.use_disk_cache = False
    if context["parameters"].get("pinBackCorners", False):
        pins = [vertex.index for vertex in cloth.data.vertices if vertex.co.y > 0.79 and abs(vertex.co.x) > 0.79]
        if len(pins) != 2:
            raise RuntimeError("Expected exactly two authored back-corner pin vertices")
        group = cloth.vertex_groups.new(name="Pinned back corners")
        group.add(pins, 1.0, "REPLACE")
        modifier.settings.vertex_group_mass = group.name
        modifier.settings.pin_stiffness = 1.0
    solidify = cloth.modifiers.new("Fabric thickness", "SOLIDIFY")
    solidify.thickness = 0.005
    subdivision = cloth.modifiers.new("Fabric finish", "SUBSURF")
    subdivision.levels = 1
    subdivision.render_levels = 1
    studio_lights(scale=0.8)
    camera((2.3, -2.8, 2.05), (0, 0, 0.62), lens=55, fstop=8)
    scene.frame_start, scene.frame_end = 1, 40
    scene.frame_set(1)


def bake(context):
    scene = bpy.context.scene
    cloth = bpy.data.objects["Woven cloth"]
    cache = cloth.modifiers["Authored cloth solver"].point_cache
    bpy.context.view_layer.objects.active = cloth
    with bpy.context.temp_override(scene=scene, active_object=cloth, object=cloth, point_cache=cache):
        bpy.ops.ptcache.bake(bake=True)
    if not cache.is_baked:
        raise RuntimeError("Cloth solver did not produce a completed bake")
    cache_root = Path(context["outputRoot"]) / "cache" / "cloth"
    cache_root.mkdir(parents=True, exist_ok=True)
    facts = []
    for frame in (1, 16, 32, 40):
        scene.frame_set(frame)
        evaluated = cloth.evaluated_get(bpy.context.evaluated_depsgraph_get())
        mesh = evaluated.to_mesh()
        facts.append({"frame": frame, "vertices": len(mesh.vertices),
                      "minZ": min((evaluated.matrix_world @ v.co).z for v in mesh.vertices),
                      "maxZ": max((evaluated.matrix_world @ v.co).z for v in mesh.vertices)})
        evaluated.to_mesh_clear()
    # Portable deformation cache supplements the native .blend's baked point cache.
    bpy.ops.object.select_all(action="DESELECT")
    cloth.select_set(True)
    bpy.ops.wm.alembic_export(filepath=str(cache_root / "cloth.abc"), start=1, end=40,
                              selected=True, xsamples=1, gsamples=1, check_existing=False)
    pin_facts = []
    pin_group = cloth.vertex_groups.get("Pinned back corners")
    if pin_group:
        indices = [vertex.index for vertex in cloth.data.vertices if any(group.group == pin_group.index and group.weight == 1 for group in vertex.groups)]
        finish = [modifier for modifier in cloth.modifiers if modifier.type in ("SOLIDIFY", "SUBSURF")]
        flags = [modifier.show_viewport for modifier in finish]
        try:
            for modifier in finish:
                modifier.show_viewport = False
            for frame in range(1, 41):
                scene.frame_set(frame)
                evaluated = cloth.evaluated_get(bpy.context.evaluated_depsgraph_get())
                mesh = evaluated.to_mesh()
                pin_facts.append({"frame": frame, "positions": [list(evaluated.matrix_world @ mesh.vertices[index].co) for index in indices]})
                evaluated.to_mesh_clear()
            if any(abs(a - b) > 0.000001 for fact in pin_facts[1:] for first, current in zip(pin_facts[0]["positions"], fact["positions"]) for a, b in zip(first, current)):
                raise RuntimeError("Completed cloth bake moved a fully weighted pin vertex")
        finally:
            for modifier, flag in zip(finish, flags):
                modifier.show_viewport = flag
    (cache_root / "bake-evidence.json").write_text(json.dumps({"isBaked": cache.is_baked, "frames": facts, "pins": pin_facts}, indent=2) + "\n")
    scene.frame_set(32)
