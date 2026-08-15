#!/usr/bin/env bun
import { randomUUID } from "node:crypto";
import { mkdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { SCENARIO_QUERY_KEY } from "@hraness/direct";
import {
  classifyCoverageEvidence,
  parseDirectProbeSnapshot,
  parseDefinitionCoverageSnapshot,
  type DirectProbeSnapshot,
  type CoverageEntry,
} from "@hraness/direct/testing";
import { z } from "zod";

import {
  bindDirectBrowserContractEvidence,
  bindDirectScenarioCatalog,
  readDirectBrowserContract,
  type DirectBrowserContract,
} from "./browser-verification";
import { atetDirect, atetScenarioCatalog } from "./scenarios";

const DEFAULT_BASE_URL = "http://127.0.0.1:5174";
const ATET_DIRECT_DOCUMENT_MARKERS = Object.freeze([
  'data-atet-surface="product"',
  "<title>Atet Direct</title>",
]);
const LOG_LIMIT = 12_000;
const SERVER_PROBE_TIMEOUT_MS = 1_500;
const SERVER_START_TIMEOUT_MS = 30_000;
const STABLE_PROBE_EXPRESSION = `(() => {
  const bridge = window.__direct;
  if (bridge === undefined || typeof bridge.snapshot !== "function") return false;
  const snapshot = bridge.snapshot();
  const quiet = snapshot.isQuiescent === true
    && snapshot.activity.active === 0
    && Object.values(snapshot.pending).every((value) => value === 0);
  if (!quiet) {
    window.__atetDirectVerifierQuiet = undefined;
    return false;
  }
  const key = [
    snapshot.activationHash,
    snapshot.generation,
    snapshot.revision,
    snapshot.activity.started,
    snapshot.activity.settled,
    JSON.stringify(snapshot.pending),
    JSON.stringify(snapshot.violations),
    JSON.stringify(snapshot.remainingWork),
  ].join(":");
  const previous = window.__atetDirectVerifierQuiet;
  if (previous?.key !== key) {
    window.__atetDirectVerifierQuiet = { key, since: Date.now() };
    return false;
  }
  return Date.now() - previous.since >= 150;
})()`;

const commandEnvelopeSchema = z.object({
  data: z.unknown(),
  error: z.unknown(),
  success: z.boolean(),
});
const evaluationSchema = z.object({ result: z.unknown() });
const remainingWorkSchema = z.object({
  disposed: z.boolean(),
  eventListeners: z.number().int().nonnegative(),
  transitions: z.number().int().nonnegative(),
}).strict();
const errorsSchema = z.object({ errors: z.array(z.unknown()) });
const consoleSchema = z.object({
  messages: z.array(z.object({ text: z.string(), type: z.string() })),
});
const networkSchema = z.object({
  requests: z.array(z.object({
    method: z.string(),
    status: z.number().int().optional(),
    url: z.string(),
  })),
});
const layoutSchema = z.object({
  clientHeight: z.number().finite().nonnegative(),
  clientWidth: z.number().finite().nonnegative(),
  controls: z.array(z.object({
    bottom: z.number().finite(),
    height: z.number().finite().nonnegative(),
    label: z.string(),
    left: z.number().finite(),
    right: z.number().finite(),
    top: z.number().finite(),
  })),
  scrollWidth: z.number().finite().nonnegative(),
});
type NetworkRequest = z.infer<typeof networkSchema>["requests"][number];
type ProbeSnapshot = Readonly<
  Omit<DirectProbeSnapshot, "remainingWork">
  & { readonly remainingWork: z.infer<typeof remainingWorkSchema> }
>;
export type ResponsiveLayoutMeasurement = z.infer<typeof layoutSchema>;

type ParsedArguments =
  | { readonly kind: "help" }
  | { readonly baseUrl: string; readonly kind: "run" };

type ScenarioAction =
  | "denied-start"
  | "interrupted-lifecycle"
  | "lifecycle"
  | "none"
  | "paused-lifecycle"
  | "permission-prompt"
  | "recover"
  | "start";

interface BrowserScenario {
  readonly action: ScenarioAction;
  readonly expectedText: readonly string[];
  readonly id: string;
  readonly viewport: { readonly height: number; readonly width: number };
}

interface ScenarioEvidence {
  readonly active: DirectBrowserContract["manifest"]["active"];
  readonly catalogHash: string;
  readonly expectedText: readonly string[];
  readonly id: string;
  readonly networkRequests: number;
  readonly probe: ProbeSnapshot;
  readonly screenshot: string;
  readonly url: string;
}

interface ScenarioVerification {
  readonly evidence: ScenarioEvidence;
  readonly manifest: DirectBrowserContract["manifest"];
}

const scenarios = [
  {
    action: "start",
    expectedText: ["Ready to record", "Start recording", "artifacts/atet/recordings/"],
    id: "idle-ready",
    viewport: { height: 720, width: 480 },
  },
  {
    action: "permission-prompt",
    expectedText: ["7 permissions need attention", "Displays (not determined)", "Camera (not determined)"],
    id: "permission-prompt",
    viewport: { height: 720, width: 480 },
  },
  {
    action: "lifecycle",
    expectedText: [
      "Built-in display · Atet Display",
      "Mac system audio · Atet microphone",
      "FaceTime HD Camera",
      "freeze",
      "silence",
      "image",
      "svg",
      "gif",
      "video",
      "emoji",
    ],
    id: "all-input-recording",
    viewport: { height: 900, width: 1_120 },
  },
  {
    action: "none",
    expectedText: ["2 displays", "Built-in display · Atet Display", "window", "zoom"],
    id: "multiple-displays",
    viewport: { height: 720, width: 480 },
  },
  {
    action: "paused-lifecycle",
    expectedText: ["Paused — segment safely closed", "Resume", "Stop"],
    id: "pause-resume",
    viewport: { height: 720, width: 480 },
  },
  {
    action: "interrupted-lifecycle",
    expectedText: [
      "Camera disconnected — segment saved; resume when ready",
      "FaceTime HD Camera (not available now)",
      "Resume",
      "Stop",
    ],
    id: "partial-source-failure",
    viewport: { height: 720, width: 480 },
  },
  {
    action: "none",
    expectedText: ["Recording saved", "artifacts/atet/recordings/rec_demo0001", "00:42"],
    id: "stop-finalized",
    viewport: { height: 720, width: 480 },
  },
  {
    action: "denied-start",
    expectedText: ["2 permissions need attention", "Mac system audio", "Camera (denied)", "Microphone (denied)"],
    id: "permission-denied",
    viewport: { height: 720, width: 480 },
  },
  {
    action: "recover",
    expectedText: ["The recording stopped after a local capture failure", "Start recording"],
    id: "failed-recovery",
    viewport: { height: 720, width: 480 },
  },
  {
    action: "none",
    expectedText: [
      "One clock · screen + two camera/audio placements",
      "Laptop screen + system audio",
      "Camera A — presenter",
      "Camera B — desk detail",
      "Audio alignment candidates",
      "accepted audio",
      "Global synchronized edit plan",
      "cut all placements",
      "speed all placements",
      "Camera motion receipts",
      "Ken Burns · digital pan + zoom",
      "camera_kenburns001 · 2 keyframes",
      "camera_faces0001 · 6 keyframes",
      "Face-follow provenance",
      "explicit 2-face group",
      "require all selected",
      "hold up to 3.0s · then fallback",
      "local geometry only",
      "no biometric identification",
    ],
    id: "multi-asset-project",
    viewport: { height: 900, width: 1_120 },
  },
  {
    action: "none",
    expectedText: [
      "Compact local evidence ledger",
      "no Python · no cloud execution",
      "PySceneDetect-compatible reference",
      "tempo change +14",
      "Screen + camera scenes",
      "safe cut →",
      "kept · music-protected",
      "kept · contextual / unsafe",
    ],
    id: "agent-analysis-ledger",
    viewport: { height: 900, width: 1_120 },
  },
  {
    action: "none",
    expectedText: [
      "Compiled graph · parallel waves · durable replay",
      "direct-code-mode",
      "Production compiler evidence",
      "6 nodes · 4 waves",
      "analyze/faces",
      "analyze/inactivity",
      "analyze/music",
      "trusted · direct.select-cuts",
      "Interrupted after trusted-code dispatch",
      "ambiguous-code",
      "Exact-node replay completed",
      "Exact recovery grant",
      "one-attempt",
      "atet runs resume run_direct_workflow --replay-ambiguous-code curate",
      "Durable run files",
      "exact graph and output digests",
      "artifacts/atet/private/workflow-runs/run_direct_workflow/graph-plan.json",
      "artifacts/atet/private/workflow-runs/run_direct_workflow/summary.json",
      "artifacts/atet/private/workflow-runs/run_direct_workflow/outputs.json",
    ],
    id: "code-mode-workflow",
    viewport: { height: 900, width: 1_120 },
  },
  {
    action: "none",
    expectedText: [
      "Image · SVG · GIF · video · emoji",
      "fully structured controls · project time",
      "duck primary to 0.35",
      "apple-emoji-pack",
      "Overlay control surface",
      "keyframes",
      "audio policy",
      "emoji set",
    ],
    id: "overlay-compositor",
    viewport: { height: 900, width: 1_120 },
  },
] as const satisfies readonly BrowserScenario[];

export const atetBrowserScenarioIds = Object.freeze(
  scenarios.map(({ id }) => id),
);

interface ScenarioCoverageReference {
  readonly key: string;
  readonly scenarios: readonly string[];
}

function duplicates(values: readonly string[]): readonly string[] {
  const seen = new Set<string>();
  const repeated = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) repeated.add(value);
    seen.add(value);
  }
  return [...repeated].sort();
}

