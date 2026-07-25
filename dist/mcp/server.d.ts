import type { McpServerOptions } from "./types.js";
export declare const graphicsMcpProtocolVersion = "2025-11-25";
export declare const graphicsMcpServerName = "hraness-graphics";
/**
 * Run one newline-delimited JSON-RPC MCP session. Protocol output is the only
 * stdout surface; callers that need logs must write them to stderr.
 */
export declare function runMcpServer(options?: McpServerOptions): Promise<void>;
