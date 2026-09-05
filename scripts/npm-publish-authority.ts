import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

const canonicalRegistry = "https://registry.npmjs.org";
const maximumArchiveBytes = 3_750_000;
const maximumAuditEntries = 2_000;
const npmPublishPredicate = "https://github.com/npm/attestation/tree/main/specs/publish/v0.1";
const slsaPredicate = "https://slsa.dev/provenance/v1";
const workflowBuildType = "https://slsa-framework.github.io/github-actions-buildtypes/workflow/v1";
const workflowPath = ".github/workflows/npm-stage.yml";
const repository = "hraness/atet";
const repositoryId = "1310516748";
const repositoryOwnerId = "307125679";
const shaPattern = /^[a-f0-9]{40}$/u;

export interface NpmPublishAuthorityInput {
  readonly auditJson: string;
  readonly expectedName: string;
  readonly expectedSourceSha: string;
  readonly expectedVersion: string;
  readonly registryArchive: string;
  readonly registryView: string;
}

export interface NpmPublicationAuthority {
  readonly attestationUrl: string;
  readonly integrity: string;
  readonly runAttempt: number;
  readonly runId: number;
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be a JSON object.`);
  }
  return value as Record<string, unknown>;
}

function array(value: unknown, label: string, maximum: number): readonly unknown[] {
  if (!Array.isArray(value) || value.length > maximum) {
    throw new Error(`${label} must be a bounded JSON array.`);
  }
  return value;
}

function nonemptyString(value: unknown, label: string, maximum = 4_096): string {
  if (typeof value !== "string" || value.length === 0 || value.length > maximum) {
    throw new Error(`${label} must be one bounded nonempty string.`);
  }
  return value;
}

function decodeBase64(value: unknown, label: string): Buffer {
  const encoded = nonemptyString(value, label, 2_000_000);
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(encoded)) {
    throw new Error(`${label} must be canonical base64.`);
  }
  const decoded = Buffer.from(encoded, "base64");
  if (decoded.toString("base64") !== encoded) {
    throw new Error(`${label} must be canonical base64.`);
  }
  return decoded;
}

function exactSubject(
  statement: Record<string, unknown>,
  expectedPurl: string,
  expectedSha512: string,
  label: string,
): void {
  const subjects = array(statement.subject, `${label} subject`, 1);
  if (subjects.length !== 1) throw new Error(`${label} must have exactly one subject.`);
  const subject = record(subjects[0], `${label} subject`);
  const digest = record(subject.digest, `${label} subject digest`);
  if (
    subject.name !== expectedPurl
    || digest.sha512 !== expectedSha512
    || Object.keys(digest).length !== 1
  ) throw new Error(`${label} subject does not identify the exact npm archive.`);
}

function verifiedStatement(
  value: unknown,
  expectedPurl: string,
  expectedSha512: string,
): Readonly<{ predicateType: string; statement: Record<string, unknown> }> {
  const attestation = record(value, "verified npm attestation");
  const predicateType = nonemptyString(
    attestation.predicateType,
    "verified npm attestation predicateType",
  );
  const bundle = record(attestation.bundle, "verified npm attestation bundle");
  const envelope = record(bundle.dsseEnvelope, "verified npm attestation DSSE envelope");
  if (envelope.payloadType !== "application/vnd.in-toto+json") {
    throw new Error("Verified npm attestation has the wrong DSSE payload type.");
  }
  const signatures = array(envelope.signatures, "verified npm attestation signatures", 10);
  if (signatures.length === 0) {
    throw new Error("Verified npm attestation has no cryptographic signature.");
  }
  for (const [index, value] of signatures.entries()) {
    const signature = record(value, `verified npm attestation signature ${String(index + 1)}`);
    decodeBase64(signature.sig, `verified npm attestation signature ${String(index + 1)}`);
  }
  const payload = decodeBase64(envelope.payload, "verified npm attestation payload");
  let statementValue: unknown;
  try {
    statementValue = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(payload)) as unknown;
  } catch {
    throw new Error("Verified npm attestation payload is not UTF-8 JSON.");
  }
  const statement = record(statementValue, "verified npm attestation statement");
  if (statement.predicateType !== predicateType) {
    throw new Error("Verified npm attestation predicate type differs from its signed statement.");
  }
  exactSubject(statement, expectedPurl, expectedSha512, "Verified npm attestation");
  return Object.freeze({ predicateType, statement });
}

function parsePositiveInteger(value: string, label: string): number {
  if (!/^[1-9][0-9]*$/u.test(value)) throw new Error(`${label} is not a positive integer.`);
  const number = Number(value);
  if (!Number.isSafeInteger(number)) throw new Error(`${label} exceeds the safe integer range.`);
  return number;
}

function verifyPublishStatement(
  statement: Record<string, unknown>,
  expectedName: string,
  expectedVersion: string,
): void {
  const predicate = record(statement.predicate, "npm publish attestation predicate");
  if (
    statement._type !== "https://in-toto.io/Statement/v0.1"
    || predicate.name !== expectedName
    || predicate.version !== expectedVersion
    || predicate.registry !== canonicalRegistry
  ) throw new Error("npm publish attestation does not bind the canonical package publication.");
}

function verifySlsaStatement(
  statement: Record<string, unknown>,
  expectedSourceSha: string,
): Readonly<{ runAttempt: number; runId: number }> {
  const predicate = record(statement.predicate, "SLSA predicate");
  const buildDefinition = record(predicate.buildDefinition, "SLSA build definition");
  const externalParameters = record(
    buildDefinition.externalParameters,
    "SLSA external parameters",
  );
  const workflow = record(externalParameters.workflow, "SLSA workflow");
  const internalParameters = record(
    buildDefinition.internalParameters,
    "SLSA internal parameters",
  );
  const github = record(internalParameters.github, "SLSA GitHub parameters");
  const dependencies = array(
    buildDefinition.resolvedDependencies,
    "SLSA resolved dependencies",
    1,
  );
  if (dependencies.length !== 1) {
    throw new Error("SLSA provenance must have exactly one source dependency.");
  }
  const dependency = record(dependencies[0], "SLSA source dependency");
  const dependencyDigest = record(dependency.digest, "SLSA source dependency digest");
  const runDetails = record(predicate.runDetails, "SLSA run details");
  const builder = record(runDetails.builder, "SLSA builder");
  const metadata = record(runDetails.metadata, "SLSA run metadata");
  const invocation = nonemptyString(metadata.invocationId, "SLSA invocation ID");
  if (
    statement._type !== "https://in-toto.io/Statement/v1"
    || buildDefinition.buildType !== workflowBuildType
    || workflow.repository !== `https://github.com/${repository}`
    || workflow.ref !== "refs/heads/main"
    || workflow.path !== workflowPath
    || github.event_name !== "workflow_dispatch"
    || github.repository_id !== repositoryId
    || github.repository_owner_id !== repositoryOwnerId
    || dependency.uri !== `git+https://github.com/${repository}@refs/heads/main`
    || dependencyDigest.gitCommit !== expectedSourceSha
    || Object.keys(dependencyDigest).length !== 1
    || builder.id !== "https://github.com/actions/runner/github-hosted"
  ) throw new Error("SLSA provenance does not bind the exact npm staging workflow and source.");
  const match = /^https:\/\/github\.com\/hraness\/atet\/actions\/runs\/([1-9][0-9]*)\/attempts\/([1-9][0-9]*)$/u.exec(invocation);
  if (match === null || match[1] === undefined || match[2] === undefined) {
    throw new Error("SLSA invocation ID is not an exact Atet GitHub Actions run attempt.");
  }
  return Object.freeze({
    runAttempt: parsePositiveInteger(match[2], "SLSA run attempt"),
    runId: parsePositiveInteger(match[1], "SLSA run ID"),
  });
}

