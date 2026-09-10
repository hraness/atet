import {
  chmod,
  copyFile,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { afterEach, expect, test } from "bun:test";

const RUN_COMPILED_SMOKE =
  process.env.SLOPCAMERA_RUN_COMPILED_CLI_SMOKE === "1";
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map(async root =>
    await rm(root, { force: true, recursive: true })));
});

async function run(
  executable: string,
  argv: readonly string[],
  cwd: string,
): Promise<string> {
  const subprocess = Bun.spawn([executable, ...argv], {
    cwd,
    stderr: "pipe",
    stdout: "pipe",
  });
  const [exitCode, stderr, stdout] = await Promise.all([
    subprocess.exited,
    new Response(subprocess.stderr).text(),
    new Response(subprocess.stdout).text(),
  ]);
  if (exitCode !== 0) {
    throw new Error(
      `Compiled Slopcamera command failed (${String(exitCode)}): ${argv.join(" ")}\n${stderr}`,
    );
  }
  return stdout;
}

test.skipIf(!RUN_COMPILED_SMOKE)(
  "ships diagram native rendering and the isolated vectorizer worker inside one portable binary",
  async () => {
    const root = await mkdtemp(join(tmpdir(), "slopcamera-compiled-cli-"));
    roots.push(root);
    const executable = join(root, "slopcamera");
    await copyFile(resolve(import.meta.dir, "..", "dist", "slopcamera"), executable);
    await chmod(executable, 0o755);

    await run(executable, ["diagram", "init", "smoke.diagram.json"], root);
    await run(
      executable,
      ["diagram", "render", "smoke.diagram.json", "--out-dir", "rendered"],
      root,
    );
    const png = join(root, "rendered", "example-flow.light.png");
    expect((await readFile(png)).subarray(0, 8)).toEqual(
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    );

    const vectorizeOutput = await run(executable, [
      "image",
      "vectorize",
      png,
      "--output",
      "vectorized.svg",
      "--timeout-ms",
      "60000",
      "--json",
    ], root);
    const vectorized = await readFile(join(root, "vectorized.svg"), "utf8");
    expect(vectorized).toStartWith("<svg");
    expect(JSON.parse(vectorizeOutput)).toMatchObject({
      outputPath: await realpath(join(root, "vectorized.svg")),
      receiptVersion: 1,
    });
  },
  120_000,
);

test.skipIf(!RUN_COMPILED_SMOKE)(
  "ships every native studio source scaffold inside the copied binary without invoking an engine",
  async () => {
    const root = await mkdtemp(join(tmpdir(), "slopcamera-compiled-studio-")); roots.push(root);
    const executable = join(root, "slopcamera");
    await copyFile(resolve(import.meta.dir, "..", "dist", "slopcamera"), executable);
    await chmod(executable, 0o755);
    for (const template of ["blender-product", "blender-character", "blender-shaded-street", "blender-cloth", "blender-fluid", "cadquery-bracket", "manim-lesson"]) {
      const initialized = JSON.parse(await run(executable, ["studio", "init", template, "--template", template, "--json"], root));
      const bundled = JSON.parse(await run(executable, ["studio", "bundle", initialized.source, "--json"], root));
      const planned = JSON.parse(await run(executable, ["studio", "plan", initialized.job, "--json"], root));
      expect(bundled.bundleSha256).toBe(initialized.bundleSha256);
      expect(planned.readiness).toBe("runtime-unbound");
      expect(planned.bundle.entrypoint.path).toBe("scene.py");
      expect(await readFile(join(root, template, "scene.py"), "utf8")).not.toBe("");
    }
  },
  120_000,
);

test.skipIf(!RUN_COMPILED_SMOKE)(
  "stages exact embedded native drivers when the copied CLI probes an explicit runtime",
  async () => {
    const root = await mkdtemp(join(tmpdir(), "slopcamera-compiled-drivers-")); roots.push(root);
    const executable = join(root, "slopcamera"), runtime = join(root, "inspecting-runtime");
    await copyFile(resolve(import.meta.dir, "..", "dist", "slopcamera"), executable); await chmod(executable, 0o755);
    const profiles = [
      ["blender-product", "drivers/blender_driver.py", "--blender-bin"],
      ["cadquery-bracket", "drivers/cadquery_driver.py", "--python"],
      ["manim-lesson", "education/driver.py", "--python"],
    ] as const;
    const hashes = await Promise.all(profiles.map(async ([, path]) => createHash("sha256").update(await readFile(resolve(import.meta.dir, "../studio", path))).digest("hex")));
    await writeFile(runtime, `#!${process.execPath}
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
const args = process.argv.slice(2);
if (!args.includes("--probe")) throw new Error("Fixture runtime only permits fixed probing");
const driver = args.includes("--python") ? args[args.indexOf("--python") + 1] : args[0];
const hash = createHash("sha256").update(readFileSync(driver)).digest("hex");
if (!${JSON.stringify(hashes)}.includes(hash)) throw new Error("Copied CLI driver differs from owned source");
console.log("SLOPCAMERA_STUDIO_PROBE=" + JSON.stringify({name:"inspected fixed driver",version:"1",packages:{},capabilities:[]}));
`, { mode: 0o755 });
    for (const [index, [template, , flag]] of profiles.entries()) {
      const scaffold = JSON.parse(await run(executable, ["studio", "init", template, "--template", template, "--json"], root));
      await run(executable, ["studio", "bundle", scaffold.source, "--json"], root);
      const bound = JSON.parse(await run(executable, ["studio", "probe", scaffold.job, flag, runtime, "--json"], root));
      expect(bound.runtime.driverSha256).toBe(hashes[index]);
      expect(bound.runtime.tool.name).toBe("inspected fixed driver");
    }
  },
  120_000,
);