export function scenarioAuditFailures(
  catalogIds: readonly string[],
  verifierIds: readonly string[],
  evidenceIds: readonly string[],
  coverage: readonly ScenarioCoverageReference[],
): readonly string[] {
  const failures: string[] = [];
  for (const [label, values] of [
    ["catalog", catalogIds],
    ["verifier", verifierIds],
    ["evidence", evidenceIds],
  ] as const) {
    const repeated = duplicates(values);
    if (repeated.length > 0) failures.push(`${label} repeats ${repeated.join(", ")}`);
  }
  const catalog = new Set(catalogIds);
  const verifier = new Set(verifierIds);
  const evidence = new Set(evidenceIds);
  const cited = new Set(coverage.flatMap(({ scenarios: ids }) => ids));
  const difference = (left: ReadonlySet<string>, right: ReadonlySet<string>) => (
    [...left].filter((value) => !right.has(value)).sort()
  );
  for (const [label, values] of [
    ["catalog scenarios missing verifier definitions", difference(catalog, verifier)],
    ["verifier definitions outside the catalog", difference(verifier, catalog)],
    ["verifier scenarios missing browser evidence", difference(verifier, evidence)],
    ["browser evidence outside verifier definitions", difference(evidence, verifier)],
    ["coverage scenarios missing browser evidence", difference(cited, evidence)],
    ["browser evidence not cited by coverage", difference(evidence, cited)],
    ["catalog scenarios not cited by coverage", difference(catalog, cited)],
  ] as const) {
    if (values.length > 0) failures.push(`${label}: ${values.join(", ")}`);
  }
  return failures;
}

