import { z } from "zod";

import {
  CameraMoveIdSchema,
  FaceTrackIdSchema,
  Sha256Schema,
  VideoProjectIdSchema,
  type ReadonlyInferred,
} from "../contracts";

const AgentCommandSchema = z.string()
  .min(1)
  .max(512)
  .refine(value => !/[\r\n]/u.test(value), "Next command must fit on one line.");

type CameraMoveId = z.infer<typeof CameraMoveIdSchema>;
type VideoProjectId = z.infer<typeof VideoProjectIdSchema>;

export function projectCameraNextCommands(
  projectId: VideoProjectId,
  cameraMoveId: CameraMoveId,
): Readonly<{ readonly remove: string; readonly show: string }> {
  return {
    remove: `atet project edit ${projectId} camera remove ${cameraMoveId} --json`,
    show: `atet project edit ${projectId} camera show --json`,
  };
}

export const ProjectCameraSelectionReceiptSchema = z.strictObject({
  kind: z.enum(["all", "explicit", "largest"]),
  requireAllSelected: z.boolean(),
  trackIds: z.array(FaceTrackIdSchema).min(1).max(64),
}).superRefine((selection, context) => {
  if (new Set(selection.trackIds).size !== selection.trackIds.length) {
    context.addIssue({ code: "custom", message: "Camera receipt track IDs must be unique." });
  }
  if (selection.kind === "largest" && selection.requireAllSelected) {
    context.addIssue({
      code: "custom",
      message: "Dynamic largest-visible selection cannot require every candidate track.",
    });
  }
});

export const ProjectCameraCreateReceiptSchema = z.strictObject({
  cameraMoveId: CameraMoveIdSchema,
  cameraMoves: z.number().int().safe().positive().max(4_096),
  keyframeCount: z.number().int().safe().min(2).max(4_096),
  nextCommands: z.strictObject({
    remove: AgentCommandSchema,
    show: AgentCommandSchema,
  }),
  operation: z.enum(["follow-faces", "path", "push", "reframe"]),
  planHash: Sha256Schema,
  projectId: VideoProjectIdSchema,
  selection: ProjectCameraSelectionReceiptSchema.nullable(),
}).superRefine((receipt, context) => {
  if ((receipt.operation === "follow-faces") !== (receipt.selection !== null)) {
    context.addIssue({
      code: "custom",
      message: "Only face-follow camera receipts carry a face selection.",
    });
  }
  const expected = projectCameraNextCommands(receipt.projectId, receipt.cameraMoveId);
  if (receipt.nextCommands.show !== expected.show) {
    context.addIssue({
      code: "custom",
      message: "Camera receipt show command must exactly match its project ID.",
      path: ["nextCommands", "show"],
    });
  }
  if (receipt.nextCommands.remove !== expected.remove) {
    context.addIssue({
      code: "custom",
      message: "Camera receipt remove command must exactly match its project and camera move IDs.",
      path: ["nextCommands", "remove"],
    });
  }
});

export const ProjectCameraRemoveReceiptSchema = z.strictObject({
  cameraMoveId: CameraMoveIdSchema,
  cameraMoves: z.number().int().safe().nonnegative().max(4_096),
  keyframeCount: z.number().int().safe().min(2).max(4_096),
  nextCommands: z.strictObject({
    show: AgentCommandSchema,
  }),
  operation: z.literal("remove"),
  planHash: Sha256Schema,
  projectId: VideoProjectIdSchema,
}).superRefine((receipt, context) => {
  const expected = projectCameraNextCommands(receipt.projectId, receipt.cameraMoveId);
  if (receipt.nextCommands.show !== expected.show) {
    context.addIssue({
      code: "custom",
      message: "Camera receipt show command must exactly match its project ID.",
      path: ["nextCommands", "show"],
    });
  }
});

export const ProjectCameraEditReceiptSchema = z.union([
  ProjectCameraCreateReceiptSchema,
  ProjectCameraRemoveReceiptSchema,
]);

export type ProjectCameraSelectionReceipt = ReadonlyInferred<
  typeof ProjectCameraSelectionReceiptSchema
>;
export type ProjectCameraEditReceipt = ReadonlyInferred<
  typeof ProjectCameraEditReceiptSchema
>;
