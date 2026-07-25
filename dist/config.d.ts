import type { LoadedConfig } from "./types.js";
export declare function loadDiagramConfig(options: {
    readonly explicitPath?: string;
    readonly searchDirectory: string;
}): Promise<LoadedConfig>;
