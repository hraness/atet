import { createHash } from "node:crypto";

import { z } from "zod";
import playwrightCorePackage from "playwright-core/package.json";

import { canonicalJson } from "../core/canonical-json";
import {
  HtmlOverlayAuthoringInputSchema,
  createHtmlOverlayBrowserRuntimeSource,
  createHtmlOverlayImportMap,
  getApprovedHtmlOverlayLibraryLock,
  type HtmlOverlayAuthoringInput,
  type HtmlOverlayImportMap,
  type HtmlOverlayLibraryLock,
} from "../html-overlay";
import {
  HtmlOverlayBrowserRuntimeBindingSchema,
  type HtmlOverlayBrowserRuntimeBinding,
} from "./html-overlay-browser-runtime";

const Sha256Schema = z.string().regex(/^[a-f0-9]{64}$/u);
const IntegrityLeafSchema = z.strictObject({
  key: z.string().min(1).max(512),
  sha256: Sha256Schema,
});

export const HtmlOverlayExecutionIntegritySchema = z.strictObject({
  algorithm: z.literal("sha256-merkle-v1"),
  leaves: z.array(IntegrityLeafSchema).min(4).max(256).superRefine((leaves, context) => {
    for (let index = 1; index < leaves.length; index += 1) {
      if (leaves[index - 1]!.key >= leaves[index]!.key) {
        context.addIssue({
          code: "custom",
          message: "HTML-overlay integrity leaves must have unique ASCII-sorted keys.",
          path: [index, "key"],
        });
      }
    }
  }),
  rootSha256: Sha256Schema,
  runtimeSha256: Sha256Schema,
  schemaVersion: z.literal(1),
});
export type HtmlOverlayExecutionIntegrity = Readonly<
  z.infer<typeof HtmlOverlayExecutionIntegritySchema>
>;

export interface HtmlOverlayExecutionBundle {
  readonly importMap: HtmlOverlayImportMap;
  readonly integrity: HtmlOverlayExecutionIntegrity;
  readonly libraryLocks: readonly HtmlOverlayLibraryLock[];
  readonly runtimeSource: string;
}

/**
 * Receipt-bound browser behavior. Any change to launch isolation, the private
 * routing model, deterministic context, or transparent capture changes the
 * execution root even when every authored and browser byte stays identical.
 */
export const HTML_OVERLAY_RENDERER_CONTRACT = Object.freeze({
  browser: "playwright-chromium",
  browserVersion: playwrightCorePackage.version,
  browserContext: Object.freeze({
    acceptDownloads: false,
    colorScheme: "light",
    locale: "en-US",
    offline: true,
    permissions: Object.freeze([] as string[]),
    reducedMotion: "no-preference",
    serviceWorkers: "block",
    timezoneId: "UTC",
  }),
  contentSecurityPolicy: Object.freeze([
    "default-src 'none'",
    "base-uri 'none'",
    "connect-src 'none'",
    "font-src https://atet-overlay.invalid data:",
    "form-action 'none'",
    "frame-src 'none'",
    "img-src https://atet-overlay.invalid data:",
    "media-src https://atet-overlay.invalid data:",
    "object-src 'none'",
    "script-src 'unsafe-inline' https://atet-overlay.invalid",
    "style-src 'unsafe-inline'",
    "worker-src 'none'",
  ]),
  documentUrl: "https://atet-overlay.invalid/atet-overlay/document",
  environment: Object.freeze({
    fixed: Object.freeze({
      LANG: "en_US.UTF-8",
      LC_ALL: "en_US.UTF-8",
      PATH: "/usr/bin:/bin",
      TZ: "UTC",
    }),
    inherited: Object.freeze([] as string[]),
    privateDirectories: Object.freeze(["HOME", "TMPDIR"]),
  }),
  launch: Object.freeze({
    args: Object.freeze([
      "--disable-background-networking",
      "--disable-breakpad",
      "--disable-component-update",
      "--disable-default-apps",
      "--disable-domain-reliability",
      "--disable-extensions",
      "--disable-features=Translate,MediaRouter,OptimizationHints",
      "--disable-quic",
      "--disable-sync",
      "--enable-unsafe-swiftshader",
      "--force-webrtc-ip-handling-policy=disable_non_proxied_udp",
      "--metrics-recording-only",
      "--mute-audio",
      "--no-default-browser-check",
      "--no-first-run",
      "--no-proxy-server",
      "--use-angle=swiftshader",
    ]),
    headless: true,
  }),
  routing: Object.freeze({
    allowedOrigin: "https://atet-overlay.invalid",
    declaredResourcesOnly: true,
    remoteNetworkDenied: true,
  }),
  runtimeSnapshot: Object.freeze({
    macosAnchor: "/private/tmp",
    macosAnchorPolicy: "physical-root-owned-sticky-direct-child",
    cleanupIdentity: "container-direct-children-and-complete-runtime-manifest",
    copyBufferBytes: 4 * 1024 * 1024,
    filesystemGuard: "anchor-basename-and-recursive-parent-watch-with-path-identities",
    orphanRecovery: "active-to-released-lease-last-atomic-quarantine-double-open-proof",
    verifiedMacosFilesystemFlags: "user-immutable-recursive",
  }),
  schemaVersion: 1,
  screenshot: Object.freeze({
    omitBackground: true,
    scale: "css",
    type: "png",
  }),
});

