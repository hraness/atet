import {
  chmod,
  copyFile,
  mkdtemp,
  readFile,
  realpath,
  rm,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { afterEach, expect, test } from "bun:test";

const RUN_COMPILED_SMOKE =
  process.env.ATET_RUN_COMPILED_CLI_SMOKE === "1";
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
      `Compiled Atet command failed (${String(exitCode)}): ${argv.join(" ")}\n${stderr}`,
    );
  }
  return stdout;
}

test.skipIf(!RUN_COMPILED_SMOKE)(
  "ships diagram native rendering and the isolated vectorizer worker inside one portable binary",
  async () => {
    const root = await mkdtemp(join(tmpdir(), "atet-compiled-cli-"));
    roots.push(root);
    const executable = join(root, "atet");
    await copyFile(resolve(import.meta.dir, "..", "dist", "atet"), executable);
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
