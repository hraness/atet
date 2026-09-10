"""Fixed SLOPCAMERA CadQuery adapter for explicitly trusted native source bundles."""

import argparse
import hashlib
import importlib.metadata
import json
import os
from pathlib import Path
import runpy
import sys


def child_path(root, relative):
    if not isinstance(relative, str) or not relative or "\\" in relative:
        raise ValueError("Expected a normalized relative artifact path")
    if any(part in ("", ".", "..") for part in relative.split("/")) or Path(relative).is_absolute():
        raise ValueError("Artifact path escapes its retained root")
    path = Path(root) / relative
    if not path.resolve().is_relative_to(Path(root).resolve()):
        raise ValueError("Artifact path crosses an external symlink")
    return path


def verify_bundle(request):
    for item in request["bundle"]["files"]:
        path = child_path(request["sourceRoot"], item["path"])
        if path.is_symlink() or not path.is_file():
            raise ValueError("Retained source is not a regular file")
        digest = hashlib.sha256()
        count = 0
        with path.open("rb") as stream:
            while data := stream.read(1024 * 1024):
                digest.update(data)
                count += len(data)
        if digest.hexdigest() != item["sha256"] or count != item["bytes"]:
            raise ValueError("Retained source bytes changed: " + item["path"])


def shapes_for(cq, value):
    if isinstance(value, cq.Assembly):
        return [value.toCompound()]
    if isinstance(value, cq.Workplane):
        return [item for item in value.vals() if isinstance(item, cq.Shape)]
    if isinstance(value, cq.Shape):
        return [value]
    raise ValueError("exportVariable must name a CadQuery Workplane, Shape, or Assembly")


def export_meter_glb(assembly, path, tolerance, angular_tolerance):
    # CadQuery 2.8's high-level GLTF writer rotates the assembly but leaves its
    # millimeter numbers unchanged. Set OCCT's physical units explicitly while
    # retaining CadQuery's colored assembly conversion and mesh tolerance in mm.
    from cadquery.occ_impl.assembly import toCAF
    from OCP.Message import Message_ProgressRange
    from OCP.RWGltf import RWGltf_CafWriter
    from OCP.RWMesh import RWMesh_CoordinateSystem_Zup, RWMesh_CoordinateSystem_Yup
    from OCP.TCollection import TCollection_AsciiString
    from OCP.TColStd import TColStd_IndexedDataMapOfStringString
    _, document = toCAF(assembly, True, True, tolerance, angular_tolerance)
    writer = RWGltf_CafWriter(TCollection_AsciiString(str(path)), True)
    converter = writer.ChangeCoordinateSystemConverter()
    converter.SetInputLengthUnit(0.001)
    converter.SetOutputLengthUnit(1.0)
    # Let OCCT transform both mesh positions and assembly translations. Rotating
    # only the root location would leave a translated assembly's origin in Z-up.
    converter.SetInputCoordinateSystem(RWMesh_CoordinateSystem_Zup)
    converter.SetOutputCoordinateSystem(RWMesh_CoordinateSystem_Yup)
    if not writer.Perform(document, TColStd_IndexedDataMapOfStringString(), Message_ProgressRange()):
        raise RuntimeError("OCCT did not complete the declared meter-scale GLB export")


