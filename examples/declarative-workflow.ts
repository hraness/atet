import {
  buildWorkflow,
  compileWorkflowGraph,
  createAtetCodeHost,
  defineWorkflow,
  PUBLIC_WORKFLOW_REGISTRY_PROJECTION,
  runBuiltWorkflow,
} from "@hraness/atet/code"
import { executeAtetOperation } from "@hraness/atet/operations"
import { z } from "zod"

const DeclarativeWorkflowInputSchema = z.strictObject({
  outDirectory: z.string().min(1).optional(),
  path: z.string().min(1),
})

export const declarativeCheckedRenderWorkflow = defineWorkflow({
  id: "declarative-checked-render",
  inputSchema: DeclarativeWorkflowInputSchema,
  inputSchemaId: "atet.example.declarative-checked-render.input/v1",
  version: 1,
  build(builder, input) {
    const checked = builder.diagram.check("check-source", {
      path: input.path,
    })
    const rendered = builder.diagram.render(
      "render-assets",
      {
        path: input.path,
        ...(input.outDirectory === undefined
          ? {}
          : { outDirectory: input.outDirectory }),
      },
      { after: checked },
    )
    return { checked, rendered }
  },
})

if (import.meta.main) {
  const path = Bun.argv[2]
  if (path === undefined) {
    throw new Error(
      "Usage: bun run examples/declarative-workflow.ts <diagram> [out-dir]",
    )
  }

  const built = buildWorkflow(
    declarativeCheckedRenderWorkflow,
    {
      path,
      ...(Bun.argv[3] === undefined ? {} : { outDirectory: Bun.argv[3] }),
    },
  )
  if (PUBLIC_WORKFLOW_REGISTRY_PROJECTION.discovery.length !== 4) {
    throw new Error("The public workflow projection must contain four operations.")
  }
  const planned = compileWorkflowGraph({
    graph: built.graph,
  })
  const host = createAtetCodeHost({
    execute: async request => await executeAtetOperation(
      request.kind,
      request.input,
    ),
  })
  const result = await runBuiltWorkflow(built, { host })

  console.log(JSON.stringify({
    compilationSha256: planned.compilationSha256,
    output: result.output,
    receipts: result.receipts,
  }, null, 2))
}
