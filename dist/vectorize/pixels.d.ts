import { type VectorizeDeadline } from "./limits.js";
import { type VectorizeInput, type VectorizeLimits } from "./types.js";
export interface LoadedRaster {
    readonly bytes: Uint8Array;
    readonly format: string;
    readonly height: number;
    readonly inputBytes: number;
    readonly pixels: Uint8Array;
    readonly scoreHeight: number;
    readonly scorePixels: Uint8Array;
    readonly scoreWidth: number;
    readonly sourceSha256: string;
    readonly width: number;
}
export declare function loadRaster(input: VectorizeInput, limits: Readonly<VectorizeLimits>, deadline: VectorizeDeadline): Promise<LoadedRaster>;
export declare function encodeTracePng(pixels: Uint8Array, width: number, height: number): Promise<Uint8Array>;
export declare function renderSvgRgba(svg: string, width: number, height: number, maxDecodedPixels: number): Promise<Uint8Array>;
export declare function sharpProvenance(): Readonly<{
    sharp: string;
    sharpVersions: Readonly<Record<string, string>>;
    vips: string;
}>;
export declare function normalizedPixelToolchain(versions: Readonly<Record<string, string | undefined>>): Readonly<Record<string, string>>;
