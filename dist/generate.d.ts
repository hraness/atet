import { type GraphicsAuthDependencies } from "./auth.js";
import { type GraphicsDiscoveryDocument, type GraphicsImageModel, type GraphicsResponseMediaType } from "./discovery.js";
export interface GenerateGraphicsImageInput {
    readonly model: GraphicsImageModel;
    readonly prompt: string;
    readonly idempotencyKey?: string;
}
export interface GeneratedGraphicsImage {
    readonly apiVersion: "v1";
    readonly image: {
        readonly base64: string;
        readonly mediaType: GraphicsResponseMediaType;
    };
    readonly model: GraphicsImageModel;
    readonly requestId: string;
}
export interface GeneratedGraphicsImageFile {
    readonly bytes: number;
    readonly idempotencyKey: string;
    readonly mediaType: GraphicsResponseMediaType;
    readonly model: GraphicsImageModel;
    readonly outputPath: string;
    readonly requestId: string;
}
export interface GraphicsGenerateDependencies extends GraphicsAuthDependencies {
    readonly discovery?: GraphicsDiscoveryDocument;
}
export declare function validateGraphicsIdempotencyKey(value: string): string;
export declare function generateGraphicsImage(input: GenerateGraphicsImageInput, dependencies?: GraphicsGenerateDependencies): Promise<GeneratedGraphicsImage & {
    readonly idempotencyKey: string;
}>;
export declare function generateGraphicsImageFile(input: GenerateGraphicsImageInput & {
    readonly outputPath: string;
}, dependencies?: GraphicsGenerateDependencies): Promise<GeneratedGraphicsImageFile>;
