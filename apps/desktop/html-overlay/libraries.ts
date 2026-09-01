import { z } from "zod";

import { canonicalJson } from "../core/canonical-json";
import type { HtmlOverlayDeclaredResource } from "./contracts";

export const HTML_OVERLAY_LIBRARY_SPECIFIERS = [
  "@paper-design/shaders",
  "motion",
  "three",
  "vgpu",
] as const;

export const HtmlOverlayLibrarySpecifierSchema = z.enum(HTML_OVERLAY_LIBRARY_SPECIFIERS);
export type HtmlOverlayLibrarySpecifier = typeof HTML_OVERLAY_LIBRARY_SPECIFIERS[number];

const MotionLockSchema = z.strictObject({
  bytes: z.literal(12_098),
  license: z.literal("MIT"),
  sha256: z.literal("0d89a96784df54ed726443ebd09be2bee6118d9f1e074166df580bce632c5b62"),
  specifier: z.literal("motion"),
  url: z.literal("https://esm.sh/motion@12.42.2/es2022/mini.bundle.mjs"),
  version: z.literal("12.42.2"),
});

const PaperShadersLockSchema = z.strictObject({
  bytes: z.literal(196_909),
  license: z.literal("Apache-2.0"),
  sha256: z.literal("4b7f8d053f6c91b4d3ec6abdcfd4b07b9fce7ec2b8086a0f0781f485c59d097e"),
  specifier: z.literal("@paper-design/shaders"),
  url: z.literal("https://esm.sh/@paper-design/shaders@0.0.77/es2022/shaders.bundle.mjs"),
  version: z.literal("0.0.77"),
});

const ThreeLockSchema = z.strictObject({
  bytes: z.literal(729_954),
  license: z.literal("MIT"),
  sha256: z.literal("12e6dd7a5cceb3efd76f8c65acbf5aa55c74820115d9ebae874b28456b9ddb5c"),
  specifier: z.literal("three"),
  url: z.literal("https://esm.sh/three@0.185.1/es2022/three.bundle.mjs"),
  version: z.literal("0.185.1"),
});

const VgpuLockSchema = z.strictObject({
  bytes: z.literal(181_522),
  license: z.literal("MIT"),
  sha256: z.literal("f7ef874ca3dd29b165beaaf77297d64e06b65db1c48819ac472446da46f2cc9f"),
  specifier: z.literal("vgpu"),
  url: z.literal("https://esm.sh/vgpu@0.3.1/es2022/vgpu.bundle.mjs"),
  version: z.literal("0.3.1"),
});

export const HtmlOverlayLibraryLockSchema = z.discriminatedUnion("specifier", [
  PaperShadersLockSchema,
  MotionLockSchema,
  ThreeLockSchema,
  VgpuLockSchema,
]);
export type HtmlOverlayLibraryLock = Readonly<z.infer<typeof HtmlOverlayLibraryLockSchema>>;

export const APPROVED_HTML_OVERLAY_LIBRARY_LOCKS = Object.freeze([
  Object.freeze({
    bytes: 196_909,
    license: "Apache-2.0",
    sha256: "4b7f8d053f6c91b4d3ec6abdcfd4b07b9fce7ec2b8086a0f0781f485c59d097e",
    specifier: "@paper-design/shaders",
    url: "https://esm.sh/@paper-design/shaders@0.0.77/es2022/shaders.bundle.mjs",
    version: "0.0.77",
  }),
  Object.freeze({
    bytes: 12_098,
    license: "MIT",
    sha256: "0d89a96784df54ed726443ebd09be2bee6118d9f1e074166df580bce632c5b62",
    specifier: "motion",
    url: "https://esm.sh/motion@12.42.2/es2022/mini.bundle.mjs",
    version: "12.42.2",
  }),
  Object.freeze({
    bytes: 729_954,
    license: "MIT",
    sha256: "12e6dd7a5cceb3efd76f8c65acbf5aa55c74820115d9ebae874b28456b9ddb5c",
    specifier: "three",
    url: "https://esm.sh/three@0.185.1/es2022/three.bundle.mjs",
    version: "0.185.1",
  }),
  Object.freeze({
    bytes: 181_522,
    license: "MIT",
    sha256: "f7ef874ca3dd29b165beaaf77297d64e06b65db1c48819ac472446da46f2cc9f",
    specifier: "vgpu",
    url: "https://esm.sh/vgpu@0.3.1/es2022/vgpu.bundle.mjs",
    version: "0.3.1",
  }),
] as const satisfies readonly HtmlOverlayLibraryLock[]);

