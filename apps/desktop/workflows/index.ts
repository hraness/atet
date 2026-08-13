import type { z } from "zod";

import type { OperationRegistry } from "../application/registry";
import {
  buildWorkflow,
  type BuiltWorkflow,
  type WorkflowDefinition,
} from "../code/define-workflow";
import type { WorkflowOutputValue } from "../code/contracts";
import { chapteredDemo } from "./chaptered-demo";
import { creativeIteration } from "./creative-iteration";
import { creativeSelection } from "./creative-selection";
import { polishedScreenDemo } from "./polished-screen-demo";
import { socialVariants } from "./social-variants";
import { talkingHeadCleanup } from "./talking-head-cleanup";

export * from "./fragments";

export interface BuiltInWorkflow {
  readonly description: string;
  readonly id: string;
  readonly inputSchema: z.ZodType<unknown>;
  readonly inputSchemaId: string;
  readonly title: string;
  readonly version: number;
  build(registry: Pick<OperationRegistry, "list">, input: unknown): BuiltWorkflow;
}

function catalogEntry<Input, Output extends WorkflowOutputValue>(
  definition: WorkflowDefinition<Input, Output>,
  metadata: {
    readonly description: string;
    readonly title: string;
  },
): BuiltInWorkflow {
  return Object.freeze({
    build: (registry: Pick<OperationRegistry, "list">, input: unknown) => (
      buildWorkflow(definition, registry, input)
    ),
    description: metadata.description,
    id: definition.id,
    inputSchema: definition.inputSchema,
    inputSchemaId: definition.inputSchemaId,
    title: metadata.title,
    version: definition.version,
  });
}

export const BUILT_IN_WORKFLOWS: readonly BuiltInWorkflow[] = Object.freeze([
  catalogEntry(chapteredDemo, {
    description: "Freeze the current chapter, overlay, and media composition and render an exact video.",
    title: "Chaptered demo",
  }),
  catalogEntry(creativeIteration, {
    description: "Render independent low-cost candidates from one frozen project and close them into an explicit selection matrix.",
    title: "Creative iteration",
  }),
  catalogEntry(creativeSelection, {
    description: "Record an explicit matrix choice, then optionally promote it and materialize verified deliveries.",
    title: "Creative selection",
  }),
  catalogEntry(polishedScreenDemo, {
    description: "Analyze cleanup and media evidence in parallel, then render a provenance-bearing multi-face camera revision.",
    title: "Polished screen demo",
  }),
  catalogEntry(socialVariants, {
    description: "Freeze and render landscape, square, and vertical videos as independent parallel branches.",
    title: "Social variants",
  }),
  catalogEntry(talkingHeadCleanup, {
    description: "Remove long pauses, retain local face evidence, and render a landscape talking-head video.",
    title: "Talking-head cleanup",
  }),
].sort((left, right) => left.id.localeCompare(right.id)));

export function builtInWorkflow(id: string): BuiltInWorkflow | undefined {
  return BUILT_IN_WORKFLOWS.find(workflow => workflow.id === id);
}

export {
  chapteredDemo,
  creativeIteration,
  creativeSelection,
  polishedScreenDemo,
  socialVariants,
  talkingHeadCleanup,
};
