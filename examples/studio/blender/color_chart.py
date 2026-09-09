"""Known linear-emission patches for PNG/EXR color and alpha qualification."""

import bpy
from studio_scene import reset, camera


def build(context):
    scene = reset()
    scene.world.node_tree.nodes["Background"].inputs["Strength"].default_value = 0
    colors = ((0.18, 0.18, 0.18), (1, 0, 0), (0, 1, 0),
              (0, 0, 1), (2, 1, 0.5), (0.5, 0.25, 0.125))
    for index, color in enumerate(colors):
        bpy.ops.mesh.primitive_plane_add(size=1, location=((index % 3 - 1), 0.4 if index < 3 else -0.4, 0))
        patch = bpy.context.object
        patch.name = "Linear emission patch " + str(index)
        patch.scale = (0.8, 0.55, 1)
        material = bpy.data.materials.new(patch.name)
        material.use_nodes = True
        material.node_tree.nodes.clear()
        emission = material.node_tree.nodes.new("ShaderNodeEmission")
        emission.inputs["Color"].default_value = (*color, 1)
        emission.inputs["Strength"].default_value = 1
        output = material.node_tree.nodes.new("ShaderNodeOutputMaterial")
        material.node_tree.links.new(emission.outputs["Emission"], output.inputs["Surface"])
        patch.data.materials.append(material)
    shot = camera((0, 0, 4), (0, 0, 0))
    shot.data.type = "ORTHO"
    shot.data.ortho_scale = 3.2
    shot.data.dof.use_dof = False
