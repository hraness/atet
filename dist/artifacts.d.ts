import type { LintFinding, RenderArtifacts } from "./types.js";
export declare function readDiagramFile(filePath: string): Promise<{
    absolutePath: string;
    spec: import("./types.js").DiagramSpec;
}>;
export declare function checkDiagramFile(options: {
    readonly filePath: string;
    readonly configPath?: string;
}): Promise<{
    readonly findings: readonly LintFinding[];
    readonly configPath: string | null;
}>;
export declare function renderDiagramFile(options: {
    readonly filePath: string;
    readonly outDirectory?: string;
    readonly configPath?: string;
    readonly scale?: number;
}): Promise<{
    readonly artifacts: RenderArtifacts;
    readonly findings: readonly LintFinding[];
    readonly configPath: string | null;
}>;
export declare function artifactSummary(artifacts: RenderArtifacts): string;
