import { describe, expect, test } from "bun:test";
import {
  AuthoredWorkflowGraphV1Schema as PortableAuthoredWorkflowGraphV1Schema,
  PUBLIC_WORKFLOW_REGISTRY_PROJECTION,
  PortableWorkflowBuilder,
  AtetCodeError,
  WorkflowGraphBuilder as PortableWorkflowGraphBuilder,
  canonicalJson as portableCanonicalJson,
  compileWorkflowGraph,
  createWorkflowRegistryProjection,
} from "@hraness/atet/code/advanced";

import { ApplicationError } from "../application/errors";
import { createApplicationOperationRegistry } from "../application/default-registry";
import { canonicalJson } from "../core/canonical-json";
import { AuthoredWorkflowGraphV1Schema } from "./contracts";
import { WorkflowGraphBuilder } from "./graph-builder";

describe("Atet SDK and Desktop convergence", () => {
  test("uses the public graph, compiler, canonical JSON, and error identities", () => {
    expect(WorkflowGraphBuilder).toBe(PortableWorkflowGraphBuilder);
    expect(AuthoredWorkflowGraphV1Schema)
      .toBe(PortableAuthoredWorkflowGraphV1Schema);
    expect(canonicalJson).toBe(portableCanonicalJson);
    expect(ApplicationError).toBe(AtetCodeError);
  });

  test("compiles one authored graph against public and complete local projections", () => {
    const builder = PortableWorkflowBuilder.create();
    const checked = builder.diagram.check("check", {
      path: "diagrams/architecture.tldr",
    });
    const rendered = builder.diagram.render(
      "render",
      { path: "diagrams/architecture.tldr" },
      { after: checked },
    );
    const graph = builder.build({
      id: "desktop-public-convergence",
      inputSchemaId: "atet.workflow.desktop-public-convergence.input/v1",
      version: 1,
    }, { artifacts: rendered.select("artifacts") });
    const desktopProjection = createWorkflowRegistryProjection(
      "atet.workflow.registry.desktop/v1",
      createApplicationOperationRegistry(),
      { trustedCompute: true },
    );

    const publicCompilation = compileWorkflowGraph({ graph });
    const desktopCompilation = compileWorkflowGraph({
      graph,
      projection: desktopProjection,
    });

    expect(desktopCompilation.graphSha256)
      .toBe(publicCompilation.graphSha256);
    expect(desktopCompilation.compilationSha256)
      .not.toBe(publicCompilation.compilationSha256);
    const desktopDiscoveries = new Set(
      desktopProjection.discovery.map(portableCanonicalJson),
    );
    for (const operation of PUBLIC_WORKFLOW_REGISTRY_PROJECTION.discovery) {
      expect(desktopDiscoveries.has(portableCanonicalJson(operation))).toBe(true);
    }
    expect(desktopProjection.discovery.length)
      .toBeGreaterThan(PUBLIC_WORKFLOW_REGISTRY_PROJECTION.discovery.length);
    expect(desktopProjection.trustedCompute).toBe(true);
    expect(PUBLIC_WORKFLOW_REGISTRY_PROJECTION.trustedCompute).toBe(false);
  });
});
