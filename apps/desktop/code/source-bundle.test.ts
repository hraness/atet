import { afterEach, describe, expect, test } from "bun:test";
import {
  lstat,
  mkdtemp,
  mkdir,
  readFile,
  realpath,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { createHostResourceCoordinator } from "@hraness/transmute/host-resources";

import {
  bundleWorkflowSource,
  checkAndBundleWorkflowSource,
} from "./source-bundle";
import { workerProcessStartIdentityStatus } from "./worker-process-identity";

const temporaryDirectories: string[] = [];

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "transmute-code-bundle-"));
  temporaryDirectories.push(directory);
  return directory;
}

async function waitForCondition(
  condition: () => Promise<boolean> | boolean,
  label: string,
  timeoutMilliseconds = 5_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMilliseconds;
  while (Date.now() < deadline) {
    if (await condition()) return;
    await Bun.sleep(20);
  }
  throw new Error(`Timed out waiting for ${label}.`);
}

async function missing(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return false;
  } catch (error) {
    if (
      error instanceof Error
      && "code" in error
      && error.code === "ENOENT"
    ) return true;
    throw error;
  }
}

async function rejection(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error("Expected promise to reject.");
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(async directory => {
    await rm(directory, { force: true, recursive: true });
  }));
});

describe("workflow source bundling", () => {
  test.skipIf(process.platform === "win32")(
    "copies its preparation lease into the bundler subprocess",
    async () => {
      const root = await temporaryDirectory();
      await writeFile(
        join(root, "workflow.ts"),
        "export default { value: 1 };\n",
        { mode: 0o600 },
      );
      const coordinator = createHostResourceCoordinator({
        profile: {
          capacities: [{ limit: 1, resource: "cpu" }],
          id: "workflow-bundler-preparation-fd",
        },
        stateRoot: join(root, "host-resources"),
      });
      const bundle = await coordinator.withLease(
        [{ amount: 1, resource: "cpu" }],
        async lease => await bundleWorkflowSource({
          allowedRoot: root,
          entryPath: "workflow.ts",
          inheritedHostResourceFileDescriptor: lease.inheritedFileDescriptor,
        }),
      );
      expect(bundle.bytes.byteLength).toBeGreaterThan(0);
    },
  );

  test("bundles one physical local graph and changes identity with an imported module", async () => {
    const root = await temporaryDirectory();
    await writeFile(join(root, "value.ts"), "export const value = 1;\n", { mode: 0o600 });
    await writeFile(join(root, "workflow.ts"), "import { value } from './value.ts'; export default { value };\n", { mode: 0o600 });
    const first = await bundleWorkflowSource({ allowedRoot: root, entryPath: "workflow.ts" });
    expect(first.importedPaths).toHaveLength(2);
    expect(first.bytes.byteLength).toBeGreaterThan(0);
    expect(first.sha256).toMatch(/^[a-f0-9]{64}$/u);

    await writeFile(join(root, "value.ts"), "export const value = 2;\n", { mode: 0o600 });
    const second = await bundleWorkflowSource({ allowedRoot: root, entryPath: "workflow.ts" });
    expect(second.sha256).not.toBe(first.sha256);
  });

  test("bundles captured bytes even when original modules change after snapshot", async () => {
    const root = await temporaryDirectory();
    const valuePath = join(root, "value.ts");
    await writeFile(valuePath, "export const value = 1;\n", { mode: 0o600 });
    await writeFile(
      join(root, "workflow.ts"),
      "import { value } from './value.ts'; export default { value };\n",
      { mode: 0o600 },
    );
    const baseline = await bundleWorkflowSource({
      allowedRoot: root,
      entryPath: "workflow.ts",
    });
    await writeFile(valuePath, "export const value = 1;\n", { mode: 0o600 });
    const raced = await bundleWorkflowSource({
      afterSourceSnapshot: async () => {
        await writeFile(
          valuePath,
          "import forbidden from 'not-allowed'; export const value = forbidden;\n",
          { mode: 0o600 },
        );
      },
      allowedRoot: root,
      entryPath: "workflow.ts",
    });
    expect(raced.sha256).toBe(baseline.sha256);
    expect(raced.dependencyGraphSha256).toBe(
      baseline.dependencyGraphSha256,
    );
    expect(raced.sourceSha256).toBe(baseline.sourceSha256);
    expect(new TextDecoder().decode(raced.bytes)).not.toContain("not-allowed");
  });

  test.skipIf(process.platform === "win32")(
    "rejects a source path replaced after its descriptor is pinned",
    async () => {
      const root = await temporaryDirectory();
      const valuePath = join(root, "value.ts");
      const replacementPath = join(root, "replacement.ts");
      await writeFile(valuePath, "export const value = 1;\n", { mode: 0o600 });
      await writeFile(replacementPath, "export const value = 2;\n", { mode: 0o600 });
      await writeFile(
        join(root, "workflow.ts"),
        "import { value } from './value.ts'; export default { value };\n",
        { mode: 0o600 },
      );

      const physicalValuePath = await realpath(valuePath);
      let replaced = false;
      expect(
        bundleWorkflowSource({
          afterSourceFileOpened: async sourcePath => {
            if (sourcePath !== physicalValuePath || replaced) return;
            replaced = true;
            await rename(replacementPath, valuePath);
          },
          allowedRoot: root,
          entryPath: "workflow.ts",
        }),
      ).rejects.toThrow("changed while its exact bytes were being captured");
      expect(replaced).toBe(true);
    },
  );

  test.skipIf(process.platform === "win32")(
    "rejects a source path replaced by a FIFO without blocking on open",
    async () => {
      const root = await temporaryDirectory();
      const valuePath = join(root, "value.ts");
      const originalPath = join(root, "value.original.ts");
      const fifoPath = join(root, "value.fifo");
      await writeFile(valuePath, "export const value = 1;\n", { mode: 0o600 });
      await writeFile(
        join(root, "workflow.ts"),
        "import { value } from './value.ts'; export default { value };\n",
        { mode: 0o600 },
      );
      const mkfifo = Bun.spawn(["mkfifo", fifoPath], {
        stderr: "pipe",
        stdout: "ignore",
      });
      expect(await mkfifo.exited).toBe(0);

      const physicalValuePath = await realpath(valuePath);
      let replaced = false;
      expect(
        bundleWorkflowSource({
          allowedRoot: root,
          beforeSourceFileOpened: async sourcePath => {
            if (sourcePath !== physicalValuePath || replaced) return;
            replaced = true;
            await rename(valuePath, originalPath);
            await rename(fifoPath, valuePath);
          },
          entryPath: "workflow.ts",
        }),
      ).rejects.toThrow("changed while its exact bytes were being captured");
      expect(replaced).toBe(true);
    },
    5_000,
  );

  test("rejects oversized source and bundle files before reading their bytes", async () => {
    const root = await temporaryDirectory();
    const source = "export default { value: 1 };\n";
    await writeFile(join(root, "workflow.ts"), source, { mode: 0o600 });

    expect(
      bundleWorkflowSource({
        allowedRoot: root,
        entryPath: "workflow.ts",
        maximumSourceBytes: Buffer.byteLength(source) - 1,
      }),
    ).rejects.toThrow(/Workflow module exceeds \d+ bytes/u);

    expect(
      bundleWorkflowSource({
        allowedRoot: root,
        entryPath: "workflow.ts",
        maximumBundleBytes: 1,
      }),
    ).rejects.toThrow("Workflow bundle exceeds 1 bytes");
  });

  test("rejects an aggregate source graph before reading another individually bounded module", async () => {
    const root = await temporaryDirectory();
    const moduleSource = "export const value = 1;\n";
    const moduleNames = Array.from({ length: 8 }, (_, index) => `value-${String(index)}.ts`);
    await Promise.all(moduleNames.map(async name => {
      await writeFile(join(root, name), moduleSource, { mode: 0o600 });
    }));
    const entrySource = moduleNames
      .map((name, index) => `import { value as value${String(index)} } from "./${name}";`)
      .join("\n")
      + "\nexport default true;\n";
    await writeFile(join(root, "workflow.ts"), entrySource, { mode: 0o600 });

    const opened: string[] = [];
    expect(
      bundleWorkflowSource({
        afterSourceFileOpened: sourcePath => {
          opened.push(sourcePath);
        },
        allowedRoot: root,
        entryPath: "workflow.ts",
        maximumSourceBytes: Buffer.byteLength(entrySource),
        maximumTotalSourceBytes:
          Buffer.byteLength(entrySource) + Buffer.byteLength(moduleSource) * 3,
      }),
    ).rejects.toThrow(/Workflow source exceeds \d+ total bytes/u);
    expect(opened).toHaveLength(4);
  });

  test("bounds aggregate import work and counts duplicate edges before resolution", async () => {
    const root = await temporaryDirectory();
    await writeFile(
      join(root, "workflow.ts"),
      'import "./middle.ts"; export default true;\n',
      { mode: 0o600 },
    );
    await writeFile(
      join(root, "middle.ts"),
      'import "./missing.ts"; import "./missing.ts"; export const value = 1;\n',
      { mode: 0o600 },
    );

    expect(
      bundleWorkflowSource({
        allowedRoot: root,
        entryPath: "workflow.ts",
        maximumImportEdges: 2,
      }),
    ).rejects.toThrow("Workflow source exceeds 2 import edges");
  });

  test("bounds bundler caller latency and permits a subsequent bundle", async () => {
    const root = await temporaryDirectory();
    await writeFile(
      join(root, "workflow.ts"),
      "export default { value: 1 };\n",
      { mode: 0o600 },
    );

    expect(
      bundleWorkflowSource({
        allowedRoot: root,
        entryPath: "workflow.ts",
        maximumBundlerDurationMs: 1,
      }),
    ).rejects.toThrow("Workflow bundler exceeded 1 milliseconds");
    expect(
      bundleWorkflowSource({ allowedRoot: root, entryPath: "workflow.ts" }),
    ).resolves.toMatchObject({ importedPaths: [await realpath(join(root, "workflow.ts"))] });
    expect(
      bundleWorkflowSource({
        allowedRoot: root,
        entryPath: "workflow.ts",
        maximumBundlerDurationMs: 2_147_483_648,
      }),
    ).rejects.toThrow("duration cannot exceed 2147483647 milliseconds");
  });

  test.skipIf(process.platform === "win32")(
    "transfers a timed-out bundler to exact retirement and post-death cleanup",
    async () => {
      const root = await temporaryDirectory();
      await writeFile(
        join(root, "workflow.ts"),
        "export default { value: 1 };\n",
        { mode: 0o600 },
      );
      let started:
        | {
          readonly processId: number;
          readonly processStartIdentity: string;
          readonly temporaryDirectory: string;
        }
        | undefined;
      let guardianReady = false;
      const beganAt = performance.now();

      const failure = await rejection(bundleWorkflowSource({
        afterBundlerRetirementGuardianReady: details => {
          guardianReady = true;
          if (started === undefined) {
            throw new Error("Bundler guardian became ready before process identity capture.");
          }
          expect(details).toEqual(started);
        },
        afterBundlerStarted: details => {
          started = details;
          process.kill(details.processId, "SIGSTOP");
        },
        allowedRoot: root,
        entryPath: "workflow.ts",
        maximumBundlerDurationMs: 10,
      }));
      expect(String(failure)).toContain("Workflow bundler exceeded 10 milliseconds");

      expect(performance.now() - beganAt).toBeLessThan(2_500);
      expect(guardianReady).toBe(true);
      expect(started).toBeDefined();
      await waitForCondition(async () => (
        workerProcessStartIdentityStatus(
          started!.processId,
          started!.processStartIdentity,
        ) === "different-or-dead"
        && await missing(started!.temporaryDirectory)
      ), "exact timed-out bundler retirement and cleanup");
    },
    10_000,
  );

  test.skipIf(process.platform === "win32")(
    "retains retirement authority when the caller crashes during pre-timeout bundling",
    async () => {
      const root = await temporaryDirectory();
      const workflowPath = join(root, "workflow.ts");
      const markerPath = join(root, "guardian-ready.json");
      const stateRoot = join(root, "host-resources");
      await writeFile(
        workflowPath,
        "export default { value: 1 };\n",
        { mode: 0o600 },
      );
      const helperSource = String.raw`
import { writeFile } from "node:fs/promises";

const sourceBundle = await import(process.argv[2]);
const { createHostResourceCoordinator } = await import(process.argv[3]);
const root = process.argv[4];
const markerPath = process.argv[5];
const stateRoot = process.argv[6];
const coordinator = createHostResourceCoordinator({
  profile: {
    capacities: [{ limit: 1, resource: "cpu" }],
    id: "workflow-bundler-crash-guardian",
  },
  stateRoot,
});
await coordinator.withLease(
  [{ amount: 1, resource: "cpu" }],
  async lease => await sourceBundle.bundleWorkflowSource({
    afterBundlerRetirementGuardianReady: async details => {
      await writeFile(markerPath, JSON.stringify(details), { flag: "wx", mode: 0o600 });
      setTimeout(() => process.kill(process.pid, "SIGKILL"), 100);
    },
    afterBundlerStarted: details => {
      process.kill(details.processId, "SIGSTOP");
    },
    allowedRoot: root,
    entryPath: "workflow.ts",
    inheritedHostResourceFileDescriptor: lease.inheritedFileDescriptor,
    maximumBundlerDurationMs: 60_000,
  }),
);
`;
      const helper = Bun.spawn([
        process.execPath,
        "-e",
        helperSource,
        "helper",
        pathToFileURL(join(import.meta.dir, "source-bundle.ts")).href,
        pathToFileURL(join(
          import.meta.dir,
          "../../../src/host-resources.ts",
        )).href,
        root,
        markerPath,
        stateRoot,
      ], {
        cwd: join(import.meta.dir, "../../.."),
        stderr: "pipe",
        stdout: "ignore",
      });
      const helperDiagnostic = new Response(helper.stderr).text();
      try {
        await waitForCondition(async () => !await missing(markerPath), "guardian-ready crash marker");
        const marker = JSON.parse(await readFile(markerPath, "utf8")) as {
          readonly processId: number;
          readonly processStartIdentity: string;
          readonly temporaryDirectory: string;
        };
        const contender = createHostResourceCoordinator({
          profile: {
            capacities: [{ limit: 1, resource: "cpu" }],
            id: "workflow-bundler-crash-guardian",
          },
          stateRoot,
        });
        let admitted = false;
        const admission = contender.withLease(
          [{ amount: 1, resource: "cpu" }],
          () => {
            admitted = true;
            expect(workerProcessStartIdentityStatus(
              marker.processId,
              marker.processStartIdentity,
            )).toBe("different-or-dead");
          },
        );
        await Bun.sleep(20);
        expect(admitted).toBe(false);
        expect(await helper.exited).not.toBe(0);
        await admission;
        expect(admitted).toBe(true);
        await waitForCondition(
          async () => await missing(marker.temporaryDirectory),
          `post-crash guardian cleanup ${marker.temporaryDirectory}`,
          1_000,
        );
      } catch (error) {
        const diagnostic = (await helperDiagnostic).trim();
        throw new Error(
          `${error instanceof Error ? (error.stack ?? error.message) : String(error)}${diagnostic === "" ? "" : `\nhelper: ${diagnostic}`}`,
        );
      } finally {
        try {
          helper.kill("SIGKILL");
        } catch {
          // The crash fixture normally exits itself after publishing its marker.
        }
        await Promise.allSettled([helper.exited, helperDiagnostic]);
      }
    },
    20_000,
  );

  test("rejects semantic TypeScript errors from the exact captured snapshot", async () => {
    const root = await temporaryDirectory();
    await writeFile(
      join(root, "workflow.ts"),
      `import { z } from "zod";
import { defineWorkflow } from "@hraness/transmute/local/code";

export default defineWorkflow({
  id: "invalid-recording",
  inputSchema: z.strictObject({}),
  inputSchemaId: "test.invalid-recording.input/v1",
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
`,
      { mode: 0o600 },
    );

    expect(
      checkAndBundleWorkflowSource({
        allowedRoot: root,
        entryPath: "workflow.ts",
      }),
    ).rejects.toThrow(/TypeScript check failed[\s\S]*microphone/u);
  }, 15_000);

  test("typechecks allowlisted package declarations outside the private source snapshot", async () => {
    const root = await temporaryDirectory();
    await writeFile(
      join(root, "workflow.ts"),
      `import { z } from "zod";
import { defineCompute, defineWorkflow } from "@hraness/transmute/local/code";

const double = defineCompute({
  key: "test.double",
  inputSchema: z.strictObject({ value: z.number() }),
  inputSchemaId: "test.double.input/v1",
  outputSchema: z.strictObject({ value: z.number() }),
  outputSchemaId: "test.double.output/v1",
  run(value) { return { value: value.value * 2 }; },
});

export default defineWorkflow({
  id: "valid-package-types",
  inputSchema: z.strictObject({ value: z.number() }),
  inputSchemaId: "test.valid-package-types.input/v1",
  version: 1,
  build(workflow, input) {
    return {
      result: workflow.compute("double", double, { value: input.value }),
    };
  },
});
`,
      { mode: 0o600 },
    );

    const bundle = await checkAndBundleWorkflowSource({
      allowedRoot: root,
      entryPath: "workflow.ts",
    });
    expect(bundle.bytes.byteLength).toBeGreaterThan(0);
  }, 15_000);

  test("typechecks the HTML-overlay authoring surface without allowing browser libraries", async () => {
    const root = await temporaryDirectory();
    await writeFile(
      join(root, "workflow.ts"),
      `import {
  createHtmlOverlayScaffold,
  createThreeReferenceScaffoldInput,
  type HtmlOverlayScaffoldKind,
} from "@hraness/transmute/local/html-overlay";
import { createMetallicLogoImageRequest } from "@hraness/transmute/local/code";

const kinds = ["plain", "motion", "paper-shaders", "three"] as const satisfies readonly HtmlOverlayScaffoldKind[];
const reference = {
  bytes: 8,
  mediaType: "image/png",
  path: "artwork/logo.png",
  sha256: "a".repeat(64),
} as const;
export default {
  html: kinds.map(kind => createHtmlOverlayScaffold(kind)),
  metallic: createMetallicLogoImageRequest({
    backgroundColor: "warm gray",
    brandName: "Hraness",
    model: "openai/image-example",
    objectColor: "brushed cobalt",
    reference,
  }),
  three: createThreeReferenceScaffoldInput(reference, reference.mediaType),
};
`,
      { mode: 0o600 },
    );

    const bundle = await checkAndBundleWorkflowSource({
      allowedRoot: root,
      entryPath: "workflow.ts",
    });
    expect(bundle).toMatchObject({
      externalImports: [],
      importedPaths: [await realpath(join(root, "workflow.ts"))],
    });

    for (const [index, specifier] of [
      "@paper-design/shaders",
      "motion",
      "three",
    ].entries()) {
      const entryPath = `browser-library-${String(index)}.ts`;
      await writeFile(
        join(root, entryPath),
        `import "${specifier}"; export default true;\n`,
        { mode: 0o600 },
      );
      let error: unknown;
      try {
        await checkAndBundleWorkflowSource({ allowedRoot: root, entryPath });
      } catch (caught) {
        error = caught;
      }
      expect(String(error))
        .toContain(`Workflow bare import is not allowlisted: ${specifier}`);
    }
  }, 15_000);

  test("bundles exact predecessor Transmute imports through canonical Transmute implementations", async () => {
    const root = await temporaryDirectory();
    await writeFile(
      join(root, "workflow.ts"),
      `import { seconds } from "@hraness/transmute/local/code";
import { GRAPH_ABI } from "@hraness/transmute/local/code/advanced";
import type { BuiltInWorkflow } from "@hraness/transmute/local/code/workflows";
import { HTML_OVERLAY_SCHEMA_VERSION } from "@hraness/transmute/local/html-overlay";

export default {
  builtIn: undefined as BuiltInWorkflow | undefined,
  graphAbi: GRAPH_ABI,
  overlaySchemaVersion: HTML_OVERLAY_SCHEMA_VERSION,
  oneSecondUs: seconds(1),
};
`,
      { mode: 0o600 },
    );

    const bundle = await checkAndBundleWorkflowSource({
      allowedRoot: root,
      entryPath: "workflow.ts",
    });

    expect(bundle.externalImports).toEqual([]);
    expect(bundle.importedPaths).toEqual([await realpath(join(root, "workflow.ts"))]);
    const source = new TextDecoder().decode(bundle.bytes);
    expect(source).not.toContain("@hraness/transmute/local/");
    expect(source).toContain("oneSecondUs");
  }, 15_000);

  test("rejects dynamic, disallowed bare, testing, and symlink imports before building", async () => {
    const root = await temporaryDirectory();
    await writeFile(join(root, "dynamic.ts"), "const name = './value.ts'; export default import(name);\n", { mode: 0o600 });
    expect(bundleWorkflowSource({ allowedRoot: root, entryPath: "dynamic.ts" })).rejects.toThrow("dynamic-import");

    await writeFile(join(root, "bare.ts"), "import x from 'not-allowed'; export default x;\n", { mode: 0o600 });
    expect(bundleWorkflowSource({ allowedRoot: root, entryPath: "bare.ts" })).rejects.toThrow("not allowlisted");

    await writeFile(join(root, "testing.ts"), "import x from '@hraness/transmute/local/code/testing'; export default x;\n", { mode: 0o600 });
    expect(bundleWorkflowSource({ allowedRoot: root, entryPath: "testing.ts" })).rejects.toThrow("cannot import");

    const outside = await temporaryDirectory();
    await writeFile(join(outside, "outside.ts"), "export default 1;\n", { mode: 0o600 });
    await mkdir(join(root, "nested"));
    await symlink(join(outside, "outside.ts"), join(root, "nested", "outside.ts"));
    await writeFile(join(root, "linked.ts"), "import value from './nested/outside.ts'; export default value;\n", { mode: 0o600 });
    expect(bundleWorkflowSource({ allowedRoot: root, entryPath: "linked.ts" })).rejects.toThrow(
      /allowed root|symbolic link/u,
    );
  });

  test("distinguishes inert import text from dynamic imports inside template expressions", async () => {
    const root = await temporaryDirectory();
    await writeFile(
      join(root, "inert.ts"),
      "const text = 'import(name)'; /* import(other) */ export default `import(value) $"
        + "{text}`;\n",
      { mode: 0o600 },
    );
    expect(bundleWorkflowSource({ allowedRoot: root, entryPath: "inert.ts" })).resolves.toMatchObject({
      importedPaths: [await realpath(join(root, "inert.ts"))],
    });

    await writeFile(
      join(root, "template-expression.ts"),
      "const name = './value.ts'; export default `$"
        + "{import(name)}`;\n",
      { mode: 0o600 },
    );
    expect(
      bundleWorkflowSource({ allowedRoot: root, entryPath: "template-expression.ts" }),
    ).rejects.toThrow("dynamic-import");
  });
});
