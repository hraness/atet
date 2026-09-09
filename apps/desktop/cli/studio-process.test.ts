import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, open, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NativeStudioProcess, studioChildEnvironment, type StudioProcessOptions } from "./studio-process";

const posixTest = process.platform === "darwin" || process.platform === "linux" ? test : test.skip;
const helper = `import { spawn } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
const [mode, state] = process.argv.slice(2);
if (mode === "ordinary-tree") {
  const child = spawn(process.execPath, [import.meta.path, "ordinary-leaf", state], { stdio: "inherit" });
  process.on("SIGTERM", () => {});
  child.on("exit", () => process.exit(0));
} else if (mode === "ordinary-leaf") {
  writeFileSync(state, JSON.stringify({ kind: "atet-studio-process-test", pid: process.pid }));
  setInterval(() => {}, 1000);
} else if (mode === "escaped-parent") {
  const child = spawn(process.execPath, [import.meta.path, "escaped-leaf", state], { detached: true, stdio: ["ignore", "inherit", "inherit"] });
  child.unref();
  process.exit(0);
} else if (mode === "escaped-leaf") {
  writeFileSync(state, JSON.stringify({ kind: "atet-studio-process-test", pid: process.pid }));
  process.on("SIGTERM", () => process.exit(0));
  setTimeout(() => process.exit(0), 15000);
  setInterval(() => {}, 1000);
} else if (mode === "fd-parent") {
  const child = spawn(process.execPath, [import.meta.path, "fd-leaf"], { stdio: ["ignore", "inherit", "inherit", 3] });
  child.on("exit", code => process.exit(code ?? 1));
} else if (mode === "fd-leaf") {
  process.stdout.write(readFileSync(3, "utf8"));
} else if (mode === "log-limit") {
  process.stdout.write("x".repeat(100000));
  process.stderr.write("y".repeat(100000));
  setInterval(() => {}, 1000);
} else if (mode === "hang") {
  process.on("SIGTERM", () => {});
  setInterval(() => {}, 1000);
} else if (mode === "normal") {
  process.stdout.write("studio-ready");
  process.stderr.write("diagnostic");
} else throw new Error("Unknown fixture mode");
`;

