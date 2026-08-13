import { dirname, isAbsolute, relative, resolve } from "node:path";

import ts from "typescript";

import { ApplicationError } from "../application/errors";

const MAX_TYPE_DIAGNOSTICS = 20;
const MAX_TYPE_DIAGNOSTIC_BYTES = 32 * 1024;
const WORKFLOW_GLOBALS_PATH = "/transmute-workflow-typecheck-globals.d.ts";
const WORKFLOW_GLOBALS_SOURCE = [
  "declare const Bun: any;",
  "declare const process: any;",
  "",
].join("\n");

export interface TypecheckWorkflowSnapshotOptions {
  readonly aliases: Readonly<Record<string, string>>;
  readonly configSearchPath: string;
  readonly entryPath: string;
  readonly includeRuntimeTypes: boolean;
  readonly sourceRoot: string;
}

function isWithin(root: string, candidate: string): boolean {
  const fromRoot = relative(root, candidate);
  return fromRoot === "" || (!fromRoot.startsWith("..") && !isAbsolute(fromRoot));
}

function diagnosticText(
  diagnostic: ts.Diagnostic,
  sourceRoot: string,
): string {
  const message = ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n");
  if (diagnostic.file === undefined || diagnostic.start === undefined) {
    return `TS${String(diagnostic.code)}: ${message}`;
  }
  const location = diagnostic.file.getLineAndCharacterOfPosition(diagnostic.start);
  const lineStarts = diagnostic.file.getLineStarts();
  const lineStart = lineStarts[location.line] ?? diagnostic.start;
  const lineEnd = diagnostic.file.text.indexOf("\n", lineStart);
  const sourceLine = diagnostic.file.text
    .slice(lineStart, lineEnd === -1 ? undefined : lineEnd)
    .trim();
  const path = isWithin(sourceRoot, diagnostic.file.fileName)
    ? relative(sourceRoot, diagnostic.file.fileName)
    : diagnostic.file.fileName;
  return [
    `${path}:${String(location.line + 1)}:${String(location.character + 1)} TS${String(diagnostic.code)}: ${message}`,
    ...(sourceLine === "" ? [] : [`  ${sourceLine.slice(0, 512)}`]),
  ].join("\n");
}

function boundedDiagnostics(
  diagnostics: readonly ts.Diagnostic[],
  sourceRoot: string,
): string {
  const lines: string[] = [];
  let bytes = 0;
  for (const diagnostic of diagnostics.slice(0, MAX_TYPE_DIAGNOSTICS)) {
    const line = diagnosticText(diagnostic, sourceRoot);
    const nextBytes = Buffer.byteLength(`${line}\n`, "utf8");
    if (bytes + nextBytes > MAX_TYPE_DIAGNOSTIC_BYTES) break;
    lines.push(line);
    bytes += nextBytes;
  }
  if (diagnostics.length > lines.length) {
    lines.push(`… ${String(diagnostics.length - lines.length)} additional diagnostic(s) omitted`);
  }
  return lines.join("\n");
}

/**
 * Semantically checks the same private source snapshot that is handed to the
 * bundler. Only workflow-owned files can make this preflight fail; the host
 * application has its own repository-wide typecheck.
 */
export function typecheckWorkflowSnapshot(
  options: TypecheckWorkflowSnapshotOptions,
): void {
  const configPath = ts.findConfigFile(
    resolve(options.configSearchPath),
    path => ts.sys.fileExists(path),
    "tsconfig.json",
  );
  if (configPath === undefined) {
    throw new ApplicationError(
      "internal",
      "Workflow semantic checking could not locate the host TypeScript configuration.",
    );
  }
  const config = ts.readConfigFile(configPath, path => ts.sys.readFile(path));
  if (config.error !== undefined) {
    throw new ApplicationError(
      "internal",
      `Workflow semantic checking could not read the host TypeScript configuration: ${
        diagnosticText(config.error, options.sourceRoot)
      }`,
    );
  }
  const parsed = ts.parseJsonConfigFileContent(
    config.config,
    ts.sys,
    dirname(configPath),
    {
      composite: false,
      declaration: false,
      emitDeclarationOnly: false,
      incremental: false,
      noEmit: true,
    },
    configPath,
  );
  if (parsed.errors.length > 0) {
    throw new ApplicationError(
      "internal",
      `Workflow semantic checking could not parse the host TypeScript configuration:\n${
        boundedDiagnostics(parsed.errors, options.sourceRoot)
      }`,
    );
  }
  const typecheckImporterPath = resolve(
    dirname(configPath),
    "transmute-workflow-typecheck.ts",
  );
  const aliasPaths = Object.fromEntries(
    Object.entries(options.aliases)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([specifier, runtimePath]) => {
        if (!/\.[cm]?js$/u.test(runtimePath)) {
          return [specifier, [runtimePath]];
        }
        const declaration = ts.resolveModuleName(
          specifier,
          typecheckImporterPath,
          parsed.options,
          ts.sys,
        ).resolvedModule?.resolvedFileName;
        return [
          specifier,
          [declaration !== undefined && /\.d\.[cm]?ts$/u.test(declaration)
            ? declaration
            : runtimePath],
        ];
      }),
  );
  const compilerOptions: ts.CompilerOptions = {
    ...parsed.options,
    baseUrl: options.sourceRoot,
    composite: false,
    declaration: false,
    emitDeclarationOnly: false,
    incremental: false,
    noEmit: true,
    paths: {
      ...parsed.options.paths,
      ...aliasPaths,
    },
    types: options.includeRuntimeTypes ? ["bun"] : [],
  };
  delete compilerOptions.tsBuildInfoFile;
  const host = ts.createCompilerHost(compilerOptions, true);
  const defaultFileExists = host.fileExists.bind(host);
  const defaultGetSourceFile = host.getSourceFile.bind(host);
  const defaultReadFile = host.readFile.bind(host);
  host.fileExists = path => (
    path === WORKFLOW_GLOBALS_PATH || defaultFileExists(path)
  );
  host.getSourceFile = (path, languageVersion, onError, shouldCreateNewSourceFile) => (
    path === WORKFLOW_GLOBALS_PATH
      ? ts.createSourceFile(
          path,
          WORKFLOW_GLOBALS_SOURCE,
          languageVersion,
          true,
          ts.ScriptKind.TS,
        )
      : defaultGetSourceFile(
          path,
          languageVersion,
          onError,
          shouldCreateNewSourceFile,
        )
  );
  host.readFile = path => (
    path === WORKFLOW_GLOBALS_PATH ? WORKFLOW_GLOBALS_SOURCE : defaultReadFile(path)
  );
  const program = ts.createProgram({
    host,
    options: compilerOptions,
    rootNames: [
      options.entryPath,
      ...(options.includeRuntimeTypes ? [] : [WORKFLOW_GLOBALS_PATH]),
    ],
  });
  const diagnostics = program.getSourceFiles()
    .filter(file => isWithin(options.sourceRoot, file.fileName))
    .flatMap(file => [
      ...program.getSyntacticDiagnostics(file),
      ...program.getSemanticDiagnostics(file),
    ])
    .filter(diagnostic => diagnostic.category === ts.DiagnosticCategory.Error);
  if (diagnostics.length > 0) {
    throw new ApplicationError(
      "invalid-data",
      `Workflow TypeScript check failed:\n${
        boundedDiagnostics(diagnostics, options.sourceRoot)
      }`,
      { diagnosticCount: diagnostics.length },
    );
  }
}
