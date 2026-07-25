import { type VectorizeErrorCode } from "./types.js";
export interface CommandResult {
    readonly pipeOutput: string | null;
    readonly stderr: string;
    readonly stdout: string;
}
export interface BoundedOutputPipe {
    readonly maximumBytes: number;
    readonly path: string;
}
export interface BoundedCommandOptions {
    /** Bounded bytes delivered to the child on standard input. */
    readonly stdin?: Uint8Array;
    /** Raise the stdout quota only for a caller that consumes bounded data there. */
    readonly maxStdoutBytes?: number;
    /** Drain an already-created POSIX FIFO while the child writes its file output. */
    readonly outputPipe?: BoundedOutputPipe;
}
/**
 * Keep conversion descendants in the already-isolated worker process group.
 * This is process-local and called only by the worker entrypoint.
 */
export declare function inheritVectorizeWorkerProcessGroup(): void;
export declare function createPrivateOutputPipe(path: string, timeoutMs: number): Promise<void>;
export declare function runBoundedCommand(command: readonly string[], timeoutMs: number, failureCode: VectorizeErrorCode, options?: BoundedCommandOptions): Promise<CommandResult>;