export function normalizeBaseUrl(input: string): string {
  let parsed: URL;
  try {
    parsed = new URL(input);
  } catch {
    throw new Error(`--base-url must be an absolute URL, received ${JSON.stringify(input)}.`);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("--base-url must use HTTP or HTTPS.");
  }
  if (parsed.username !== "" || parsed.password !== "") {
    throw new Error("--base-url cannot contain credentials.");
  }
  if (parsed.pathname !== "/" || parsed.search !== "" || parsed.hash !== "") {
    throw new Error("--base-url must identify an origin without a path, query, or fragment.");
  }
  return parsed.origin;
}

export function parseArguments(arguments_: readonly string[]): ParsedArguments {
  let baseUrl = DEFAULT_BASE_URL;
  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index];
    if (argument === undefined) continue;
    if (argument === "--help" || argument === "-h") return { kind: "help" };
    if (argument.startsWith("--base-url=")) {
      baseUrl = argument.slice("--base-url=".length);
      continue;
    }
    if (argument === "--base-url") {
      const value = arguments_[index + 1];
      if (value === undefined || value.startsWith("-")) throw new Error("--base-url requires a value.");
      baseUrl = value;
      index += 1;
      continue;
    }
    throw new Error(`Unknown argument ${JSON.stringify(argument)}.`);
  }
  return { baseUrl: normalizeBaseUrl(baseUrl), kind: "run" };
}

export function canAutomaticallyStartServer(baseUrl: string): boolean {
  const url = new URL(normalizeBaseUrl(baseUrl));
  return url.protocol === "http:" && (url.hostname === "127.0.0.1" || url.hostname === "localhost");
}

export function externalOrFailedRequests(
  requests: readonly NetworkRequest[],
  baseUrl: string,
): readonly NetworkRequest[] {
  const origin = normalizeBaseUrl(baseUrl);
  return requests.filter((request) => {
    let requestOrigin: string;
    try {
      requestOrigin = new URL(request.url).origin;
    } catch {
      return true;
    }
    return requestOrigin !== origin
      || request.method !== "GET"
      || request.status === undefined
      || request.status < 200
      || request.status >= 400;
  });
}

export function responsiveLayoutFailures(
  measurement: ResponsiveLayoutMeasurement,
): readonly string[] {
  const failures: string[] = [];
  if (measurement.scrollWidth > measurement.clientWidth + 1) {
    failures.push(`document is ${Math.round(measurement.scrollWidth - measurement.clientWidth)}px wider than its viewport`);
  }
  for (const control of measurement.controls) {
    if (control.left < -0.5 || control.right > measurement.clientWidth + 0.5) {
      failures.push(`${control.label} leaves the horizontal viewport`);
    }
    if (control.height + 0.5 < 44) {
      failures.push(`${control.label} is only ${Math.round(control.height)}px tall`);
    }
  }
  return failures;
}

