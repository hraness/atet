import { constants } from "node:fs";
import { mkdir, open } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import {
  HTML_OVERLAY_SCAFFOLD_KINDS,
  createHtmlOverlayScaffold,
  type HtmlOverlayScaffoldKind,
} from "../html-overlay";
import { CliError } from "./errors";

const HEADLESS_TRANSMUTE_CLI_MODULE = "@hraness/transmute/cli";

async function runHeadlessTransmuteCli(argv: readonly string[]): Promise<void> {
  // Keep this as a runtime package import so the headless CLI retains its own
  // package-relative skill and asset resolution inside an installed bundle.
  const module: unknown = await import(HEADLESS_TRANSMUTE_CLI_MODULE);
  if (
    typeof module !== "object"
    || module === null
    || !("main" in module)
    || typeof module.main !== "function"
  ) {
    throw new CliError("unavailable", "The portable Transmute CLI is unavailable.");
  }
  await module.main(argv);
}

export interface PortableSurfaceDependencies {
  readonly cwd?: () => string;
  readonly log?: (value: string) => void;
  readonly runHeadless?: (argv: readonly string[]) => Promise<void>;
  readonly writeScaffold?: (path: string, html: string) => Promise<void>;
}
function optionValue(argv: readonly string[], name: string): string | undefined {
  const indexes = argv.flatMap((value, index) => value === name ? [index] : []);
  if (indexes.length > 1) {
    throw new CliError("usage", `${name} may be supplied at most once.`);
  }
  const index = indexes[0];
  if (index === undefined) return undefined;
  const value = argv[index + 1];
  if (value === undefined || value.startsWith("--")) {
    throw new CliError("usage", `${name} requires a value.`);
  }
  return value;
}

/**
 * `image generate --prompt ...` is the project/media spelling and stays on the
 * desktop Gateway lane. The portable file command has an explicit --output
 * and delegates to @hraness/transmute without duplicating its parser.
 */
export function canonicalizeUnifiedCliArgs(
  argv: readonly string[],
): readonly string[] {
  if (argv[0] !== "image" || argv[1] !== "generate") return argv;
  const output = optionValue(argv, "--output");
  const prompt = optionValue(argv, "--prompt");
  if (output === undefined) {
    return ["ai", "image", "generate", ...argv.slice(2)];
  }
  if (prompt === undefined) return argv;
  const promptIndex = argv.indexOf("--prompt");
  return [
    "image",
    "generate",
    prompt,
    ...argv.slice(2, promptIndex),
    ...argv.slice(promptIndex + 2),
  ];
}

function scaffoldKind(input: string | undefined): HtmlOverlayScaffoldKind {
  if (
    input === undefined
    || !HTML_OVERLAY_SCAFFOLD_KINDS.includes(input as HtmlOverlayScaffoldKind)
  ) {
    throw new CliError(
      "usage",
      `HTML scaffold must be one of: ${HTML_OVERLAY_SCAFFOLD_KINDS.join(", ")}.`,
    );
  }
  return input as HtmlOverlayScaffoldKind;
}

async function writeScaffoldWithoutReplacement(
  path: string,
  html: string,
): Promise<void> {
  await mkdir(dirname(path), { mode: 0o700, recursive: true });
  let handle;
  try {
    handle = await open(
      path,
      constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW | constants.O_WRONLY,
      0o600,
    );
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "EEXIST") {
      throw new CliError("conflict", `Refusing to overwrite existing file: ${path}`);
    }
    throw error;
  }
  try {
    await handle.writeFile(html, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function runHtmlScaffold(
  argv: readonly string[],
  dependencies: PortableSurfaceDependencies,
): Promise<number> {
  if (argv[1] !== "scaffold") {
    throw new CliError("usage", "Use transmute html scaffold <kind> --output <file.html>.");
  }
  const kind = scaffoldKind(argv[2]);
  const output = optionValue(argv, "--output");
  if (output === undefined) {
    throw new CliError("usage", "transmute html scaffold requires --output <file.html>.");
  }
  if (!output.toLowerCase().endsWith(".html")) {
    throw new CliError("usage", "HTML scaffold output must end in .html.");
  }
  if (
    argv.length !== 5
    || argv[3] !== "--output"
  ) {
    throw new CliError(
      "usage",
      "Use transmute html scaffold <kind> --output <file.html>.",
    );
  }
  const outputPath = resolve((dependencies.cwd ?? process.cwd)(), output);
  await (dependencies.writeScaffold ?? writeScaffoldWithoutReplacement)(
    outputPath,
    createHtmlOverlayScaffold(kind),
  );
  (dependencies.log ?? console.log)(`Created ${outputPath}`);
  return 0;
}

export async function runPortableSurface(
  argvInput: readonly string[],
  dependencies: PortableSurfaceDependencies = {},
): Promise<number | undefined> {
  const argv = canonicalizeUnifiedCliArgs(argvInput);
  if (argv[0] === "html") {
    return await runHtmlScaffold(argv, dependencies);
  }
  const delegatesToHeadless = argv[0] === "diagram"
    || argv[0] === "mcp"
    || argv[0] === "canvas"
    || argv[0] === "skill"
    || (
      argv[0] === "code"
      && (argv[1] === "search" || argv[1] === "execute")
    )
    || (
      argv[0] === "image"
      && (argv[1] === "vectorize" || argv[1] === "generate")
    );
  if (!delegatesToHeadless) return undefined;

  const previousExitCode = process.exitCode;
  process.exitCode = undefined;
  try {
    await (dependencies.runHeadless ?? runHeadlessTransmuteCli)(argv);
    return process.exitCode ?? 0;
  } finally {
    process.exitCode = previousExitCode;
  }
}
