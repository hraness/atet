import { describe, expect, test } from "bun:test";
import { lstat, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";

import {
  createNodeBundleFileSystem,
  loadEditPlan,
  saveRecordingManifest,
} from "../core";
import { testManifest } from "../core/test-support";
import { CURRENT_EDIT_PLAN_PATH } from "./bundle-service";
import { CliError, EXIT_CODE } from "./errors";
import type { CliIo, ProcessRunner, RunResult } from "./io";
import {
  MUTATION_LOCK_FILE,
  MUTATION_LOCK_TEMP_PREFIX,
  withMutationLock,
} from "./mutation-lock";
import type { RepositoryPaths } from "./paths";
import { createCliTestRunner } from "./run-cli-test-helper";

const NOW = new Date("2026-07-22T18:00:00.000Z");
const PNG_SIGNATURE = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
let executeInvocation = 0;

interface CliResult {
  readonly exitCode: number;
  readonly stderr: string;
  readonly stdout: string;
}

interface RecordingFixture {
  readonly paths: RepositoryPaths;
  readonly recordingDirectory: string;
  readonly root: string;
  readonly source: string;
}

class OverlayRunner implements ProcessRunner {
  readonly #capabilityAvailable: boolean;
  readonly #gate: boolean;
  readonly #release: Promise<void>;
  #releaseGate!: () => void;
  readonly started: Promise<void>;
  #start!: () => void;
  #started = false;

  constructor(options: { readonly capabilityAvailable: boolean; readonly gate: boolean }) {
    this.#capabilityAvailable = options.capabilityAvailable;
    this.#gate = options.gate;
    this.started = new Promise(resolve => { this.#start = resolve; });
    this.#release = new Promise(resolve => { this.#releaseGate = resolve; });
  }

  release(): void {
    this.#releaseGate();
  }

  async run(argv: readonly [string, ...string[]]): Promise<RunResult> {
    const executable = argv[0].split("/").at(-1);
    if (executable === "ffprobe" && argv.includes("-version")) {
      if (!this.#started) {
        this.#started = true;
        this.#start();
        if (this.#gate) await this.#release;
      }
      return this.#capabilityAvailable
        ? { exitCode: 0, stderr: "", stdout: "ffprobe fixture" }
        : { exitCode: 1, stderr: "ffprobe unavailable", stdout: "" };
    }
    if (executable === "ffprobe" && argv.includes("-show_entries")) {
      return {
        exitCode: 0,
        stderr: "",
        stdout: JSON.stringify({
          format: { duration: "10", start_time: "0" },
          streams: [{
            codec_type: "video",
            duration: "10",
            height: 1,
            index: 0,
            start_time: "0",
            width: 1,
          }],
        }),
      };
    }
    return { exitCode: 1, stderr: "not installed in fixture", stdout: "" };
  }
}

async function execute(
  paths: RepositoryPaths,
  argv: readonly string[],
  runner: ProcessRunner = new OverlayRunner({ capabilityAvailable: true, gate: false }),
): Promise<CliResult> {
  let stderr = "";
  let stdout = "";
  const io: CliIo = {
    cwd: () => paths.repositoryRoot,
    env: {},
    now: () => NOW,
    platform: process.platform,
    stderr: value => { stderr += value; },
    stdout: value => { stdout += value; },
  };
  const runCli = createCliTestRunner(import.meta.url, ++executeInvocation);
  const exitCode = await runCli(argv, { io, paths, runner });
  return { exitCode, stderr, stdout };
}

async function rejected(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error("Expected promise rejection.");
}

async function recordingFixture(): Promise<RecordingFixture> {
  const root = await mkdtemp(join(tmpdir(), "atet-mutation-lock-"));
  const paths: RepositoryPaths = {
    artifactRoot: join(root, "artifacts", "atet", "recordings"),
    desktopRoot: join(root, "projects", "atet", "apps", "desktop"),
    privateRoot: join(root, "artifacts", "atet", "private"),
    projectRoot: join(root, "artifacts", "atet", "projects"),
    repositoryRoot: root,
  };
  const recordingDirectory = join(paths.artifactRoot, "rec_example001");
  await mkdir(recordingDirectory, { recursive: true });
  await saveRecordingManifest(createNodeBundleFileSystem(recordingDirectory), testManifest());
  const source = join(root, "overlay.png");
  await writeFile(source, PNG_SIGNATURE, { mode: 0o600 });
  expect((await execute(paths, ["edit", "rec_example001", "init", "--json"])).exitCode).toBe(0);
  return { paths, recordingDirectory, root, source };
}

function overlayArguments(source: string): readonly string[] {
  return [
    "edit", "rec_example001", "overlay", "add",
    "--kind", "image", "--source", source,
    "--from", "1s", "--to", "3s", "--json",
  ];
}

describe("exclusive bundle mutation lock", () => {
  test("uses the same conflict boundary for project edits", async () => {
    const root = await mkdtemp(join(tmpdir(), "atet-project-mutation-lock-"));
    const paths: RepositoryPaths = {
      artifactRoot: join(root, "artifacts", "atet", "recordings"),
      desktopRoot: join(root, "projects", "atet", "apps", "desktop"),
      privateRoot: join(root, "artifacts", "atet", "private"),
      projectRoot: join(root, "artifacts", "atet", "projects"),
      repositoryRoot: root,
    };
    const directory = join(paths.projectRoot, "project_lock001");
    await mkdir(directory, { recursive: true });
    try {
      await withMutationLock(directory, {
        command: "project-add",
        label: "project project_lock001",
      }, async () => {
        const contender = await execute(paths, [
          "project", "edit", "project_lock001", "cut", "1s", "2s", "--json",
        ]);
        expect(contender.exitCode).toBe(EXIT_CODE.conflict);
        expect(JSON.parse(contender.stderr)).toMatchObject({
          error: { code: "conflict", details: { command: "project-add" } },
        });
      });
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  test("rejects a simultaneous edit without overwriting either edit's base", async () => {
    const fixture = await recordingFixture();
    const runner = new OverlayRunner({ capabilityAvailable: true, gate: true });
    try {
      const firstPromise = execute(fixture.paths, overlayArguments(fixture.source), runner);
      await runner.started;
      const contender = await execute(fixture.paths, [
        "edit", "rec_example001", "cut", "--from", "4s", "--to", "5s", "--json",
      ]);
      expect(contender.exitCode).toBe(EXIT_CODE.conflict);
      expect(JSON.parse(contender.stderr)).toMatchObject({
        error: { code: "conflict", details: { command: "edit:overlay-add" } },
      });

      runner.release();
      expect((await firstPromise).exitCode).toBe(0);
      const afterFirst = await loadEditPlan(
        createNodeBundleFileSystem(fixture.recordingDirectory),
        CURRENT_EDIT_PLAN_PATH,
      );
      expect(afterFirst.overlays).toHaveLength(1);
      expect(afterFirst.keep).toEqual([{ endUs: 10_000_000, startUs: 0 }]);

      expect((await execute(fixture.paths, [
        "edit", "rec_example001", "cut", "--from", "4s", "--to", "5s", "--json",
      ])).exitCode).toBe(0);
      const afterRetry = await loadEditPlan(
        createNodeBundleFileSystem(fixture.recordingDirectory),
        CURRENT_EDIT_PLAN_PATH,
      );
      expect(afterRetry.overlays).toHaveLength(1);
      expect(afterRetry.keep).toEqual([
        { endUs: 4_000_000, startUs: 0 },
        { endUs: 10_000_000, startUs: 5_000_000 },
      ]);
    } finally {
      runner.release();
      await rm(fixture.root, { force: true, recursive: true });
    }
  });

  test("finishes rollback before a competing asset reuse can commit", async () => {
    const fixture = await recordingFixture();
    const failingRunner = new OverlayRunner({ capabilityAvailable: false, gate: true });
    try {
      const failingPromise = execute(fixture.paths, overlayArguments(fixture.source), failingRunner);
      await failingRunner.started;
      expect(await readdir(join(fixture.recordingDirectory, "assets"))).toHaveLength(1);

      const contender = await execute(fixture.paths, overlayArguments(fixture.source));
      expect(contender.exitCode).toBe(EXIT_CODE.conflict);
      failingRunner.release();
      expect((await failingPromise).exitCode).toBe(EXIT_CODE.unavailable);
      expect(await readdir(join(fixture.recordingDirectory, "assets"))).toEqual([]);

      expect((await execute(fixture.paths, overlayArguments(fixture.source))).exitCode).toBe(0);
      const plan = await loadEditPlan(
        createNodeBundleFileSystem(fixture.recordingDirectory),
        CURRENT_EDIT_PLAN_PATH,
      );
      expect(plan.overlays).toHaveLength(1);
      expect(Array.from(await readFile(join(fixture.recordingDirectory, plan.overlays[0]!.source.asset.path))))
        .toEqual(Array.from(PNG_SIGNATURE));
    } finally {
      failingRunner.release();
      await rm(fixture.root, { force: true, recursive: true });
    }
  });

  test("publishes only a complete owner and cleans proven-abandoned acquisition temps", async () => {
    const directory = await mkdtemp(join(tmpdir(), "atet-published-lock-"));
    const abandonedName = `${MUTATION_LOCK_TEMP_PREFIX}00000000-0000-4000-8000-000000000099.tmp`;
    const abandoned = join(directory, abandonedName);
    try {
      await writeFile(abandoned, "partial", { mode: 0o600 });
      const future = new Date(Date.now() + 60_000);
      await withMutationLock(directory, {
        command: "edit:cut",
        label: "recording rec_publish",
        legacyArtifactOpenState: () => Promise.resolve("closed"),
        now: () => future,
        staleAfterMs: 1_000,
      }, async () => {
        const contents = await readFile(join(directory, MUTATION_LOCK_FILE), "utf8");
        expect(contents.length).toBeGreaterThan(0);
        expect(JSON.parse(contents)).toMatchObject({
          command: "edit:cut",
          pid: process.pid,
          schemaVersion: 1,
        });
        expect(await readdir(directory)).not.toContain(abandonedName);
      });
      expect(await readdir(directory)).toEqual([]);
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });

  test("recovers old zero-byte and partial legacy acquisition artifacts only when proven unheld", async () => {
    for (const [name, contents] of [["empty", ""], ["partial", "{\"acquiredAt\":"]] as const) {
      const directory = await mkdtemp(join(tmpdir(), `atet-${name}-legacy-lock-`));
      try {
        await writeFile(join(directory, MUTATION_LOCK_FILE), contents, { mode: 0o600 });
        let entered = false;
        await withMutationLock(directory, {
          command: "edit:trim",
          label: `recording rec_${name}`,
          legacyArtifactOpenState: () => Promise.resolve("closed"),
          now: () => new Date(Date.now() + 60_000),
          staleAfterMs: 1_000,
        }, () => {
          entered = true;
          return Promise.resolve();
        });
        expect(entered).toBe(true);
        expect(await readdir(directory)).toEqual([]);
      } finally {
        await rm(directory, { force: true, recursive: true });
      }
    }
  });

  test("keeps an old partial owner fail-closed when it may still be open", async () => {
    const directory = await mkdtemp(join(tmpdir(), "atet-open-partial-lock-"));
    const path = join(directory, MUTATION_LOCK_FILE);
    const contents = "{\"acquiredAt\":";
    try {
      await writeFile(path, contents, { mode: 0o600 });
      const failure = await rejected(withMutationLock(directory, {
        command: "edit:trim",
        label: "recording rec_partial",
        legacyArtifactOpenState: () => Promise.resolve("open"),
        now: () => new Date(Date.now() + 60_000),
        staleAfterMs: 1_000,
      }, () => Promise.resolve()));
      expect(failure).toMatchObject({ code: "conflict" });
      expect(await readFile(path, "utf8")).toBe(contents);
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });

  test("keeps symlink and non-file lock artifacts fail-closed", async () => {
    const directory = await mkdtemp(join(tmpdir(), "atet-unsafe-lock-"));
    const path = join(directory, MUTATION_LOCK_FILE);
    const target = join(directory, "target");
    const options = {
      command: "edit:cut",
      label: "recording rec_unsafe",
      legacyArtifactOpenState: () => Promise.resolve("closed" as const),
      now: () => new Date(Date.now() + 60_000),
      staleAfterMs: 1_000,
    };
    try {
      await writeFile(target, "", { mode: 0o600 });
      await symlink(target, path);
      expect(await rejected(withMutationLock(directory, options, () => Promise.resolve())))
        .toMatchObject({ code: "conflict" });
      expect((await lstat(path)).isSymbolicLink()).toBe(true);

      await rm(path);
      await mkdir(path);
      expect(await rejected(withMutationLock(directory, options, () => Promise.resolve())))
        .toMatchObject({ code: "conflict" });
      expect((await lstat(path)).isDirectory()).toBe(true);
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });

  test("reclaims only an old same-host owner that is proven dead", async () => {
    const directory = await mkdtemp(join(tmpdir(), "atet-stale-lock-"));
    try {
      await writeFile(join(directory, MUTATION_LOCK_FILE), `${JSON.stringify({
        acquiredAt: "2026-07-22T17:00:00.000Z",
        command: "edit:cut",
        hostname: hostname(),
        pid: 999_999,
        schemaVersion: 1,
        token: "00000000-0000-4000-8000-000000000001",
      })}\n`, { mode: 0o600 });
      let entered = false;
      await withMutationLock(directory, {
        command: "edit:trim",
        label: "recording rec_stale",
        now: () => NOW,
        processAlive: () => false,
        staleAfterMs: 1_000,
      }, () => {
        entered = true;
        return Promise.resolve();
      });
      expect(entered).toBe(true);
      expect(await readdir(directory)).not.toContain(MUTATION_LOCK_FILE);
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });

  test("never reclaims a live owner merely because the operation is long", async () => {
    const directory = await mkdtemp(join(tmpdir(), "atet-live-lock-"));
    const lockPath = join(directory, MUTATION_LOCK_FILE);
    try {
      const contents = `${JSON.stringify({
        acquiredAt: "2026-07-22T17:00:00.000Z",
        command: "project-render:run",
        hostname: hostname(),
        pid: process.pid,
        schemaVersion: 1,
        token: "00000000-0000-4000-8000-000000000002",
      })}\n`;
      await writeFile(lockPath, contents, { mode: 0o600 });
      let failure: unknown;
      try {
        await withMutationLock(directory, {
          command: "project-edit:cut",
          label: "project project_live",
          now: () => NOW,
          processAlive: () => true,
          staleAfterMs: 1_000,
        }, () => Promise.resolve());
      } catch (error) {
        failure = error;
      }
      expect(failure).toBeInstanceOf(CliError);
      expect((failure as CliError).code).toBe("conflict");
      expect(await readFile(lockPath, "utf8")).toBe(contents);
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });
});