function scenarioUrl(baseUrl: string, id: string): string {
  const url = new URL("/", `${normalizeBaseUrl(baseUrl)}/`);
  url.searchParams.set(SCENARIO_QUERY_KEY, id);
  url.searchParams.set("directFrame", "1");
  return url.href;
}

function renderUnknown(value: unknown): string {
  if (value instanceof Error) return `${value.name}: ${value.message}`;
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}

function tail(value: string): string {
  return value.length <= LOG_LIMIT ? value : value.slice(-LOG_LIMIT);
}

function parseAgentBrowserJson(source: string): unknown {
  let input: unknown;
  try {
    input = JSON.parse(source) as unknown;
  } catch {
    throw new Error("agent-browser did not return one JSON envelope.");
  }
  const envelope = commandEnvelopeSchema.safeParse(input);
  if (!envelope.success) throw new Error(`agent-browser envelope is invalid: ${envelope.error.message}`);
  if (!envelope.data.success) throw new Error(`agent-browser failed: ${renderUnknown(envelope.data.error)}`);
  return envelope.data.data;
}

function parseData<Value>(schema: z.ZodType<Value>, input: unknown, label: string): Value {
  const parsed = schema.safeParse(input);
  if (!parsed.success) throw new Error(`${label} is invalid: ${parsed.error.message}`);
  return parsed.data;
}

function createBrowser(repositoryRoot: string) {
  const binary = join(repositoryRoot, "apps/desktop/node_modules/.bin/agent-browser");
  const session = `atet-${String(process.pid)}-${randomUUID().slice(0, 6)}`;
  const environment = {
    ...process.env,
    AGENT_BROWSER_DEFAULT_TIMEOUT: "35000",
    AGENT_BROWSER_NAMESPACE: session,
    AGENT_BROWSER_RESTORE_SAVE: "never",
    AGENT_BROWSER_SESSION: session,
  };
  let used = false;
  return {
    async close(): Promise<void> {
      if (used) await this.run(["close"]);
    },
    async run(arguments_: readonly string[]): Promise<unknown> {
      used = true;
      const command = Bun.spawn([binary, "--json", ...arguments_], {
        cwd: repositoryRoot,
        env: environment,
        stderr: "pipe",
        stdin: "ignore",
        stdout: "pipe",
      });
      const [stdout, stderr, exitCode] = await Promise.all([
        new Response(command.stdout).text(),
        new Response(command.stderr).text(),
        command.exited,
      ]);
      if (exitCode !== 0) {
        throw new Error(`agent-browser ${arguments_.join(" ")} failed: ${tail(stderr.trim() || stdout.trim())}`);
      }
      return parseAgentBrowserJson(stdout);
    },
  };
}

type Browser = ReturnType<typeof createBrowser>;

async function evaluate(browser: Browser, expression: string): Promise<unknown> {
  const result = parseData(evaluationSchema, await browser.run(["eval", expression]), "browser evaluation");
  return result.result;
}

async function joinStableProbe(browser: Browser): Promise<void> {
  await evaluate(browser, "window.__atetDirectVerifierQuiet = undefined");
  await browser.run(["wait", "--fn", STABLE_PROBE_EXPRESSION]);
}

interface BrowserCommandRunner {
  readonly run: (arguments_: readonly string[]) => Promise<unknown>;
}

export async function waitForDirectBridge(
  browser: BrowserCommandRunner,
  scenarioId: string,
): Promise<void> {
  try {
    await browser.run([
      "wait",
      "--fn",
      "typeof window.__direct?.snapshot === 'function'",
    ]);
  } catch (reason) {
    let diagnostic: string;
    try {
      const errors = parseData(
        errorsSchema,
        await browser.run(["errors"]),
        "browser startup errors",
      ).errors;
      diagnostic = errors.length === 0
        ? "no browser errors were reported"
        : `browser errors: ${renderUnknown(errors)}`;
    } catch (diagnosticReason) {
      diagnostic = `browser error inspection failed: ${renderUnknown(diagnosticReason)}`;
    }
    throw new Error(
      `${scenarioId} did not mount the Direct bridge: ${renderUnknown(reason)}; ${diagnostic}`,
      { cause: reason },
    );
  }
}

async function readProbe(browser: Browser): Promise<ProbeSnapshot> {
  const parsed = parseDirectProbeSnapshot(
    await evaluate(browser, "window.__direct.snapshot()"),
  );
  if (!parsed.ok) throw new Error(`canonical probe is invalid: ${parsed.error.message}`);
  return Object.freeze({
    ...parsed.value,
    remainingWork: parseData(
      remainingWorkSchema,
      parsed.value.remainingWork,
      "Atet remaining work",
    ),
  });
}

