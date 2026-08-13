import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, stat, symlink } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  buildCaptureHelper,
  captureHelperExecutablePath,
  resolveCaptureHelperPath,
  verifyCaptureHelperIdentity,
} from "./build";
import { CAPTURE_PROTOCOL_VERSION } from "./protocol";

let helperBuild: ReturnType<typeof buildCaptureHelper> | undefined;

function builtHelper(): ReturnType<typeof buildCaptureHelper> {
  helperBuild ??= buildCaptureHelper();
  return helperBuild;
}

describe("capture helper build boundary", () => {
  test("exports one stable ignored runtime path without running the compiler on import", () => {
    expect(resolveCaptureHelperPath()).toBe(captureHelperExecutablePath);
    expect(captureHelperExecutablePath).toEndWith("/capture/dist/transmute-capture");
  });

  test("embeds privacy metadata and signs the stable helper identity without requesting capture", async () => {
    if (process.platform !== "darwin") return;
    const result = await builtHelper();
    expect(await verifyCaptureHelperIdentity(result.path)).toBeUndefined();
  }, 120_000);

  test("a configure attempt creates private session directories without starting capture", async () => {
    if (process.platform !== "darwin") return;
    const { path } = await builtHelper();
    const session = await mkdtemp(join(tmpdir(), "transmute-capture-security-"));
    try {
      const child = Bun.spawn([path], { stdin: "pipe", stdout: "pipe", stderr: "pipe" });
      const configure = {
        command: "configure",
        options: {
          camera: { kind: "disabled" },
          displays: { kind: "all" },
          excludedBundleIdentifiers: ["com.hraness.transmute"],
          metadata: false,
          microphone: { kind: "disabled" },
          strictSources: false,
          systemAudio: false,
          typedText: false,
        },
        protocolVersion: CAPTURE_PROTOCOL_VERSION,
        requestId: "security-configure",
        sessionDirectory: session,
      };
      const shutdown = {
        command: "shutdown",
        protocolVersion: CAPTURE_PROTOCOL_VERSION,
        requestId: "security-shutdown",
      };
      void child.stdin.write(`${JSON.stringify(configure)}\n${JSON.stringify(shutdown)}\n`);
      void child.stdin.end();
      const [exitCode, stdout] = await Promise.all([child.exited, new Response(child.stdout).text()]);
      expect(exitCode).toBe(0);
      const events = stdout.trim().split("\n").map((line) => JSON.parse(line) as {
        code?: string;
        event?: string;
        recoverable?: boolean;
        requestId?: string;
        state?: string;
      });
      const configureEvent = events.find(({ requestId }) => requestId === configure.requestId);
      expect(configureEvent).toBeDefined();
      if (configureEvent?.event === "error") {
        expect(configureEvent).toMatchObject({
          code: "no-displays",
          event: "error",
          recoverable: true,
          requestId: configure.requestId,
          state: "unconfigured",
        });
      } else {
        expect(configureEvent).toMatchObject({
          event: "configured",
          requestId: configure.requestId,
          state: "ready",
        });
      }
      expect(events.at(-1)?.event).toBe("shutdown");
      for (const directory of [session, join(session, "segments"), join(session, "events")]) {
        expect((await stat(directory)).mode & 0o777).toBe(0o700);
      }
    } finally {
      await rm(session, { force: true, recursive: true });
    }
  }, 30_000);

  test("configure rejects a session root reached through a symlink", async () => {
    if (process.platform !== "darwin") return;
    const { path } = await builtHelper();
    const container = await mkdtemp(join(tmpdir(), "transmute-capture-symlink-"));
    const target = join(container, "target");
    const alias = join(container, "alias");
    try {
      await mkdir(target);
      await symlink(target, alias);
      const child = Bun.spawn([path], { stdin: "pipe", stdout: "pipe", stderr: "pipe" });
      const configure = {
        command: "configure",
        options: {
          camera: { kind: "disabled" },
          displays: { kind: "all" },
          excludedBundleIdentifiers: [],
          metadata: false,
          microphone: { kind: "disabled" },
          strictSources: false,
          systemAudio: false,
          typedText: false,
        },
        protocolVersion: CAPTURE_PROTOCOL_VERSION,
        requestId: "symlink-configure",
        sessionDirectory: alias,
      };
      const shutdown = {
        command: "shutdown",
        protocolVersion: CAPTURE_PROTOCOL_VERSION,
        requestId: "symlink-shutdown",
      };
      void child.stdin.write(`${JSON.stringify(configure)}\n${JSON.stringify(shutdown)}\n`);
      void child.stdin.end();
      const stdout = await new Response(child.stdout).text();
      await child.exited;
      const events = stdout.trim().split("\n").map((line) => JSON.parse(line) as { code?: string; event?: string });
      expect(events.some(({ code, event }) => event === "error" && code === "unsafe-session-path")).toBeTrue();
    } finally {
      await rm(container, { force: true, recursive: true });
    }
  }, 30_000);
});
