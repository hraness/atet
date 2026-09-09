"""An articulated studio character with a skinned IK arm and blended facial shapes."""

import math
import bpy
from studio_scene import reset, material, cube, cylinder, sphere, camera, floor, studio_lights


def weighted(obj, armature, weights):
    modifier = obj.modifiers.new("Character skin", "ARMATURE")
    modifier.object = armature
    obj.parent = armature
    for bone_name, vertex_weights in weights.items():
        group = obj.vertex_groups.new(name=bone_name)
        for index, weight in vertex_weights:
            if weight > 0:
                group.add([index], weight, "REPLACE")


def rigid_skin(obj, armature, bone_name):
    weighted(obj, armature, {bone_name: [(v.index, 1) for v in obj.data.vertices]})


def build(context):
    scene = reset()
    ceramic = material("Warm porcelain shell", (0.69, 0.75, 0.73), roughness=0.26)
    teal = material("Teal woven joint sleeve", (0.027, 0.23, 0.28), roughness=0.5, texture=True)
    dark = material("Graphite facial details", (0.012, 0.027, 0.037), roughness=0.30)
    copper = material("Copper joint collars", (0.56, 0.19, 0.065), metallic=0.82, roughness=0.3)
    floor(size=25)
    skeleton = bpy.data.armatures.new("Character deformation skeleton")
    rig = bpy.data.objects.new("Character rig", skeleton)
    bpy.context.collection.objects.link(rig)
    bpy.context.view_layer.objects.active = rig
    rig.select_set(True)
    bpy.ops.object.mode_set(mode="EDIT")
    definitions = [
        ("root", (0, 0, 0.1), (0, 0, 0.65), None),
        ("chest", (0, 0, 0.65), (0, 0, 1.20), "root"),
        ("head", (0, 0, 1.20), (0, 0, 1.67), "chest"),
        ("upper_arm.R", (0.29, 0, 1.15), (0.61, 0, 1.12), "chest"),
        ("forearm.R", (0.61, 0, 1.12), (0.91, 0, 1.09), "upper_arm.R"),
        ("upper_arm.L", (-0.29, 0, 1.15), (-0.42, 0, 0.85), "chest"),
        ("forearm.L", (-0.42, 0, 0.85), (-0.43, -0.025, 0.58), "upper_arm.L"),
        ("leg.R", (0.14, 0, 0.65), (0.14, 0, 0.14), "root"),
        ("leg.L", (-0.14, 0, 0.65), (-0.14, 0, 0.14), "root"),
    ]
    for name, head, tail, parent in definitions:
        bone = skeleton.edit_bones.new(name)
        bone.head, bone.tail = head, tail
        if parent:
            bone.parent = skeleton.edit_bones[parent]
    bpy.ops.object.mode_set(mode="OBJECT")
    torso = sphere("Porcelain torso", (0, 0, 0.96), (0.29, 0.16, 0.36), ceramic)
    rigid_skin(torso, rig, "chest")
    head = sphere("Expressive head", (0, -0.012, 1.47), (0.275, 0.19, 0.245), ceramic)
    rigid_skin(head, rig, "head")
    head.shape_key_add(name="Basis")
    jaw = head.shape_key_add(name="JawOpen")
    for vertex in jaw.data:
        if vertex.co.z < -0.02:
            vertex.co.z -= 0.055 * min(1, -vertex.co.z / 0.18)
    for side, x in (("L", -0.095), ("R", 0.095)):
        eye = sphere("Eye." + side, (x, -0.190, 1.51), (0.038, 0.014, 0.053), dark)
        rigid_skin(eye, rig, "head")
        eye.shape_key_add(name="Basis")
        blink = eye.shape_key_add(name="Blink")
        for vertex in blink.data:
            vertex.co.z *= 0.12
        for frame, value in ((1, 0), (7, 0), (9, 1), (11, 0), (24, 0)):
            blink.value = value
            blink.keyframe_insert("value", frame=frame)
    vertices, faces = [], []
    for index in range(25):
        x = (index / 24 - 0.5) * 0.17
        for offset in (-0.007, 0.007):
            vertices.append((x, -0.202, 1.40 + offset))
        if index:
            faces.append((2 * index - 2, 2 * index, 2 * index + 1, 2 * index - 1))
    mesh = bpy.data.meshes.new("Mouth surface")
    mesh.from_pydata(vertices, [], faces)
    mouth = bpy.data.objects.new("Animated smile", mesh)
    bpy.context.collection.objects.link(mouth)
    mouth.data.materials.append(dark)
    rigid_skin(mouth, rig, "head")
    mouth.shape_key_add(name="Basis")
    smile = mouth.shape_key_add(name="Smile")
    open_mouth = mouth.shape_key_add(name="MouthOpen")
    for index, vertex in enumerate(smile.data):
        vertex.co.z += 0.055 * (abs(vertex.co.x) / 0.085) ** 1.7
    for index, vertex in enumerate(open_mouth.data):
        vertex.co.z += (0.018 if index % 2 else -0.018) * (1 - (vertex.co.x / 0.09) ** 2)
    for frame, value in ((1, 0.1), (12, 0.3), (18, 1), (24, 0.85)):
        smile.value = value
        smile.keyframe_insert("value", frame=frame)
    for frame, value in ((1, 0), (12, 0.1), (17, 0.8), (21, 0.2), (24, 0)):
        open_mouth.value = value
        open_mouth.keyframe_insert("value", frame=frame)
        jaw.value = value
        jaw.keyframe_insert("value", frame=frame)
    # Continuous tube with blended weights demonstrates skin deformation at the elbow.
    vertices, faces, weights = [], [], {"upper_arm.R": [], "forearm.R": []}
    for ring in range(25):
        x = 0.29 + ring / 24 * 0.62
        z = 1.15 - ring / 24 * 0.06
        blend = max(0, min(1, (x - 0.55) / 0.12))
        for radial in range(16):
            angle = radial * math.tau / 16
            index = len(vertices)
            vertices.append((x, math.cos(angle) * 0.073, z + math.sin(angle) * 0.073))
            weights["upper_arm.R"].append((index, 1 - blend))
            weights["forearm.R"].append((index, blend))
            if ring:
                previous = (radial + 1) % 16
                faces.append(((ring - 1) * 16 + radial, (ring - 1) * 16 + previous,
                              ring * 16 + previous, ring * 16 + radial))
    mesh = bpy.data.meshes.new("Continuous arm skin")
    mesh.from_pydata(vertices, [], faces)
    arm = bpy.data.objects.new("Deforming IK sleeve", mesh)
    bpy.context.collection.objects.link(arm)
    arm.data.materials.append(teal)
    for polygon in mesh.polygons:
        polygon.use_smooth = True
    weighted(arm, rig, weights)
    hand = sphere("Reaching hand", (0.94, 0, 1.09), (0.105, 0.085, 0.085), ceramic)
    rigid_skin(hand, rig, "forearm.R")
    for side, x in (("L", -0.14), ("R", 0.14)):
        leg = cylinder("Leg." + side, (x, 0, 0.40), 0.10, 0.40, teal, 0.025)
        rigid_skin(leg, rig, "leg." + side)
        foot = sphere("Foot." + side, (x, -0.065, 0.11), (0.135, 0.19, 0.09), ceramic)
        rigid_skin(foot, rig, "leg." + side)
    left_arm = sphere("Left arm sleeve", (-0.39, 0, 0.91), (0.08, 0.085, 0.23), teal)
    rigid_skin(left_arm, rig, "upper_arm.L")
    left_hand = sphere("Left hand", (-0.43, -0.025, 0.58), (0.09, 0.085, 0.10), ceramic)
    rigid_skin(left_hand, rig, "forearm.L")
    for x in (-0.27, 0.27):
        sphere("Shoulder collar", (x, 0, 1.15), (0.095, 0.10, 0.10), copper)
    goal = bpy.data.objects.new("Right hand IK goal", None)
    bpy.context.collection.objects.link(goal)
    goal.empty_display_type = "SPHERE"
    goal.empty_display_size = 0.05
    for frame, location in ((1, (0.88, 0, 1.09)), (12, (0.69, -0.10, 1.45)),
                            (18, (0.62, -0.09, 1.59)), (24, (0.73, -0.08, 1.48))):
        goal.location = location
        goal.keyframe_insert("location", frame=frame)
    pole = bpy.data.objects.new("Elbow pole", None)
    bpy.context.collection.objects.link(pole)
    pole.location = (0.6, -0.7, 0.8)
    ik = rig.pose.bones["forearm.R"].constraints.new("IK")
    ik.target, ik.pole_target, ik.chain_count, ik.use_stretch = goal, pole, 2, False
    studio_lights(scale=1)
    camera((2.4, -4.4, 2.1), (0.12, 0, 0.87), lens=47, fstop=8)
    scene.frame_set((context.get("render") or {}).get("startFrame", 1))