export function parseAtetDefinitionCoverage(input: unknown) {
  return parseDefinitionCoverageSnapshot(input, atetDirect);
}

async function bodyText(browser: Browser): Promise<string> {
  const body = await evaluate(browser, "document.body?.innerText ?? ''");
  if (typeof body !== "string") throw new Error("Browser body evaluation did not return text.");
  return body;
}

export function visibleTextContains(body: string, expected: string): boolean {
  return body.toLocaleLowerCase().includes(expected.toLocaleLowerCase());
}

async function clickExactButton(browser: Browser, label: string): Promise<void> {
  const clicked = await evaluate(browser, `(() => {
    const buttons = [...document.querySelectorAll("button")]
      .filter((button) => button.textContent?.trim() === ${JSON.stringify(label)});
    if (buttons.length !== 1) return { count: buttons.length };
    buttons[0].click();
    return { count: 1 };
  })()`);
  if (
    typeof clicked !== "object"
    || clicked === null
    || Reflect.get(clicked, "count") !== 1
  ) {
    throw new Error(`Expected one ${label} button, received ${renderUnknown(clicked)}.`);
  }
}

async function clickExactButtonTwiceInOneTask(
  browser: Browser,
  label: string,
): Promise<void> {
  const clicked = await evaluate(browser, `(() => {
    const buttons = [...document.querySelectorAll("button")]
      .filter((button) => button.textContent?.trim() === ${JSON.stringify(label)});
    if (buttons.length !== 1) return { count: buttons.length };
    buttons[0].click();
    buttons[0].click();
    return { count: 1 };
  })()`);
  if (
    typeof clicked !== "object"
    || clicked === null
    || Reflect.get(clicked, "count") !== 1
  ) {
    throw new Error(`Expected one ${label} button, received ${renderUnknown(clicked)}.`);
  }
}

async function waitForText(browser: Browser, text: string): Promise<void> {
  const expected = JSON.stringify(text.toLocaleLowerCase());
  await browser.run([
    "wait",
    "--fn",
    `document.body?.innerText.toLocaleLowerCase().includes(${expected}) === true`,
  ]);
}

async function performAction(browser: Browser, action: ScenarioAction): Promise<readonly string[]> {
  if (action === "none") return [];
  if (action === "start") {
    await clickExactButtonTwiceInOneTask(browser, "Start recording");
    await waitForText(browser, "Recording");
    await browser.run([
      "wait",
      "--fn",
      "document.querySelector('[data-command-pending]')?.getAttribute('data-command-pending') === 'none'",
    ]);
    if (visibleTextContains(await bodyText(browser), "Could not start recording.")) {
      throw new Error("Renderer dispatched a second Start while the first command was in flight.");
    }
    return ["Recording"];
  }
  if (action === "permission-prompt") {
    await clickExactButton(browser, "Start recording");
    await waitForText(browser, "Grant screen, audio, camera, microphone, and metadata permissions before recording.");
    return ["Grant screen, audio, camera, microphone, and metadata permissions before recording."];
  }
  if (action === "denied-start") {
    await clickExactButton(browser, "Start recording");
    await waitForText(browser, "A requested recording source is unavailable.");
    return ["A requested recording source is unavailable."];
  }
  if (action === "recover") {
    await clickExactButton(browser, "Start recording");
    await waitForText(browser, "Recording");
    return ["Recording"];
  }
  if (action === "interrupted-lifecycle") {
    await waitForText(browser, "Camera disconnected");
    await clickExactButton(browser, "Resume");
    await waitForText(browser, "Recording");
    await clickExactButton(browser, "Stop");
    await waitForText(browser, "Recording saved");
    return ["Recording", "Recording saved"];
  }
  if (action === "paused-lifecycle") {
    await clickExactButton(browser, "Resume");
    await waitForText(browser, "Recording");
    await clickExactButton(browser, "Pause");
    await waitForText(browser, "Paused — segment safely closed");
    await clickExactButton(browser, "Stop");
    await waitForText(browser, "Recording saved");
    return ["Recording", "Recording saved"];
  }
  await clickExactButton(browser, "Pause");
  await waitForText(browser, "Paused — segment safely closed");
  await clickExactButton(browser, "Resume");
  await waitForText(browser, "Recording");
  await clickExactButton(browser, "Stop");
  await waitForText(browser, "Recording saved");
  return ["Paused — segment safely closed", "Recording saved"];
}

