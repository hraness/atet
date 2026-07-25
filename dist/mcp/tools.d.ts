import { WorkspaceBoundary } from "./boundary.js";
import type { McpToolDefinition, McpToolResult } from "./types.js";
export declare const mcpMaximumScale = 4;
export declare const mcpMaximumRenderedPixels = 16777216;
export declare const mcpMaximumShapes = 64;
export declare const mcpMaximumEdges = 128;
export declare const mcpMaximumReturnedFindings = 40;
export declare const graphicsMcpTools: readonly McpToolDefinition[];
export declare class GraphicsMcpToolRuntime {
    readonly boundary: WorkspaceBoundary;
    private renderQueue;
    private constructor();
    static create(rootDirectory: string): Promise<GraphicsMcpToolRuntime>;
    private enqueueRender;
    call(name: string, argumentsValue: unknown): Promise<McpToolResult>;
    private check;
    private render;
}
