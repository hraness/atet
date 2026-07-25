import type { Anchor, BoxShape, ColorMode, DiagramConfig, DiagramEdge, DiagramSpec, RenderedDiagram } from "./types.js";
declare function pointForAnchor(shape: BoxShape, anchor: Anchor | undefined, toward: {
    readonly x: number;
    readonly y: number;
}): {
    readonly x: number;
    readonly y: number;
    readonly normalized: {
        readonly x: number;
        readonly y: number;
    };
};
export interface ResolvedEdge {
    readonly edge: DiagramEdge;
    readonly from: BoxShape;
    readonly to: BoxShape;
    readonly start: ReturnType<typeof pointForAnchor>;
    readonly end: ReturnType<typeof pointForAnchor>;
    readonly control: {
        readonly x: number;
        readonly y: number;
    };
}
export declare function resolveEdge(spec: DiagramSpec, edge: DiagramEdge): ResolvedEdge;
export declare function renderSvg(spec: DiagramSpec, mode: ColorMode, config: DiagramConfig): Promise<RenderedDiagram>;
export declare function renderPng(rendered: RenderedDiagram, config: DiagramConfig, scale?: number): Uint8Array;
export {};
