import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";

import type { ApplicationContext } from "../application/context";
import { createApplicationOperationRegistry } from "../application/default-registry";
import { openProjectSnapshot } from "../application/project-store";
import {
  createOperationProjectFixture,
  operationApplicationContext,
} from "../application/operations/test-support";
import { createApplicationNodePlanner } from "./application-node-planner";
import {
  assertOperationFileProvenance,
  collectDeclaredFileCandidates,
  collectLiteralFileCandidates,
  fileCandidateDescriptor,
  mergeFileCandidateDescriptors,
} from "./file-candidate-provenance";
import type { AuthoredWorkflowGraphV1 } from "./contracts";
import { fileCandidate } from "./file-candidate";
import type { NodeExecutionPlanningRequest } from "./scheduler";

const SHA256 = "a".repeat(64);

function fixture<Value>(value: unknown): Value {
  return value as Value;
}

function request(options: {
  readonly candidate?: ReturnType<typeof fileCandidateDescriptor>;
  readonly producer: "compute" | "operation";
  readonly source?: {
    readonly bytes: number;
    readonly path: string;
    readonly sha256: string;
  };
}): NodeExecutionPlanningRequest {
  const source = options.source ?? {
    bytes: 5,
    path: "fixtures/private.wav",
    sha256: SHA256,
  };
  return fixture<NodeExecutionPlanningRequest>({
    dependencyOutputs: {
      source: {
        digestSha256: "b".repeat(64),
        summary: {},
        value: { artifact: source },
      },
    },
    graphPlan: {
      graph: {
        nodes: [{
          dependencies: [],
          executor: options.producer === "compute"
            ? {
                compute: {
                  bounds: {
                    maxDurationMs: 1,
                    maxInputBytes: 1,
                    maxOutputBytes: 1,
                  },
                  key: "test.source",
                  version: 1,
                },
                kind: "compute",
              }
            : {
                kind: "operation",
                operation: { kind: "media.ingest", version: 1 },
              },
          input: {},
          inputSchemaId: "test.input/v1",
          key: "source",
          outputSchemaId: "test.output/v1",
        }],
      },
      staticBindings: {
        candidates: options.candidate === undefined
          ? []
          : [options.candidate],
      },
    },
    node: { key: "effects" },
    operation: { kind: "media.audio-effects" },
    resolvedInput: {
      input: source,
      transform: {},
    },
  });
}

