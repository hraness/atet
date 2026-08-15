import { z } from "zod";

import { ApplicationError } from "./errors";
import {
  RESOURCE_KINDS,
  type BoundedOperationSummary,
  type OperationDefinition,
  type OperationExecutionContext,
  type OperationKind,
  type OperationPolicy,
  type OperationRequest,
  type OperationResult,
} from "./operation";

export interface OperationDiscovery {
  readonly inputSchemaId: string;
  readonly kind: OperationKind;
  readonly lifecycle: OperationDefinition["lifecycle"]["kind"];
  readonly outputSchemaId: string;
  readonly policy: OperationPolicy;
  readonly version: number;
}

export interface OperationDescription extends OperationDiscovery {
  readonly inputJsonSchema: Readonly<Record<string, unknown>>;
  readonly outputJsonSchema: Readonly<Record<string, unknown>>;
}

export interface RegisteredOperation {
  readonly discovery: OperationDiscovery;
  describe(): OperationDescription;
  execute(context: OperationExecutionContext, input: unknown): Promise<OperationResult>;
}

function registryKey(kind: string, version: number): string {
  return `${kind}@${String(version)}`;
}

function canonicalOperationKind(kind: string): string | null {
  switch (kind) {
    case "transmute.diagram.check": return "atet.diagram.check";
    case "transmute.diagram.render": return "atet.diagram.render";
    case "transmute.image.generate": return "atet.image.generate";
    case "transmute.image.vectorize": return "atet.image.vectorize";
    default: return null;
  }
}

function predecessorAlias(kind: string, operation: RegisteredOperation): RegisteredOperation {
  const discovery = Object.freeze({
    ...operation.discovery,
    inputSchemaId: operation.discovery.inputSchemaId.replace(/^atet\./u, "transmute."),
    kind,
    outputSchemaId: operation.discovery.outputSchemaId.replace(/^atet\./u, "transmute."),
  }) as OperationDiscovery;
  return Object.freeze({
    discovery,
    describe: () => ({ ...operation.describe(), ...discovery }),
    execute: async (context: OperationExecutionContext, input: unknown) => {
      const result = await operation.execute(context, input);
      return {
        ...result,
        kind,
        summary: { ...result.summary, kind },
      } as OperationResult;
    },
  });
}

function validatePolicy(policy: OperationPolicy): void {
  if (!Number.isSafeInteger(policy.maxDurationMs) || policy.maxDurationMs < 1) {
    throw new ApplicationError("invalid-data", "Operation duration limit must be a positive safe integer.");
  }
  for (const [name, value] of [
    ["fan-out", policy.maxFanOut],
    ["input byte", policy.maxInputBytes],
    ["output byte", policy.maxOutputBytes],
  ] as const) {
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new ApplicationError("invalid-data", `Operation ${name} limit must be a nonnegative safe integer.`);
    }
  }
  const knownResources = new Set<string>(RESOURCE_KINDS);
  const seen = new Set<string>();
  for (const claim of policy.resources) {
    if (!knownResources.has(claim.resource)) {
      throw new ApplicationError("invalid-data", `Unknown operation resource: ${claim.resource}`);
    }
    if (seen.has(claim.resource)) {
      throw new ApplicationError("invalid-data", `Duplicate operation resource claim: ${claim.resource}`);
    }
    if (!Number.isSafeInteger(claim.amount) || claim.amount < 1) {
      throw new ApplicationError("invalid-data", `Resource ${claim.resource} must claim a positive safe integer.`);
    }
    seen.add(claim.resource);
  }
}

function eraseDefinition<Input, Output>(
  definition: OperationDefinition<OperationKind, Input, Output>,
): RegisteredOperation {
  validatePolicy(definition.policy);
  if (!Number.isSafeInteger(definition.version) || definition.version < 1) {
    throw new ApplicationError("invalid-data", "Operation versions must be positive safe integers.");
  }
  const discovery: OperationDiscovery = Object.freeze({
    inputSchemaId: definition.inputSchemaId,
    kind: definition.kind,
    lifecycle: definition.lifecycle.kind,
    outputSchemaId: definition.outputSchemaId,
    policy: definition.policy,
    version: definition.version,
  });
  return Object.freeze({
    describe: (): OperationDescription => ({
      ...discovery,
      inputJsonSchema: {
        ...z.toJSONSchema(definition.inputSchema),
        $id: definition.inputSchemaId,
      },
      outputJsonSchema: {
        ...z.toJSONSchema(definition.outputSchema),
        $id: definition.outputSchemaId,
      },
    }),
    discovery,
    execute: async (context: OperationExecutionContext, input: unknown): Promise<OperationResult> => {
      const parsedInput = definition.inputSchema.parse(input);
      const output = definition.outputSchema.parse(
        await definition.lifecycle.execute(context, parsedInput),
      );
      const summary: BoundedOperationSummary = definition.summarize(output);
      if (summary.kind !== definition.kind || Object.keys(summary.fields).length > 32) {
        throw new ApplicationError("internal", `Operation ${definition.kind} returned an invalid summary.`);
      }
      const receiptReference = definition.receiptReference?.(output);
      if (
        receiptReference !== undefined
        && (
          receiptReference.length < 1
          || receiptReference.length > 2_048
          || receiptReference.includes("\0")
        )
      ) {
        throw new ApplicationError(
          "internal",
          `Operation ${definition.kind} returned an invalid receipt reference.`,
        );
      }
      return {
        kind: definition.kind,
        output,
        ...(receiptReference === undefined ? {} : { receiptReference }),
        summary,
        version: definition.version,
      };
    },
  });
}

export class OperationRegistry {
  readonly #operations = new Map<string, RegisteredOperation>();

  register<Input, Output>(
    definition: OperationDefinition<OperationKind, Input, Output>,
  ): void {
    const key = registryKey(definition.kind, definition.version);
    if (this.#operations.has(key)) {
      throw new ApplicationError("conflict", `Duplicate operation definition: ${key}`);
    }
    this.#operations.set(key, eraseDefinition(definition));
  }

  get(kind: string, version: number): RegisteredOperation {
    const operation = this.#operations.get(registryKey(kind, version));
    if (operation === undefined) {
      const canonical = canonicalOperationKind(kind);
      const canonicalOperation = canonical === null
        ? undefined
        : this.#operations.get(registryKey(canonical, version));
      if (canonicalOperation !== undefined) return predecessorAlias(kind, canonicalOperation);
    }
    if (operation === undefined) {
      throw new ApplicationError("unsupported-plan", `Unsupported operation: ${kind}@${String(version)}`);
    }
    return operation;
  }

  describe(kind: string, version: number): OperationDescription {
    return this.get(kind, version).describe();
  }

  list(): readonly OperationDiscovery[] {
    return Object.freeze([...this.#operations.values()]
      .map(operation => operation.discovery)
      .sort((left, right) => (
        left.kind.localeCompare(right.kind) || left.version - right.version
      )));
  }

  async execute(
    context: OperationExecutionContext,
    request: OperationRequest,
  ): Promise<OperationResult> {
    return await this.get(request.kind, request.version).execute(context, request.input);
  }
}
