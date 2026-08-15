import { describe, expect, test } from "bun:test";
import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { RepositoryPaths } from "./paths";
import { BunProcessRunner, type CliIo, type ProcessRunner } from "./io";
import {
  createOperationProjectFixture,
} from "../application/operations/test-support";
import { loadProjectEditPlan } from "../core";
import { createCliTestRunner } from "./run-cli-test-helper";

function testIo(
  root: string,
  now = new Date("2026-07-23T12:00:00.000Z"),
) {
  let stdout = "";
  let stderr = "";
  const io: CliIo = {
    cwd: () => root,
    env: {},
    now: () => now,
    platform: process.platform,
    stderr: value => { stderr += value; },
    stdout: value => { stdout += value; },
  };
  return {
    io,
    stderr: () => stderr,
    stdout: () => stdout,
  };
}

class WorkflowTestRunner implements ProcessRunner {
  readonly #delegate = new BunProcessRunner();

  run(
    argv: readonly [string, ...string[]],
    options?: Parameters<ProcessRunner["run"]>[1],
  ) {
    if (
      argv[0]
      === "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
    ) {
      return Promise.resolve({
        exitCode: 1,
        stderr: "HTML browser is intentionally unavailable in this fixture.",
        stdout: "",
      });
    }
    return this.#delegate.run(argv, options);
  }
}

async function repositoryFixture(): Promise<{
  readonly paths: RepositoryPaths;
  readonly root: string;
}> {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), "atet-workflow-cli-")),
  );
  const paths: RepositoryPaths = {
    artifactRoot: join(root, "artifacts", "atet"),
    desktopRoot: join(root, "desktop"),
    privateRoot: join(root, ".atet"),
    projectRoot: join(root, "projects", "atet"),
    repositoryRoot: root,
  };
  await Promise.all([
    mkdir(paths.artifactRoot, { mode: 0o700, recursive: true }),
    mkdir(paths.desktopRoot, { mode: 0o700, recursive: true }),
    mkdir(paths.projectRoot, { mode: 0o700, recursive: true }),
  ]);
  return { paths, root };
}

const PURE_WORKFLOW = `import { z } from "zod";
import { defineWorkflow } from "@hraness/atet/local/code";

export default defineWorkflow({
  id: "pure-edit-batch",
  inputSchema: z.strictObject({
    endUs: z.number().int().positive(),
    startUs: z.number().int().nonnegative(),
  }),
  inputSchemaId: "studio.workflow.pure-edit-batch.input/v1",
  version: 1,
  build(workflow, input) {
    const batch = workflow.edits.batch("batch", {
      ordered: [{
        kind: "cut",
        range: { endUs: input.endUs, startUs: input.startUs },
      }],
    });
    return { batch };
  },
});
`;

const PROJECT_EDIT_WORKFLOW = `import { z } from "zod";
import { defineWorkflow } from "@hraness/atet/local/code";

export default defineWorkflow({
  id: "checked-project-cut",
  inputSchema: z.strictObject({
    project: z.string().regex(/^project_[A-Za-z0-9][A-Za-z0-9_-]*$/u),
  }),
  inputSchemaId: "studio.workflow.checked-project-cut.input/v1",
  version: 1,
  build(workflow, input) {
    const project = workflow.project.snapshot("project", input.project);
    const batch = workflow.edits.batch("batch", {
      ordered: [{
        kind: "cut",
        range: { endUs: 2_000_000, startUs: 1_000_000 },
      }],
    });
    const committed = workflow.project.commitEdits("commit", {
      batch,
      project,
    });
    return { commit: committed.receipt };
  },
});
`;

const TYPE_INVALID_WORKFLOW = `import { z } from "zod";
import { defineWorkflow } from "@hraness/atet/local/code";

export default defineWorkflow({
  id: "type-invalid-recording",
  inputSchema: z.strictObject({}),
  inputSchemaId: "studio.workflow.type-invalid-recording.input/v1",
  version: 1,
  build(workflow) {
    return {
      recording: workflow.recording.start("start", {
        camera: { kind: "default" },
        displays: { kind: "all" },
        microphone: "yes",
        strictInputs: true,
        systemAudio: true,
        typedText: false,
      }),
    };
  },
});
`;

