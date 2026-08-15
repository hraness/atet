import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import {
  EditPlanIdSchema,
  RecordingManifestV1Schema,
  RecordingRenderReceiptV1Schema,
  RenderPlanV1Schema,
} from "../contracts";
import {
  canonicalJson,
  createDefaultEditPlan,
  createNodeBundleFileSystem,
  saveEditPlan,
  saveRecordingManifest,
  sha256Hex,
} from "../core";
import { testManifest } from "../core/test-support";
import { CURRENT_EDIT_PLAN_PATH } from "./bundle-service";
import type { CliIo, ProcessRunner } from "./io";
import type { RepositoryPaths } from "./paths";
import { createCliTestRunner } from "./run-cli-test-helper";

const runCli = createCliTestRunner(import.meta.url);

const NOW = new Date("2026-07-22T16:00:00.000Z");
const HASH = "a".repeat(64);

test("recording render receipts reject unknown fields and unverifiable output identities", () => {
  const valid = {
    createdAt: NOW.toISOString(),
    display: { displayId: "display-primary", trackId: "track_display01" },
    kind: "studio.recording-render-receipt",
    output: { bytes: 1, path: "renders/final.mp4", sha256: HASH },
    plan: { path: `renders/resolved-${HASH}.json`, sha256: HASH },
    recordingId: "rec_example001",
    schemaVersion: 1,
  } as const;
  expect(RecordingRenderReceiptV1Schema.safeParse(valid).success).toBe(true);
  expect(() => RecordingRenderReceiptV1Schema.parse({ ...valid, unexpected: true })).toThrow();
  expect(() => RecordingRenderReceiptV1Schema.parse({
    ...valid,
    output: { ...valid.output, bytes: 0 },
  })).toThrow();
  expect(() => RecordingRenderReceiptV1Schema.parse({
    ...valid,
    output: { ...valid.output, path: "../outside.mp4" },
  })).toThrow();
});

async function materializeRecording(root: string): Promise<{
  readonly directory: string;
  readonly paths: RepositoryPaths;
}> {
  const paths: RepositoryPaths = {
    artifactRoot: join(root, "artifacts", "atet", "recordings"),
    desktopRoot: join(root, "projects", "atet", "apps", "desktop"),
    privateRoot: join(root, "artifacts", "atet", "private"),
    projectRoot: join(root, "artifacts", "atet", "projects"),
    repositoryRoot: root,
  };
  const directory = join(paths.artifactRoot, "rec_example001");
  const input = testManifest();
  const integrityByPath = new Map<string, { readonly bytes: number; readonly sha256: string }>();
  for (const track of input.tracks) {
    for (const segment of track.segments) {
      if (integrityByPath.has(segment.path)) continue;
      const bytes = new TextEncoder().encode(`recording receipt fixture for ${segment.path}\n`);
      const absolute = join(directory, segment.path);
      await mkdir(dirname(absolute), { recursive: true });
      await writeFile(absolute, bytes);
      integrityByPath.set(segment.path, {
        bytes: bytes.byteLength,
        sha256: createHash("sha256").update(bytes).digest("hex"),
      });
    }
  }
  const manifest = RecordingManifestV1Schema.parse({
    ...input,
    tracks: input.tracks.map(track => ({
      ...track,
      segments: track.segments.map(segment => ({
        ...segment,
        integrity: { ...integrityByPath.get(segment.path)!, state: "verified" },
      })),
    })),
  });
  const fileSystem = createNodeBundleFileSystem(directory);
  await saveRecordingManifest(fileSystem, manifest);
  await saveEditPlan(
    fileSystem,
    createDefaultEditPlan(manifest, EditPlanIdSchema.parse("plan_receipt001"), NOW.toISOString()),
    CURRENT_EDIT_PLAN_PATH,
  );
  return { directory, paths };
}

