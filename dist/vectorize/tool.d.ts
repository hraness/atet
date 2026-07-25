import { type VectorizeDeadline } from "./limits.js";
export declare const VTRACER_VERSION = "0.6.4";
interface VTracerRelease {
    readonly archiveSha256: string;
    readonly binarySha256: string;
    readonly format: "tar.gz" | "zip";
    readonly url: string;
}
/**
 * Hashes were independently recomputed from the five official GitHub release
 * assets and their extracted binaries on 2026-07-25.
 */
export declare const vtracerReleases: Readonly<{
    "darwin-arm64": Readonly<VTracerRelease>;
    "darwin-x64": Readonly<VTracerRelease>;
    "linux-arm64": Readonly<VTracerRelease>;
    "linux-x64": Readonly<VTracerRelease>;
    "win32-x64": Readonly<VTracerRelease>;
}>;
export interface VTracerTool {
    /**
     * A conversion-private executable copied through one verified source handle.
     * Callers must remove its containing conversion directory when finished.
     */
    readonly path: string;
    readonly sha256: string;
    readonly source: "official-release" | "override";
    readonly version: string;
}
export declare function ensureVTracer(deadline: VectorizeDeadline, privateDirectory: string, cacheDirectory?: string): Promise<VTracerTool>;
export {};
