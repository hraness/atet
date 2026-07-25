import { type DiagramSource, type DiagramSpec } from "./types.js";
export declare class DiagramValidationError extends Error {
    readonly issues: readonly string[];
    constructor(issues: readonly string[]);
}
export declare function parseDiagramSource(value: unknown): DiagramSource;
export declare function parseDiagramSpec(value: unknown): DiagramSpec;
