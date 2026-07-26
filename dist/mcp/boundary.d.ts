export declare const mcpSourceByteLimit: number;
export declare class WorkspaceBoundaryError extends Error {
    readonly code: "INVALID_PATH" | "PATH_OUTSIDE_ROOT" | "SOURCE_NOT_FOUND" | "SOURCE_NOT_FILE" | "SOURCE_TOO_LARGE" | "SOURCE_ENCODING" | "OUTPUT_NOT_DIRECTORY" | "FILESYSTEM_ERROR";
    constructor(code: WorkspaceBoundaryError["code"], message: string);
}
export interface WorkspaceSource {
    readonly absolutePath: string;
    readonly relativePath: string;
    readonly text: string;
}
export interface WorkspaceDirectory {
    readonly absolutePath: string;
    readonly relativePath: string;
}
export interface WorkspaceFile {
    readonly absolutePath: string;
    readonly relativePath: string;
}
export declare class WorkspaceBoundary {
    readonly rootDirectory: string;
    private constructor();
    static create(rootDirectory: string): Promise<WorkspaceBoundary>;
    private assertConfined;
    toRelativePath(absolutePath: string): string;
    readSource(value: string): Promise<WorkspaceSource>;
    resolveInputFile(value: string, maximumBytes: number): Promise<WorkspaceFile>;
    prepareOutputFile(value: string): Promise<WorkspaceFile>;
    prepareOutputDirectory(value: string): Promise<WorkspaceDirectory>;
}
