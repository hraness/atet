import { describe, expect, spyOn, test } from "bun:test";
import * as fs from "node:fs/promises";
import {
  lstat,
  mkdir,
  mkdtemp,
  realpath,
  rm,
  symlink,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { Cause, Effect, Exit } from "effect";

import type { ApplicationContext } from "./context";
import { operationBoundary, operationExitValue, operationFinally, runStandaloneOperation, type OperationEffectFailure } from "./operation-effects";
import { withOutputPublicationLease, withOutputPublicationLeaseEffect } from "./output-publication-lease";
import { AtomicRenderPlatform, executeAtomicRenderEffect } from "../cli/atomic-render-effects";
import { nativeAtomicRenderPlatform } from "../cli/atomic-render-platform";
import { MUTATION_LOCK_FILE, MUTATION_LOCK_TEMP_PREFIX } from "../cli/mutation-lock";

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
  test.each([
    { label: "close undefined", primary: new Error("private execution"), temporary: null, close: undefined, unlink: { fails: false } },
    { label: "close false", primary: undefined, temporary: new Error("private temporary"), close: false, unlink: { fails: false } },
    { label: "unlink null", primary: false, temporary: undefined, close: new Error("private close"), unlink: { fails: true, cause: null } },
  ])("native close/unlink settlement retains finally precedence and the same-output queue ($label)", async scenario => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "slopcamera-lease-finally-")));
    const context = application(root);
    const closing = Promise.withResolvers<void>();
    const releaseClose = Promise.withResolvers<void>();
    const events: string[] = [];
    const nativeOpen = fs.open;
    const nativeUnlink = fs.unlink;
    let capturedOwner: string | undefined;
    let injectUnlink = true;
    const openSpy = spyOn(fs, "open").mockImplementation(async (...args) => {
      const handle = await nativeOpen(...args);
      if (capturedOwner !== undefined || typeof args[0] !== "string"
        || !args[0].startsWith(`${context.paths.privateRoot}/`)
        || !basename(args[0]).startsWith(MUTATION_LOCK_TEMP_PREFIX)) return handle;
      capturedOwner = join(dirname(args[0]), MUTATION_LOCK_FILE);
      const close = handle.close.bind(handle);
      handle.close = async () => {
        events.push("close:held");
        closing.resolve();
        await releaseClose.promise;
        await close();
        events.push("close:settled");
        throw scenario.close;
      };
      return handle;
    });
    const unlinkSpy = spyOn(fs, "unlink").mockImplementation(async path => {
      await nativeUnlink(path);
      if (path === capturedOwner && injectUnlink) {
        injectUnlink = false;
        events.push("unlink:settled");
        if (scenario.unlink.fails) throw scenario.unlink.cause;
      }
    });
    const target = { outputPath: "renders/output.mp4", projectId: "project_output01" };
    const finalOutputPath = join(root, "output.mp4");
    const tagged = (cause: unknown): OperationEffectFailure => ({ _tag: "OperationBoundaryFailure", phase: "cleanup", cause });
    const nativeRender = executeAtomicRenderEffect({
      argv: ["ffmpeg", "-y", finalOutputPath], finalOutputPath,
      failureLabel: "Fixture render failed", maximumOutputBytes: 1024,
      runner: { run: () => Promise.reject(scenario.primary) },
    }, { prepare: () => Effect.void }).pipe(Effect.provideService(AtomicRenderPlatform, {
      ...nativeAtomicRenderPlatform,
      cleanup: staging => operationFinally(nativeAtomicRenderPlatform.cleanup(staging), Effect.fail(tagged(scenario.temporary))),
    }));
    const first = Effect.runPromiseExit(withOutputPublicationLeaseEffect(context, target, nativeRender));
    let next: Promise<void> | undefined;
    try {
      await Promise.race([
        closing.promise,
        first.then(() => { throw new Error("Native render settled without reaching the expected lease-close seam."); }),
      ]);
      next = withOutputPublicationLease(context, target, () => {
        events.push("next");
        return Promise.resolve();
      });
      await withOutputPublicationLease(context, { ...target, outputPath: "renders/distinct.mp4" }, () => {
        events.push("distinct");
        return Promise.resolve();
      });
      expect(events).toEqual(["close:held", "distinct"]);
      releaseClose.resolve();
      const exit = await first;
      const observed = await Promise.resolve().then(() => operationExitValue(exit)).then(
        value => ({ status: "fulfilled" as const, value }),
        (reason: unknown) => ({ status: "rejected" as const, reason }),
      );
      expect(observed.status).toBe("rejected");
      if (observed.status === "rejected") {
        expect(Object.is(observed.reason, scenario.unlink.fails ? scenario.unlink.cause : scenario.close)).toBe(true);
      }
      if (Exit.isFailure(exit)) expect(Array.from(Cause.failures(exit.cause))).toHaveLength(1);
      await next;
      expect(events).toEqual(["close:held", "distinct", "close:settled", "unlink:settled", "next"]);
    } finally {
      releaseClose.resolve();
      await first;
      await next;
      openSpy.mockRestore();
      unlinkSpy.mockRestore();
      await rm(root, { force: true, recursive: true });
    }
  });

  test.each(["promise-first", "effect-first"] as const)("serializes mixed callers without coupling distinct outputs (%s)", async firstKind => {
    const root = await mkdtemp(join(tmpdir(), "slopcamera-output-lease-"));
    const context = application(root);
    const events: string[] = [];
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>(resolve => { releaseFirst = resolve; });
    let enteredFirst!: () => void;
    const firstEntered = new Promise<void>(resolve => { enteredFirst = resolve; });
    try {
      const firstTarget = {
        outputPath: "renders/landscape.mp4",
        projectId: "project_output01",
      };
      const firstUse = async () => {
        events.push("first:start");
        enteredFirst();
        await firstGate;
        events.push("first:end");
      };
      const first = firstKind === "promise-first"
        ? withOutputPublicationLease(context, firstTarget, firstUse)
        : runStandaloneOperation(withOutputPublicationLeaseEffect(context, firstTarget, operationBoundary("execution", firstUse)));
      await firstEntered;
      const sameUse = () => {
        events.push("same");
        return Promise.resolve();
      };
      const same = firstKind === "effect-first"
        ? withOutputPublicationLease(context, firstTarget, sameUse)
        : runStandaloneOperation(withOutputPublicationLeaseEffect(context, firstTarget, operationBoundary("execution", sameUse)));
      const distinct = runStandaloneOperation(withOutputPublicationLeaseEffect(context, {
        outputPath: "renders/vertical.mp4",
        projectId: "project_output01",
      }, Effect.sync(() => {
        events.push("distinct");
      })));
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
    const root = await mkdtemp(join(tmpdir(), "slopcamera-output-lease-path-"));
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
