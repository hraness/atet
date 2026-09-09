"""Parametric instrument mount in millimeters; exports an editable solid assembly."""

import cadquery as cq


def build(context):
    parameters = context["parameters"]
    width = float(parameters.get("widthMm", 100))
    depth = float(parameters.get("depthMm", 64))
    height = float(parameters.get("heightMm", 56))
    thickness = float(parameters.get("thicknessMm", 8))
    if not (50 <= width <= 160 and 40 <= depth <= 100 and 30 <= height <= 100 and 5 <= thickness <= 12):
        raise ValueError("Fixture dimensions exceed the qualified instrument-mount range")
    base = cq.Workplane("XY").box(width, depth, thickness).edges("|Z").fillet(5)
    base = base.faces(">Z").workplane().pushPoints([(-width / 2 + 14, -depth / 2 + 12),
                                                  (width / 2 - 14, -depth / 2 + 12),
                                                  (-width / 2 + 14, depth / 2 - 12),
                                                  (width / 2 - 14, depth / 2 - 12)]).cboreHole(6, 11, 3)
    upright = (cq.Workplane("XY").box(width - 22, thickness, height).edges("|Z").fillet(2)
               .translate((0, depth / 2 - thickness / 2, height / 2 + thickness / 2)))
    # Round each primitive before union: the union also contains the already
    # rounded base and counterbores, whose vertical seam edges cannot be filleted.
    body = base.union(upright)
    # Cylindrical aperture runs through the vertical mounting plate.
    aperture = cq.Workplane("XZ").center(0, height * 0.60).circle(12).extrude(depth, both=True)
    body = body.cut(aperture)
    assembly = cq.Assembly(name="InstrumentMount")
    assembly.add(body, name="MachinedBracket", color=cq.Color(0.70, 0.45, 0.16))
    pad = cq.Workplane("XY").box(width - 32, depth - 28, 2).translate((0, -3, thickness / 2 + 1))
    assembly.add(pad, name="IsolationPad", color=cq.Color(0.04, 0.055, 0.07))
    translation = parameters.get("rootTranslationMm", [0, 0, 0])
    rotation = float(parameters.get("rootRotationDegrees", 0))
    if len(translation) != 3 or any(abs(float(value)) > 1000 for value in translation) or not -180 <= rotation <= 180:
        raise ValueError("Fixture root transform exceeds its qualified range")
    assembly.loc = cq.Location(tuple(float(value) for value in translation), (0, 0, 1), rotation)
    return assembly
