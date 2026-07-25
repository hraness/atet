export declare function sha256(input: string | Uint8Array): string;
export declare function sanitizedTraceRgba(rgba: Uint8Array, minimumAlpha: number): Uint8Array;
export declare function alphaPlaneTraceRgba(rgba: Uint8Array): Uint8Array;
export declare function lowAlphaMassRatio(rgba: Uint8Array, cutoff: number): number;
export declare function hasFractionalAlpha(rgba: Uint8Array): boolean;
export declare function normalizedPremultipliedRmse(source: Uint8Array, candidate: Uint8Array): number;
export declare function normalizedAlphaRmse(source: Uint8Array, candidate: Uint8Array): number;
export interface SupportMetrics {
    readonly outsideAlphaRatio: number;
    readonly supportRecall: number;
}
export declare function measureSupport(source: Uint8Array, candidate: Uint8Array, width: number, height: number, dilation?: number): SupportMetrics;
type OklabColor = readonly [number, number, number];
export interface DominantOklabDuotoneModel {
    readonly cutoff: number;
    readonly primary: OklabColor;
    readonly primaryShare: number;
}
export declare function parseHexColor(value: string): readonly [number, number, number];
export declare function normalizedHexColor(value: string): string;
export declare function oklabDistance(left: OklabColor, right: OklabColor): number;
export declare function dominantOklabDuotoneModel(rgba: Uint8Array): DominantOklabDuotoneModel;
export declare function colorBelongsToPrimary(rgb: readonly [number, number, number], model: DominantOklabDuotoneModel): boolean;
export {};
