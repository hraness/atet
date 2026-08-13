import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import {
  ProjectRenderPlanV1Schema,
  ProjectRenderReceiptV1Schema,
  RecordingManifestV1Schema,
} from "../contracts";
import {
  canonicalJson,
  createNodeBundleFileSystem,
  saveRecordingManifest,
  sha256Hex,
} from "../core";
import { testManifest } from "../core/test-support";
import { openRecording } from "./bundle-service";
import type { CliIo, ProcessRunner } from "./io";
import type { RepositoryPaths } from "./paths";
import { createProjectFromRecording } from "./project-service";
import { createCliTestRunner } from "./run-cli-test-helper";

const runCli = createCliTestRunner(import.meta.url);

const NOW = new Date("2026-07-22T16:00:00.000Z");

async function materializeProject(root: string): Promise<{
  readonly directory: string;
  readonly paths: RepositoryPaths;
}> {
  const paths: RepositoryPaths = {
    artifactRoot: join(root, "artifacts", "transmute", "recordings"),
    desktopRoot: join(root, "projects", "transmute", "apps", "desktop"),
    privateRoot: join(root, "artifacts", "transmute", "private"),
    projectRoot: join(root, "artifacts", "transmute", "projects"),
    repositoryRoot: root,
  };
  const recordingDirectory = join(paths.artifactRoot, "rec_example001");
  const input = testManifest();
  const integrityByPath = new Map<string, { readonly bytes: number; readonly sha256: string }>();
  for (const track of input.tracks) {
    for (const segment of track.segments) {
      if (integrityByPath.has(segment.path)) continue;
      const bytes = Buffer.from(`project receipt fixture for ${segment.path}\n`, "utf8");
      const absolute = join(recordingDirectory, segment.path);
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
  await saveRecordingManifest(createNodeBundleFileSystem(recordingDirectory), manifest);
  const recording = await openRecording(paths.artifactRoot, "rec_example001");
  const project = await createProjectFromRecording({
    id: "project_receipt001",
    now: NOW,
    projectRoot: paths.projectRoot,
    recording,
    repositoryRoot: root,
  });
  return { directory: project.directory.path, paths };
}

test("project receipts hash the persisted full plan document while retaining its composition-keyed path", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "transmute-project-render-receipt-")));
  try {
    const fixture = await materializeProject(root);
    const outputRelative = "renders/custom/final.mp4";
    const receiptRelative = `${outputRelative}.plan.json`;
    await mkdir(dirname(join(fixture.directory, receiptRelative)), { recursive: true });
    await writeFile(join(fixture.directory, receiptRelative), "stale receipt");
    const renderedBytes = Buffer.from("new project render", "utf8");
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
      "project", "render", "run", "project_receipt001",
      "--output", outputRelative,
      "--json",
    ], { io, paths: fixture.paths, runner });

    expect({ exitCode, stderr }).toEqual({ exitCode: 0, stderr: "" });
    const commandOutput = JSON.parse(stdout) as {
      readonly output: { readonly bytes: number; readonly sha256: string };
      readonly planPath: string;
      readonly receiptPath: string;
    };
    expect(commandOutput.receiptPath).toBe(receiptRelative);
    const receipt = ProjectRenderReceiptV1Schema.parse(JSON.parse(
      await readFile(join(fixture.directory, receiptRelative), "utf8"),
    ));
    const plan = ProjectRenderPlanV1Schema.parse(JSON.parse(
      await readFile(join(fixture.directory, receipt.plan.path), "utf8"),
    ));
    const fullPlanSha256 = sha256Hex(canonicalJson(plan));
    const outputSha256 = createHash("sha256").update(renderedBytes).digest("hex");

    expect(receipt.plan).toEqual({ path: commandOutput.planPath, sha256: fullPlanSha256 });
    expect(commandOutput.planPath).toBe(`renders/plans/${plan.planSha256}.json`);
    expect(receipt.plan.sha256).not.toBe(plan.planSha256);
    expect(receipt.output).toEqual({
      bytes: renderedBytes.byteLength,
      path: outputRelative,
      sha256: outputSha256,
    });
    expect(commandOutput.output).toEqual({ bytes: renderedBytes.byteLength, sha256: outputSha256 });
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});
