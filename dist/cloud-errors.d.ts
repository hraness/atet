export type GraphicsCloudErrorCode = "AUTHORIZATION_FAILED" | "AUTH_CALLBACK_UNAVAILABLE" | "AUTH_REQUIRED" | "AUTH_TIMEOUT" | "DISCOVERY_INVALID" | "DISCOVERY_UNAVAILABLE" | "GENERATION_FAILED" | "GENERATION_INVALID_RESPONSE" | "INVALID_ARGUMENT" | "OUTPUT_WRITE_FAILED" | "REVOCATION_FAILED" | "TOKEN_EXCHANGE_FAILED" | "TOKEN_REFRESH_FAILED" | "TOKEN_STORAGE_FAILED";
/**
 * A stable, redacted failure from the Graphics network boundary.
 *
 * `cause` is retained for local diagnostics but is deliberately not included
 * in the public message or CLI output.
 */
export declare class GraphicsCloudError extends Error {
    readonly code: GraphicsCloudErrorCode;
    constructor(code: GraphicsCloudErrorCode, message: string, options?: ErrorOptions);
}
