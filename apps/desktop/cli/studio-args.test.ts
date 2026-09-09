import { expect, test } from "bun:test";
import { parseCliArgs } from "./args";
import { studioStarter } from "./studio-scaffold";
import { STUDIO_TEMPLATES } from "./studio-template-names";

test("studio CLI keeps runtime selection separate from source execution authorization", () => {
  expect(parseCliArgs(["studio", "probe", "job.json", "--python", "/venv/python", "--json"])).toMatchObject({ kind: "studio", action: "probe", python: "/venv/python", allowTrustedCode: false, json: true });
  expect(() => parseCliArgs(["studio", "run", "job.json", "--python", "/venv/python"])).toThrow("--allow-trusted-code");
  expect(parseCliArgs(["studio", "run", "job.json", "--allow-trusted-code", "--blender-bin", "/Blender"])).toMatchObject({ kind: "studio", action: "run", allowTrustedCode: true });
  expect(() => parseCliArgs(["studio", "plan", "job.json", "--allow-trusted-code"])).toThrow();
  expect(() => parseCliArgs(["studio", "run", "job.json", "--allow-trusted-code", "--argv", "arbitrary"])).toThrow();
});
test("workflow runtime flags do not imply native trust", () => {
  expect(parseCliArgs(["code", "run", "film.ts", "--input", "input.json", "--studio-python", "/venv/python"])).toMatchObject({ studio: { python: "/venv/python", allowTrustedCode: false } });
  expect(parseCliArgs(["code", "run", "film.ts", "--input", "input.json", "--studio-python", "/venv/python", "--allow-trusted-code"])).toMatchObject({ studio: { python: "/venv/python", allowTrustedCode: true } });
  expect(parseCliArgs(["code", "run", "film.ts", "--input", "input.json"])).not.toHaveProperty("studio");
});
test("every embedded scaffold binds all explicit helper bytes to a valid native job", () => {
  for (const template of STUDIO_TEMPLATES) {
    const starter = studioStarter(template);
    expect(starter.source.files).toEqual(starter.bundle.files.map(file => file.path));
    expect(starter.job.bundleSha256).toMatch(/^[a-f0-9]{64}$/u);
    expect(starter.job.execution).toEqual({ trust: "trusted-current-user", isolation: "none", hermetic: false });
  }
});

test("studio assets and encoding select closed operations without authored execution", () => {
  expect(parseCliArgs(["studio", "assets", "plan", "selection.json"])).toMatchObject({ action: "assets", operation: "plan", path: "selection.json" });
  expect(parseCliArgs(["studio", "encode", "studio_sample", "--output-id", "beauty"])).toMatchObject({ action: "encode", id: "studio_sample", outputId: "beauty" });
  expect(parseCliArgs(["studio", "assemble", "studio_sample", "--output-id", "beauty", "--name", "The film"])).toMatchObject({ action: "assemble", title: "The film" });
  expect(() => parseCliArgs(["studio", "encode", "studio_sample"])).toThrow("--output-id");
  expect(() => parseCliArgs(["studio", "encode", "studio_sample", "--output-id", "beauty", "--argv", "arbitrary"])).toThrow();
});

test("portrait city starter retains its character dependency and matching camera clock", () => {
  const starter = studioStarter("blender-shaded-street");
  expect(starter.source.files).toEqual(["character.py", "scene.py", "studio_scene.py"]);
  expect(starter.job.render).toMatchObject({ width: 360, height: 640, startFrame: 1, endFrameExclusive: 73 });
  expect(starter.job.engine).toMatchObject({ renderer: "cycles", device: "gpu", viewTransform: "Standard" });
  expect(starter.job.parameters).toEqual({ shot: "establish", motion: "approach" });
});
