import { type VectorizeErrorCode, type VectorizeOptions, type VectorizeResult } from "./types.js";
export declare const VECTORIZE_WORKER_PROTOCOL = 1;
export declare const MAX_VECTORIZE_REQUEST_BYTES: number;
export declare const MAX_VECTORIZE_RESPONSE_BYTES: number;
export type VectorizeWorkerInput = Readonly<{
    kind: "bytes";
    value: string;
}> | Readonly<{
    kind: "path";
    value: string;
}>;
export interface VectorizeWorkerRequest {
    readonly input: VectorizeWorkerInput;
    readonly options: VectorizeOptions;
    readonly protocol: typeof VECTORIZE_WORKER_PROTOCOL;
    /** Conversion-private directory created and removed by the supervisor. */
    readonly temporaryRoot: string;
}
export type VectorizeWorkerResponse = Readonly<{
    error: Readonly<{
        code: VectorizeErrorCode;
        details: Readonly<Record<string, unknown>>;
        message: string;
    }>;
    ok: false;
    protocol: typeof VECTORIZE_WORKER_PROTOCOL;
}> | Readonly<{
    ok: true;
    protocol: typeof VECTORIZE_WORKER_PROTOCOL;
    result: VectorizeResult;
}>;
