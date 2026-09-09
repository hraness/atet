"""Small authored scene helpers; include this exact file in the source bundle."""

import math
import bpy
from mathutils import Vector


def reset():
    bpy.ops.object.select_all(action="SELECT")
    bpy.ops.object.delete(use_global=False)
    scene = bpy.context.scene
    scene.unit_settings.system = "METRIC"
    scene.unit_settings.scale_length = 1.0
    scene.world = bpy.data.worlds.new("Studio environment")
    scene.world.use_nodes = True
    scene.world.node_tree.nodes["Background"].inputs["Color"].default_value = (0.055, 0.075, 0.12, 1)
    scene.world.node_tree.nodes["Background"].inputs["Strength"].default_value = 0.24
    scene.render.image_settings.color_mode = "RGB"
    scene.view_settings.look = "AgX - Medium High Contrast"
    return scene


def material(name, color, metallic=0.0, roughness=0.35, transmission=0.0, texture=False):
    mat = bpy.data.materials.new(name)
    mat.diffuse_color = (*color, 1)
    mat.use_nodes = True
    nodes = mat.node_tree.nodes
    shader = nodes.get("Principled BSDF")
    shader.inputs["Base Color"].default_value = (*color, 1)
    shader.inputs["Metallic"].default_value = metallic
    shader.inputs["Roughness"].default_value = roughness
    shader.inputs["Transmission Weight"].default_value = transmission
    shader.inputs["IOR"].default_value = 1.46
    if texture:
        noise = nodes.new("ShaderNodeTexNoise")
        noise.inputs["Scale"].default_value = 180
        noise.inputs["Detail"].default_value = 2
        bump = nodes.new("ShaderNodeBump")
        bump.inputs["Strength"].default_value = 0.16
        bump.inputs["Distance"].default_value = 0.001
        mat.node_tree.links.new(noise.outputs["Fac"], bump.inputs["Height"])
        mat.node_tree.links.new(bump.outputs["Normal"], shader.inputs["Normal"])
    return mat


def finish(obj, name, mat, bevel=0.0, smooth=True):
    obj.name = name
    if mat:
        obj.data.materials.append(mat)
    if bevel:
        modifier = obj.modifiers.new("Machined edge radius", "BEVEL")
        modifier.width = bevel
        modifier.segments = 3
    if smooth and obj.type == "MESH":
        for polygon in obj.data.polygons:
            polygon.use_smooth = True
    return obj


def cube(name, location, scale, mat, bevel=0.0):
    bpy.ops.mesh.primitive_cube_add(size=1, location=location)
    obj = bpy.context.object
    obj.scale = scale
    bpy.ops.object.transform_apply(location=False, rotation=False, scale=True)
    return finish(obj, name, mat, bevel, False)


def sphere(name, location, scale, mat, segments=48):
    bpy.ops.mesh.primitive_uv_sphere_add(segments=segments, ring_count=24, radius=1, location=location)
    obj = bpy.context.object
    obj.scale = scale
    bpy.ops.object.transform_apply(location=False, rotation=False, scale=True)
    return finish(obj, name, mat)


def cylinder(name, location, radius, depth, mat, bevel=0.0, rotation=(0, 0, 0), vertices=64):
    bpy.ops.mesh.primitive_cylinder_add(vertices=vertices, radius=radius, depth=depth,
                                      location=location, rotation=rotation)
    return finish(bpy.context.object, name, mat, bevel)


def torus(name, location, major, minor, mat, rotation=(0, 0, 0)):
    bpy.ops.mesh.primitive_torus_add(major_segments=72, minor_segments=12, major_radius=major,
                                   minor_radius=minor, location=location, rotation=rotation)
    return finish(bpy.context.object, name, mat)


def aim(obj, target):
    obj.rotation_euler = (Vector(target) - obj.location).to_track_quat("-Z", "Y").to_euler()


def area(name, location, target, energy, color, size, size_y=None):
    data = bpy.data.lights.new(name, "AREA")
    data.energy = energy
    data.color = color
    data.shape = "RECTANGLE"
    data.size = size
    data.size_y = size_y if size_y else size
    obj = bpy.data.objects.new(name, data)
    bpy.context.collection.objects.link(obj)
    obj.location = location
    aim(obj, target)
    return obj


def camera(location, target, lens=55, fstop=4.0):
    data = bpy.data.cameras.new("Cinema camera")
    data.lens = lens
    data.sensor_width = 36
    data.clip_start = 0.005
    data.clip_end = 100
    data.dof.use_dof = True
    data.dof.aperture_fstop = fstop
    data.dof.aperture_blades = 8
    obj = bpy.data.objects.new("Cinema camera", data)
    bpy.context.collection.objects.link(obj)
    obj.location = location
    aim(obj, target)
    data.dof.focus_distance = (Vector(target) - obj.location).length
    bpy.context.scene.camera = obj
    return obj


def floor(size=200, z=0, color=(0.055, 0.075, 0.10)):
    return cube("Seamless studio floor", (0, 0, z - 0.02), (size, size, 0.04),
                material("Slate studio floor", color, roughness=0.45), 0.01)


def studio_lights(scale=1):
    area("Warm softbox", (-2 * scale, -2 * scale, 3 * scale), (0, 0, scale),
         300 * scale * scale, (1.0, 0.82, 0.62), 2 * scale)
    area("Cool edge strip", (2 * scale, scale, 2.2 * scale), (0, 0, scale),
         420 * scale * scale, (0.45, 0.68, 1.0), 0.45 * scale, 2 * scale)
    area("Front fill", (0, -3 * scale, 1.5 * scale), (0, 0, scale),
         90 * scale * scale, (0.8, 0.9, 1), 2 * scale)


def set_linear_animation(obj):
    if obj.animation_data and obj.animation_data.action:
        for slot in obj.animation_data.action.slots:
            for layer in obj.animation_data.action.layers:
                for strip in layer.strips:
                    bag = strip.channelbag(slot)
                    if bag:
                        for curve in bag.fcurves:
                            for key in curve.keyframe_points:
                                key.interpolation = "LINEAR"
