import { z } from "zod";

import {
  RepositoryRelativePathSchema,
  Sha256Schema,
} from "../contracts";

export const WORKFLOW_FILE_CANDIDATE_VERSION =
  "atet-workflow-file-candidate-v1" as const;

const CandidatePathSchema = RepositoryRelativePathSchema.and(
  z.string().max(256),
);

export const WorkflowFileCandidateSchema = z.strictObject({
  bytes: z.number().int().safe().positive().optional(),
  kind: z.literal("file"),
  mediaType: z.string()
    .max(160)
    .regex(
      /^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/u,
    )
    .optional(),
  path: CandidatePathSchema,
  sha256: Sha256Schema.optional(),
  version: z.literal(WORKFLOW_FILE_CANDIDATE_VERSION),
}).superRefine((candidate, context) => {
  if ((candidate.bytes === undefined) !== (candidate.sha256 === undefined)) {
    context.addIssue({
      code: "custom",
      message: "Exact file candidates require both bytes and sha256.",
    });
  }
});

export type WorkflowFileCandidate =
  z.infer<typeof WorkflowFileCandidateSchema>;

interface FileCandidateBase {
  readonly mediaType?: string;
  readonly path: string;
}

export type FileCandidateInput =
  | string
  | (FileCandidateBase & {
      readonly bytes?: never;
      readonly sha256?: never;
    })
  | (FileCandidateBase & {
      readonly bytes: number;
      readonly sha256: string;
    });

/**
 * Declares local-file authority in workflow input without opening the file.
 *
 * Trusted compute may choose among these inert declarations. A registered
 * media/Gateway operation still reopens, hashes, and binds the chosen file in
 * its exact node plan before effect authorization.
 */
export function fileCandidate(input: FileCandidateInput): WorkflowFileCandidate {
  const candidate = typeof input === "string" ? { path: input } : input;
  return WorkflowFileCandidateSchema.parse({
    ...candidate,
    kind: "file",
    version: WORKFLOW_FILE_CANDIDATE_VERSION,
  });
}
