import { type VectorizeInput, type VectorizeOptions, type VectorizeResult } from "./types.js";
export declare function vectorizeImage(input: VectorizeInput, options?: VectorizeOptions): Promise<VectorizeResult>;
export declare function vectorizeImageInProcess(input: VectorizeInput, options: VectorizeOptions | undefined, temporaryRoot: string): Promise<VectorizeResult>;
