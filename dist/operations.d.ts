import { type GraphicsAuthDependencies } from "./auth.js";
import type { LintFinding, RenderArtifacts } from "./types.js";
import { type GeneratedGraphicsImageFile } from "./generate.js";
import { type GraphicsImageModel } from "./discovery.js";
import { type VectorizeReceipt } from "./vectorize/index.js";
export declare const graphicsOperationCodes: readonly ["graphics.diagram.check", "graphics.diagram.render", "graphics.image.vectorize", "graphics.image.generate"];
export type GraphicsOperationCode = (typeof graphicsOperationCodes)[number];
export interface GraphicsOperationDescriptor {
    readonly code: GraphicsOperationCode;
    readonly title: string;
    readonly description: string;
    readonly execution: "local" | "hosted";
    readonly authentication: "none" | "required";
    readonly destructive: boolean;
    readonly idempotent: boolean;
    readonly inputSchema: Readonly<Record<string, unknown>>;
    readonly transport?: {
        readonly method: "POST";
        readonly endpointFromDiscovery: "endpoints.generateImage";
        readonly authorization: "bearer";
        readonly idempotencyHeader: "Idempotency-Key";
        readonly retry: "never";
    };
}
export declare class GraphicsOperationError extends Error {
    readonly code: "INVALID_OPERATION" | "INVALID_OPERATION_INPUT" | "INVALID_SEARCH";
    constructor(code: GraphicsOperationError["code"], message: string);
}
export declare const graphicsOperationRegistry: readonly GraphicsOperationDescriptor[];
export interface CheckGraphicsOperationInput {
    readonly path: string;
}
export interface RenderGraphicsOperationInput extends CheckGraphicsOperationInput {
    readonly outDirectory?: string;
    readonly scale?: number;
}
export interface VectorizeGraphicsOperationInput {
    readonly inputPath: string;
    readonly outputPath: string;
    readonly duotone?: readonly [string, string];
    readonly alphaCutoff?: number;
    readonly timeoutMs?: number;
}
export interface GenerateGraphicsOperationInput {
    readonly model: GraphicsImageModel;
    readonly prompt: string;
    readonly outputPath: string;
    readonly idempotencyKey?: string;
}
export interface GraphicsOperationInputMap {
    readonly "graphics.diagram.check": CheckGraphicsOperationInput;
    readonly "graphics.diagram.render": RenderGraphicsOperationInput;
    readonly "graphics.image.vectorize": VectorizeGraphicsOperationInput;
    readonly "graphics.image.generate": GenerateGraphicsOperationInput;
}
export interface GraphicsOperationResultMap {
    readonly "graphics.diagram.check": {
        readonly findings: readonly LintFinding[];
        readonly configPath: null;
    };
    readonly "graphics.diagram.render": {
        readonly artifacts: RenderArtifacts;
        readonly findings: readonly LintFinding[];
        readonly configPath: null;
    };
    readonly "graphics.image.vectorize": {
        readonly outputPath: string;
        readonly receipt: VectorizeReceipt;
    };
    readonly "graphics.image.generate": GeneratedGraphicsImageFile;
}
export declare function parseGraphicsOperationInput<C extends GraphicsOperationCode>(code: C, input: unknown): GraphicsOperationInputMap[C];
export declare function isGraphicsOperationCode(value: string): value is GraphicsOperationCode;
export declare function searchGraphicsOperations(query?: string, limit?: number): readonly GraphicsOperationDescriptor[];
export type GraphicsOperationDependencies = GraphicsAuthDependencies;
export declare function executeGraphicsOperation<C extends GraphicsOperationCode>(code: C, value: unknown, dependencies?: GraphicsOperationDependencies): Promise<GraphicsOperationResultMap[C]>;
