import { randomUUID } from "node:crypto";
import { lstat, mkdir, realpath } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { parseStudioJob, parseStudioSourceBundle, studioSourceBundleSha256 } from "../../../src/studio";
import blenderProduct from "../../../examples/studio/blender/product.py" with { type: "text" };
import blenderCharacter from "../../../examples/studio/blender/character.py" with { type: "text" };
import blenderCloth from "../../../examples/studio/blender/cloth.py" with { type: "text" };
import blenderFluid from "../../../examples/studio/blender/fluid.py" with { type: "text" };
import blenderToolkit from "../../../examples/studio/blender/studio_scene.py" with { type: "text" };
import cadqueryBracket from "../../../examples/studio/cadquery/bracket.py" with { type: "text" };
import educationScene from "../../../examples/studio/education/scene.py" with { type: "text" };
import educationLesson from "../../../examples/studio/education/lesson.json";
import educationValidation from "../studio/education/lesson.py" with { type: "text" };
import educationToolkit from "../studio/education/toolkit.py" with { type: "text" };
import { createNodeBundleFileSystem } from "../core/storage";
import { studioBytesSha256, studioJson } from "./studio-files";
import type { StudioTemplate } from "./studio-template-names";

export function studioStarter(template: StudioTemplate) {
  const engine = template.startsWith("blender-") ? "blender" : template === "cadquery-bracket" ? "cadquery" : "manim";
  const files: Record<string, string> = engine === "blender" ? {
    "scene.py": ({ "blender-product": blenderProduct, "blender-character": blenderCharacter, "blender-cloth": blenderCloth, "blender-fluid": blenderFluid } as Record<string, string>)[template]!,
    "studio_scene.py": blenderToolkit,
  } : engine === "cadquery" ? { "scene.py": cadqueryBracket } : { "scene.py": educationScene, "lesson.json": studioJson(educationLesson), "lesson.py": educationValidation, "toolkit.py": educationToolkit };
  const source = { engine, entrypoint: { kind: "python", path: "scene.py" }, files: Object.keys(files).sort() };
  const bundle = parseStudioSourceBundle({ kind: "atet.studio-source-bundle", schemaVersion: 1, engine, entrypoint: source.entrypoint,
    files: Object.entries(files).map(([path, text]) => ({ path, bytes: Buffer.byteLength(text), sha256: studioBytesSha256(text) })) });
  const raster = { kind: "raster", colorSpace: "srgb", alpha: "opaque", dataType: "uint8", channels: ["R", "G", "B"], semantic: "color", unit: "unitless" };
  const simulation = template === "blender-cloth" || template === "blender-fluid";
  const outputs = engine === "cadquery" ? [
    { id: "solid", kind: "file", role: "model", format: "step", path: "model.step", interpretation: { kind: "model", sourceSpace: { units: "millimeters", upAxis: "z", handedness: "right" } } },
    { id: "preview", kind: "file", role: "model", format: "glb", path: "model.glb", interpretation: { kind: "model", sourceSpace: { units: "meters", upAxis: "y", handedness: "right" } } },
  ] : simulation ? [
    { id: "native", kind: "file", role: "native-source", format: "blend", path: "native/scene.blend", interpretation: { kind: "native-source" } },
    { id: "cache", kind: "directory", role: "simulation-cache", format: "cache", path: "cache", interpretation: { kind: "cache", semantics: "opaque-native" } },
  ] : [
    { id: "beauty", kind: "sequence", role: "beauty", format: "png", pathPattern: "frames/%06d.png", interpretation: raster },
    ...(engine === "manim" ? [{ id: "movie", kind: "file", role: "beauty", format: "mp4", path: "lesson.mp4", interpretation: raster }]
      : [{ id: "native", kind: "file", role: "native-source", format: "blend", path: "native/scene.blend", interpretation: { kind: "native-source" } }]),
  ];
  const job = parseStudioJob({ kind: "atet.studio-job", schemaVersion: 1, jobId: `studio_${template.replaceAll("-", "_")}_${randomUUID()}`, bundleSha256: studioSourceBundleSha256(bundle),
    stage: engine === "cadquery" ? "build" : simulation ? "bake" : "render",
    parameters: engine === "manim" ? { lessonFile: "lesson.json" } : {},
    engine: engine === "blender" ? { engine, renderer: "cycles", device: "gpu", samples: 32, transparent: false, viewTransform: "AgX", denoise: true, seed: 0 }
      : engine === "manim" ? { engine, scene: "PythagoreanLesson", renderer: "cairo", transparent: false }
        : { engine, exportVariable: "model", tolerance: 0.05, angularTolerance: 0.1 },
    ...(engine === "cadquery" ? {} : { render: { width: engine === "manim" ? 480 : 640, height: engine === "manim" ? 854 : 360, frameRate: { numerator: 24, denominator: 1 },
      startFrame: simulation ? 1 : 0, endFrameExclusive: engine === "manim" ? 240 : template === "blender-cloth" ? 41 : template === "blender-fluid" ? 33 : 72 } }),
    outputs, limits: { timeoutSeconds: 900, maximumOutputBytes: 2_147_483_648, maximumOutputFiles: 2048 },
    execution: { trust: "trusted-current-user", isolation: "none", hermetic: false },
  });
  return { source, bundle, job, files };
}

export async function createStudioScaffold(directoryInput: string, template: StudioTemplate, fence: () => Promise<void>) {
  const requested = resolve(directoryInput), parent = await realpath(dirname(requested)), directory = join(parent, requested.slice(dirname(requested).length + 1));
  await fence();
  await mkdir(directory, { mode: 0o700 }); // A scaffold never merges into an existing source directory.
  if (!(await lstat(directory)).isDirectory()) throw new Error("Studio scaffold directory changed.");
  const starter = studioStarter(template), fs = createNodeBundleFileSystem(directory);
  for (const [path, text] of Object.entries(starter.files)) await fs.writeTextNoReplace!(path, text, fence);
  await fs.writeTextNoReplace!("source.json", studioJson(starter.source), fence);
  await fs.writeTextNoReplace!("job.json", studioJson(starter.job), fence);
  return { directory, template, jobId: starter.job.jobId, bundleSha256: starter.job.bundleSha256, executed: false,
    source: join(directory, "source.json"), job: join(directory, "job.json"),
    next: ["Edit the retained source and job as needed.", `atet studio bundle ${JSON.stringify(join(directory, "source.json"))} --json`, "After editing source, bind the returned bundleSha256 into a new job ID before running."] };
}
