import type { z } from "zod";

import {
  canonicalJson,
  createNodeBundleFileSystem,
  saveImmutableText,
  sha256Hex,
  type BundleFileSystem,
} from "../../../core";
import type { ApplicationContext } from "../../context";
import {
  CreativeCandidateReferenceV1Schema,
  CreativeCandidateV1Schema,
  CreativeImmutableArtifactSchema,
  creativeCandidateReferenceV1,
  variantMatrixReferenceV1,
  VariantMatrixReferenceV1Schema,
  VariantMatrixV1Schema,
  variantSelectionReferenceV1,
  VariantSelectionReferenceV1Schema,
  VariantSelectionV1Schema,
  type CreativeCandidateReferenceV1,
  type CreativeCandidateV1,
  type VariantMatrixReferenceV1,
  type VariantMatrixV1,
  type VariantSelectionReferenceV1,
  type VariantSelectionV1,
} from "../../creative-iteration";
import { ApplicationError } from "../../errors";
import {
  ProjectEditRevisionDocumentSchema,
  ProjectRenderReceiptV2Schema,
  type ProjectEditRevisionDocument,
} from "../../receipts";
import { exactProjectDirectory } from "../render/project-plan";

type CreativeImmutableArtifact = z.infer<
  typeof CreativeImmutableArtifactSchema
>;

function parseJson(text: string, label: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new ApplicationError(
      "invalid-data",
      `${label} is not valid JSON.`,
    );
  }
}

export async function creativeProjectFileSystem(
  application: ApplicationContext,
  projectId: string,
): Promise<BundleFileSystem> {
  return createNodeBundleFileSystem(await exactProjectDirectory(
    application,
    projectId,
  ));
}

export async function publishCreativeDocument<Document>(input: {
  readonly document: Document;
  readonly fileSystem: BundleFileSystem;
  readonly path: string;
  readonly schema: z.ZodType<Document>;
}): Promise<CreativeImmutableArtifact> {
  const document = input.schema.parse(input.document);
  const contents = `${canonicalJson(document)}\n`;
  const artifact = CreativeImmutableArtifactSchema.parse({
    bytes: new TextEncoder().encode(contents).byteLength,
    path: input.path,
    sha256: sha256Hex(contents),
  });
  await saveImmutableText(
    input.fileSystem,
    artifact.path,
    contents,
    artifact.sha256,
  );
  return artifact;
}

export async function loadCreativeDocument<Document>(input: {
  readonly artifact: CreativeImmutableArtifact;
  readonly fileSystem: BundleFileSystem;
  readonly label: string;
  readonly schema: z.ZodType<Document>;
}): Promise<Document> {
  const artifact = CreativeImmutableArtifactSchema.parse(input.artifact);
  const contents = await input.fileSystem.readText(artifact.path);
  const bytes = new TextEncoder().encode(contents).byteLength;
  if (bytes !== artifact.bytes || sha256Hex(contents) !== artifact.sha256) {
    throw new ApplicationError(
      "conflict",
      `${input.label} physical artifact hash or byte count changed.`,
    );
  }
  const document = input.schema.parse(parseJson(contents, input.label));
  if (contents !== `${canonicalJson(document)}\n`) {
    throw new ApplicationError(
      "invalid-data",
      `${input.label} is not canonical immutable JSON.`,
    );
  }
  return document;
}

export async function loadCreativeCandidate(input: {
  readonly fileSystem: BundleFileSystem;
  readonly reference: CreativeCandidateReferenceV1;
}): Promise<CreativeCandidateV1> {
  const reference = CreativeCandidateReferenceV1Schema.parse(input.reference);
  const candidate = await loadCreativeDocument({
    artifact: reference.artifact,
    fileSystem: input.fileSystem,
    label: "Creative candidate",
    schema: CreativeCandidateV1Schema,
  });
  const expected = creativeCandidateReferenceV1({
    artifact: reference.artifact,
    candidate,
  });
  if (canonicalJson(expected) !== canonicalJson(reference)) {
    throw new ApplicationError(
      "conflict",
      "Creative candidate document does not match its reference.",
    );
  }
  return candidate;
}

