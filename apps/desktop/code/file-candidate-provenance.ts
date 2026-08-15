import { ApplicationError } from "../application/errors";
import {
  canonicalJson,
  sha256Hex,
} from "../core/canonical-json";
import {
  isOperationGraphNode,
  type AuthoredWorkflowGraphV1,
  type CandidateDescriptor,
  type GraphInputValue,
  type JsonValue,
} from "./contracts";
import type { NodeExecutionPlanningRequest } from "./scheduler";
import {
  WorkflowFileCandidateSchema,
  type WorkflowFileCandidate,
} from "./file-candidate";

const FILE_CANDIDATE_DOMAIN = "studio.workflow.file-candidate/v1";

interface FileClaim {
  readonly bytes?: number;
  readonly mediaType?: string;
  readonly path: string;
  readonly sha256?: string;
}

function record(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function reference(value: unknown): boolean {
  return record(value) && Object.hasOwn(value, "$ref");
}

function field(value: unknown, key: string): unknown {
  return record(value) ? value[key] : undefined;
}

function claim(value: unknown): FileClaim | undefined {
  if (!record(value) || reference(value) || typeof value.path !== "string") {
    return undefined;
  }
  return {
    ...(typeof value.bytes === "number" ? { bytes: value.bytes } : {}),
    ...(typeof value.mediaType === "string"
      ? { mediaType: value.mediaType }
      : {}),
    path: value.path,
    ...(typeof value.sha256 === "string" ? { sha256: value.sha256 } : {}),
  };
}

function array(value: unknown): readonly unknown[] {
  return Array.isArray(value) ? value : [];
}

function optionalClaim(value: unknown): readonly FileClaim[] {
  const parsed = claim(value);
  return parsed === undefined ? [] : [parsed];
}

function optionalPathClaim(value: unknown): readonly FileClaim[] {
  if (typeof value === "string") return [{ path: value }];
  return optionalClaim(value);
}

/**
 * Returns only fields whose operation contract grants local-file authority.
 * Other path-looking values (for example output destinations) are excluded.
 */
export function operationFileClaims(
  operation: string,
  input: GraphInputValue | JsonValue,
): readonly FileClaim[] {
  if (!record(input)) return [];
  if (operation === "media.ingest") {
    return optionalClaim(Reflect.get(input, "source"));
  }
  if (operation === "media.overlay") {
    const source = field(input, "source");
    return record(source)
      ? optionalClaim(field(source, "artifact"))
      : [];
  }
  if (operation === "media.html-overlay") {
    return [
      ...optionalClaim(field(input, "document")),
      ...array(field(input, "resources")).flatMap((resource) => (
        record(resource)
          ? optionalClaim(field(resource, "artifact"))
          : []
      )),
    ];
  }
  if (
    operation === "media.audio-effects"
    || operation === "media.color-grade"
  ) {
    return optionalClaim(Reflect.get(input, "input"));
  }
  if (
    operation === "atet.diagram.check"
    || operation === "atet.diagram.render"
  ) {
    return optionalPathClaim(Reflect.get(input, "path"));
  }
  if (operation === "atet.image.vectorize") {
    return optionalPathClaim(Reflect.get(input, "inputPath"));
  }
  if (operation === "gateway.image") {
    return [
      ...array(Reflect.get(input, "images")).flatMap(
        value => claim(value) ?? [],
      ),
      ...optionalClaim(Reflect.get(input, "mask")),
    ];
  }
  if (operation === "gateway.video") {
    const frames = array(Reflect.get(input, "frames")).flatMap((value) => {
      if (!record(value)) return [];
      return optionalClaim(value.source);
    });
    return [
      ...frames,
      ...optionalClaim(Reflect.get(input, "promptImage")),
      ...array(Reflect.get(input, "references")).flatMap(
        value => claim(value) ?? [],
      ),
    ];
  }
  if (operation === "gateway.transcription") {
    return optionalClaim(Reflect.get(input, "audio"));
  }
  return [];
}

function descriptorBody(
  input: Omit<CandidateDescriptor, "descriptorSha256">,
): Omit<CandidateDescriptor, "descriptorSha256"> {
  return {
    ...(input.bytes === undefined ? {} : { bytes: input.bytes }),
    id: input.id,
    kind: input.kind,
    ...(input.mediaType === undefined ? {} : { mediaType: input.mediaType }),
    ...(input.sha256 === undefined ? {} : { sha256: input.sha256 }),
  };
}

export function fileCandidateDescriptor(
  input: Omit<CandidateDescriptor, "descriptorSha256">,
): CandidateDescriptor {
  const body = descriptorBody(input);
  return {
    ...body,
    descriptorSha256: sha256Hex(
      `${FILE_CANDIDATE_DOMAIN}\0${canonicalJson(body)}`,
    ),
  };
}

function assertDescriptorIntegrity(candidate: CandidateDescriptor): void {
  const expected = fileCandidateDescriptor(descriptorBody(candidate));
  if (candidate.descriptorSha256 !== expected.descriptorSha256) {
    throw new ApplicationError(
      "invalid-data",
      `Static file candidate ${candidate.id} has an invalid descriptor digest.`,
    );
  }
}

export function collectLiteralFileCandidates(
  graph: AuthoredWorkflowGraphV1,
): readonly CandidateDescriptor[] {
  const claims = new Map<string, FileClaim>();
  for (const node of graph.nodes) {
    if (!isOperationGraphNode(node)) continue;
    const operation = node.executor.operation.kind;
    for (const authored of operationFileClaims(operation, node.input)) {
      const existing = claims.get(authored.path);
      if (
        existing !== undefined
        && (
          (
            existing.bytes !== undefined
            && authored.bytes !== undefined
            && existing.bytes !== authored.bytes
          )
          || (
            existing.sha256 !== undefined
            && authored.sha256 !== undefined
            && existing.sha256 !== authored.sha256
          )
          || (
            existing.mediaType !== undefined
            && authored.mediaType !== undefined
            && existing.mediaType !== authored.mediaType
          )
        )
      ) {
        throw new ApplicationError(
          "conflict",
          `File candidate ${authored.path} was authored with conflicting descriptors.`,
        );
      }
      claims.set(authored.path, {
        ...(existing?.bytes ?? authored.bytes) === undefined
          ? {}
          : { bytes: existing?.bytes ?? authored.bytes },
        ...(existing?.mediaType ?? authored.mediaType) === undefined
          ? {}
          : { mediaType: existing?.mediaType ?? authored.mediaType },
        path: authored.path,
        ...(existing?.sha256 ?? authored.sha256) === undefined
          ? {}
          : { sha256: existing?.sha256 ?? authored.sha256 },
      });
    }
  }
  return [...claims.values()]
    .map(candidate => fileCandidateDescriptor({
      ...(candidate.bytes === undefined ? {} : { bytes: candidate.bytes }),
      id: candidate.path,
      kind: "file",
      ...(candidate.mediaType === undefined
        ? {}
        : { mediaType: candidate.mediaType }),
      ...(candidate.sha256 === undefined ? {} : { sha256: candidate.sha256 }),
    }))
    .sort((left, right) => left.id.localeCompare(right.id));
}

function declaredCandidate(
  declaration: WorkflowFileCandidate,
): CandidateDescriptor {
  return fileCandidateDescriptor({
    ...(declaration.bytes === undefined ? {} : { bytes: declaration.bytes }),
    id: declaration.path,
    kind: "file",
    ...(declaration.mediaType === undefined
      ? {}
      : { mediaType: declaration.mediaType }),
    ...(declaration.sha256 === undefined
      ? {}
      : { sha256: declaration.sha256 }),
  });
}

export function collectDeclaredFileCandidates(
  value: unknown,
): readonly CandidateDescriptor[] {
  if (Array.isArray(value)) return value.flatMap(collectDeclaredFileCandidates);
  if (!record(value)) return [];
  if (
    Reflect.get(value, "kind") === "file"
    && Reflect.get(value, "version") === "atet-workflow-file-candidate-v1"
  ) {
    return [declaredCandidate(WorkflowFileCandidateSchema.parse(value))];
  }
  return Object.values(value).flatMap(collectDeclaredFileCandidates);
}

export function mergeFileCandidateDescriptors(
  groups: readonly (readonly CandidateDescriptor[])[],
): readonly CandidateDescriptor[] {
  const merged = new Map<string, FileClaim>();
  for (const candidate of groups.flat()) {
    if (candidate.kind !== "file") continue;
    assertDescriptorIntegrity(candidate);
    const existing = merged.get(candidate.id);
    const next: FileClaim = {
      ...(candidate.bytes === undefined ? {} : { bytes: candidate.bytes }),
      ...(candidate.mediaType === undefined
        ? {}
        : { mediaType: candidate.mediaType }),
      path: candidate.id,
      ...(candidate.sha256 === undefined ? {} : { sha256: candidate.sha256 }),
    };
    if (
      existing !== undefined
      && (
        (
          existing.bytes !== undefined
          && next.bytes !== undefined
          && existing.bytes !== next.bytes
        )
        || (
          existing.sha256 !== undefined
          && next.sha256 !== undefined
          && existing.sha256 !== next.sha256
        )
        || (
          existing.mediaType !== undefined
          && next.mediaType !== undefined
          && existing.mediaType !== next.mediaType
        )
      )
    ) {
      throw new ApplicationError(
        "conflict",
        `File candidate ${candidate.id} was declared with conflicting descriptors.`,
      );
    }
    merged.set(candidate.id, {
      ...(existing?.bytes ?? next.bytes) === undefined
        ? {}
        : { bytes: existing?.bytes ?? next.bytes },
      ...(existing?.mediaType ?? next.mediaType) === undefined
        ? {}
        : { mediaType: existing?.mediaType ?? next.mediaType },
      path: candidate.id,
      ...(existing?.sha256 ?? next.sha256) === undefined
        ? {}
        : { sha256: existing?.sha256 ?? next.sha256 },
    });
  }
  return [...merged.values()]
    .map(candidate => fileCandidateDescriptor({
      ...(candidate.bytes === undefined ? {} : { bytes: candidate.bytes }),
      id: candidate.path,
      kind: "file",
      ...(candidate.mediaType === undefined
        ? {}
        : { mediaType: candidate.mediaType }),
      ...(candidate.sha256 === undefined ? {} : { sha256: candidate.sha256 }),
    }))
    .sort((left, right) => left.id.localeCompare(right.id));
}

function exactClaimMatches(left: FileClaim, right: FileClaim): boolean {
  return left.path === right.path
    && (left.bytes === undefined || left.bytes === right.bytes)
    && (left.sha256 === undefined || left.sha256 === right.sha256)
    && (left.mediaType === undefined || left.mediaType === right.mediaType);
}

function candidateMatches(
  requested: FileClaim,
  candidate: CandidateDescriptor,
): boolean {
  return requested.path === candidate.id
    && (candidate.bytes === undefined || candidate.bytes === requested.bytes)
    && (
      candidate.sha256 === undefined
      || candidate.sha256 === requested.sha256
    )
    && (
      candidate.mediaType === undefined
      || candidate.mediaType === requested.mediaType
    );
}

function collectExactClaims(value: unknown): readonly FileClaim[] {
  if (Array.isArray(value)) return value.flatMap(collectExactClaims);
  if (!record(value)) return [];
  const direct = claim(value);
  const nested = Object.values(value).flatMap(collectExactClaims);
  if (
    direct === undefined
    || direct.bytes === undefined
    || direct.sha256 === undefined
  ) {
    return nested;
  }
  return [direct, ...nested];
}

function hostDependencyClaims(
  request: NodeExecutionPlanningRequest,
): readonly FileClaim[] {
  const nodes = new Map(
    request.graphPlan.graph.nodes.map(node => [node.key, node]),
  );
  return Object.entries(request.dependencyOutputs).flatMap(
    ([nodeKey, output]) => {
      const node = nodes.get(nodeKey);
      return node !== undefined && isOperationGraphNode(node)
        ? collectExactClaims(output.value)
        : [];
    },
  );
}

export function assertOperationFileProvenance(
  request: NodeExecutionPlanningRequest,
): void {
  const claims = operationFileClaims(
    request.operation.kind,
    request.resolvedInput,
  );
  if (claims.length === 0) return;
  const candidates = request.graphPlan.staticBindings.candidates.filter(
    candidate => candidate.kind === "file",
  );
  for (const candidate of candidates) assertDescriptorIntegrity(candidate);
  const hostClaims = hostDependencyClaims(request);
  for (const requested of claims) {
    const authorizedByPlan = candidates.some(candidate =>
      candidateMatches(requested, candidate));
    const authorizedByHost = hostClaims.some(candidate =>
      exactClaimMatches(requested, candidate));
    if (!authorizedByPlan && !authorizedByHost) {
      throw new ApplicationError(
        "authorization-required",
        `Node ${request.node.key} received undeclared local media: ${requested.path}`,
        {
          operation: request.operation.kind,
          path: requested.path,
        },
      );
    }
  }
}
