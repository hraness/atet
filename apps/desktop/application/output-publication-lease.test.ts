import { describe, expect, test } from "bun:test";
import {
  lstat,
  mkdir,
  mkdtemp,
  rm,
  symlink,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { ApplicationContext } from "./context";
import { withOutputPublicationLease } from "./output-publication-lease";

function application(root: string): ApplicationContext {
  return {
    capabilities: () => Promise.resolve([]),
    capability: name => Promise.resolve({
      available: false,
      name,
      reason: "Capability was not configured for this fixture.",
    }),
    clock: {
      now: () => new Date("2026-07-24T00:00:00.000Z"),
      timestampMilliseconds: () => 0,
    },
    paths: {
      artifactRoot: join(root, "recordings"),
      desktopRoot: join(root, "desktop"),
      privateRoot: join(root, "private"),
      projectRoot: join(root, "projects"),
      repositoryRoot: root,
    },
    runner: {
      run: () => Promise.resolve({ exitCode: 0, stderr: "", stdout: "" }),
    },
  };
}

describe("output publication lease", () => {
  test("serializes the same output without coupling distinct outputs", async () => {
    const root = await mkdtemp(join(tmpdir(), "transmute-output-lease-"));
    const context = application(root);
    const events: string[] = [];
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>(resolve => { releaseFirst = resolve; });
    let enteredFirst!: () => void;
    const firstEntered = new Promise<void>(resolve => { enteredFirst = resolve; });
    try {
      const first = withOutputPublicationLease(context, {
        outputPath: "renders/landscape.mp4",
        projectId: "project_output01",
      }, async () => {
        events.push("first:start");
        enteredFirst();
        await firstGate;
        events.push("first:end");
      });
      await firstEntered;
      const same = withOutputPublicationLease(context, {
        outputPath: "renders/landscape.mp4",
        projectId: "project_output01",
      }, () => {
        events.push("same");
        return Promise.resolve();
      });
      const distinct = withOutputPublicationLease(context, {
        outputPath: "renders/vertical.mp4",
        projectId: "project_output01",
      }, () => {
        events.push("distinct");
        return Promise.resolve();
      });
      await distinct;
      expect(events).toEqual(["first:start", "distinct"]);
      releaseFirst();
      await Promise.all([first, same]);
      expect(events).toEqual([
        "first:start",
        "distinct",
        "first:end",
        "same",
      ]);
    } finally {
      releaseFirst();
      await rm(root, { force: true, recursive: true });
    }
  });

  test("rejects paths outside renders and prepositioned lease symlinks", async () => {
    const root = await mkdtemp(join(tmpdir(), "transmute-output-lease-path-"));
    const context = application(root);
    try {
      expect(withOutputPublicationLease(context, {
        outputPath: "project.json",
        projectId: "project_output01",
      }, () => Promise.resolve())).rejects.toMatchObject({
        code: "unsafe-path",
      });

      const privateRoot = context.paths.privateRoot;
      await mkdir(privateRoot, { mode: 0o700, recursive: true });
      const outside = join(root, "outside");
      await mkdir(outside);
      await symlink(outside, join(privateRoot, "output-publication-leases"));
      expect(withOutputPublicationLease(context, {
        outputPath: "renders/output.mp4",
        projectId: "project_output01",
      }, () => Promise.resolve())).rejects.toMatchObject({
        code: "unsafe-path",
      });
      expect((await lstat(outside)).isDirectory()).toBe(true);
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });
});
