"""Import a caller-declared STEP assembly; its exact bytes belong in the bundle."""

from pathlib import Path
import cadquery as cq


def build(context):
    relative = context["parameters"].get("input", "assets/bracket.step")
    path = (Path(context["sourceRoot"]) / relative).resolve(strict=True)
    if not path.is_relative_to(Path(context["sourceRoot"]).resolve()):
        raise ValueError("STEP fixture input must be inside the retained source bundle")
    return cq.Assembly.importStep(str(path), unit="MM")
