#!/usr/bin/env bun
import { vectorizeImage } from "./index.js";
import { generateGraphicsImageFile } from "./generate.js";
export interface GraphicsCliDependencies {
    readonly generate?: typeof generateGraphicsImageFile;
    readonly log?: (value: string) => void;
    readonly requireAuthentication?: () => Promise<unknown>;
    readonly vectorize?: typeof vectorizeImage;
}
export declare function main(args: readonly string[], dependencies?: GraphicsCliDependencies): Promise<void>;