function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function leafSha256(key: string, value: unknown): string {
  return sha256(canonicalJson({
    domain: "transmute.html-overlay-integrity-leaf/v1",
    key,
    value,
  }));
}

function merkleRoot(leaves: readonly Readonly<{ key: string; sha256: string }>[]): string {
  let level = leaves.map(leaf => sha256([
    "atet.html-overlay-integrity-node/v1",
    "leaf",
    leaf.key,
    leaf.sha256,
  ].join("\0")));
  while (level.length > 1) {
    const next: string[] = [];
    for (let index = 0; index < level.length; index += 2) {
      const left = level[index]!;
      const right = level[index + 1] ?? left;
      next.push(sha256([
        "atet.html-overlay-integrity-node/v1",
        "branch",
        left,
        right,
      ].join("\0")));
    }
    level = next;
  }
  return level[0]!;
}

/**
 * Freezes every byte-bearing browser input behind one reproducible Merkle root.
 * The renderer verifies the declared browser, resource, and module bytes and
 * executes the exact runtime source returned in this bundle.
 */
export function createHtmlOverlayExecutionBundle(
  authoringInput: HtmlOverlayAuthoringInput,
  browserRuntimeInput: HtmlOverlayBrowserRuntimeBinding,
): HtmlOverlayExecutionBundle {
  const authoring = HtmlOverlayAuthoringInputSchema.parse(authoringInput);
  const browserRuntime = HtmlOverlayBrowserRuntimeBindingSchema.parse(
    browserRuntimeInput,
  );
  const libraryLocks = authoring.libraries.map(
    getApprovedHtmlOverlayLibraryLock,
  );
  const importMap = createHtmlOverlayImportMap(authoring.libraries);
  const runtimeSource = createHtmlOverlayBrowserRuntimeSource({
    canvas: authoring.canvas,
    parameters: authoring.parameters,
    resources: authoring.resources,
    seed: authoring.seed,
    timing: authoring.timing,
  });
  const runtimeSha256 = sha256(Buffer.from(runtimeSource, "utf8"));
  const entries: Array<Readonly<{ key: string; value: unknown }>> = [
    {
      key: "authoring-config",
      value: {
        canvas: authoring.canvas,
        kind: authoring.kind,
        parameters: authoring.parameters,
        schemaVersion: authoring.schemaVersion,
        seed: authoring.seed,
        timing: authoring.timing,
      },
    },
    { key: "browser-runtime", value: browserRuntime },
    { key: "renderer-contract", value: HTML_OVERLAY_RENDERER_CONTRACT },
    {
      key: "document",
      value: {
        bytes: Buffer.byteLength(authoring.html, "utf8"),
        sha256: sha256(Buffer.from(authoring.html, "utf8")),
      },
    },
    { key: "import-map", value: importMap },
    {
      key: "runtime",
      value: {
        bytes: Buffer.byteLength(runtimeSource, "utf8"),
        sha256: runtimeSha256,
      },
    },
    ...libraryLocks.map(lock => ({
      key: `library:${lock.specifier}`,
      value: lock,
    })),
    ...authoring.resources.map(resource => ({
      key: `resource:${resource.name}`,
      value: resource,
    })),
  ];
  const leaves = entries
    .map(entry => ({
      key: entry.key,
      sha256: leafSha256(entry.key, entry.value),
    }))
    .sort((left, right) => left.key < right.key ? -1 : left.key > right.key ? 1 : 0);
  const integrity = HtmlOverlayExecutionIntegritySchema.parse({
    algorithm: "sha256-merkle-v1",
    leaves,
    rootSha256: merkleRoot(leaves),
    runtimeSha256,
    schemaVersion: 1,
  });
  return Object.freeze({
    importMap,
    integrity: Object.freeze(integrity),
    libraryLocks: Object.freeze(libraryLocks),
    runtimeSource,
  });
}
