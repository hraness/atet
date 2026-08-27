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
const schemaId = "https://raw.githubusercontent.com/hraness/atet/v3.0.2/schema/diagram.schema.json"
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
    throw new Error(`${relativePath} must reference the Atet v3.0.2 schema.`)
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

process.stdout.write(
  "diagram schema is valid, accepts the shipped examples, and bounds box label font size\n",
)