const COMPUTE_WORKFLOW = `import { z } from "zod";
import { defineCompute, defineWorkflow } from "@hraness/atet/local/code";

const double = defineCompute({
  key: "example.double",
  inputSchema: z.strictObject({ value: z.number().int() }),
  inputSchemaId: "example.double.input/v1",
  outputSchema: z.strictObject({ value: z.number().int() }),
  outputSchemaId: "example.double.output/v1",
  run(input) {
    return { value: input.value * 2 };
  },
});

export default defineWorkflow({
  id: "trusted-compute",
  inputSchema: z.strictObject({ value: z.number().int() }),
  inputSchemaId: "studio.workflow.trusted-compute.input/v1",
  version: 1,
  build(workflow, input) {
    return {
      doubled: workflow.compute("double", double, { value: input.value }),
    };
  },
});
`;

function interruptedComputeWorkflow(marker: string): string {
  return `import { appendFileSync } from "node:fs";
import { z } from "zod";
import { defineCompute, defineWorkflow } from "@hraness/atet/local/code";

appendFileSync(
  ${JSON.stringify(marker)},
  JSON.stringify({ kind: "load", pid: process.pid }) + "\\n",
);
const recover = defineCompute({
  key: "example.recover",
  inputSchema: z.strictObject({ value: z.number().int() }),
  inputSchemaId: "example.recover.input/v1",
  maxDurationMs: 120_000,
  outputSchema: z.strictObject({ value: z.number().int() }),
  outputSchemaId: "example.recover.output/v1",
  run(input, context) {
    if (!context.replayAcknowledged) process.exit(47);
    return { value: input.value + 1 };
  },
});

export default defineWorkflow({
  id: "interrupted-compute",
  inputSchema: z.strictObject({ value: z.number().int() }),
  inputSchemaId: "studio.workflow.interrupted-compute.input/v1",
  version: 1,
  build(workflow, input) {
    return {
      recovered: workflow.compute("recover", recover, { value: input.value }),
    };
  },
});
`;
}

function parallelComputeWorkflow(marker: string): string {
  return `import { appendFileSync } from "node:fs";
import { z } from "zod";
import { defineCompute, defineWorkflow } from "@hraness/atet/local/code";

const marker = ${JSON.stringify(marker)};
appendFileSync(marker, JSON.stringify({ kind: "load", pid: process.pid }) + "\\n");
const delayed = defineCompute({
  key: "example.parallel",
  inputSchema: z.strictObject({ id: z.string() }),
  inputSchemaId: "example.parallel.input/v1",
  outputSchema: z.strictObject({ id: z.string() }),
  outputSchemaId: "example.parallel.output/v1",
  async run(input) {
    appendFileSync(marker, JSON.stringify({ id: input.id, kind: "start" }) + "\\n");
    await Bun.sleep(1_000);
    appendFileSync(marker, JSON.stringify({ id: input.id, kind: "end" }) + "\\n");
    return { id: input.id };
  },
});

export default defineWorkflow({
  id: "parallel-compute",
  inputSchema: z.strictObject({}),
  inputSchemaId: "studio.workflow.parallel-compute.input/v1",
  version: 1,
  build(workflow) {
    appendFileSync(marker, JSON.stringify({ kind: "build", pid: process.pid }) + "\\n");
    return {
      a: workflow.compute("a", delayed, { id: "a" }),
      b: workflow.compute("b", delayed, { id: "b" }),
      c: workflow.compute("c", delayed, { id: "c" }),
      d: workflow.compute("d", delayed, { id: "d" }),
    };
  },
});
`;
}

