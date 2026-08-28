import { readFile } from "node:fs/promises"
import { join } from "node:path"
import Ajv2020 from "ajv/dist/2020.js"

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function formatErrors(
  errors: readonly {
    readonly instancePath?: string
    readonly message?: string
    readonly schemaPath?: string
  }[] | null | undefined,
): string {
  return (errors ?? [])
    .map(
      (error) =>
        `${error.instancePath ?? ""} ${error.message ?? "is invalid"} (${error.schemaPath ?? "unknown schema path"})`,
    )
    .join("\n")
}

const repository = join(import.meta.dir, "..")
const schemaPath = join(repository, "schema", "diagram.schema.json")
const parsedSchema: unknown = JSON.parse(await readFile(schemaPath, "utf8"))
if (!isRecord(parsedSchema)) {
  throw new Error("schema/diagram.schema.json must contain a JSON object.")
}
const schemaId = "https://raw.githubusercontent.com/hraness/atet/v3.1.2/schema/diagram.schema.json"
if (parsedSchema.$id !== schemaId) {
  throw new Error(`Diagram schema $id must be ${schemaId}.`)
}

const ajv = new Ajv2020({
  allErrors: true,
  strict: true,
  validateSchema: true,
})
if (!ajv.validateSchema(parsedSchema)) {
  throw new Error(`Diagram schema is not valid Draft 2020-12:\n${formatErrors(ajv.errors)}`)
}
const validate = ajv.compile(parsedSchema)

for (const relativePath of [
  "examples/capex-opex.diagram.json",
  "examples/semantic-flow.diagram.json",
] as const) {
  const instance: unknown = JSON.parse(
    await readFile(join(repository, relativePath), "utf8"),
  )
  if (!isRecord(instance) || instance.$schema !== schemaId) {
    throw new Error(`${relativePath} must reference the Atet v3.1.2 schema.`)
  }
  if (!validate(instance)) {
    throw new Error(
      `${relativePath} does not satisfy the public schema:\n${formatErrors(validate.errors)}`,
    )
  }
}

const sizedBoxLabel = {
  version: 1,
  name: "sized-box-label",
  canvas: { width: 320, height: 200 },
  shapes: [
    {
      id: "evidence",
      type: "rect",
      x: 40,
      y: 40,
      width: 240,
      height: 120,
      label: "Evidence packet",
      labelFontSize: 16,
    },
  ],
}
if (!validate(sizedBoxLabel)) {
  throw new Error(
    `Diagram schema must accept a positive box labelFontSize:\n${formatErrors(validate.errors)}`,
  )
}
const invalidSizedBoxLabel = {
  ...sizedBoxLabel,
  shapes: [{ ...sizedBoxLabel.shapes[0], labelFontSize: 0 }],
}
if (validate(invalidSizedBoxLabel)) {
  throw new Error("Diagram schema must reject a non-positive box labelFontSize.")
}

const richDiagram = {
  version: 1,
  name: "rich-labels-and-ports",
  canvas: { width: 720, height: 320 },
  shapes: [
    {
      id: "source",
      type: "rect",
      x: 40,
      y: 80,
      width: 220,
      height: 160,
      labelRows: [
        { text: "ENTITY", fontSize: 15, fontFamily: "mono", weight: 700 },
        { text: "Aβ*56 assembly", fontSize: 20, weight: 500 },
      ],
      labelRowGap: 8,
    },
    { id: "target", type: "rect", x: 460, y: 80, width: 220, height: 160 },
  ],
  edges: [
    {
      id: "source-target",
      from: "source",
      to: "target",
      startPosition: 0.3,
      endPosition: 0.7,
      label: "supports",
      labelFontFamily: "mono",
      labelFontSize: 19,
      labelWeight: 700,
      labelPosition: 0.45,
      labelOffset: -16,
    },
  ],
}
if (!validate(richDiagram)) {
  throw new Error(
    `Diagram schema must accept rich labels and positioned ports:\n${formatErrors(validate.errors)}`,
  )
}
if (
  validate({
    ...richDiagram,
    shapes: [{ ...richDiagram.shapes[0], label: "conflict" }, richDiagram.shapes[1]],
  })
) {
  throw new Error("Diagram schema must reject a box that combines label and labelRows.")
}
if (
  validate({
    ...richDiagram,
    edges: [{ id: "source-target", from: "source", to: "target", labelFontSize: 18 }],
  })
) {
  throw new Error("Diagram schema must reject label styling without an edge label.")
}

process.stdout.write(
  "diagram schema is valid, accepts rich labels and ports, and rejects conflicting text states\n",
)
