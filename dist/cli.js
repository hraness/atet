#!/usr/bin/env bun
// @bun
import {
  ATET_VERSION,
  artifactSummary,
  checkDiagramFile,
  desktopStatus,
  getLatestDesktopRelease,
  installDesktop,
  openInDesktop,
  renderDiagramFile,
  runMcpServer,
  selectDesktopAsset
} from "./index-m1bf6vnz.js";
import {
  installSkill,
  pathExists
} from "./index-pc34q4wz.js";
import"./index-38hzjjaq.js";
import {
  atetOperationCodes,
  executeAtetOperation,
  isAtetOperationCode,
  searchAtetOperations,
  withAtetOperationHostAdmission
} from "./index-b7xv1v0z.js";
import {
  vectorizeImage
} from "./index-zhffnaj1.js";
import {
  atetGatewayCredentialStatus,
  atetImageModels,
  generateAtetImageFile
} from "./index-70c7xxz7.js";
import"./index-6kb9qvnn.js";
import {
  __require
} from "./index-z1w83f81.js";

// src/cli.ts
import { writeFile } from "fs/promises";
import { resolve } from "path";
import { createInterface } from "readline/promises";
var atetCliVersion = ATET_VERSION;
var help = `atet ${atetCliVersion}

Turn source material into deterministic diagrams, images, and canvas assets.

Usage:
  atet diagram init [file]
  atet diagram check <file> [--config <file>] [--strict]
  atet diagram render <file> [--out-dir <directory>] [--config <file>] [--scale <number>]
  atet image vectorize <image> --output <file.svg> [--json] [--duotone <#rgb,#rgb>]
  atet image generate <prompt> --output <file.png|jpg|webp> [--model <provider/model>] [--json]
  atet code search [query] [--limit <number>]
  atet code execute <operation> --input <JSON>
  atet mcp --root <workspace>
  atet canvas open <file.tldr|file.tldraw>
  atet canvas status
  atet canvas url
  atet canvas install [--yes] [--download-only]
  atet doctor
  atet skill path
  atet skill install [--target codex|claude|agents] [--scope user|project] [--force]

Render writes the same five replaceable artifacts on every run:
  <name>.tldr
  <name>.light.svg
  <name>.dark.svg
  <name>.light.png
  <name>.dark.png

The .tldr file is editable tldraw interchange. It imports into tldraw Offline,
which can save the newer app-owned .tldraw bundle. Rendering does not require
tldraw Offline or the tldraw SDK.

Vectorize adaptively traces a raster with a checksum-pinned VTracer binary.
It enforces bounded input, decode, time, path, and output budgets and emits a
safe path-only SVG (plus an internal vector alpha mask when fidelity requires).
It is fully local. No source path or bytes are sent to a network endpoint.

Generate sends one bounded, non-retried request directly to Vercel AI Gateway.
Set AI_GATEWAY_API_KEY, or run through \`vercel env run -- \u2026\` so
VERCEL_OIDC_TOKEN is available. Atet never stores or prints the token.
PNG, JPEG, and WebP responses are signature-checked and published atomically.

Code mode searches and executes a fixed semantic registry. Execute accepts
typed JSON for one exact owned operation code; it never evaluates source text.

MCP preserves root-relative check_diagram/render_diagram and adds closed
search_atet/execute_atet registry tools. It uses built-in assets, never
executes workspace config or caller code, and writes protocol messages only to
stdout.
`;
function parseArguments(args, valueOptions) {
  const positionals = [];
  const options = {};
  const flags = new Set;
  for (let index = 0;index < args.length; index += 1) {
    const argument = args[index];
    if (argument === undefined)
      continue;
    if (!argument.startsWith("--")) {
      positionals.push(argument);
      continue;
    }
    const name = argument.slice(2);
    if (!valueOptions.has(name)) {
      flags.add(name);
      continue;
    }
    const value = args[index + 1];
    if (value === undefined || value.startsWith("--")) {
      throw new Error(`--${name} requires a value`);
    }
    options[name] = value;
    index += 1;
  }
  return { positionals, options, flags };
}
function requiredPositional(parsed, index, label) {
  const value = parsed.positionals[index];
  if (value === undefined)
    throw new Error(`Missing ${label}`);
  return value;
}
function requiredOption(parsed, name) {
  const value = parsed.options[name];
  if (value === undefined)
    throw new Error(`--${name} is required`);
  return value;
}
function parsePositiveInteger(value, name) {
  if (value === undefined)
    return;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new Error(`--${name} must be a positive integer`);
  }
  return parsed;
}
function parseDuotone(value) {
  if (value === undefined)
    return;
  const colors = value.split(",").map((color) => color.trim());
  if (colors.length !== 2 || colors.some((color) => !/^#[a-f0-9]{3}(?:[a-f0-9]{3})?$/iu.test(color))) {
    throw new Error("--duotone must contain two #rgb or #rrggbb colors separated by a comma");
  }
  return [colors[0], colors[1]];
}
function printFindings(findings) {
  if (findings.length === 0) {
    console.log("No diagram lint findings.");
    return;
  }
  console.warn(`${findings.length} diagram lint finding${findings.length === 1 ? "" : "s"}:`);
  for (const finding of findings) {
    console.warn(`  [${finding.code}] ${finding.message}`);
  }
}
var starter = {
  $schema: "https://raw.githubusercontent.com/hraness/atet/v3.0.0/schema/diagram.schema.json",
  version: 1,
  name: "example-flow",
  canvas: { width: 960, height: 540, padding: 64 },
  layout: { type: "stack", direction: "horizontal", gap: 160, align: "center" },
  shapes: [
    {
      id: "source",
      type: "rect",
      width: 240,
      height: 160,
      label: "Source",
      icon: "document",
      tone: "blue"
    },
    {
      id: "result",
      type: "rect",
      width: 240,
      height: 160,
      label: "Result",
      icon: "check",
      tone: "green"
    }
  ],
  edges: [{ id: "source-result", from: "source", to: "result" }]
};
async function confirmInstall() {
  if (!process.stdin.isTTY) {
    throw new Error("Pass --yes to download the 100\u2013230 MB official tldraw Offline installer");
  }
  const prompt = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await prompt.question("Download, verify, and launch the official tldraw Offline installer? [y/N] ");
    return answer.trim().toLowerCase() === "y" || answer.trim().toLowerCase() === "yes";
  } finally {
    prompt.close();
  }
}
function hostAdmissionOptions(dependencies) {
  return dependencies.hostResourceCoordinator === undefined ? {} : { hostResourceCoordinator: dependencies.hostResourceCoordinator };
}
function canonicalArguments(args) {
  const [surface, subcommand, ...rest] = args;
  if (surface === "diagram") {
    if (subcommand === "init" || subcommand === "check" || subcommand === "render") {
      return [subcommand, ...rest];
    }
    throw new Error("Use atet diagram init, check, or render");
  }
  if (surface === "image") {
    if (subcommand === "vectorize" || subcommand === "generate") {
      return [subcommand, ...rest];
    }
    throw new Error("Use atet image vectorize or generate");
  }
  if (surface === "canvas") {
    if (subcommand === "open")
      return ["open", ...rest];
    if (subcommand === "status" || subcommand === "url" || subcommand === "install") {
      return ["desktop", subcommand, ...rest];
    }
    throw new Error("Use atet canvas open, status, url, or install");
  }
  if (surface === "init" || surface === "check" || surface === "render" || surface === "vectorize" || surface === "generate" || surface === "open" || surface === "desktop") {
    throw new Error(`The flat \`${surface}\` command moved to a namespaced Atet surface.

${help}`);
  }
  return args;
}
async function main(args, dependencies = {}) {
  const [command, ...rest] = canonicalArguments(args);
  if (command === undefined || command === "help" || command === "--help" || command === "-h") {
    console.log(help);
    return;
  }
  if (command === "version" || command === "--version" || command === "-v") {
    console.log(atetCliVersion);
    return;
  }
  if (command === "init") {
    const parsed = parseArguments(rest, new Set);
    const filePath = resolve(parsed.positionals[0] ?? "diagram.diagram.json");
    if (await pathExists(filePath))
      throw new Error(`Refusing to overwrite existing file: ${filePath}`);
    await writeFile(filePath, `${JSON.stringify(starter, null, 2)}
`);
    console.log(`Created ${filePath}`);
    return;
  }
  if (command === "check") {
    const parsed = parseArguments(rest, new Set(["config"]));
    const result = await withAtetOperationHostAdmission("atet.diagram.check", async () => await checkDiagramFile({
      filePath: requiredPositional(parsed, 0, "diagram file"),
      ...parsed.options.config === undefined ? {} : { configPath: parsed.options.config }
    }), hostAdmissionOptions(dependencies));
    console.log(`Valid diagram${result.configPath === null ? "" : ` with ${result.configPath}`}.`);
    printFindings(result.findings);
    if (parsed.flags.has("strict") && result.findings.length > 0)
      process.exitCode = 2;
    return;
  }
  if (command === "render") {
    const parsed = parseArguments(rest, new Set(["out-dir", "config", "scale"]));
    const scale = parsed.options.scale === undefined ? undefined : Number.parseFloat(parsed.options.scale);
    const result = await withAtetOperationHostAdmission("atet.diagram.render", async () => await renderDiagramFile({
      filePath: requiredPositional(parsed, 0, "diagram file"),
      ...parsed.options["out-dir"] === undefined ? {} : { outDirectory: parsed.options["out-dir"] },
      ...parsed.options.config === undefined ? {} : { configPath: parsed.options.config },
      ...scale === undefined ? {} : { scale }
    }), hostAdmissionOptions(dependencies));
    console.log(artifactSummary(result.artifacts));
    printFindings(result.findings);
    return;
  }
  if (command === "vectorize") {
    const parsed = parseArguments(rest, new Set(["output", "duotone", "alpha-cutoff", "timeout-ms"]));
    const unknownFlags = [...parsed.flags].filter((flag) => flag !== "json");
    if (unknownFlags.length > 0) {
      throw new Error(`Unknown vectorize option: --${unknownFlags[0]}`);
    }
    if (parsed.positionals.length > 1) {
      throw new Error("atet image vectorize accepts exactly one raster input");
    }
    const output = requiredOption(parsed, "output");
    if (!output.toLowerCase().endsWith(".svg")) {
      throw new Error("--output must end in .svg");
    }
    const alphaCutoff = parsePositiveInteger(parsed.options["alpha-cutoff"], "alpha-cutoff");
    const timeoutMs = parsePositiveInteger(parsed.options["timeout-ms"], "timeout-ms");
    const duotone = parseDuotone(parsed.options.duotone);
    const result = await withAtetOperationHostAdmission("atet.image.vectorize", async (lease) => await (dependencies.vectorize ?? vectorizeImage)(requiredPositional(parsed, 0, "raster image"), {
      ...alphaCutoff === undefined ? {} : { alphaCutoff },
      ...duotone === undefined ? {} : { duotone },
      ...timeoutMs === undefined ? {} : { limits: { maxDurationMs: timeoutMs } },
      inheritedFileDescriptors: [lease.inheritedFileDescriptor],
      outputPath: output
    }), hostAdmissionOptions(dependencies));
    if (parsed.flags.has("json")) {
      (dependencies.log ?? console.log)(JSON.stringify({ ...result.receipt, outputPath: result.outputPath }, null, 2));
    } else {
      (dependencies.log ?? console.log)(`Vectorized ${result.receipt.width}\xD7${result.receipt.height} with ` + `${result.receipt.profile}/${result.receipt.representation}: ${result.outputPath}`);
    }
    return;
  }
  if (command === "generate") {
    const parsed = parseArguments(rest, new Set(["model", "output"]));
    const unknownFlags = [...parsed.flags].filter((flag) => flag !== "json");
    if (unknownFlags.length > 0) {
      throw new Error(`Unknown generate option: --${unknownFlags[0]}`);
    }
    if (parsed.positionals.length !== 1) {
      throw new Error("atet image generate accepts exactly one prompt");
    }
    const model = parsed.options.model ?? atetImageModels[1];
    if (model.length > 256 || !/^[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._:-]*$/iu.test(model)) {
      throw new Error("--model must be a bounded Vercel AI Gateway provider/model id");
    }
    const result = await withAtetOperationHostAdmission("atet.image.generate", async () => await (dependencies.generate ?? generateAtetImageFile)({
      model,
      prompt: requiredPositional(parsed, 0, "prompt"),
      outputPath: requiredOption(parsed, "output")
    }), hostAdmissionOptions(dependencies));
    if (parsed.flags.has("json")) {
      (dependencies.log ?? console.log)(JSON.stringify(result, null, 2));
    } else {
      (dependencies.log ?? console.log)(`Generated ${result.mediaType} with ${result.model}: ${result.outputPath} (${result.bytes} bytes, request ${result.requestId})`);
    }
    return;
  }
  if (command === "code") {
    const [subcommand, ...subcommandArgs] = rest;
    if (subcommand === "search") {
      const parsed = parseArguments(subcommandArgs, new Set(["limit"]));
      if (parsed.flags.size > 0 || parsed.positionals.length > 1) {
        throw new Error("Use atet code search [query] [--limit <number>]");
      }
      const limit = parsePositiveInteger(parsed.options.limit, "limit") ?? atetOperationCodes.length;
      const operations = searchAtetOperations(parsed.positionals[0] ?? "", limit);
      console.log(JSON.stringify({ operations }, null, 2));
      return;
    }
    if (subcommand === "execute") {
      const parsed = parseArguments(subcommandArgs, new Set(["input"]));
      if (parsed.flags.size > 0 || parsed.positionals.length !== 1) {
        throw new Error("Use atet code execute <operation> --input <JSON>");
      }
      const requestedOperation = parsed.positionals[0];
      const operation = isAtetOperationCode(requestedOperation) ? requestedOperation : undefined;
      if (operation === undefined) {
        throw new Error(`Unknown Atet operation code: ${requestedOperation}`);
      }
      const inputText = requiredOption(parsed, "input");
      if (Buffer.byteLength(inputText, "utf8") > 64 * 1024) {
        throw new Error("--input JSON must be no more than 65536 UTF-8 bytes");
      }
      let input;
      try {
        input = JSON.parse(inputText);
      } catch {
        throw new Error("--input must be valid JSON");
      }
      const result = await executeAtetOperation(operation, input, {
        ...hostAdmissionOptions(dependencies)
      });
      (dependencies.log ?? console.log)(JSON.stringify({ operation, result }, null, 2));
      return;
    }
    throw new Error("Use atet code search [query] or atet code execute <operation> --input <JSON>");
  }
  if (command === "mcp") {
    const parsed = parseArguments(rest, new Set(["root"]));
    if (parsed.positionals.length > 0 || parsed.flags.size > 0) {
      throw new Error("atet mcp accepts only --root <workspace>");
    }
    await runMcpServer({
      rootDirectory: requiredOption(parsed, "root"),
      serverVersion: atetCliVersion
    });
    return;
  }
  if (command === "open") {
    const parsed = parseArguments(rest, new Set);
    await openInDesktop(requiredPositional(parsed, 0, "tldraw file"));
    console.log("Opened in tldraw Offline.");
    return;
  }
  if (command === "doctor") {
    const status = await desktopStatus();
    console.log(`atet ${atetCliVersion}`);
    console.log(`Bun ${process.versions.bun ?? "not detected"}`);
    console.log("Headless diagram SVG/PNG/tldraw renderer ready");
    console.log(process.platform === "win32" ? "Local raster-to-SVG vectorizer unavailable on Windows (fails closed with tool_platform)" : "Local raster-to-SVG vectorizer ready without authentication (VTracer downloads on first use)");
    console.log("Root-relative MCP check/render server ready (trusted local workspace)");
    const gateway = atetGatewayCredentialStatus();
    console.log(gateway.available ? `Vercel AI Gateway ready via ${gateway.source}` : "Vercel AI Gateway requires AI_GATEWAY_API_KEY or VERCEL_OIDC_TOKEN");
    console.log(status.installedPath === null ? "tldraw Offline not installed (optional)" : `tldraw Offline: ${status.installedPath}`);
    console.log(status.server === null ? "tldraw Offline agent server not running (optional)" : `tldraw Offline agent server: localhost:${status.server.port}`);
    return;
  }
  if (command === "desktop") {
    const [subcommand, ...subcommandArgs] = rest;
    if (subcommand === "status") {
      const status = await desktopStatus();
      console.log(JSON.stringify(status, null, 2));
      return;
    }
    if (subcommand === "url") {
      const release = await getLatestDesktopRelease();
      const asset = selectDesktopAsset(release);
      console.log(JSON.stringify({
        release: release.tag_name,
        releaseUrl: release.html_url,
        asset: asset.name,
        url: asset.browser_download_url,
        bytes: asset.size,
        sha256: asset.digest
      }, null, 2));
      return;
    }
    if (subcommand === "install") {
      const parsed = parseArguments(subcommandArgs, new Set);
      if (!parsed.flags.has("yes") && !await confirmInstall()) {
        console.log("Cancelled.");
        return;
      }
      const result = await installDesktop({ downloadOnly: parsed.flags.has("download-only") });
      console.log(`${parsed.flags.has("download-only") ? "Downloaded" : "Prepared"} tldraw Offline ${result.release}: ${result.filePath}`);
      return;
    }
    throw new Error("Use atet canvas status, url, or install");
  }
  if (command === "skill") {
    const [subcommand, ...subcommandArgs] = rest;
    if (subcommand === "path") {
      const { bundledSkillPath } = await import("./skill-install-6gdmqbem.js");
      console.log(bundledSkillPath());
      return;
    }
    if (subcommand === "install") {
      const parsed = parseArguments(subcommandArgs, new Set(["target", "scope", "project"]));
      const target = parsed.options.target ?? "codex";
      const scope = parsed.options.scope ?? "user";
      if (!["codex", "claude", "agents"].includes(target)) {
        throw new Error("--target must be codex, claude, or agents");
      }
      if (!["user", "project"].includes(scope)) {
        throw new Error("--scope must be user or project");
      }
      const destination = await installSkill({
        target,
        scope,
        ...parsed.options.project === undefined ? {} : { projectDirectory: parsed.options.project },
        force: parsed.flags.has("force")
      });
      console.log(`Installed atet skill at ${destination}`);
      return;
    }
    throw new Error("Use atet skill path or install");
  }
  throw new Error(`Unknown command: ${command}

${help}`);
}
if (import.meta.main) {
  try {
    await main(process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
export {
  main,
  atetCliVersion
};
