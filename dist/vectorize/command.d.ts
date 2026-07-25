import { type VectorizeErrorCode } from "./types.js";
export interface CommandResult {
    readonly stderr: string;
    readonly stdout: string;
}
export interface BoundedCommandOptions {
    /** Bounded bytes delivered to the child on standard input. */
    readonly stdin?: Uint8Array;
    /** Raise the stdout quota only for a caller that consumes bounded data there. */
    readonly maxStdoutBytes?: number;
}
export interface BoundedPathOutputOptions extends BoundedCommandOptions {
    /** Maximum bytes accepted from the command's pathname-based primary output. */
    readonly maxOutputBytes: number;
    /** Existing private directory in which to create the per-call output endpoint. */
    readonly temporaryRoot: string;
}
export interface PathOutputCommandResult extends CommandResult {
    readonly output: string;
}
/**
 * Forward supervisor termination into every command group owned by the
 * isolated worker. This is process-local and called only by the worker
 * entrypoint before conversion begins.
 */
export declare function forwardVectorizeWorkerTermination(): void;
export declare function runBoundedCommand(command: readonly string[], timeoutMs: number, failureCode: VectorizeErrorCode, options?: BoundedCommandOptions): Promise<CommandResult>;
/**
 * Run a command whose primary output must be a pathname while retaining a
 * bounded streaming boundary. A private FIFO gives pathname-only tools a
 * portable output argument and applies backpressure before output can exceed
 * the in-memory quota.
 */
export declare function runBoundedPathOutputCommand(commandForOutput: (outputPath: string) => readonly string[], timeoutMs: number, failureCode: VectorizeErrorCode, options: BoundedPathOutputOptions): Promise<PathOutputCommandResult>;