export async function loadVariantMatrix(input: {
  readonly fileSystem: BundleFileSystem;
  readonly reference: VariantMatrixReferenceV1;
}): Promise<VariantMatrixV1> {
  const reference = VariantMatrixReferenceV1Schema.parse(input.reference);
  const matrix = await loadCreativeDocument({
    artifact: reference.artifact,
    fileSystem: input.fileSystem,
    label: "Variant matrix",
    schema: VariantMatrixV1Schema,
  });
  const expected = variantMatrixReferenceV1({
    artifact: reference.artifact,
    matrix,
  });
  if (canonicalJson(expected) !== canonicalJson(reference)) {
    throw new ApplicationError(
      "conflict",
      "Variant matrix document does not match its reference.",
    );
  }
  return matrix;
}

export async function loadVariantSelection(input: {
  readonly fileSystem: BundleFileSystem;
  readonly reference: VariantSelectionReferenceV1;
}): Promise<VariantSelectionV1> {
  const reference = VariantSelectionReferenceV1Schema.parse(input.reference);
  const selection = await loadCreativeDocument({
    artifact: reference.artifact,
    fileSystem: input.fileSystem,
    label: "Variant selection",
    schema: VariantSelectionV1Schema,
  });
  const expected = variantSelectionReferenceV1({
    artifact: reference.artifact,
    selection,
  });
  if (canonicalJson(expected) !== canonicalJson(reference)) {
    throw new ApplicationError(
      "conflict",
      "Variant selection document does not match its reference.",
    );
  }
  return selection;
}

export async function loadCandidateRevision(input: {
  readonly candidate: CreativeCandidateV1;
  readonly fileSystem: BundleFileSystem;
}): Promise<ProjectEditRevisionDocument> {
  const candidate = CreativeCandidateV1Schema.parse(input.candidate);
  const revision = await loadCreativeDocument({
    artifact: candidate.revision.artifact,
    fileSystem: input.fileSystem,
    label: "Creative candidate revision",
    schema: ProjectEditRevisionDocumentSchema,
  });
  if (
    revision.revisionSha256 !== candidate.revision.revisionSha256
    || revision.projectSha256 !== candidate.revision.projectSha256
    || revision.projectEditPlanSha256
      !== candidate.revision.projectEditPlanSha256
    || revision.projectSha256 !== candidate.base.generation.projectSha256
  ) {
    throw new ApplicationError(
      "conflict",
      "Creative candidate revision document does not match its candidate.",
    );
  }
  return revision;
}

export async function verifyCandidateRender(input: {
  readonly candidate: CreativeCandidateV1;
  readonly fileSystem: BundleFileSystem;
  readonly render: CreativeCandidateV1["renders"][number];
}): Promise<void> {
  const receipt = await loadCreativeDocument({
    artifact: {
      bytes: input.render.receipt.bytes,
      path: input.render.receipt.path,
      sha256: input.render.receipt.sha256,
    },
    fileSystem: input.fileSystem,
    label: `Creative candidate render receipt ${input.render.name}`,
    schema: ProjectRenderReceiptV2Schema,
  });
  if (
    receipt.receiptSha256 !== input.render.receipt.receiptSha256
    || receipt.run.nodePlanSha256 !== input.render.receipt.nodePlanSha256
    || receipt.output.sha256 !== input.render.output.sha256
    || canonicalJson(receipt.output) !== canonicalJson(input.render.output)
    || receipt.output.revisionSha256 !== input.candidate.revision.revisionSha256
  ) {
    throw new ApplicationError(
      "conflict",
      `Creative candidate render ${input.render.name} is not bound to its verified receipt.`,
    );
  }
  if (input.fileSystem.inspectFile === undefined) {
    throw new ApplicationError(
      "internal",
      "Project storage does not support immutable render verification.",
    );
  }
  const integrity = await input.fileSystem.inspectFile(input.render.output.path);
  if (
    integrity.bytes !== input.render.output.bytes
    || integrity.sha256 !== input.render.output.sha256
  ) {
    throw new ApplicationError(
      "conflict",
      `Creative candidate render ${input.render.name} bytes changed after verification.`,
    );
  }
}
