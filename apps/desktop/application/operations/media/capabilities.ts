import { z } from "zod";

import { canonicalJson } from "../../../core/canonical-json";
import {
  ExactCapabilityApplicationRunner,
  ExactCapabilityBindingSchema,
  assertExactCapabilityBindings,
  bindExactCapabilities,
  exactCapabilityByName,
  type ExactCapabilityBinding,
} from "../../capability-binding";
import type {
  ApplicationContext,
  ApplicationProcessRunner,
} from "../../context";
import { ApplicationError } from "../../errors";

const MEDIA_CAPABILITY_NAMES = ["ffmpeg", "ffprobe", "html-browser"] as const;
export type MediaCapabilityName = typeof MEDIA_CAPABILITY_NAMES[number];

export const MediaCapabilityBindingSchema = ExactCapabilityBindingSchema
  .extend({
    name: z.enum(MEDIA_CAPABILITY_NAMES),
  })
  .strict();

export const MediaCapabilityBindingsSchema = z.array(
  MediaCapabilityBindingSchema,
).max(MEDIA_CAPABILITY_NAMES.length).superRefine((bindings, context) => {
  for (let index = 0; index < bindings.length; index += 1) {
    const previous = bindings[index - 1];
    if (
      previous !== undefined
      && previous.name.localeCompare(bindings[index]!.name) >= 0
    ) {
      context.addIssue({
        code: "custom",
        message: "Media capability bindings must have unique sorted names.",
        path: [index, "name"],
      });
    }
  }
});

export async function bindMediaCapabilities(
  application: ApplicationContext,
  names: readonly MediaCapabilityName[],
): Promise<z.infer<typeof MediaCapabilityBindingsSchema>> {
  return MediaCapabilityBindingsSchema.parse(
    await bindExactCapabilities(application, names),
  );
}

export async function bindExpectedMediaCapabilities(
  application: ApplicationContext,
  names: readonly MediaCapabilityName[],
  expected: z.infer<typeof MediaCapabilityBindingsSchema> | undefined,
): Promise<z.infer<typeof MediaCapabilityBindingsSchema>> {
  const current = await bindMediaCapabilities(application, names);
  if (
    expected !== undefined
    && canonicalJson(expected) !== canonicalJson(current)
  ) {
    throw new ApplicationError(
      "conflict",
      "A media capability changed after exact node planning.",
    );
  }
  return current;
}

export async function assertMediaCapabilities(
  context: { readonly workflow?: unknown },
  application: ApplicationContext,
  expected: z.infer<typeof MediaCapabilityBindingsSchema> | undefined,
  names: readonly MediaCapabilityName[],
): Promise<void> {
  if (context.workflow !== undefined && expected === undefined) {
    throw new ApplicationError(
      "incompatible",
      "Workflow media operations require exact capability bindings.",
    );
  }
  if (expected !== undefined) {
    await assertExactCapabilityBindings(application, expected, names);
  }
}

export function mediaCapabilityCommand(
  expected: readonly ExactCapabilityBinding[],
  name: MediaCapabilityName,
): string {
  return exactCapabilityByName(expected, name).executablePath;
}

export function mediaCapabilityVersion(
  expected: readonly ExactCapabilityBinding[],
  name: MediaCapabilityName,
): string {
  return exactCapabilityByName(expected, name).version;
}

export function mediaCapabilityRunner(
  application: Pick<ApplicationContext, "paths" | "runner">,
  expected: readonly ExactCapabilityBinding[],
): ApplicationProcessRunner {
  return new ExactCapabilityApplicationRunner(
    application.runner,
    expected,
    application.paths.privateRoot,
  );
}