function verifyAttestationUrl(value: unknown, expectedName: string, expectedVersion: string): string {
  const text = nonemptyString(value, "npm attestation URL");
  const url = new URL(text);
  const prefix = "/-/npm/v1/attestations/";
  let identity = "";
  try {
    identity = decodeURIComponent(url.pathname.slice(prefix.length));
  } catch {
    throw new Error("npm attestation URL contains invalid escaping.");
  }
  if (
    url.origin !== canonicalRegistry
    || !url.pathname.startsWith(prefix)
    || identity !== `${expectedName}@${expectedVersion}`
    || url.username !== ""
    || url.password !== ""
    || url.search !== ""
    || url.hash !== ""
  ) throw new Error("npm attestation URL is not canonical for the exact package version.");
  return text;
}

export async function verifyNpmPublishAuthority(
  input: NpmPublishAuthorityInput,
): Promise<NpmPublicationAuthority> {
  if (input.expectedName !== "@hraness/atet") {
    throw new Error("npm publication authority is restricted to @hraness/atet.");
  }
  if (!shaPattern.test(input.expectedSourceSha)) {
    throw new Error("npm publication authority requires one lowercase source SHA.");
  }
  const archive = await readFile(input.registryArchive);
  if (archive.length === 0 || archive.length > maximumArchiveBytes) {
    throw new Error("Canonical npm archive is outside the reviewed size bound.");
  }
  const integrity = `sha512-${createHash("sha512").update(archive).digest("base64")}`;
  const sha512 = createHash("sha512").update(archive).digest("hex");
  const expectedPurl = `pkg:npm/%40hraness/atet@${input.expectedVersion}`;

  const view = record(
    JSON.parse(await readFile(input.registryView, "utf8")) as unknown,
    "canonical npm registry view",
  );
  const dist = record(view.dist, "canonical npm registry dist");
  const distTags = record(view["dist-tags"], "canonical npm registry dist-tags");
  if (
    view.name !== input.expectedName
    || view.version !== input.expectedVersion
    || dist.integrity !== integrity
    || distTags.latest !== input.expectedVersion
  ) throw new Error("Canonical npm registry version, integrity, or latest channel differs from the release.");
  const registrySignatures = array(dist.signatures, "canonical npm registry signatures", 10);
  if (registrySignatures.length === 0) {
    throw new Error("Canonical npm registry has no package signature.");
  }
  for (const [index, value] of registrySignatures.entries()) {
    const signature = record(value, `canonical npm registry signature ${String(index + 1)}`);
    nonemptyString(signature.keyid, `canonical npm registry signature ${String(index + 1)} keyid`, 512);
    decodeBase64(signature.sig, `canonical npm registry signature ${String(index + 1)} value`);
  }
  const distAttestations = record(dist.attestations, "canonical npm registry attestations");
  const attestationUrl = verifyAttestationUrl(
    distAttestations.url,
    input.expectedName,
    input.expectedVersion,
  );
  const provenance = record(distAttestations.provenance, "canonical npm provenance summary");
  if (provenance.predicateType !== slsaPredicate) {
    throw new Error("Canonical npm registry does not advertise SLSA v1 provenance.");
  }

  const audit = record(
    JSON.parse(await readFile(input.auditJson, "utf8")) as unknown,
    "npm audit signatures receipt",
  );
  if (
    array(audit.invalid, "npm audit invalid results", maximumAuditEntries).length !== 0
    || array(audit.missing, "npm audit missing results", maximumAuditEntries).length !== 0
  ) throw new Error("npm audit signatures reported missing or invalid authority.");
  const verified = array(audit.verified, "npm audit verified attestations", maximumAuditEntries);
  const candidates = verified.map(value => record(value, "npm audit verified package")).filter(value => (
    value.name === input.expectedName
    && value.version === input.expectedVersion
    && value.location === "node_modules/@hraness/atet"
    && value.registry === canonicalRegistry
  ));
  if (candidates.length !== 1) {
    throw new Error("npm audit signatures did not verify exactly one direct Atet package.");
  }
  const candidate = candidates[0] as Record<string, unknown>;
  const auditedAttestations = record(candidate.attestations, "npm audit Atet attestations");
  if (
    verifyAttestationUrl(auditedAttestations.url, input.expectedName, input.expectedVersion) !== attestationUrl
    || record(auditedAttestations.provenance, "npm audit Atet provenance").predicateType !== slsaPredicate
  ) throw new Error("npm audit attestation summary differs from canonical registry metadata.");
  const bundles = array(candidate.attestationBundles, "npm audit Atet attestation bundles", 10);
  if (bundles.length !== 2) {
    throw new Error("npm audit must verify exactly the npm publish and SLSA attestations.");
  }
  const statements = bundles.map(value => verifiedStatement(value, expectedPurl, sha512));
  const publishStatements = statements.filter(value => value.predicateType === npmPublishPredicate);
  const slsaStatements = statements.filter(value => value.predicateType === slsaPredicate);
  if (publishStatements.length !== 1 || slsaStatements.length !== 1) {
    throw new Error("npm audit did not verify one npm publish and one SLSA attestation.");
  }
  verifyPublishStatement(
    publishStatements[0]!.statement,
    input.expectedName,
    input.expectedVersion,
  );
  const invocation = verifySlsaStatement(
    slsaStatements[0]!.statement,
    input.expectedSourceSha,
  );
  return Object.freeze({ attestationUrl, integrity, ...invocation });
}

if (import.meta.main) {
  const [
    auditJson,
    registryView,
    registryArchive,
    expectedName,
    expectedVersion,
    expectedSourceSha,
    ...extra
  ] = process.argv.slice(2);
  if (
    extra.length !== 0
    || auditJson === undefined
    || registryView === undefined
    || registryArchive === undefined
    || expectedName === undefined
    || expectedVersion === undefined
    || expectedSourceSha === undefined
  ) throw new Error("Usage: bun scripts/npm-publish-authority.ts <audit.json> <registry-view.json> <registry.tgz> <name> <version> <source-sha>");
  const invocation = await verifyNpmPublishAuthority({
    auditJson,
    expectedName,
    expectedSourceSha,
    expectedVersion,
    registryArchive,
    registryView,
  });
  process.stdout.write(
    `${String(invocation.runId)}\t${String(invocation.runAttempt)}\t${invocation.integrity}\t${invocation.attestationUrl}\n`,
  );
}
