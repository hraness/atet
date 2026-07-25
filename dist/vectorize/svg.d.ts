import { type DominantOklabDuotoneModel } from "./metrics.js";
export interface CanonicalVectorPath {
    readonly d: string;
    readonly fill: string;
    readonly rgb: readonly [number, number, number];
    readonly transform?: string;
}
export interface CanonicalVector {
    readonly paths: readonly CanonicalVectorPath[];
    readonly svg: string;
}
export declare function canonicalizeVTracerSvg(sourceSvg: string, width: number, height: number, maxPaths: number): CanonicalVector;
export declare function buildColorSvg(paths: readonly CanonicalVectorPath[], width: number, height: number, duotone?: Readonly<{
    model: DominantOklabDuotoneModel;
    palette: readonly [primary: string, secondary: string];
}>): string;
export declare function buildAlphaMaskedSvg(artworkPaths: readonly CanonicalVectorPath[], maskPaths: readonly CanonicalVectorPath[], width: number, height: number, duotone?: Readonly<{
    model: DominantOklabDuotoneModel;
    palette: readonly [primary: string, secondary: string];
}>): string;
export declare function countSvgPaths(svg: string): number;
export declare function assertSafeCanonicalSvg(svg: string): void;
