import type { z } from "zod"

import { TransmuteCodeError } from "./errors.js"

export function parseCodeBoundary<Output>(
  schema: z.ZodType<Output>,
  input: unknown,
  name: string,
): Output {
  const result = schema.safeParse(input)
  if (!result.success) {
    throw new TransmuteCodeError("invalid-data", `Invalid ${name}.`, {
      issues: result.error.issues.map(issue => ({
        code: issue.code,
        message: issue.message,
        path: issue.path.map(String),
      })),
    })
  }
  return result.data
}