test("replaces a stale custom-output receipt with verified output and immutable plan identity", async () => {
  const root = await mkdtemp(join(tmpdir(), "atet-recording-render-receipt-"));
  try {
    const fixture = await materializeRecording(root);
    const outputRelative = "renders/custom/final.mp4";
    const receiptRelative = `${outputRelative}.plan.json`;
    await mkdir(dirname(join(fixture.directory, receiptRelative)), { recursive: true });
    await writeFile(join(fixture.directory, receiptRelative), "stale receipt");
    const renderedBytes = Buffer.from("new recording render", "utf8");
    const runner: ProcessRunner = {
      run: async argv => {
        if (argv.includes("-filter_complex_script")) {
          await writeFile(argv.at(-1)!, renderedBytes);
          return { exitCode: 0, stderr: "", stdout: "" };
        }
        return { exitCode: 0, stderr: "", stdout: "fixture tool 1.0" };
      },
    };
    let stderr = "";
    let stdout = "";
    const io: CliIo = {
      cwd: () => fixture.paths.repositoryRoot,
      env: {},
      now: () => NOW,
      platform: process.platform,
      stderr: value => { stderr += value; },
      stdout: value => { stdout += value; },
    };

    const exitCode = await runCli([
      "render", "run", "rec_example001",
      "--no-auto-inactivity",
      "--output", outputRelative,
      "--json",
    ], { io, paths: fixture.paths, runner });

    expect({ exitCode, stderr }).toEqual({ exitCode: 0, stderr: "" });
    const commandOutput = JSON.parse(stdout) as {
      readonly artifactPath: string;
      readonly output: { readonly bytes: number; readonly sha256: string };
      readonly outputPath: string;
      readonly receiptPath: string;
    };
    expect(commandOutput.outputPath).toBe(outputRelative);
    expect(commandOutput.receiptPath).toBe(receiptRelative);
    const outputBytes = await readFile(join(fixture.directory, outputRelative));
    const expectedOutputSha256 = createHash("sha256").update(renderedBytes).digest("hex");
    expect(outputBytes).toEqual(renderedBytes);
    expect(commandOutput.output).toEqual({ bytes: renderedBytes.byteLength, sha256: expectedOutputSha256 });

    const receipt = RecordingRenderReceiptV1Schema.parse(JSON.parse(
      await readFile(join(fixture.directory, receiptRelative), "utf8"),
    ));
    expect(receipt).toMatchObject({
      createdAt: NOW.toISOString(),
      display: { displayId: "display-primary", trackId: "track_display01" },
      kind: "atet.recording-render-receipt",
      output: {
        bytes: renderedBytes.byteLength,
        path: outputRelative,
        sha256: expectedOutputSha256,
      },
      plan: { path: commandOutput.artifactPath },
      recordingId: "rec_example001",
      schemaVersion: 1,
    });
    expect(commandOutput.artifactPath).toBe(`renders/resolved-${receipt.plan.sha256}.json`);
    const resolvedPlan = RenderPlanV1Schema.parse(JSON.parse(
      await readFile(join(fixture.directory, receipt.plan.path), "utf8"),
    ));
    expect(sha256Hex(canonicalJson(resolvedPlan))).toBe(receipt.plan.sha256);
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

test("recording render dry-runs publish neither output nor receipt", async () => {
  const root = await mkdtemp(join(tmpdir(), "atet-recording-render-dry-run-"));
  try {
    const fixture = await materializeRecording(root);
    const outputRelative = "renders/dry-run.mp4";
    let encoded = false;
    const runner: ProcessRunner = {
      run: argv => {
        if (argv.includes("-filter_complex_script")) encoded = true;
        return Promise.resolve({ exitCode: 0, stderr: "", stdout: "fixture tool 1.0" });
      },
    };
    let stderr = "";
    let stdout = "";
    const io: CliIo = {
      cwd: () => fixture.paths.repositoryRoot,
      env: {},
      now: () => NOW,
      platform: process.platform,
      stderr: value => { stderr += value; },
      stdout: value => { stdout += value; },
    };

    const exitCode = await runCli([
      "render", "run", "rec_example001",
      "--dry-run",
      "--no-auto-inactivity",
      "--output", outputRelative,
      "--json",
    ], { io, paths: fixture.paths, runner });

    expect({ exitCode, stderr }).toEqual({ exitCode: 0, stderr: "" });
    expect((JSON.parse(stdout) as { readonly receiptPath: null }).receiptPath).toBeNull();
    expect(encoded).toBe(false);
    expect(await readFile(join(fixture.directory, outputRelative)).catch(() => null)).toBeNull();
    expect(await readFile(join(fixture.directory, `${outputRelative}.plan.json`)).catch(() => null)).toBeNull();
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});