function assertProbe(probe: ProbeSnapshot, scenarioId: string): void {
  if (!probe.isQuiescent || probe.activity.active !== 0 || probe.activity.started !== probe.activity.settled) {
    throw new Error(`${scenarioId} leaked Direct activity: ${JSON.stringify(probe.activity)}`);
  }
  if (Object.values(probe.pending).some((count) => count !== 0)) {
    throw new Error(`${scenarioId} retained pending work: ${JSON.stringify(probe.pending)}`);
  }
  const violations = Object.entries(probe.violations).filter(([, count]) => count !== 0);
  if (violations.length > 0) {
    throw new Error(`${scenarioId} reported Direct violations: ${JSON.stringify(violations)}`);
  }
  if (
    probe.remainingWork.disposed
    || probe.remainingWork.eventListeners !== 1
    || probe.remainingWork.transitions !== 0
  ) {
    throw new Error(`${scenarioId} retained unexpected work: ${JSON.stringify(probe.remainingWork)}`);
  }
}

async function verifyScenario(options: {
  readonly baseUrl: string;
  readonly browser: Browser;
  readonly definition: BrowserScenario;
  readonly repositoryRoot: string;
  readonly runDirectory: string;
}): Promise<ScenarioVerification> {
  const { baseUrl, browser, definition, repositoryRoot, runDirectory } = options;
  const url = scenarioUrl(baseUrl, definition.id);
  await browser.run(["set", "viewport", String(definition.viewport.width), String(definition.viewport.height)]);
  await browser.run(["errors", "--clear"]);
  await browser.run(["console", "--clear"]);
  await browser.run(["network", "requests", "--clear"]);
  await browser.run(["open", url]);
  await waitForDirectBridge(browser, definition.id);
  const authoredScenario = atetScenarioCatalog.resolve(definition.id);
  if (!authoredScenario.ok) throw new Error(authoredScenario.error.message);
  const contract = await readDirectBrowserContract({
    evaluate: (expression) => evaluate(browser, expression),
  }, {
    source: "scenario",
    scenario: definition.id,
    route: authoredScenario.value.route,
  });
  await joinStableProbe(browser);

  for (const expected of definition.expectedText) await waitForText(browser, expected);
  const beforeActionBody = await bodyText(browser);
  const missingInitialText = definition.expectedText.filter((expected) => !visibleTextContains(beforeActionBody, expected));
  if (missingInitialText.length > 0) {
    throw new Error(`${definition.id} is missing initial text: ${missingInitialText.join(", ")}`);
  }
  const actionEvidence = await performAction(browser, definition.action);
  await joinStableProbe(browser);
  const expectedText = [...definition.expectedText, ...actionEvidence];

  const layout = parseData(layoutSchema, await evaluate(browser, `(() => {
    const root = document.documentElement;
    const controls = [...document.querySelectorAll("button, summary")]
      .filter((element) => element.getClientRects().length > 0)
      .map((element) => {
        const rectangle = element.getBoundingClientRect();
        return {
          bottom: rectangle.bottom,
          height: rectangle.height,
          label: (element.getAttribute("aria-label") || element.textContent || element.tagName).trim().slice(0, 80),
          left: rectangle.left,
          right: rectangle.right,
          top: rectangle.top,
        };
      });
    return {
      clientHeight: root.clientHeight,
      clientWidth: root.clientWidth,
      controls,
      scrollWidth: root.scrollWidth,
    };
  })()`), "responsive layout");
  const layoutFailures = responsiveLayoutFailures(layout);
  if (layoutFailures.length > 0) {
    throw new Error(`${definition.id} layout failed: ${layoutFailures.join("; ")}`);
  }

  const probe = await readProbe(browser);
  assertProbe(probe, definition.id);
  await joinStableProbe(browser);
  const stableProbe = await readProbe(browser);
  assertProbe(stableProbe, definition.id);
  if (JSON.stringify(probe) !== JSON.stringify(stableProbe)) {
    throw new Error(`${definition.id} canonical probe changed across two stable settle intervals.`);
  }

  const errors = parseData(errorsSchema, await browser.run(["errors"]), "browser errors").errors;
  if (errors.length > 0) throw new Error(`${definition.id} reported browser errors: ${renderUnknown(errors)}`);
  const messages = parseData(consoleSchema, await browser.run(["console"]), "browser console").messages;
  const consoleFailures = messages.filter(({ type }) => type === "error" || type === "assert");
  if (consoleFailures.length > 0) {
    throw new Error(`${definition.id} reported console failures: ${renderUnknown(consoleFailures)}`);
  }
  const requests = parseData(networkSchema, await browser.run(["network", "requests"]), "network requests").requests;
  const rejected = externalOrFailedRequests(requests, baseUrl);
  if (rejected.length > 0) throw new Error(`${definition.id} made rejected requests: ${renderUnknown(rejected)}`);

  const screenshot = join(runDirectory, `${definition.id}.png`);
  await browser.run(["screenshot", "--full", screenshot]);
  if ((await stat(screenshot)).size < 1_024) throw new Error(`${definition.id} screenshot is unexpectedly small.`);
  const finalContract = bindDirectBrowserContractEvidence(
    contract,
    await readDirectBrowserContract({
      evaluate: (expression) => evaluate(browser, expression),
    }, {
      source: "scenario",
      scenario: definition.id,
      route: authoredScenario.value.route,
    }),
    stableProbe,
  );
  return {
    evidence: {
      active: finalContract.manifest.active,
      catalogHash: finalContract.manifest.catalogHash,
      expectedText,
      id: definition.id,
      networkRequests: requests.length,
      probe,
      screenshot: relative(repositoryRoot, screenshot),
      url,
    },
    manifest: finalContract.manifest,
  };
}

