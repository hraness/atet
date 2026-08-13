import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { CliError } from "./errors";

export interface RecordingDirectory {
  readonly id: string;
  readonly modifiedAt: string;
  readonly path: string;
}

export async function listRecordingDirectories(artifactRoot: string): Promise<RecordingDirectory[]> {
  let entries;
  try {
    entries = await readdir(artifactRoot, { withFileTypes: true });
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return [];
    throw error;
  }
  const directories = await Promise.all(entries
    .filter((entry) => entry.isDirectory() && entry.name.startsWith("rec_"))
    .map(async (entry) => {
      const path = join(artifactRoot, entry.name);
      const details = await stat(path);
      return { id: entry.name, modifiedAt: details.mtime.toISOString(), path };
    }));
  return directories.sort((left, right) =>
    right.modifiedAt.localeCompare(left.modifiedAt) || left.id.localeCompare(right.id)
  );
}

export async function resolveRecordingDirectory(
  artifactRoot: string,
  reference: string,
): Promise<RecordingDirectory> {
  if (!/^rec_[A-Za-z0-9][A-Za-z0-9_-]*$/u.test(reference)) {
    throw new CliError(
      "usage",
      `Recording reference must be an exact rec_ ID or prefix: ${reference}`,
    );
  }
  const recordings = await listRecordingDirectories(artifactRoot);
  const exact = recordings.find(({ id }) => id === reference);
  if (exact !== undefined) return exact;
  const matches = recordings.filter(({ id }) => id.startsWith(reference));
  if (matches.length === 0) {
    throw new CliError("not-found", `No recording matches ${reference}.`);
  }
  if (matches.length > 1) {
    throw new CliError(
      "conflict",
      `Recording prefix ${reference} is ambiguous: ${matches.map(({ id }) => id).join(", ")}.`,
      { matches: matches.map(({ id }) => id), reference },
    );
  }
  return matches[0]!;
}