def run(cq, request):
    for key in ("sourceRoot", "outputRoot", "workingRoot"):
        root = Path(request[key])
        if not root.is_absolute() or not root.is_dir() or root.is_symlink() or root.resolve() != root:
            raise ValueError("Driver roots must be existing absolute physical directories")
    roots = [Path(request[key]) for key in ("sourceRoot", "outputRoot", "workingRoot")]
    if any(a == b or a in b.parents or b in a.parents for index, a in enumerate(roots) for b in roots[index + 1:]):
        raise ValueError("Source, output and scratch roots must be disjoint")
    if any(Path(request["outputRoot"]).iterdir()):
        raise ValueError("CadQuery requires a fresh owned output directory")
    job = request["job"]
    if request["bundle"]["engine"] != "cadquery" or job["engine"]["engine"] != "cadquery":
        raise ValueError("CadQuery driver requires a CadQuery bundle and job")
    if request["bundle"]["entrypoint"]["kind"] != "python":
        raise ValueError("CadQuery requires a Python entrypoint")
    verify_bundle(request)
    context = json.loads(json.dumps({"parameters": job["parameters"], "stage": job["stage"], "render": job.get("render"),
               "sourceRoot": request["sourceRoot"], "outputRoot": request["outputRoot"],
               "workingRoot": request["workingRoot"]}))
    os.chdir(request["workingRoot"])
    sys.dont_write_bytecode = True
    source = child_path(request["sourceRoot"], request["bundle"]["entrypoint"]["path"])
    sys.path.insert(0, request["sourceRoot"])
    namespace = runpy.run_path(str(source), init_globals={"SLOPCAMERA_CONTEXT": context}, run_name="__slopcamera_studio__")
    if callable(namespace.get("build")):
        built = namespace["build"](context)
        if built is not None:
            namespace[job["engine"]["exportVariable"]] = built
    if job["stage"] == "bake" and callable(namespace.get("bake")):
        namespace["bake"](context)
    value = namespace.get(job["engine"]["exportVariable"])
    shapes = shapes_for(cq, value)
    if not shapes or any(not shape.isValid() for shape in shapes):
        raise ValueError("CadQuery output is empty or geometrically invalid")
    options = job["engine"]
    exported = []
    for output in job["outputs"]:
        if output["role"] != "model":
            continue
        if output["kind"] != "file" or output["format"] not in ("step", "glb"):
            raise ValueError("CadQuery automatic export supports STEP and GLB file outputs")
        path = child_path(request["outputRoot"], output["path"])
        path.parent.mkdir(parents=True, exist_ok=True)
        if path.exists() or path.is_symlink():
            raise ValueError("Refusing to overwrite a preexisting CAD output")
        if output["format"] == "step":
            if output["interpretation"].get("sourceSpace") != {"units": "millimeters", "upAxis": "z", "handedness": "right"}:
                raise ValueError("Automatic CadQuery STEP export requires millimeters, right-handed Z-up declaration")
            if isinstance(value, cq.Assembly):
                value.export(str(path), exportType="STEP", mode="default", unit="MM")
            else:
                cq.exporters.export(value, str(path), exportType="STEP")
        else:
            if output["interpretation"].get("sourceSpace") != {"units": "meters", "upAxis": "y", "handedness": "right"}:
                raise ValueError("Automatic CadQuery GLB export requires meters, right-handed Y-up declaration")
            assembly = value if isinstance(value, cq.Assembly) else cq.Assembly(value, name="model")
            export_meter_glb(assembly, path, options["tolerance"], options["angularTolerance"])
        exported.append({"id": output["id"], "format": output["format"], "path": output["path"]})
        observed = [path for path in Path(request["outputRoot"]).rglob("*") if path.is_file()]
        if any(path.is_symlink() for path in observed) or len(observed) > job["limits"]["maximumOutputFiles"] or sum(path.stat().st_size for path in observed) > job["limits"]["maximumOutputBytes"]:
            raise ValueError("CadQuery exceeded its declared output budget or produced indirect output")
    verify_bundle(request)
    bounds = []
    for shape in shapes:
        box = shape.BoundingBox()
        bounds.append({"minimum": [box.xmin, box.ymin, box.zmin],
                       "maximum": [box.xmax, box.ymax, box.zmax],
                       "volume": shape.Volume(), "solids": len(shape.Solids()),
                       "faces": len(shape.Faces()), "valid": shape.isValid()})
    result = {"kind": "slopcamera.studio-cadquery-result", "schemaVersion": 1,
              "version": cq.__version__, "stage": job["stage"], "bounds": bounds,
              "sourceSpace": {"units": "millimeters", "upAxis": "z", "handedness": "right"},
              "tessellation": {"tolerance": options["tolerance"], "angularTolerance": options["angularTolerance"]},
              "exports": exported, "trust": "trusted-current-user", "hermetic": False}
    with (Path(request["workingRoot"]) / "result.json").open("x", encoding="utf-8") as stream:
        json.dump(result, stream, indent=2, allow_nan=False)
        stream.write("\n")


def main():
    import cadquery as cq
    parser = argparse.ArgumentParser()
    group = parser.add_mutually_exclusive_group(required=True)
    group.add_argument("--probe", action="store_true")
    group.add_argument("--request")
    args = parser.parse_args()
    if args.probe:
        packages = {"cadquery": cq.__version__, "python": sys.version.split()[0]}
        for name in ("cadquery-ocp", "numpy", "vtk"):
            try:
                packages[name] = importlib.metadata.version(name)
            except importlib.metadata.PackageNotFoundError:
                pass
        print("SLOPCAMERA_STUDIO_PROBE=" + json.dumps({"name": "CadQuery", "version": cq.__version__,
                          "packages": packages, "capabilities": ["python-authoring", "build", "bake", "render", "model-export", "native-cache"]}))
        return
    with Path(args.request).open("rb") as stream:
        data = stream.read(2 * 1024 * 1024 + 1)
    if len(data) > 2 * 1024 * 1024:
        raise ValueError("Driver request exceeds its byte bound")
    run(cq, json.loads(data))


if __name__ == "__main__":
    main()
