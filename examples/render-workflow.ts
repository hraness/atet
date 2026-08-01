import {
  defineTransmuteWorkflow,
  runTransmuteWorkflow,
} from "@hraness/transmute/workflow"

interface RenderWorkflowInput {
  readonly path: string
  readonly outDirectory?: string
}

function parseInput(value: unknown): RenderWorkflowInput {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Workflow input must be an object.")
  }
  const path = Reflect.get(value, "path")
  const outDirectory = Reflect.get(value, "outDirectory")
  if (typeof path !== "string" || path.length < 1) {
    throw new Error("Workflow input requires path.")
  }
  if (outDirectory !== undefined && typeof outDirectory !== "string") {
    throw new Error("outDirectory must be a string when provided.")
  }
  return {
    path,
    ...(outDirectory === undefined ? {} : { outDirectory }),
  }
}

export const checkedRenderWorkflow = defineTransmuteWorkflow({
  id: "checked-render",
  version: 1,
  parseInput,
  async run(workflow, input) {
    const checked = await workflow.operation(
      "check-source",
      "transmute.diagram.check",
      { path: input.path },
    )
    if (checked.findings.length > 0) {
      throw new Error("Diagram has lint findings; render was skipped.")
    }
    const rendered = await workflow.operation(
      "render-assets",
      "transmute.diagram.render",
      {
        path: input.path,
        ...(input.outDirectory === undefined
          ? {}
          : { outDirectory: input.outDirectory }),
      },
    )
    return {
      artifacts: rendered.artifacts,
      findingCount: checked.findings.length,
    }
  },
})

if (import.meta.main) {
  const path = Bun.argv[2]
  if (path === undefined) {
    throw new Error("Usage: bun run examples/render-workflow.ts <diagram> [out-dir]")
  }
  const result = await runTransmuteWorkflow(checkedRenderWorkflow, {
    path,
    ...(Bun.argv[3] === undefined ? {} : { outDirectory: Bun.argv[3] }),
  })
  console.log(JSON.stringify(result, null, 2))
}
