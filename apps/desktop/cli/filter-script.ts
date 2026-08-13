import { createHash, randomUUID } from "node:crypto";
import { lstat, link, open, rm } from "node:fs/promises";
import { join } from "node:path";

import { RepositoryRelativePathSchema } from "../contracts";
import { CliError } from "./errors";
import { ensurePhysicalPrivateDirectoryWithin } from "./paths";
import { resolveVerifiedProjectMedia } from "./project-media-integrity";

export const MAXIMUM_FILTER_GRAPH_BYTES = 32 * 1024 * 1024;

export interface MaterializedFilterScript {
  readonly bytes: number;
  readonly path: string;
  readonly repositoryPath: string;
  readonly sha256: string;
}

async function awaitSingleLink(path: string): Promise<void> {
  for (let attempt = 0; attempt < 16; attempt += 1) {
    if ((await lstat(path)).nlink === 1) return;
    await new Promise(resolve => setTimeout(resolve, 0));
  }
}

/** Persist a bounded filter graph without exposing it through process argv. */
export async function materializeFilterScript(options: {
  readonly graph: string;
  readonly relativeDirectory: string;
  readonly root: string;
}): Promise<MaterializedFilterScript> {
  const contents = `${options.graph}\n`;
  const bytes = Buffer.byteLength(contents);
  if (bytes <= 1 || bytes > MAXIMUM_FILTER_GRAPH_BYTES) {
    throw new CliError(
      "invalid-data",
      `FFmpeg filter graph must contain at most ${MAXIMUM_FILTER_GRAPH_BYTES} UTF-8 bytes.`,
    );
  }
  const sha256 = createHash("sha256").update(contents).digest("hex");
  const directory = await ensurePhysicalPrivateDirectoryWithin(options.root, options.relativeDirectory);
  const repositoryPath = RepositoryRelativePathSchema.parse(
    `${options.relativeDirectory}/${sha256}.ffgraph`,
  );
  const path = join(directory, `${sha256}.ffgraph`);
  const temporary = join(directory, `.${sha256}.${randomUUID()}.tmp`);
  const handle = await open(temporary, "wx", 0o600);
  try {
    await handle.writeFile(contents, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    try {
      await link(temporary, path);
      await rm(temporary);
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error;
      await awaitSingleLink(path);
    }
    await resolveVerifiedProjectMedia({
      expected: { bytes, sha256 },
      label: "FFmpeg filter graph",
      path: repositoryPath,
      repositoryRoot: options.root,
    });
    const details = await lstat(path);
    if (details.nlink !== 1) {
      throw new CliError("unsafe-path", "FFmpeg filter graph must not be hard-linked.");
    }
    return { bytes, path, repositoryPath, sha256 };
  } finally {
    await rm(temporary, { force: true });
  }
}