describe("workflow file candidate provenance", () => {
  test("rejects a compute-minted file before host preparation", () => {
    expect(() => assertOperationFileProvenance(request({
      producer: "compute",
    }))).toThrow("undeclared local media");
  });

  test("accepts an exact static candidate or host operation artifact", () => {
    const candidate = fileCandidateDescriptor({
      bytes: 5,
      id: "fixtures/private.wav",
      kind: "file",
      sha256: SHA256,
    });
    expect(() => assertOperationFileProvenance(request({
      candidate,
      producer: "compute",
    }))).not.toThrow();
    expect(() => assertOperationFileProvenance(request({
      candidate: fileCandidateDescriptor({
        id: "fixtures/private.wav",
        kind: "file",
      }),
      producer: "compute",
    }))).not.toThrow();
    expect(() => assertOperationFileProvenance(request({
      producer: "operation",
    }))).not.toThrow();
  });

  test("applies file authority to nested overlay sources", () => {
    const source = {
      bytes: 5,
      path: "fixtures/title.png",
      sha256: SHA256,
    };
    const overlayRequest = (producer: "compute" | "operation") => {
      const planning = request({ producer, source });
      return fixture<NodeExecutionPlanningRequest>({
        ...planning,
        operation: { kind: "media.overlay" },
        resolvedInput: {
          project: "project_example",
          range: { endUs: 2_000_000, startUs: 0 },
          source: {
            artifact: source,
            kind: "image",
          },
        },
      });
    };

    expect(() => assertOperationFileProvenance(overlayRequest("compute")))
      .toThrow("undeclared local media");
    expect(() => assertOperationFileProvenance(overlayRequest("operation")))
      .not.toThrow();
    expect(() => assertOperationFileProvenance(fixture({
      ...overlayRequest("compute"),
      resolvedInput: {
        project: "project_example",
        range: { endUs: 2_000_000, startUs: 0 },
        source: { kind: "emoji", query: "sparkles" },
      },
    }))).not.toThrow();
  });

  test("applies file authority to every progressive Atet visual source", () => {
    const cases = [
      {
        input: { path: "fixtures/system.diagram.json" },
        kind: "atet.diagram.check",
        path: "fixtures/system.diagram.json",
      },
      {
        input: { path: "fixtures/render.diagram.json", scale: 2 },
        kind: "atet.diagram.render",
        path: "fixtures/render.diagram.json",
      },
      {
        input: { inputPath: "fixtures/sketch.png" },
        kind: "atet.image.vectorize",
        path: "fixtures/sketch.png",
      },
    ] as const;
    for (const testCase of cases) {
      const compute = fixture<NodeExecutionPlanningRequest>({
        ...request({ producer: "compute" }),
        operation: { kind: testCase.kind },
        resolvedInput: testCase.input,
      });
      expect(() => assertOperationFileProvenance(compute))
        .toThrow(`undeclared local media: ${testCase.path}`);
      expect(() => assertOperationFileProvenance(fixture({
        ...compute,
        graphPlan: {
          ...compute.graphPlan,
          staticBindings: {
            ...compute.graphPlan.staticBindings,
            candidates: [fileCandidateDescriptor({
              id: testCase.path,
              kind: "file",
            })],
          },
        },
      }))).not.toThrow();

      const operationDependency = fixture<NodeExecutionPlanningRequest>({
        ...compute,
        dependencyOutputs: {
          source: {
            digestSha256: "b".repeat(64),
            summary: {},
            value: {
              artifact: {
                bytes: 5,
                path: testCase.path,
                sha256: SHA256,
              },
            },
          },
        },
        graphPlan: {
          ...compute.graphPlan,
          graph: {
            nodes: [{
              dependencies: [],
              executor: {
                kind: "operation",
                operation: { kind: "media.ingest", version: 1 },
              },
              input: {},
              inputSchemaId: "test.input/v1",
              key: "source",
              outputSchemaId: "test.output/v1",
            }],
          },
        },
      });
      expect(() => assertOperationFileProvenance(operationDependency))
        .not.toThrow();
    }
  });

  test("planner pins declared overlay bytes and accepts exact Gateway dependency output", async () => {
    const root = await mkdtemp(join(tmpdir(), "atet-overlay-provenance-"));
    try {
      const fixtureProject = await createOperationProjectFixture(root);
      const sourcePath = join(root, "fixtures", "title.png");
      const sourceBytes = Buffer.from([
        0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
      ]);
      await mkdir(join(root, "fixtures"), { recursive: true });
      await writeFile(sourcePath, sourceBytes);
      const source = {
        bytes: sourceBytes.byteLength,
        mediaType: "image/png",
        path: relative(root, sourcePath),
        sha256: createHash("sha256").update(sourceBytes).digest("hex"),
      };
      const registry = createApplicationOperationRegistry();
      const operation = registry.describe("media.overlay", 1);
      const initial = await openProjectSnapshot(
        fixtureProject.projectRoot,
        fixtureProject.project.projectId,
      );
      const input = {
        project: fixtureProject.project.projectId,
        range: { endUs: 2_000_000, startUs: 0 },
        source: {
          artifact: { path: source.path },
          kind: "image",
        },
      };
      const projectNode = {
        dependencies: [],
        executor: {
          kind: "operation",
          operation: { kind: "project.snapshot", version: 1 },
        },
        input: { project: fixtureProject.project.projectId },
        inputSchemaId: "studio.operation.project.snapshot.input/v1",
        key: "project",
        outputSchemaId: "studio.operation.project.snapshot.output/v1",
      };
      const projectOutput = {
        currentPlan: initial.plan,
        editBasis: initial.editBasis,
        generation: initial.generation,
        project: initial.project,
      };
      const node = {
        dependencies: ["project"],
        executor: {
          kind: "operation",
          operation: { kind: "media.overlay", version: 1 },
        },
        input,
        inputSchemaId: operation.inputSchemaId,
        key: "overlay",
        outputSchemaId: operation.outputSchemaId,
      };
      const staticBindings = {
        candidates: [fileCandidateDescriptor({
          id: source.path,
          kind: "file",
        })],
        initialSubjects: [{
          descriptorSha256: "1".repeat(64),
          id: fixtureProject.project.projectId,
          kind: "project",
          planSha256: initial.generation.currentPlanSha256,
          projectSha256: initial.generation.projectSha256,
        }],
        version: "atet-static-bindings-v1",
      };
      const planner = createApplicationNodePlanner(
        operationApplicationContext(root, {
          capabilities: () => Promise.resolve([{
            available: true,
            command: Bun.which("true") ?? "/usr/bin/true",
            name: "ffprobe",
            version: "ffprobe provenance fixture",
          }]),
        }),
      );
      const declared = await planner.plan(fixture({
        dependencyOutputs: {
          project: {
            digestSha256: "3".repeat(64),
            summary: {},
            value: projectOutput,
          },
        },
        graphPlan: {
          graph: { nodes: [projectNode, node] },
          staticBindings,
        },
        node,
        operation,
        preparationPlan: {},
        resolvedInput: input,
        runId: "run_overlay_declared",
      }));
      expect(declared.exactInput).toMatchObject({
        source: {
          artifact: {
            bytes: source.bytes,
            path: source.path,
            sha256: source.sha256,
          },
          kind: "image",
        },
      });

      const gatewayNode = {
        dependencies: [],
        executor: {
          kind: "operation",
          operation: { kind: "gateway.image", version: 1 },
        },
        input: {},
        inputSchemaId: "studio.operation.gateway.image.input/v1",
        key: "image",
        outputSchemaId: "studio.operation.gateway.image.output/v1",
      };
      const gatewayInput = {
        ...input,
        source: { artifact: source, kind: "image" },
      };
      const gatewayPlanned = await planner.plan(fixture({
        dependencyOutputs: {
          image: {
            digestSha256: "2".repeat(64),
            summary: {},
            value: { outputs: [source] },
          },
          project: {
            digestSha256: "3".repeat(64),
            summary: {},
            value: projectOutput,
          },
        },
        graphPlan: {
          graph: {
            nodes: [
              projectNode,
              gatewayNode,
              {
                ...node,
                dependencies: ["image", "project"],
                input: gatewayInput,
              },
            ],
          },
          staticBindings: {
            ...staticBindings,
            candidates: [],
          },
        },
        node: {
          ...node,
          dependencies: ["image", "project"],
          input: gatewayInput,
        },
        operation,
        preparationPlan: {},
        resolvedInput: gatewayInput,
        runId: "run_overlay_gateway",
      }));
      expect(gatewayPlanned.exactInput).toMatchObject({
        source: {
          artifact: {
            bytes: source.bytes,
            path: source.path,
            sha256: source.sha256,
          },
          kind: "image",
        },
      });
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  test("planner binds exact HTML documents and declared resources", async () => {
    const root = await mkdtemp(join(tmpdir(), "atet-html-overlay-provenance-"));
    try {
      const fixtureProject = await createOperationProjectFixture(root);
      const documentPath = join(root, "fixtures", "lower-third.html");
      const resourcePath = join(root, "fixtures", "avatar.png");
      const documentBytes = Buffer.from(
        "<!doctype html><div>Recording</div>",
        "utf8",
      );
      const resourceBytes = Buffer.from([
        0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
      ]);
      await mkdir(join(root, "fixtures"), { recursive: true });
      await Promise.all([
        writeFile(documentPath, documentBytes),
        writeFile(resourcePath, resourceBytes),
      ]);
      const document = {
        bytes: documentBytes.byteLength,
        path: relative(root, documentPath),
        sha256: createHash("sha256").update(documentBytes).digest("hex"),
      };
      const resource = {
        bytes: resourceBytes.byteLength,
        path: relative(root, resourcePath),
        sha256: createHash("sha256").update(resourceBytes).digest("hex"),
      };
      const registry = createApplicationOperationRegistry();
      const operation = registry.describe("media.html-overlay", 1);
      const initial = await openProjectSnapshot(
        fixtureProject.projectRoot,
        fixtureProject.project.projectId,
      );
      const input = {
        canvas: {
          deviceScaleFactor: 1,
          height: 1_080,
          width: 1_920,
        },
        document: { path: document.path },
        project: fixtureProject.project.projectId,
        range: { endUs: 2_000_000, startUs: 0 },
        resources: [{
          artifact: { path: resource.path },
          mediaType: "image/png",
          name: "avatar",
          urlPath: "assets/avatar.png",
        }],
        timing: { durationUs: 2_000_000, fps: 30 },
      };
      const projectNode = {
        dependencies: [],
        executor: {
          kind: "operation",
          operation: { kind: "project.snapshot", version: 1 },
        },
        input: { project: fixtureProject.project.projectId },
        inputSchemaId: "studio.operation.project.snapshot.input/v1",
        key: "project",
        outputSchemaId: "studio.operation.project.snapshot.output/v1",
      };
      const node = {
        dependencies: ["project"],
        executor: {
          kind: "operation",
          operation: { kind: "media.html-overlay", version: 1 },
        },
        input,
        inputSchemaId: operation.inputSchemaId,
        key: "html-overlay",
        outputSchemaId: operation.outputSchemaId,
      };
      const planner = createApplicationNodePlanner(
        operationApplicationContext(root, {
          capabilities: () => Promise.resolve([
            {
              available: true,
              command: Bun.which("true") ?? "/usr/bin/true",
              name: "ffmpeg",
              version: "ffmpeg HTML provenance fixture",
            },
            {
              available: true,
              command: Bun.which("true") ?? "/usr/bin/true",
              name: "ffprobe",
              version: "ffprobe HTML provenance fixture",
            },
            {
              available: true,
              command: Bun.which("true") ?? "/usr/bin/true",
              name: "html-browser",
              version: "browser HTML provenance fixture",
            },
          ]),
        }),
      );
      const planned = await planner.plan(fixture({
        dependencyOutputs: {
          project: {
            digestSha256: "3".repeat(64),
            summary: {},
            value: {
              currentPlan: initial.plan,
              editBasis: initial.editBasis,
              generation: initial.generation,
              project: initial.project,
            },
          },
        },
        graphPlan: {
          graph: { nodes: [projectNode, node] },
          staticBindings: {
            candidates: [
              fileCandidateDescriptor({
                id: document.path,
                kind: "file",
              }),
              fileCandidateDescriptor({
                id: resource.path,
                kind: "file",
              }),
            ],
            initialSubjects: [{
              descriptorSha256: "1".repeat(64),
              id: fixtureProject.project.projectId,
              kind: "project",
              planSha256: initial.generation.currentPlanSha256,
              projectSha256: initial.generation.projectSha256,
            }],
            version: "atet-static-bindings-v1",
          },
        },
        node,
        operation,
        preparationPlan: {},
        resolvedInput: input,
        runId: "run_html_overlay_declared",
      }));

      expect(planned.exactInput).toMatchObject({
        document,
        resources: [{
          artifact: resource,
          mediaType: "image/png",
          name: "avatar",
          urlPath: "assets/avatar.png",
        }],
      });

      const gatewayResource = {
        ...resource,
        mediaType: "image/png",
      } as const;
      const gatewayNode = {
        dependencies: [],
        executor: {
          kind: "operation",
          operation: { kind: "gateway.image", version: 1 },
        },
        input: {},
        inputSchemaId: "studio.operation.gateway.image.input/v1",
        key: "image",
        outputSchemaId: "studio.operation.gateway.image.output/v1",
      };
      const gatewayInput = {
        ...input,
        resources: [{
          artifact: gatewayResource,
          mediaType: "image/png",
          name: "reference-image",
          urlPath: "assets/reference-image",
        }],
      };
      const gatewayOverlayNode = {
        ...node,
        dependencies: ["image", "project"],
        input: gatewayInput,
      };
      const gatewayPlanned = await planner.plan(fixture({
        dependencyOutputs: {
          image: {
            digestSha256: "2".repeat(64),
            summary: {},
            value: { outputs: [gatewayResource] },
          },
          project: {
            digestSha256: "3".repeat(64),
            summary: {},
            value: {
              currentPlan: initial.plan,
              editBasis: initial.editBasis,
              generation: initial.generation,
              project: initial.project,
            },
          },
        },
        graphPlan: {
          graph: { nodes: [projectNode, gatewayNode, gatewayOverlayNode] },
          staticBindings: {
            candidates: [fileCandidateDescriptor({
              id: document.path,
              kind: "file",
            })],
            initialSubjects: [{
              descriptorSha256: "1".repeat(64),
              id: fixtureProject.project.projectId,
              kind: "project",
              planSha256: initial.generation.currentPlanSha256,
              projectSha256: initial.generation.projectSha256,
            }],
            version: "atet-static-bindings-v1",
          },
        },
        node: gatewayOverlayNode,
        operation,
        preparationPlan: {},
        resolvedInput: gatewayInput,
        runId: "run_html_overlay_gateway",
      }));

      expect(gatewayPlanned.exactInput).toMatchObject({
        document,
        resources: [{
          artifact: resource,
          mediaType: "image/png",
          name: "reference-image",
          urlPath: "assets/reference-image",
        }],
      });
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  test("rejects candidate descriptor and file identity drift", () => {
    const wrongBytes = fileCandidateDescriptor({
      bytes: 6,
      id: "fixtures/private.wav",
      kind: "file",
      sha256: SHA256,
    });
    expect(() => assertOperationFileProvenance(request({
      candidate: wrongBytes,
      producer: "compute",
    }))).toThrow("undeclared local media");

    const tampered = {
      ...fileCandidateDescriptor({
        bytes: 5,
        id: "fixtures/private.wav",
        kind: "file",
        sha256: SHA256,
      }),
      descriptorSha256: "c".repeat(64),
    };
    expect(() => assertOperationFileProvenance(request({
      candidate: tampered,
      producer: "compute",
    }))).toThrow("invalid descriptor digest");
  });

  test("planner rejects undeclared files before Gateway preparation", () => {
    let preparations = 0;
    const application = fixture<ApplicationContext>({
      gatewayPort: {
        prepare: () => {
          preparations += 1;
          return Promise.reject(new Error("must not prepare"));
        },
      },
      paths: {
        repositoryRoot: "/path/that/must/not/be-opened",
      },
    });
    const planning = fixture<NodeExecutionPlanningRequest>({
      ...request({ producer: "compute" }),
      operation: { kind: "gateway.transcription" },
      resolvedInput: {
        audio: {
          bytes: 5,
          mediaType: "audio/wav",
          path: "fixtures/private.wav",
          sha256: SHA256,
        },
        model: "openai/whisper-1",
      },
    });

    expect(createApplicationNodePlanner(application).plan(planning))
      .rejects.toMatchObject({ code: "authorization-required" });
    expect(preparations).toBe(0);
  });

  test("planning declares authored media without opening or hashing it", () => {
    const graph = fixture<AuthoredWorkflowGraphV1>({
      nodes: [{
        executor: {
          kind: "operation",
          operation: { kind: "media.ingest", version: 1 },
        },
        input: {
          project: "project_candidate01",
          role: "primary",
          source: { path: "fixtures/input-that-need-not-exist.wav" },
        },
      }],
    });

    const candidates = collectLiteralFileCandidates(graph);

    expect(candidates).toHaveLength(1);
    expect(candidates[0]).toMatchObject({
      id: "fixtures/input-that-need-not-exist.wav",
      kind: "file",
    });
    expect(candidates[0]?.descriptorSha256).toMatch(/^[a-f0-9]{64}$/u);
  });

  test("planning declares overlay files but not host-resolved emoji assets", () => {
    const graph = fixture<AuthoredWorkflowGraphV1>({
      nodes: [
        {
          executor: {
            kind: "operation",
            operation: { kind: "media.overlay", version: 1 },
          },
          input: {
            project: "project_candidate01",
            range: { endUs: 2_000_000, startUs: 1_000_000 },
            source: {
              artifact: { path: "fixtures/title-card.svg" },
              kind: "svg",
            },
          },
        },
        {
          executor: {
            kind: "operation",
            operation: { kind: "media.overlay", version: 1 },
          },
          input: {
            project: "project_candidate01",
            range: { endUs: 4_000_000, startUs: 3_000_000 },
            source: {
              kind: "emoji",
              query: "sparkles",
            },
          },
        },
      ],
    });

    expect(collectLiteralFileCandidates(graph).map(candidate => candidate.id))
      .toEqual(["fixtures/title-card.svg"]);
  });

  test("planning declares every authored Atet visual source", () => {
    const graph = fixture<AuthoredWorkflowGraphV1>({
      nodes: [
        {
          executor: {
            kind: "operation",
            operation: { kind: "atet.diagram.check", version: 1 },
          },
          input: { path: "fixtures/check.diagram.json" },
        },
        {
          executor: {
            kind: "operation",
            operation: { kind: "atet.diagram.render", version: 1 },
          },
          input: { path: "fixtures/render.diagram.json", scale: 2 },
        },
        {
          executor: {
            kind: "operation",
            operation: { kind: "atet.image.vectorize", version: 1 },
          },
          input: { inputPath: "fixtures/sketch.png" },
        },
      ],
    });

    expect(collectLiteralFileCandidates(graph).map(candidate => candidate.id))
      .toEqual([
        "fixtures/check.diagram.json",
        "fixtures/render.diagram.json",
        "fixtures/sketch.png",
      ]);
  });

  test("planning declares an HTML document and every resource artifact", () => {
    const graph = fixture<AuthoredWorkflowGraphV1>({
      nodes: [{
        executor: {
          kind: "operation",
          operation: { kind: "media.html-overlay", version: 1 },
        },
        input: {
          document: { path: "fixtures/lower-third.html" },
          project: "project_candidate01",
          resources: [
            {
              artifact: { path: "fixtures/avatar.png" },
              mediaType: "image/png",
              name: "avatar",
              urlPath: "assets/avatar.png",
            },
            {
              artifact: { path: "fixtures/fonts/inter.woff2" },
              mediaType: "font/woff2",
              name: "inter",
              urlPath: "assets/inter.woff2",
            },
          ],
        },
      }],
    });

    expect(collectLiteralFileCandidates(graph).map(candidate => candidate.id))
      .toEqual([
        "fixtures/avatar.png",
        "fixtures/fonts/inter.woff2",
        "fixtures/lower-third.html",
      ]);
  });

  test("inline HTML is not a file candidate while its resources remain declared", () => {
    const graph = fixture<AuthoredWorkflowGraphV1>({
      nodes: [{
        executor: {
          kind: "operation",
          operation: { kind: "media.html-overlay", version: 1 },
        },
        input: {
          document: { html: "<!doctype html><div>Inline overlay</div>" },
          project: "project_candidate01",
          resources: [{
            artifact: { path: "fixtures/avatar.png" },
            mediaType: "image/png",
            name: "avatar",
            urlPath: "assets/avatar.png",
          }],
        },
      }],
    });

    expect(collectLiteralFileCandidates(graph).map(candidate => candidate.id))
      .toEqual(["fixtures/avatar.png"]);
  });

  test("planning preserves authored exact file constraints", () => {
    const graph = fixture<AuthoredWorkflowGraphV1>({
      nodes: [{
        executor: {
          kind: "operation",
          operation: { kind: "gateway.transcription", version: 1 },
        },
        input: {
          audio: {
            bytes: 5,
            mediaType: "audio/wav",
            path: "fixtures/input.wav",
            sha256: SHA256,
          },
        },
      }],
    });

    expect(collectLiteralFileCandidates(graph)[0]).toMatchObject({
      bytes: 5,
      id: "fixtures/input.wav",
      kind: "file",
      mediaType: "audio/wav",
      sha256: SHA256,
    });
  });

  test("workflow input can predeclare files for trusted compute selection", () => {
    const pathOnly = fileCandidate("fixtures/choice.wav");
    const exact = fileCandidate({
      bytes: 12,
      mediaType: "audio/wav",
      path: "fixtures/choice.wav",
      sha256: SHA256,
    });

    const declared = collectDeclaredFileCandidates({
      choices: [{ source: pathOnly }],
    });
    const merged = mergeFileCandidateDescriptors([
      declared,
      collectDeclaredFileCandidates({ exact }),
    ]);

    expect(merged).toHaveLength(1);
    expect(merged[0]).toMatchObject({
      bytes: 12,
      id: "fixtures/choice.wav",
      kind: "file",
      mediaType: "audio/wav",
      sha256: SHA256,
    });
  });
});