function compareAscii(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

export const HtmlOverlayLibrarySelectionSchema = z.array(HtmlOverlayLibrarySpecifierSchema)
  .max(APPROVED_HTML_OVERLAY_LIBRARY_LOCKS.length)
  .superRefine((specifiers, context) => {
    if (new Set(specifiers).size !== specifiers.length) {
      context.addIssue({ code: "custom", message: "HTML overlay library specifiers must be unique." });
    }
  })
  .overwrite(specifiers => [...specifiers].sort(compareAscii));
export type HtmlOverlayLibrarySelection = Readonly<z.infer<typeof HtmlOverlayLibrarySelectionSchema>>;

export const HtmlOverlayLibraryLocksSchema = z.array(HtmlOverlayLibraryLockSchema)
  .max(APPROVED_HTML_OVERLAY_LIBRARY_LOCKS.length)
  .superRefine((locks, context) => {
    const specifiers = locks.map(lock => lock.specifier);
    if (new Set(specifiers).size !== specifiers.length) {
      context.addIssue({ code: "custom", message: "HTML overlay library locks must be unique." });
    }
  })
  .overwrite(locks => [...locks].sort((left, right) => compareAscii(left.specifier, right.specifier)));
export type HtmlOverlayLibraryLocks = Readonly<z.infer<typeof HtmlOverlayLibraryLocksSchema>>;

export const HTML_OVERLAY_LIBRARY_LOCAL_PREFIX = "/.atet-overlay/libraries/" as const;
export const HTML_OVERLAY_ASSET_LOCAL_PREFIX = "/.atet-overlay/assets/" as const;

export function getApprovedHtmlOverlayLibraryLock(
  specifier: HtmlOverlayLibrarySpecifier,
): HtmlOverlayLibraryLock {
  const parsed = HtmlOverlayLibrarySpecifierSchema.parse(specifier);
  const lock = APPROVED_HTML_OVERLAY_LIBRARY_LOCKS.find(candidate => candidate.specifier === parsed);
  if (lock === undefined) {
    throw new RangeError(`HTML overlay library is not approved: ${parsed}`);
  }
  return lock;
}

export function htmlOverlayLibraryLocalUrl(
  lockOrSpecifier: HtmlOverlayLibraryLock | HtmlOverlayLibrarySpecifier,
): string {
  const lock = typeof lockOrSpecifier === "string"
    ? getApprovedHtmlOverlayLibraryLock(lockOrSpecifier)
    : HtmlOverlayLibraryLockSchema.parse(lockOrSpecifier);
  return `${HTML_OVERLAY_LIBRARY_LOCAL_PREFIX}${lock.sha256}.mjs`;
}

export function htmlOverlayAssetLocalUrl(resource: HtmlOverlayDeclaredResource): string {
  return `${HTML_OVERLAY_ASSET_LOCAL_PREFIX}${resource.sha256}/${resource.urlPath}`;
}

export interface HtmlOverlayImportMap {
  readonly imports: Readonly<Partial<Record<HtmlOverlayLibrarySpecifier, string>>>;
}

export function createHtmlOverlayImportMap(
  selection: readonly HtmlOverlayLibrarySpecifier[],
): HtmlOverlayImportMap {
  const specifiers = HtmlOverlayLibrarySelectionSchema.parse(selection);
  const imports: Partial<Record<HtmlOverlayLibrarySpecifier, string>> = {};
  for (const specifier of specifiers) {
    imports[specifier] = htmlOverlayLibraryLocalUrl(specifier);
  }
  return Object.freeze({ imports: Object.freeze(imports) });
}

export function serializeHtmlOverlayImportMap(
  selection: readonly HtmlOverlayLibrarySpecifier[],
): string {
  return canonicalJson(createHtmlOverlayImportMap(selection));
}
