import { type VectorizeLimits } from "./types.js";
export declare const vectorizeHardLimits: Readonly<{
    maxDecodedPixels: 16777216;
    maxDimension: 4096;
    maxDurationMs: 120000;
    maxInputBytes: number;
    maxOutputBytes: 2000000;
    maxPaths: 12000;
}>;
export declare const vectorizeDefaultLimits: Readonly<{
    maxDurationMs: 30000;
    maxDecodedPixels: 16777216;
    maxDimension: 4096;
    maxInputBytes: number;
    maxOutputBytes: 2000000;
    maxPaths: 12000;
}>;
export declare function resolveVectorizeLimits(input: Partial<VectorizeLimits> | undefined): Readonly<VectorizeLimits>;
export declare class VectorizeDeadline {
    #private;
    constructor(durationMs: number);
    assert(stage: string): void;
    remainingMs(): number;
}
