const canonicalRegistry = "https://registry.npmjs.org";
const expectedPublishConfigKeys = ["access", "registry"] as const;

function record(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be a JSON object.`);
  }
  return value as Record<string, unknown>;
}

export function verifyNpmPublishConfig(value: unknown): void {
  const publishConfig = record(value, "package.json publishConfig");
  const keys = Object.keys(publishConfig).toSorted();
  if (JSON.stringify(keys) !== JSON.stringify(expectedPublishConfigKeys)) {
    throw new Error(
      "package.json publishConfig must contain exactly access and registry; packed npm configuration overrides are forbidden.",
    );
  }
  if (
    publishConfig.access !== "public"
    || publishConfig.registry !== canonicalRegistry
  ) {
    throw new Error("package.json must publish publicly through the canonical npm registry.");
  }
}

export function verifyNpmPublishManifest(value: unknown): void {
  const manifest = record(value, "package.json");
  if (Object.hasOwn(manifest, "tag")) {
    throw new Error(
      "package.json must not contain a top-level tag because npm lets it override the requested dist-tag.",
    );
  }
  verifyNpmPublishConfig(manifest.publishConfig);
}