export type AtetDirectServerProbe = "other" | "atet" | "unreachable";

export async function probeAtetDirectServer(
  baseUrl: string,
): Promise<AtetDirectServerProbe> {
  try {
    const response = await fetch(`${baseUrl}/`, { signal: AbortSignal.timeout(SERVER_PROBE_TIMEOUT_MS) });
    if (!response.ok) {
      await response.body?.cancel();
      return "other";
    }
    const document = await response.text();
    return ATET_DIRECT_DOCUMENT_MARKERS.every(marker => document.includes(marker))
      ? "atet"
      : "other";
  } catch {
    return "unreachable";
  }
}

interface StartedServer {
  readonly output: Promise<string>;
  readonly process: ReturnType<typeof Bun.spawn>;
}

interface AcquiredServer {
  readonly baseUrl: string;
  readonly server: StartedServer | null;
  readonly source: "reused" | "started";
}

async function portIsAvailable(port: number, hostname: string): Promise<boolean> {
  return await new Promise((resolveAvailability) => {
    const probe = createServer();
    let resolved = false;
    const finish = (available: boolean) => {
      if (resolved) return;
      resolved = true;
      resolveAvailability(available);
    };
    probe.unref();
    probe.once("error", () => finish(false));
    probe.listen(port, hostname, () => probe.close(() => finish(true)));
  });
}

async function availableLocalBaseUrl(baseUrl: string): Promise<string> {
  const url = new URL(normalizeBaseUrl(baseUrl));
  const startingPort = Number(url.port || "80");
  for (let offset = 1; offset <= 256; offset += 1) {
    const port = startingPort + offset;
    if (port > 65_535) break;
    if (await portIsAvailable(port, url.hostname)) {
      url.port = String(port);
      return url.origin;
    }
  }
  throw new Error(
    `Could not find a free local Atet Direct port after ${String(startingPort)}.`,
  );
}

async function collectStream(stream: ReadableStream<Uint8Array>): Promise<string> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let output = "";
  for (;;) {
    const chunk = await reader.read();
    if (chunk.done) return tail(`${output}${decoder.decode()}`);
    output = tail(`${output}${decoder.decode(chunk.value, { stream: true })}`);
  }
}

function startServer(repositoryRoot: string, baseUrl: string): StartedServer {
  const desktop = join(repositoryRoot, "apps/desktop");
  const port = new URL(baseUrl).port || "80";
  const process_ = Bun.spawn([process.execPath, "run", "dev:direct", "--", "--port", port], {
    cwd: desktop,
    env: { ...process.env, CI: "1" },
    stderr: "pipe",
    stdin: "ignore",
    stdout: "pipe",
  });
  const output = Promise.all([
    collectStream(process_.stdout),
    collectStream(process_.stderr),
  ]).then(([stdout, stderr]) => tail(`${stdout}\n${stderr}`.trim()));
  return { output, process: process_ };
}

async function stopServer(server: StartedServer): Promise<void> {
  if (server.process.exitCode === null) server.process.kill("SIGTERM");
  const stopped = await Promise.race([
    server.process.exited.then(() => true),
    Bun.sleep(3_000).then(() => false),
  ]);
  if (!stopped) {
    server.process.kill("SIGKILL");
    await server.process.exited;
  }
  await server.output;
}

async function acquireServer(
  repositoryRoot: string,
  requestedBaseUrl: string,
): Promise<AcquiredServer> {
  const initialProbe = await probeAtetDirectServer(requestedBaseUrl);
  const canStartLocally = canAutomaticallyStartServer(requestedBaseUrl);
  if (!canStartLocally) {
    if (initialProbe === "atet") {
      return { baseUrl: requestedBaseUrl, server: null, source: "reused" };
    }
    const reason = initialProbe === "other"
      ? "the reachable server is not Atet Direct"
      : "no server is reachable";
    throw new Error(
      `${reason} at ${requestedBaseUrl}; automatic startup is local HTTP only.`,
    );
  }
  const baseUrl = initialProbe === "unreachable"
    ? requestedBaseUrl
    : await availableLocalBaseUrl(requestedBaseUrl);
  const server = startServer(repositoryRoot, baseUrl);
  try {
    const deadline = Date.now() + SERVER_START_TIMEOUT_MS;
    while (Date.now() < deadline) {
      if (server.process.exitCode !== null) throw new Error(`Direct server exited: ${await server.output}`);
      if (await probeAtetDirectServer(baseUrl) === "atet") {
        return { baseUrl, server, source: "started" };
      }
      await Bun.sleep(200);
    }
    throw new Error(`Direct server did not start within ${String(SERVER_START_TIMEOUT_MS)}ms.`);
  } catch (reason) {
    await stopServer(server);
    throw reason;
  }
}

