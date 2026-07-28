// @bun
import {
  generateTransmuteImageFile,
  validateTransmuteIdempotencyKey
} from "./index-7yzj6023.js";
import {
  transmuteImageModels,
  transmuteMaximumPromptBytes
} from "./index-qn66cvha.js";
import {
  builtInIcons,
  lintDiagram,
  parseDiagramSpec,
  renderPng,
  renderSvg,
  serializeTldr
} from "./index-15w61te4.js";
import {
  vectorizeImage
} from "./index-qa7cngbb.js";

// src/operations.ts
import { randomUUID } from "crypto";
import { mkdir, readFile, rename, rm, writeFile } from "fs/promises";
import { dirname, join, resolve } from "path";
var transmuteOperationCodes = [
  "transmute.diagram.check",
  "transmute.diagram.render",
  "transmute.image.vectorize",
  "transmute.image.generate"
];

class TransmuteOperationError extends Error {
  code;
  constructor(code, message) {
    super(`[${code}] ${message}`);
    this.name = "TransmuteOperationError";
    this.code = code;
  }
}
var modelSchema = {
  type: "string",
  enum: transmuteImageModels
};
var pathSchema = {
  type: "string",
  minLength: 1,
  maxLength: 4096
};
function deepFreeze(value) {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) {
    return value;
  }
  for (const nested of Object.values(value))
    deepFreeze(nested);
  return Object.freeze(value);
}
var transmuteOperationRegistry = deepFreeze([
  {
    code: "transmute.diagram.check",
    title: "Check diagram",
    description: "Parse and lint a checked Transmute diagram source without changing its files.",
    execution: "local",
    authentication: "none",
    destructive: false,
    idempotent: true,
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["path"],
      properties: { path: pathSchema }
    }
  },
  {
    code: "transmute.diagram.render",
    title: "Render diagram",
    description: "Render a checked Transmute diagram source to its replaceable light, dark, PNG, SVG, and tldraw artifacts.",
    execution: "local",
    authentication: "none",
    destructive: true,
    idempotent: true,
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["path"],
      properties: {
        path: pathSchema,
        outDirectory: pathSchema,
        scale: {
          type: "number",
          exclusiveMinimum: 0,
          maximum: 4
        }
      }
    }
  },
  {
    code: "transmute.image.vectorize",
    title: "Vectorize image",
    description: "Convert a local caller-owned raster into a bounded inert SVG without authentication or network access.",
    execution: "local",
    authentication: "none",
    destructive: true,
    idempotent: false,
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["inputPath", "outputPath"],
      properties: {
        inputPath: pathSchema,
        outputPath: pathSchema,
        duotone: {
          type: "array",
          minItems: 2,
          maxItems: 2,
          items: {
            type: "string",
            pattern: "^#[a-fA-F0-9]{3}(?:[a-fA-F0-9]{3})?$"
          }
        },
        alphaCutoff: { type: "integer", minimum: 1, maximum: 64 },
        timeoutMs: { type: "integer", minimum: 1, maximum: 300000 }
      }
    }
  },
  {
    code: "transmute.image.generate",
    title: "Generate image",
    description: "Generate one bounded free-preview WebP with an explicitly supported hosted model, durable suite-account idempotency, and no ambiguous retry.",
    execution: "hosted",
    authentication: "required",
    destructive: true,
    idempotent: false,
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["model", "prompt", "outputPath"],
      properties: {
        model: modelSchema,
        prompt: {
          type: "string",
          minLength: 1,
          maxLength: transmuteMaximumPromptBytes
        },
        outputPath: pathSchema,
        idempotencyKey: {
          type: "string",
          minLength: 16,
          maxLength: 128,
          pattern: "^[A-Za-z0-9][A-Za-z0-9._:-]*$"
        }
      }
    },
    transport: {
      method: "POST",
      endpointFromDiscovery: "endpoints.generateImage",
      authorization: "bearer",
      idempotencyHeader: "Idempotency-Key",
      retry: "never"
    }
  }
]);
function operationFailure(message) {
  throw new TransmuteOperationError("INVALID_OPERATION_INPUT", message);
}
function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function record(value, allowedKeys) {
  if (!isRecord(value))
    operationFailure("Operation input must be an object.");
  const unknown = Object.keys(value).filter((key) => !allowedKeys.includes(key));
  if (unknown.length > 0) {
    operationFailure(`Unsupported operation input field: ${unknown[0]}.`);
  }
  return value;
}
function pathValue(value, name) {
  if (typeof value !== "string" || value.length < 1 || value.length > 4096 || value.includes("\x00")) {
    operationFailure(`${name} must be a non-empty bounded local path.`);
  }
  return value;
}
function parseCheck(value) {
  const input = record(value, ["path"]);
  return { path: pathValue(input.path, "path") };
}
function parseRender(value) {
  const input = record(value, ["path", "outDirectory", "scale"]);
  const scale = input.scale;
  if (scale !== undefined && (typeof scale !== "number" || !Number.isFinite(scale) || scale <= 0 || scale > 4)) {
    operationFailure("scale must be greater than zero and no more than 4.");
  }
  return {
    path: pathValue(input.path, "path"),
    ...input.outDirectory === undefined ? {} : { outDirectory: pathValue(input.outDirectory, "outDirectory") },
    ...scale === undefined ? {} : { scale }
  };
}
function parseVectorize(value) {
  const input = record(value, [
    "inputPath",
    "outputPath",
    "duotone",
    "alphaCutoff",
    "timeoutMs"
  ]);
  const inputPath = pathValue(input.inputPath, "inputPath");
  const outputPath = pathValue(input.outputPath, "outputPath");
  if (!outputPath.toLowerCase().endsWith(".svg")) {
    operationFailure("outputPath must end in .svg.");
  }
  const duotone = input.duotone;
  if (duotone !== undefined && (!Array.isArray(duotone) || duotone.length !== 2 || duotone.some((color) => typeof color !== "string" || !/^#[a-f0-9]{3}(?:[a-f0-9]{3})?$/iu.test(color)))) {
    operationFailure("duotone must contain exactly two #rgb or #rrggbb colors.");
  }
  const alphaCutoff = input.alphaCutoff;
  if (alphaCutoff !== undefined && (!Number.isInteger(alphaCutoff) || alphaCutoff < 1 || alphaCutoff > 64)) {
    operationFailure("alphaCutoff must be an integer from 1 through 64.");
  }
  const timeoutMs = input.timeoutMs;
  if (timeoutMs !== undefined && (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 300000)) {
    operationFailure("timeoutMs must be an integer from 1 through 300000.");
  }
  return {
    inputPath,
    outputPath,
    ...duotone === undefined ? {} : { duotone },
    ...alphaCutoff === undefined ? {} : { alphaCutoff },
    ...timeoutMs === undefined ? {} : { timeoutMs }
  };
}
function parseGenerate(value) {
  const input = record(value, [
    "model",
    "prompt",
    "outputPath",
    "idempotencyKey"
  ]);
  if (typeof input.model !== "string" || !transmuteImageModels.includes(input.model)) {
    operationFailure(`model must be ${transmuteImageModels[0]} or ${transmuteImageModels[1]}.`);
  }
  if (typeof input.prompt !== "string" || input.prompt.trim().length < 1 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(input.prompt) || Buffer.byteLength(input.prompt, "utf8") > transmuteMaximumPromptBytes) {
    operationFailure(`prompt must be non-empty and no more than ${transmuteMaximumPromptBytes} UTF-8 bytes.`);
  }
  if (input.idempotencyKey !== undefined) {
    try {
      validateTransmuteIdempotencyKey(typeof input.idempotencyKey === "string" ? input.idempotencyKey : "");
    } catch {
      operationFailure("idempotencyKey is invalid.");
    }
  }
  const outputPath = pathValue(input.outputPath, "outputPath");
  if (!outputPath.toLowerCase().endsWith(".webp")) {
    operationFailure("outputPath must end in .webp.");
  }
  return {
    model: input.model,
    prompt: input.prompt,
    outputPath,
    ...input.idempotencyKey === undefined ? {} : { idempotencyKey: input.idempotencyKey }
  };
}
function parseTransmuteOperationInput(code, input) {
  switch (code) {
    case "transmute.diagram.check":
      return parseCheck(input);
    case "transmute.diagram.render":
      return parseRender(input);
    case "transmute.image.vectorize":
      return parseVectorize(input);
    case "transmute.image.generate":
      return parseGenerate(input);
    default:
      throw new TransmuteOperationError("INVALID_OPERATION", "Unknown Transmute operation code.");
  }
}
function isTransmuteOperationCode(value) {
  return transmuteOperationCodes.includes(value);
}
function searchTransmuteOperations(query = "", limit = transmuteOperationRegistry.length) {
  if (typeof query !== "string" || query.length > 200 || /[\u0000-\u001f\u007f]/u.test(query) || !Number.isInteger(limit) || limit < 1 || limit > 20) {
    throw new TransmuteOperationError("INVALID_SEARCH", "Search requires a bounded query and a limit from 1 through 20.");
  }
  const terms = query.toLowerCase().split(/\s+/u).filter((term) => term.length > 0);
  return transmuteOperationRegistry.filter((operation) => {
    const haystack = `${operation.code} ${operation.title} ${operation.description}`.toLowerCase();
    return terms.every((term) => haystack.includes(term));
  }).slice(0, limit);
}
var operationBuiltInConfig = Object.freeze({
  icons: builtInIcons
});
async function readOperationDiagram(path) {
  const absolutePath = resolve(path);
  let value;
  try {
    value = JSON.parse(await readFile(absolutePath, "utf8"));
  } catch (cause) {
    throw new TransmuteOperationError("INVALID_OPERATION_INPUT", "Diagram source could not be read as JSON.");
  }
  const spec = parseDiagramSpec(value);
  for (const shape of spec.shapes) {
    if ((shape.type === "rect" || shape.type === "ellipse") && shape.icon !== undefined && !Object.hasOwn(builtInIcons, shape.icon)) {
      throw new TransmuteOperationError("INVALID_OPERATION_INPUT", "Diagram requests an unavailable built-in icon.");
    }
  }
  return { absolutePath, spec };
}
async function atomicOperationWrite(path, value) {
  const temporaryPath = join(dirname(path), `.${randomUUID()}.transmute-operation.tmp`);
  try {
    await writeFile(temporaryPath, value, { flag: "wx" });
    await rename(temporaryPath, path);
  } finally {
    await rm(temporaryPath, { force: true }).catch(() => {
      return;
    });
  }
}
async function checkOperationDiagram(path) {
  const { spec } = await readOperationDiagram(path);
  return {
    findings: lintDiagram(spec),
    configPath: null
  };
}
async function renderOperationDiagram(input) {
  const { absolutePath, spec } = await readOperationDiagram(input.path);
  const outputDirectory = resolve(input.outDirectory ?? dirname(absolutePath));
  const scale = input.scale ?? 2;
  const [light, dark] = await Promise.all([
    renderSvg(spec, "light", operationBuiltInConfig),
    renderSvg(spec, "dark", operationBuiltInConfig)
  ]);
  const [lightPng, darkPng] = [
    renderPng(light, operationBuiltInConfig, scale),
    renderPng(dark, operationBuiltInConfig, scale)
  ];
  const artifacts = {
    spec: absolutePath,
    tldr: join(outputDirectory, `${spec.name}.tldr`),
    lightSvg: join(outputDirectory, `${spec.name}.light.svg`),
    darkSvg: join(outputDirectory, `${spec.name}.dark.svg`),
    lightPng: join(outputDirectory, `${spec.name}.light.png`),
    darkPng: join(outputDirectory, `${spec.name}.dark.png`)
  };
  await mkdir(outputDirectory, { recursive: true });
  await Promise.all([
    atomicOperationWrite(artifacts.tldr, serializeTldr(spec, operationBuiltInConfig)),
    atomicOperationWrite(artifacts.lightSvg, light.svg),
    atomicOperationWrite(artifacts.darkSvg, dark.svg),
    atomicOperationWrite(artifacts.lightPng, lightPng),
    atomicOperationWrite(artifacts.darkPng, darkPng)
  ]);
  return {
    artifacts,
    findings: lintDiagram(spec),
    configPath: null
  };
}
async function executeTransmuteOperation(code, value, dependencies = {}) {
  const input = parseTransmuteOperationInput(code, value);
  switch (code) {
    case "transmute.diagram.check": {
      const options = input;
      return await checkOperationDiagram(options.path);
    }
    case "transmute.diagram.render": {
      const options = input;
      return await renderOperationDiagram(options);
    }
    case "transmute.image.vectorize": {
      const options = input;
      const result = await vectorizeImage(options.inputPath, {
        outputPath: options.outputPath,
        ...options.duotone === undefined ? {} : { duotone: options.duotone },
        ...options.alphaCutoff === undefined ? {} : { alphaCutoff: options.alphaCutoff },
        ...options.timeoutMs === undefined ? {} : { limits: { maxDurationMs: options.timeoutMs } }
      });
      if (result.outputPath === null) {
        throw new TransmuteOperationError("INVALID_OPERATION_INPUT", "Vectorization did not publish its required output.");
      }
      return {
        outputPath: result.outputPath,
        receipt: result.receipt
      };
    }
    case "transmute.image.generate": {
      const options = input;
      return await generateTransmuteImageFile(options, dependencies);
    }
    default:
      throw new TransmuteOperationError("INVALID_OPERATION", "Unknown Transmute operation code.");
  }
}

export { transmuteOperationCodes, TransmuteOperationError, transmuteOperationRegistry, parseTransmuteOperationInput, isTransmuteOperationCode, searchTransmuteOperations, executeTransmuteOperation };
