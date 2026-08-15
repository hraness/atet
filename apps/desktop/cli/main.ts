#!/usr/bin/env bun

import { basename, join, resolve } from "node:path";
import { parseCliArgs } from "./args";
import { runCli } from "./commands";
import { asCliError, CliError, EXIT_CODE } from "./errors";
import { BunProcessRunner, processIo } from "./io";
import { resolveRepositoryPaths } from "./paths";
import {
  canonicalizeUnifiedCliArgs,
  runPortableSurface,
} from "./portable-surface";
import { RecordingDaemonClient, runRecordingDaemon } from "./recording-daemon";
import { renamedEnvironmentValue } from "./renamed-environment";

function valueAfter(argv: readonly string[], name: string): string {
  const index = argv.indexOf(name);
  const value = index === -1 ? undefined : argv[index + 1];
  if (value === undefined || value.startsWith("--")) throw new CliError("usage", `${name} requires a value.`);
  return value;
}

export function daemonCommandFor(executableInput: string, entrypointInput: string): readonly [string, ...string[]] {
  const executable = resolve(executableInput);
  if (entrypointInput.includes("$bunfs")) return [executable];
  const entrypoint = resolve(entrypointInput);
  return executable === entrypoint ? [executable] : [executable, entrypoint];
}

function daemonCommand(): readonly [string, ...string[]] {
  return daemonCommandFor(process.execPath, import.meta.path);
}

export function isEmbeddedVectorizeWorkerInvocation(
  argv: readonly string[],
  entrypoint: string = import.meta.path,
): boolean {
  return entrypoint.includes("$bunfs")
    && argv.length === 1
    && argv[0]?.startsWith("/$bunfs/") === true
    && argv[0].endsWith("/vectorize/worker.js");
}

export async function main(argv: readonly string[] = process.argv.slice(2)): Promise<number> {
  if (isEmbeddedVectorizeWorkerInvocation(argv)) {
    // The bundled headless supervisor preserves process isolation by spawning
    // this compiled executable with its virtual worker path. Loading the
    // worker only in that exact internal invocation keeps sharp/VTracer and
    // the bounded stdin protocol inside the shipped artifact.
    await import("../../../src/vectorize/worker.ts");
    return typeof process.exitCode === "number" ? process.exitCode : 0;
  }
  if (argv[0] === "__record_daemon") {
    if (argv.length !== 5 || argv[1] !== "--artifact-root" || argv[3] !== "--helper") {
      throw new CliError("usage", "Invalid internal recording-daemon invocation.");
    }
    const paths = await resolveRepositoryPaths(process.cwd(), process.env);
    const artifactRoot = valueAfter(argv, "--artifact-root");
    if (resolve(artifactRoot) !== resolve(paths.artifactRoot)) {
      throw new CliError("unsafe-path", "Recording daemon artifact root differs from the repository-owned root.");
    }
    await runRecordingDaemon({
      artifactRoot,
      helperExecutable: valueAfter(argv, "--helper"),
    });
    return 0;
  }
  const unifiedArgv = canonicalizeUnifiedCliArgs(argv);
  const portableExitCode = await runPortableSurface(unifiedArgv);
  if (portableExitCode !== undefined) return portableExitCode;
  const earlyCommand = parseCliArgs(unifiedArgv);
  if (earlyCommand.kind === "help" || earlyCommand.kind === "version" || earlyCommand.kind === "complete") {
    return await runCli(unifiedArgv, { io: processIo });
  }
  const paths = await resolveRepositoryPaths(processIo.cwd(), processIo.env);
  const helperExecutable = renamedEnvironmentValue(processIo.env, "ATET_CAPTURE_HELPER")
    ?? join(paths.desktopRoot, "capture", "dist", "atet-capture");
  const recordingController = new RecordingDaemonClient({
    artifactRoot: paths.artifactRoot,
    daemonCommand: daemonCommand(),
    helperExecutable,
  });
  return await runCli(unifiedArgv, {
    io: processIo,
    paths,
    recordingController,
    runner: new BunProcessRunner(),
  });
}

export function isLegacyTransmuteInvocation(
  candidates: readonly string[] = [process.argv[0] ?? "", process.argv[1] ?? "", process.execPath],
): boolean {
  return candidates.some((candidate) => basename(candidate).replace(/\.exe$/iu, "") === "transmute");
}

export function writeLegacyTransmuteInvocationWarning(
  candidates: readonly string[],
  write: (message: string) => void,
): boolean {
  if (!isLegacyTransmuteInvocation(candidates)) return false;
  write("transmute is deprecated; use atet.\n");
  return true;
}

export async function runMainEntrypoint(): Promise<void> {
  if (process.argv[2] !== "__record_daemon") {
    writeLegacyTransmuteInvocationWarning(
      [process.argv[0] ?? "", process.argv[1] ?? "", process.execPath],
      message => process.stderr.write(message),
    );
  }
  try {
    process.exitCode = await main();
  } catch (error) {
    const failure = asCliError(error);
    process.stderr.write(`atet: ${failure.message}\n`);
    process.exitCode = EXIT_CODE[failure.code];
  }
}

if (import.meta.main) {
  await runMainEntrypoint();
}