async function writeManifest(path: string, value: unknown): Promise<void> {
  const temporary = join(dirname(path), `.${String(process.pid)}-${randomUUID()}.tmp`);
  try {
    await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8");
    await rename(temporary, path);
  } catch (reason) {
    await rm(temporary, { force: true });
    throw reason;
  }
}

async function run(repositoryRoot: string, requestedBaseUrl: string): Promise<string> {
  const artifactRoot = join(repositoryRoot, "artifacts/atet/direct");
  const generatedAt = new Date().toISOString();
  const runDirectory = join(artifactRoot, `${generatedAt.replaceAll(/[^0-9A-Za-z]/gu, "-")}-${String(process.pid)}`);
  await mkdir(runDirectory, { recursive: true });
  const acquiredServer = await acquireServer(repositoryRoot, requestedBaseUrl);
  const { baseUrl, server } = acquiredServer;
  const browser = createBrowser(repositoryRoot);
  const evidence: ScenarioEvidence[] = [];
  const sessionManifests: DirectBrowserContract["manifest"][] = [];
  let failure: unknown = null;
  let coverage: readonly CoverageEntry[] = [];
  try {
    for (const definition of scenarios) {
      console.log(`Verifying ${definition.id}...`);
      const verified = await verifyScenario({
        baseUrl,
        browser,
        definition,
        repositoryRoot,
        runDirectory,
      });
      evidence.push(verified.evidence);
      sessionManifests.push(verified.manifest);
    }
    const parsedCoverage = parseAtetDefinitionCoverage(
      bindDirectScenarioCatalog(sessionManifests),
    );
    if (!parsedCoverage.ok) {
      throw new Error(`coverage catalog is invalid: ${parsedCoverage.error.message}`);
    }
    coverage = parsedCoverage.value.entries;
    const auditFailures = scenarioAuditFailures(
      atetScenarioCatalog.list().map(({ id }) => id),
      atetBrowserScenarioIds,
      evidence.map(({ id }) => id),
      coverage,
    );
    if (auditFailures.length > 0) throw new Error(`Scenario audit failed: ${auditFailures.join("; ")}`);
    if (!coverage.some(({ mode }) => mode === "direct")) {
      throw new Error("Coverage must keep native-only proof visible.");
    }
  } catch (reason) {
    failure = reason;
  }

  const cleanupFailures: unknown[] = [];
  try {
    await browser.close();
  } catch (reason) {
    cleanupFailures.push(reason);
  }
  if (server !== null) {
    try {
      await stopServer(server);
    } catch (reason) {
      cleanupFailures.push(reason);
    }
  }
  if (failure !== null || cleanupFailures.length > 0) {
    throw new AggregateError(
      failure === null ? cleanupFailures : [failure, ...cleanupFailures],
      `Atet browser verification failed: ${renderUnknown(failure ?? cleanupFailures[0])}`,
    );
  }

  const manifestPath = join(artifactRoot, "manifest.json");
  await writeManifest(manifestPath, {
    $schema: "jungle.direct.web-verification/v1",
    baseUrl,
    coverage,
    coverageResults: coverage.map((entry) => ({
      key: entry.key,
      result: classifyCoverageEvidence(entry, {
        exercisedScenarios: new Set(evidence.map(({ id }) => id)),
      }),
      scenarios: entry.scenarios,
    })),
    generatedAt,
    product: "atet",
    scenarios: evidence,
    server: acquiredServer.source,
  });
  return manifestPath;
}

function usage(): string {
  return [
    "Usage: bun run direct/verify-browser.ts [--base-url URL]",
    "",
    `Default URL: ${DEFAULT_BASE_URL}`,
    "Reuses a reachable server or starts and stops Atet's isolated Vite lab.",
  ].join("\n");
}

async function main(): Promise<void> {
  const arguments_ = parseArguments(process.argv.slice(2));
  if (arguments_.kind === "help") {
    console.log(usage());
    return;
  }
  const repositoryRoot = resolve(fileURLToPath(new URL("../../..", import.meta.url)));
  const manifest = await run(repositoryRoot, arguments_.baseUrl);
  console.log(`Atet Direct browser verification passed. Manifest: ${manifest}`);
}

if (import.meta.main) await main();
