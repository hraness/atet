"""Cinematic machined lens instrument: reflective metal, glass, fine surface detail."""

import math
import bpy
from studio_scene import reset, material, cube, cylinder, sphere, torus, camera, aim, floor, studio_lights


def build(context):
    scene = reset()
    brass = material("Satin champagne brass", (0.56, 0.31, 0.105), metallic=0.88, roughness=0.23, texture=True)
    dark = material("Black anodized aluminum", (0.022, 0.032, 0.045), metallic=0.75, roughness=0.27)
    rubber = material("Focus grip", (0.018, 0.022, 0.023), roughness=0.58, texture=True)
    glass = material("Optical glass", (0.63, 0.9, 0.92), roughness=0.045, transmission=1)
    silver = material("Steel fasteners", (0.5, 0.58, 0.64), metallic=1, roughness=0.17)
    floor(size=10, color=(0.035, 0.053, 0.067))
    cube("Display plinth", (0, 0.025, 0.035), (0.30, 0.26, 0.07), dark, 0.014)
    cube("Instrument base", (0, 0.015, 0.10), (0.19, 0.15, 0.075), brass, 0.014)
    cube("Support neck", (0, 0.03, 0.17), (0.105, 0.075, 0.08), dark, 0.012)
    rotation = (math.pi / 2, 0, 0)
    cylinder("Lens barrel", (0, 0.0, 0.23), 0.081, 0.16, brass, 0.006, rotation)
    cylinder("Rubber focus collar", (0, -0.035, 0.23), 0.084, 0.055, rubber, 0.002, rotation)
    for index in range(64):
        angle = index * math.tau / 64
        rib = cube("Machined focus rib", (0.084 * math.sin(angle), -0.035, 0.23 + 0.084 * math.cos(angle)),
                   (0.002, 0.05, 0.004), dark, 0.0006)
        rib.rotation_euler.y = angle
    torus("Front rim", (0, -0.085, 0.23), 0.072, 0.007, brass, rotation)
    cylinder("Lens interior", (0, -0.068, 0.23), 0.066, 0.012, dark, rotation=rotation)
    sphere("Rounded front optic", (0, -0.091, 0.23), (0.064, 0.018, 0.064), glass)
    for index in range(6):
        angle = index * math.tau / 6
        cylinder("Steel rim screw", (0.075 * math.sin(angle), -0.092, 0.23 + 0.075 * math.cos(angle)),
                 0.0028, 0.0035, silver, 0.0003, rotation, vertices=16)
    for index in range(5):
        cube("Vent slot", ((index - 2) * 0.027, -0.063, 0.105), (0.014, 0.003, 0.029), dark, 0.003)
    cylinder("Control knob", (0.095, 0.026, 0.16), 0.022, 0.016, dark, 0.002, (0, math.pi / 2, 0))
    cylinder("Control knob cap", (0.105, 0.026, 0.16), 0.014, 0.002, brass, 0.001, (0, math.pi / 2, 0))
    studio_lights(scale=0.20)
    shot = camera((0.47, -0.68, 0.39), (0, -0.015, 0.17), lens=49, fstop=4.5)
    interval = context.get("render") or {"startFrame": 1, "endFrameExclusive": 25}
    start = interval["startFrame"]
    end = max(start + 1, interval["endFrameExclusive"] - 1)
    shot.keyframe_insert("location", frame=start)
    shot.keyframe_insert("rotation_euler", frame=start)
    shot.location = (0.28, -0.74, 0.34)
    aim(shot, (0, -0.02, 0.18))
    shot.keyframe_insert("location", frame=end)
    shot.keyframe_insert("rotation_euler", frame=end)
    shot.data.dof.focus_distance = 0.79
    shot.data.dof.keyframe_insert("focus_distance", frame=start)
    shot.data.dof.focus_distance = 0.72
    shot.data.dof.keyframe_insert("focus_distance", frame=end)
    scene.frame_set(start)