describe("workflow CLI", () => {
  test("discovers operations and initializes source without overwriting", async () => {
    const runCli = createCliTestRunner(import.meta.url, 1);
    const fixture = await repositoryFixture();
    try {
      const discovery = testIo(fixture.root);
      expect(await runCli(
        ["operations", "list", "--json"],
        { io: discovery.io, paths: fixture.paths },
      )).toBe(0);
      const parsed = JSON.parse(discovery.stdout()) as {
        readonly operations: readonly { readonly kind: string }[];
      };
      expect(parsed.operations.some(operation => (
        operation.kind === "derive.edit-batch"
      ))).toBe(true);

      const ambiguousOperation = testIo(fixture.root);
      expect(await runCli(
        ["operations", "show", "derive.edit-batch", "--json"],
        { io: ambiguousOperation.io, paths: fixture.paths },
      )).toBe(4);
      expect(ambiguousOperation.stderr()).toContain("<kind>@<version>");

      const operationDescription = testIo(fixture.root);
      expect(await runCli(
        ["operations", "show", "derive.edit-batch@1", "--json"],
        { io: operationDescription.io, paths: fixture.paths },
      )).toBe(0);
      expect(JSON.parse(operationDescription.stdout())).toMatchObject({
        inputJsonSchema: {
          $id: "atet.operation.derive.edit-batch.input/v1",
          additionalProperties: false,
          type: "object",
        },
        kind: "derive.edit-batch",
        outputJsonSchema: {
          $id: "atet.operation.derive.edit-batch.output/v1",
          additionalProperties: false,
          type: "object",
        },
      });

      const completeOperationDescription = testIo(fixture.root);
      expect(await runCli(
        ["operations", "show", "derive.edit-batch@2", "--json"],
        { io: completeOperationDescription.io, paths: fixture.paths },
      )).toBe(0);
      expect(JSON.parse(completeOperationDescription.stdout())).toMatchObject({
        inputJsonSchema: {
          $id: "atet.operation.derive.edit-batch.input/v2",
          additionalProperties: false,
          type: "object",
        },
        kind: "derive.edit-batch",
        outputJsonSchema: {
          $id: "atet.operation.derive.edit-batch.output/v2",
          additionalProperties: false,
          type: "object",
        },
        version: 2,
      });

      const workflowDescription = testIo(fixture.root);
      expect(await runCli(
        ["workflows", "show", "polished-screen-demo", "--json"],
        { io: workflowDescription.io, paths: fixture.paths },
      )).toBe(0);
      expect(JSON.parse(workflowDescription.stdout())).toMatchObject({
        id: "polished-screen-demo",
        inputJsonSchema: {
          $id: "atet.workflow.polished-screen-demo.input/v4",
          additionalProperties: false,
          type: "object",
        },
      });

      const initialized = testIo(fixture.root);
      expect(await runCli(
        ["code", "init", "automation/clean-demo.ts"],
        { io: initialized.io, paths: fixture.paths },
      )).toBe(0);
      const initializedSource = await readFile(
        join(fixture.root, "automation", "clean-demo.ts"),
        "utf8",
      );
      expect(initializedSource).toContain("defineWorkflow");
      expect(initializedSource).toContain(
        'inputSchemaId: "atet.workflow.clean-demo.input/v1"',
      );
      expect(initializedSource).toContain("workflow.project.freezeRevision");
      expect(initializedSource).toContain("workflow.render.plan");
      expect(initializedSource).toContain("workflow.render.project");
      expect(initializedSource).toContain("}).prefault({});");
      expect(initializedSource).toContain("require-verified");
      expect(initializedSource).not.toContain("{ project }");

      const checked = testIo(fixture.root);
      expect(await runCli(
        ["code", "check", "automation/clean-demo.ts", "--json"],
        { io: checked.io, paths: fixture.paths },
      )).toBe(0);

      const repeated = testIo(fixture.root);
      expect(await runCli(
        ["code", "init", "automation/clean-demo.ts"],
        { io: repeated.io, paths: fixture.paths },
      )).toBe(4);
      expect(repeated.stderr()).toContain("never overwrites");
    } finally {
      await rm(fixture.root, { force: true, recursive: true });
    }
  }, 30_000);

  test("rejects repository JSON paths that cross a symlink", async () => {
    const runCli = createCliTestRunner(import.meta.url, 2);
    const fixture = await repositoryFixture();
    const outside = await mkdtemp(join(tmpdir(), "atet-workflow-outside-"));
    try {
      await writeFile(join(outside, "input.json"), "{}\n");
      await symlink(outside, join(fixture.root, "linked"));
      const output = testIo(fixture.root);
      expect(await runCli([
        "workflows", "plan", "chaptered-demo",
        "--input", "linked/input.json",
      ], {
        io: output.io,
        paths: fixture.paths,
      })).toBe(6);
      expect(output.stderr()).toContain("symbolic link");
    } finally {
      await Promise.all([
        rm(fixture.root, { force: true, recursive: true }),
        rm(outside, { force: true, recursive: true }),
      ]);
    }
  }, 30_000);

  test("semantic-checks custom source before check or plan can succeed", async () => {
    const runCli = createCliTestRunner(import.meta.url, 3);
    const fixture = await repositoryFixture();
    try {
      await writeFile(join(fixture.root, "invalid.ts"), TYPE_INVALID_WORKFLOW);
      await writeFile(join(fixture.root, "input.json"), "{}\n");

      for (const command of [
        ["code", "check", "invalid.ts", "--json"],
        ["code", "plan", "invalid.ts", "--input", "input.json", "--json"],
      ]) {
        const output = testIo(fixture.root);
        expect(await runCli(command, {
          io: output.io,
          paths: fixture.paths,
        })).toBe(7);
        expect(output.stderr()).toContain("Workflow TypeScript check failed");
        expect(output.stderr()).toContain("microphone");
      }
    } finally {
      await rm(fixture.root, { force: true, recursive: true });
    }
  }, 30_000);

  test("plans and durably executes a pure custom workflow", async () => {
    const runCli = createCliTestRunner(import.meta.url, 4);
    const fixture = await repositoryFixture();
    try {
      await writeFile(join(fixture.root, "workflow.ts"), PURE_WORKFLOW);
      await writeFile(
        join(fixture.root, "input.json"),
        "{\"endUs\":2000000,\"startUs\":1000000}\n",
      );
      const output = testIo(fixture.root);
      const exitCode = await runCli([
        "code", "run", "workflow.ts",
        "--input", "input.json",
        "--jobs", "4",
        "--json",
      ], {
        io: output.io,
        paths: fixture.paths,
      });
      if (exitCode !== 0) {
        throw new Error(`Code workflow failed (${String(exitCode)}): ${output.stderr()}`);
      }
      expect(output.stderr()).toBe("");
      const result = JSON.parse(output.stdout()) as {
        readonly summary: {
          readonly counts: { readonly completed: number };
          readonly runId: string;
          readonly status: string;
        };
      };
      if (result.summary.status !== "completed") {
        throw new Error(`Project workflow did not complete: ${output.stdout()}`);
      }
      expect(result.summary.status).toBe("completed");
      expect(result.summary.counts.completed).toBe(1);

      const shown = testIo(fixture.root);
      expect(await runCli([
        "runs", "show", result.summary.runId, "--nodes", "all", "--json",
      ], {
        io: shown.io,
        paths: fixture.paths,
      })).toBe(0);
      const details = JSON.parse(shown.stdout()) as {
        readonly nodes: readonly { readonly status: string }[];
        readonly outputs: {
          readonly batch: { readonly ordered: readonly unknown[] };
        };
      };
      expect(details.nodes).toHaveLength(1);
      expect(details.nodes[0]?.status).toBe("completed");
      expect(details.outputs.batch.ordered).toHaveLength(1);
    } finally {
      await rm(fixture.root, { force: true, recursive: true });
    }
  }, 60_000);

  test("executes a schema-bound trusted compute callback in the retained worker", async () => {
    const runCli = createCliTestRunner(import.meta.url, 5);
    const fixture = await repositoryFixture();
    try {
      await writeFile(join(fixture.root, "compute.ts"), COMPUTE_WORKFLOW);
      await writeFile(join(fixture.root, "compute-input.json"), "{\"value\":21}\n");
      const output = testIo(fixture.root);
      const exitCode = await runCli([
        "code", "run", "compute.ts",
        "--input", "compute-input.json",
        "--json",
      ], {
        io: output.io,
        paths: fixture.paths,
      });
      if (exitCode !== 0) {
        throw new Error(
          `Trusted compute workflow failed (${String(exitCode)}): ${output.stderr()}`,
        );
      }
      const result = JSON.parse(output.stdout()) as {
        readonly summary: {
          readonly outputs: { readonly doubled: { readonly value: number } };
          readonly status: string;
        };
      };
      expect(result.summary.status).toBe("completed");
      expect(result.summary.outputs.doubled.value).toBe(42);
    } finally {
      await rm(fixture.root, { force: true, recursive: true });
    }
  }, 60_000);

  test("--jobs bounds a verified worker pool while independent compute nodes overlap", async () => {
    const runCli = createCliTestRunner(import.meta.url, 6);
    const fixture = await repositoryFixture();
    try {
      const marker = join(fixture.root, "parallel-events.jsonl");
      await writeFile(
        join(fixture.root, "parallel-compute.ts"),
        parallelComputeWorkflow(marker),
      );
      await writeFile(join(fixture.root, "parallel-input.json"), "{}\n");
      const output = testIo(fixture.root);
      const exitCode = await runCli([
        "code", "run", "parallel-compute.ts",
        "--input", "parallel-input.json",
        "--jobs", "2",
        "--json",
      ], {
        io: output.io,
        paths: fixture.paths,
      });
      if (exitCode !== 0) {
        throw new Error(
          `Parallel compute workflow failed (${String(exitCode)}): ${output.stderr()}`,
        );
      }
      expect(JSON.parse(output.stdout())).toMatchObject({
        summary: {
          counts: { completed: 4 },
          status: "completed",
        },
      });
      const events = (await readFile(marker, "utf8"))
        .trim()
        .split("\n")
        .map(line => JSON.parse(line) as { readonly kind: string });
      expect(events.filter(event => event.kind === "load")).toHaveLength(2);
      expect(events.filter(event => event.kind === "build")).toHaveLength(2);
      let active = 0;
      let maximumActive = 0;
      for (const event of events) {
        if (event.kind === "start") {
          active += 1;
          maximumActive = Math.max(maximumActive, active);
        } else if (event.kind === "end") {
          active -= 1;
        }
        expect(active).toBeLessThanOrEqual(2);
      }
      expect(active).toBe(0);
      expect(maximumActive).toBe(2);
    } finally {
      await rm(fixture.root, { force: true, recursive: true });
    }
  }, 60_000);

  test("loads persisted code only for an exact explicitly replayed compute node", async () => {
    const runCli = createCliTestRunner(import.meta.url, 7);
    const fixture = await repositoryFixture();
    const runner = new WorkflowTestRunner();
    try {
      const loadMarker = join(fixture.root, "interrupted-loads.jsonl");
      await writeFile(
        join(fixture.root, "interrupted-compute.ts"),
        interruptedComputeWorkflow(loadMarker),
      );
      await writeFile(
        join(fixture.root, "interrupted-compute-input.json"),
        "{\"value\":9}\n",
      );
      const initial = testIo(fixture.root);
      expect(await runCli([
        "code", "run", "interrupted-compute.ts",
        "--input", "interrupted-compute-input.json",
        "--json",
      ], {
        io: initial.io,
        paths: fixture.paths,
        runner,
      })).toBe(0);
      const interrupted = JSON.parse(initial.stdout()) as {
        readonly summary: {
          readonly runId: string;
          readonly status: string;
        };
      };
      expect(interrupted.summary.status).toBe("ambiguous-code");
      expect((await readFile(loadMarker, "utf8")).trim().split("\n")).toHaveLength(1);

      const shown = testIo(fixture.root);
      expect(await runCli([
        "runs", "show", interrupted.summary.runId, "--nodes", "all",
      ], {
        io: shown.io,
        paths: fixture.paths,
      })).toBe(0);
      expect(shown.stdout()).toContain(
        `atet runs resume ${interrupted.summary.runId} --replay-ambiguous-code recover`,
      );

      const ordinary = testIo(fixture.root);
      expect(await runCli([
        "runs", "resume", interrupted.summary.runId, "--json",
      ], {
        io: ordinary.io,
        paths: fixture.paths,
        runner,
      })).toBe(0);
      expect(JSON.parse(ordinary.stdout())).toMatchObject({
        summary: { status: "ambiguous-code" },
      });
      expect((await readFile(loadMarker, "utf8")).trim().split("\n")).toHaveLength(1);

      const replay = testIo(fixture.root);
      const replayExitCode = await runCli([
        "runs", "resume", interrupted.summary.runId,
        "--replay-ambiguous-code", "recover",
        "--json",
      ], {
        io: replay.io,
        paths: fixture.paths,
        runner,
      });
      if (replayExitCode !== 0) {
        throw new Error(
          `Persisted compute replay failed (${String(replayExitCode)}): ${replay.stderr()}`,
        );
      }
      expect(JSON.parse(replay.stdout())).toMatchObject({
        summary: {
          outputs: { recovered: { value: 10 } },
          status: "completed",
        },
      });
      expect((await readFile(loadMarker, "utf8")).trim().split("\n")).toHaveLength(2);
    } finally {
      await rm(fixture.root, { force: true, recursive: true });
    }
  }, 180_000);

  test("executes a generation-checked project commit under the shared physical lease", async () => {
    const runCli = createCliTestRunner(import.meta.url, 8);
    const fixture = await repositoryFixture();
    try {
      const project = await createOperationProjectFixture(fixture.root);
      const paths = {
        ...fixture.paths,
        projectRoot: project.projectRoot,
      };
      await writeFile(
        join(fixture.root, "project-cut.ts"),
        PROJECT_EDIT_WORKFLOW,
      );
      await writeFile(
        join(fixture.root, "project-input.json"),
        `${JSON.stringify({ project: project.project.projectId })}\n`,
      );
      const output = testIo(
        fixture.root,
        new Date("2026-07-24T12:00:00.000Z"),
      );
      const exitCode = await runCli([
        "code", "run", "project-cut.ts",
        "--input", "project-input.json",
        "--json",
      ], {
        io: output.io,
        paths,
      });
      if (exitCode !== 0) {
        throw new Error(
          `Project workflow failed (${String(exitCode)}): ${output.stderr()}`,
        );
      }
      const result = JSON.parse(output.stdout()) as {
        readonly summary: {
          readonly counts: { readonly completed: number };
          readonly runId: string;
          readonly status: string;
        };
      };
      if (result.summary.status !== "completed") {
        const details = testIo(fixture.root);
        await runCli([
          "runs", "show", result.summary.runId, "--nodes", "all", "--json",
        ], { io: details.io, paths });
        throw new Error(
          `Project workflow did not complete: ${details.stdout()}`,
        );
      }
      expect(result.summary.status).toBe("completed");
      expect(result.summary.counts.completed).toBe(3);
      expect((await loadProjectEditPlan(project.fileSystem)).keep).toEqual([
        { endUs: 1_000_000, startUs: 0 },
        { endUs: 10_000_000, startUs: 2_000_000 },
      ]);
    } finally {
      await rm(fixture.root, { force: true, recursive: true });
    }
  }, 180_000);
});
