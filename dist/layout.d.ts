import type { DiagramSource, DiagramSpec, StackDiagramSource } from "./types.js";
export declare const stackLayoutDefaults: {
    readonly gap: 160;
    readonly padding: 64;
    readonly align: "center";
};
export declare class StackLayoutError extends Error {
    readonly issues: readonly string[];
    constructor(issues: readonly string[]);
}
export declare function resolveStackLayout(source: StackDiagramSource): DiagramSpec;
export declare function resolveDiagramSource(source: DiagramSource): DiagramSpec;
