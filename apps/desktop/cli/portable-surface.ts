import { constants } from "node:fs";
import { mkdir, open } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import { canonicalJson } from "../core/canonical-json";
import {
  HTML_OVERLAY_SCAFFOLD_KINDS,
  HTML_OVERLAY_SCAFFOLD_PROFILES,
  createHtmlOverlayScaffold,
  getApprovedHtmlOverlayLibraryLock,
  getHtmlOverlayScaffoldProfile,
  type HtmlOverlayLibrarySpecifier,
  type HtmlOverlayScaffoldKind,
} from "../html-overlay";
import { CliError } from "./errors";

const HEADLESS_ATET_CLI_MODULE = "@hraness/atet/cli";

async function runHeadlessAtetCli(argv: readonly string[]): Promise<void> {
  // Keep this as a runtime package import so the headless CLI retains its own
  // package-relative skill and asset resolution inside an installed bundle.
  const module: unknown = await import(HEADLESS_ATET_CLI_MODULE);
  if (
    typeof module !== "object"
    || module === null
    || !("main" in module)
    || typeof module.main !== "function"
  ) {
    throw new CliError("unavailable", "The portable Atet CLI is unavailable.");
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
 * and delegates to @hraness/atet without duplicating its parser.
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
  if (input !== undefined) {
    try {
      return getHtmlOverlayScaffoldProfile(input as HtmlOverlayScaffoldKind).kind;
    } catch {
      // Preserve one stable CLI usage error for every foreign scaffold kind.
    }
  }
  throw new CliError(
    "usage",
    `HTML scaffold must be one of: ${HTML_OVERLAY_SCAFFOLD_KINDS.join(", ")}.`,
  );
}

function catalogLibraries(
  specifiers: readonly HtmlOverlayLibrarySpecifier[],
): readonly Readonly<{ specifier: string; version: string }>[] {
  return specifiers.map(specifier => {
    const lock = getApprovedHtmlOverlayLibraryLock(specifier);
    return Object.freeze({
      specifier: lock.specifier,
      version: lock.version,
    });
  });
}

function htmlOverlayCatalogJson(): string {
  return canonicalJson({
    profiles: HTML_OVERLAY_SCAFFOLD_PROFILES.map(profile => ({
      bestFor: profile.bestFor,
      clockIntegration: profile.clockIntegration,
      kind: profile.kind,
      libraries: catalogLibraries(profile.libraries),
      primaryJob: profile.primaryJob,
      substrate: profile.substrate,
      summary: profile.summary,
    })),
    schemaVersion: 1,
  });
}

function htmlOverlayCatalogText(): string {
  const rows = ["HTML overlay scaffold profiles:"];
  for (const profile of HTML_OVERLAY_SCAFFOLD_PROFILES) {
    const libraries = catalogLibraries(profile.libraries)
      .map(library => `${library.specifier}@${library.version}`)
      .join(", ") || "none";
    rows.push(
      `${profile.kind}  job=${profile.primaryJob}  substrate=${profile.substrate}  libraries=${libraries}`,
      `  ${profile.summary} Best for: ${profile.bestFor}`,
    );
  }
  return rows.join("\n");
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
    throw new CliError("usage", "Use atet html scaffold <kind> --output <file.html>.");
  }
  const kind = scaffoldKind(argv[2]);
  const output = optionValue(argv, "--output");
  if (output === undefined) {
    throw new CliError("usage", "atet html scaffold requires --output <file.html>.");
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
      "Use atet html scaffold <kind> --output <file.html>.",
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

function runHtmlCatalog(
  argv: readonly string[],
  dependencies: PortableSurfaceDependencies,
): number {
  const options = argv.slice(2);
  if (
    options.length > 1
    || (options.length === 1 && options[0] !== "--json")
  ) {
    throw new CliError("usage", "Use atet html catalog [--json].");
  }
  const output = options[0] === "--json"
    ? htmlOverlayCatalogJson()
    : htmlOverlayCatalogText();
  (dependencies.log ?? console.log)(output);
  return 0;
}

export async function runPortableSurface(
  argvInput: readonly string[],
  dependencies: PortableSurfaceDependencies = {},
): Promise<number | undefined> {
  const argv = canonicalizeUnifiedCliArgs(argvInput);
  if (argv[0] === "html") {
    if (argv[1] === "catalog") return runHtmlCatalog(argv, dependencies);
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
    await (dependencies.runHeadless ?? runHeadlessAtetCli)(argv);
    return process.exitCode ?? 0;
  } finally {
    process.exitCode = previousExitCode;
  }
}