async function waitForFixturePid(path: string): Promise<number> {
  const deadline = performance.now() + 5000;
  while (performance.now() < deadline) {
    try {
      const state: unknown = JSON.parse(await readFile(path, "utf8"));
      if (typeof state === "object" && state !== null && "kind" in state && state.kind === "atet-studio-process-test"
        && "pid" in state && typeof state.pid === "number" && Number.isSafeInteger(state.pid) && state.pid > 1) return state.pid;
    } catch (error) { if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error; }
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  throw new Error("Owned process fixture did not publish its PID.");
}

function liveFixture(pid: number): boolean {
  try { process.kill(pid, 0); } catch (error) { if (error instanceof Error && "code" in error && error.code === "ESRCH") return false; throw error; }
  // On Linux an orphan can briefly await init reaping; a zombie owns no process resources.
  const status = spawnSync("/bin/ps", ["-p", String(pid), "-o", "stat="], { encoding: "utf8" });
  if (status.status !== 0 && status.stdout.trim() === "") return false;
  return !status.stdout.trim().startsWith("Z");
}

async function stopOwnedFixture(pid: number): Promise<void> {
  if (!liveFixture(pid)) return;
  try { process.kill(pid, "SIGTERM"); } catch (error) { if (!(error instanceof Error && "code" in error && error.code === "ESRCH")) throw error; }
  const deadline = performance.now() + 3000;
  while (liveFixture(pid) && performance.now() < deadline) await new Promise(resolve => setTimeout(resolve, 20));
  if (liveFixture(pid)) {
    process.kill(pid, "SIGKILL");
    const killed = performance.now() + 3000;
    while (liveFixture(pid) && performance.now() < killed) await new Promise(resolve => setTimeout(resolve, 20));
  }
  expect(liveFixture(pid)).toBe(false);
}

async function fixture(run: (context: { root: string; path: string; options: StudioProcessOptions }) => Promise<void>) {
  const root = await mkdtemp(join(await realpath(tmpdir()), "atet-studio-process-test-"));
  const path = join(root, "fixture.mjs");
  await writeFile(path, helper, { mode: 0o600 });
  for (const name of ["home", "tmp", "blender-user"]) await mkdir(join(root, name), { mode: 0o700 });
  try { await run({ root, path, options: { cwd: root, env: studioChildEnvironment(process.execPath, root, 1), timeoutMs: 10000, maximumLogBytes: 1024 } }); }
  finally { await rm(root, { recursive: true, force: true }); }
}

posixTest("native studio process returns closed custody with bounded separate output", async () => {
  await fixture(async ({ path, options }) => {
    expect(await new NativeStudioProcess().run([process.execPath, path, "normal"], options)).toEqual({ exitCode: 0, stdout: "studio-ready", stderr: "diagnostic", custody: "closed" });
    expect(options.env).not.toHaveProperty("AI_GATEWAY_API_KEY");
    expect(options.env).not.toHaveProperty("VERCEL_OIDC_TOKEN");
    expect(options.env).not.toHaveProperty("BLOB_READ_WRITE_TOKEN");
    expect(options.env).not.toHaveProperty("PYTHONPATH");
  });
});

posixTest("native studio missing executable and pre-dispatch cancellation are closed without native work", async () => {
  await fixture(async ({ root, path, options }) => {
    expect(await new NativeStudioProcess().run([join(root, "missing")], options)).toMatchObject({ exitCode: null, custody: "closed", failure: "spawn" });
    const controller = new AbortController(); controller.abort();
    let spawned = false;
    expect(await new NativeStudioProcess().run([process.execPath, path, "normal"], { ...options, signal: controller.signal, onSpawn: async () => { spawned = true; } })).toMatchObject({ custody: "closed", failure: "cancelled" });
    expect(spawned).toBe(false);
  });
});

posixTest("native cancellation closes the ordinary grandchild process group", async () => {
  await fixture(async ({ root, path, options }) => {
    const pidPath = join(root, "ordinary.json"), controller = new AbortController();
    const running = new NativeStudioProcess().run([process.execPath, path, "ordinary-tree", pidPath], { ...options, signal: controller.signal });
    let leaf: number | undefined;
    try {
      leaf = await waitForFixturePid(pidPath);
      controller.abort();
      expect(await running).toMatchObject({ custody: "closed", failure: "cancelled" });
      expect(liveFixture(leaf)).toBe(false);
    } finally { controller.abort(); await running; if (leaf !== undefined) await stopOwnedFixture(leaf); }
  });
}, 15000);

posixTest("native process enforces the combined stdout/stderr byte cap", async () => {
  await fixture(async ({ path, options }) => {
    const result = await new NativeStudioProcess().run([process.execPath, path, "log-limit"], options);
    expect(result).toMatchObject({ custody: "closed", failure: "output-limit" });
    expect(Buffer.byteLength(result.stdout) + Buffer.byteLength(result.stderr)).toBeLessThanOrEqual(options.maximumLogBytes);
  });
});

posixTest("native deadline escalates an ordinary SIGTERM-resistant leader", async () => {
  await fixture(async ({ path, options }) => {
    const started = performance.now();
    expect(await new NativeStudioProcess().run([process.execPath, path, "hang"], { ...options, timeoutMs: 100 })).toMatchObject({ custody: "closed", failure: "timeout" });
    expect(performance.now() - started).toBeLessThan(8000);
  });
}, 10000);

posixTest("native lease descriptors stay open through an ordinary grandchild", async () => {
  await fixture(async ({ root, path, options }) => {
    const retained = join(root, "lease.txt"); await writeFile(retained, "exact-physical-lease");
    const handle = await open(retained, "r");
    try { expect(await new NativeStudioProcess().run([process.execPath, path, "fd-parent"], { ...options, inheritedFileDescriptors: [handle.fd] })).toMatchObject({ exitCode: 0, custody: "closed", stdout: "exact-physical-lease" }); }
    finally { await handle.close(); }
  });
});

posixTest("escaped inherited pipes produce bounded unknown custody and the fixture is explicitly stopped", async () => {
  await fixture(async ({ root, path, options }) => {
    const pidPath = join(root, "escaped.json");
    const started = performance.now();
    const running = new NativeStudioProcess().run([process.execPath, path, "escaped-parent", pidPath], options);
    let escaped: number | undefined;
    try {
      escaped = await waitForFixturePid(pidPath);
      expect(await running).toMatchObject({ custody: "unknown", failure: "descendants" });
      expect(performance.now() - started).toBeLessThan(10000);
    } finally {
      if (escaped !== undefined) await stopOwnedFixture(escaped);
      await running;
    }
  });
}, 15000);

posixTest("an unsettled host callback is bounded and never reported as closed custody", async () => {
  await fixture(async ({ path, options }) => {
    const started = performance.now();
    let settle: () => void = () => {};
    const checkpoint = new Promise<void>(resolve => { settle = resolve; });
    try {
      const result = await new NativeStudioProcess().run([process.execPath, path, "normal"], { ...options, onSpawn: async () => await checkpoint });
      expect(result).toMatchObject({ exitCode: 0, custody: "unknown", failure: "descendants" });
      expect(performance.now() - started).toBeLessThan(9_000);
    } finally { settle(); await checkpoint; }
  });
}, 12_000);
