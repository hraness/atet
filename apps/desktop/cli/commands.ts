import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { link, lstat, open, realpath, rm } from "node:fs/promises";
import { basename, dirname, extname, isAbsolute, join, relative, resolve } from "node:path";
import {
  createDefaultHostResourceCoordinator,
  HOST_RESOURCE_MAX_WAIT_MILLISECONDS,
  HostResourceError,
  type HostResourceClaim,
  type HostResourceCoordinator,
  type HostResourceLease,
} from "@hraness/atet/host-resources";
import {
  AnalyzerEvidenceV1Schema,
  AlignmentCandidateIdSchema,
  AudioAlignmentAnalysisV1Schema,
  EventKindSchema,
  MusicAnalysisV1Schema,
  OverlayOperationSchema,
  ProjectCameraMoveSchema,
  ProjectPlacementIdSchema,
  ProjectRenderReceiptV1Schema,
  ProjectStreamIdSchema,
  RecordingRenderReceiptV1Schema,
  VideoProjectV1Schema,
  type AnalyzerEvidenceV1,
  type AudioEffect,
  type ColorGradeControls,
  type EditPlanV1,
  type EmojiSelector,
  type OverlayOperation,
  type ProjectCameraMove,
  type ProjectEditPlanV1,
  type ProjectPlacementV1,
  type RecordingEventV1,
  type RecordingManifestV1,
  type VideoProjectV1,
  ZoomOperationSchema,
  type ZoomOperation,
} from "../contracts";
import {
  addOverlay,
  applyProjectInactivityPlan,
  analyzeAudioAlignment,
  applyAudioAlignmentCandidate,
  addZoom,
  buildProjectOutputTimeMap,
  buildSourceTimeMap,
  canonicalAtetPersistenceDocument,
  canonicalJson,
  compileProjectRenderPlan,
  compileRenderPlan,
  createNodeBundleFileSystem,
  createDefaultEditPlan,
  cutPlan,
  cutProjectPlan,
  hashEditPlan,
  hashProjectCameraGeometry,
  hashProjectCameraSync,
  hashProjectEditPlan,
  hashPlacementSync,
  normalizeEditPlan,
  normalizeProjectEditPlan,
  planAutomaticInactivityCuts,
  planAutomaticZooms,
  projectFillerCut,
  removeOverlay,
  removeZoom,
  saveEditPlan,
  saveAnalysisArtifact,
  saveProjectEditPlan,
  setSpeed,
  rebaseProjectEditPlan,
  saveVideoProject,
  sha256Hex,
  loadAnalysisArtifact,
  mapProjectIntervalToOutputSlices,
  mapAssetIntervalToProjectSlices,
  mapSourceInterval,
  trimPlan,
  unionIntervals,
  unverifiedEnabledPlacementIds,
  type ProjectMetadataContext,
  assertProjectCameraMoveBindings,
} from "../core";
import { FfmpegInactivityAnalyzer, probeVisualMediaSummary } from "./analyzer";
import { executeAtomicRender } from "./atomic-render";
import { ingestEmojiAsset, ingestOverlayAsset, inspectSvgIntrinsicSize } from "./asset-ingest";
import { mapBounded } from "./bounded-map";
import {
  ingestProjectMedia,
  probeProjectMedia,
  SELF_CONTAINED_MEDIA_INPUT_ARGUMENTS,
} from "./media-ingest";
import { LocalMediaEffectsService } from "./media-effects-service";
import {
  DEFAULT_MUSIC_ANALYSIS_CONFIG,
  analyzeAndPersistProjectMusic,
  assertCompleteMusicAnalysis,
} from "./music-analysis-service";
import {
  alignmentInputDigest,
  resolveAudioAnalysisSubject,
  withAlignmentEnvelopes,
} from "./audio-analysis";
import type { CliCommand, EditCommand } from "./args";
import { parseCliArgs } from "./args";
import {
  CURRENT_EDIT_PLAN_PATH,
  bundleRelativePath,
  defaultPlanId,
  loadCurrentPlan,
  loadRecordingEvents,
  openRecording,
  recordingSummary,
  tryLoadCurrentPlan,
  type OpenRecording,
} from "./bundle-service";
import {
  capabilityByName,
  capabilityCandidates,
  probeCapability,
  type Capability,
  type CapabilityName,
} from "./capabilities";
import { resolveEmojiAsset, searchEmojiAssets, inspectEmojiAssets } from "./emoji-assets";
import { asCliError, CliError, EXIT_CODE } from "./errors";
import { commandHelp, completions } from "./help";
import { PlaywrightHtmlOverlayRenderer } from "./html-overlay-renderer";
import { BunProcessRunner, processIo, writeJson, writeLine, type CliIo, type ProcessRunner } from "./io";
import {
  codePreparationHostResourceClaims,
  combineHostResourceClaims,
  commandHostResourceClaims,
  computeWorkerPoolSize,
  hostResourceClaimsCover,
  missingHostResourceClaims,
} from "./command-host-resources";

import {
  displayPath,
  ensurePhysicalPrivateDirectoryWithin,
  ensurePrivateDirectory,
  defaultCliStateRoot,
  resolveRepositoryPaths,
  resolveSafePath,
  type RepositoryPaths,
} from "./paths";
import { renamedEnvironmentValue } from "./renamed-environment";
import { withMutationLock } from "./mutation-lock";
import {
  commitProjectStateTransaction,
  projectStateTransactionMayHaveCommitted,
  recoverProjectStateTransaction,
} from "./project-state-transaction";
import { listRecordingDirectories, resolveRecordingDirectory } from "./recording-ref";
import {
  addAssetToProject,
  createProjectFromRecording,
  listProjectDirectories,
  loadCurrentProjectPlan,
  openProject,
  projectSummary,
  projectAnalysisPath,
  resolveProjectDirectory,
  type OpenProject,
} from "./project-service";
import { resolveVerifiedProjectMedia } from "./project-media-integrity";
import {
  executeRecordingAction,
  type RecordingController,
  type RecordingSnapshot,
  type RecordingStartOptions,
} from "./recording-controller";
import { buildFfmpegInvocation, prepareOverlaySources } from "./renderer";
import { buildProjectFfmpegInvocation } from "./project-renderer";
import {
  DEFAULT_PROJECT_INACTIVITY_CONFIG,
  analyzeAndPersistProjectInactivity,
} from "./project-inactivity-service";
import { resolveAnimatedPlaybackWindow } from "./overlay-playback";
import { analyzeProjectScenes } from "./scene-analysis-service";
import type { SceneDescriptionProvider } from "@hraness/atet/scene";
import { parseCliTime } from "./time";
import {
  DEFAULT_FACE_ANALYSIS_CONFIG,
  analyzeAndPersistProjectFaces,
  listFaceTrackSummaries,
  loadVerifiedProjectFaceAnalysis,
} from "./face-analysis-service";
import { planProjectFaceCamera } from "./project-face-camera";
import {
  ProjectCameraCreateReceiptSchema,
  ProjectCameraRemoveReceiptSchema,
  projectCameraNextCommands,
  type ProjectCameraEditReceipt,
  type ProjectCameraSelectionReceipt,
} from "./project-camera-receipt";
import {
  persistSpeechAnalysis,
  runLocalSpeechAnalysis,
} from "./speech-analysis-service";
import {
  GatewayCredentialError,
  inspectGatewayCredential,
  loadGatewayCredential,
} from "./gateway-credential";
import {
  createGatewaySceneProvider,
  type GatewaySceneProviderOptions,
} from "./gateway-scene-provider";
import {
  GatewayMediaCatalogError,
  createFileGatewayMediaCatalogSnapshotStore,
  createGatewayMediaCatalogCache,
  createHttpGatewayMediaCatalogTransport,
  inspectGatewayMediaModel,
  listGatewayMediaModels,
  type GatewayMediaCatalogTransport,
} from "./gateway-media-catalog";
import {
  GatewayMediaArtifactError,
  createFileGatewayMediaArtifactStore,
  type GatewayMediaArtifactBundle,
} from "./gateway-media-artifacts";
import {
  GATEWAY_MEDIA_UPLOAD_POLICY,
  GatewayMediaExecutionError,
  createAiSdkGatewayMediaSdk,
  createBoundedGatewayMediaDownload,
  createGatewayMediaService,
  type GatewayMediaDispatchEvent,
  type GatewayMediaDownload,
  type GatewayMediaInput,
  type GatewayMediaService,
  type GatewayMediaSdk,
} from "./gateway-media-service";
import { gatewayMediaBytesMatchType } from "./gateway-media-signature";
import {
  GatewayProviderOptionsError,
  gatewayProviderParameterHints,
  gatewayProviderOptionsSummary,
  parseGatewayProviderOptions,
  type GatewayProviderOptions,
} from "./gateway-provider-options";
import {
  createGatewayApplicationPort,
  type GatewayApplicationServiceCallbacks,
} from "./gateway-application-port";
import {
  bindProjectCommitEditsInputV3,
  createApplicationOperationRegistry,
  ManualProjectZoomInputV3Schema,
  projectEditBasis,
  ProjectEditBatchSchema,
  ProjectEditBatchV3Schema,
  ProjectEditCommitReceiptSchema,
  AtetDiagramCheckOutputSchema,
  AtetDiagramRenderOutputSchema,
  AtetImageVectorizeOutputSchema,
  type ApplicationContext,
  type OperationExecutionContext,
} from "../application";
import { builtInWorkflow, BUILT_IN_WORKFLOWS } from "../workflows";
import {
  checkCustomWorkflow,
  humanOperation,
  humanOperationList,
  humanWorkflow,
  humanWorkflowPlan,
  initializeWorkflowSource,
  operationDiscovery,
  operationDiscoveryList,
  planCatalogWorkflow,
  planCustomWorkflow,
  prepareCustomWorkflowRun,
  workflowCatalogDescription,
  workflowCatalogEntry,
  workflowPlanSummary,
} from "./workflow-code";
import { assertPlanHash } from "../code/planning";
import { physicalHostResourceClaims } from "../code/host-resource-policy";
import type { CodeWorkerPool } from "../code/worker-client";
import {
  approveWorkflowRun,
  cancelWorkflowRun,
  createWorkflowRun,
  humanRunSummary,
  listWorkflowRuns,
  runWorkflow,
  workflowRunDetails,
  workflowRunStore,
} from "./workflow-runs";

export const ATET_VERSION = "3.1.1";

// Legacy direct renders predate per-target output contracts. Keep them
// bounded generously enough for long-form production while preventing one
// malformed invocation from consuming an entire shared development disk.
const MAXIMUM_LEGACY_RECORDING_RENDER_OUTPUT_BYTES = 32 * 1024 * 1024 * 1024;
const MAXIMUM_LEGACY_PROJECT_RENDER_OUTPUT_BYTES = 32 * 1024 * 1024 * 1024;

export interface CliDependencies {
  readonly stateRoot?: string;
  readonly clock?: () => number;
  readonly fetch?: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
  readonly gatewayCatalogTransport?: GatewayMediaCatalogTransport;
  readonly gatewayMediaDownload?: GatewayMediaDownload;
  readonly gatewayMediaSdk?: GatewayMediaSdk;
  readonly hostResourceCoordinator?: HostResourceCoordinator;
  readonly io?: CliIo;
  readonly paths?: RepositoryPaths;
  readonly recordingController?: RecordingController;
  readonly runner?: ProcessRunner;
  readonly sceneProviderFactory?: (options: GatewaySceneProviderOptions) => SceneDescriptionProvider;
  readonly sleep?: (milliseconds: number) => Promise<void>;
  readonly version?: string;
}

interface CommandContext {
  readonly stateRoot: string;
  readonly capability: (
    name: CapabilityName,
    signal?: AbortSignal,
    inheritedFileDescriptors?: readonly number[],
  ) => Promise<Capability>;
  readonly capabilities: (
    inheritedFileDescriptors?: readonly number[],
  ) => Promise<readonly Capability[]>;
  readonly clock: () => number;
  readonly fetch: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
  readonly gatewayCatalogTransport: GatewayMediaCatalogTransport;
  readonly gatewayMediaDownload: GatewayMediaDownload;
  readonly gatewayMediaSdk: GatewayMediaSdk;
  readonly hostResourceLease?: ApplicationContext["hostResourceLease"];
  readonly hostResourceCoordinator: HostResourceCoordinator;
  readonly io: CliIo;
  readonly paths: RepositoryPaths;
  readonly recordingController: RecordingController | undefined;
  readonly runner: ProcessRunner;
  readonly sceneProviderFactory: (options: GatewaySceneProviderOptions) => SceneDescriptionProvider;
  readonly sleep: (milliseconds: number) => Promise<void>;
  readonly version: string;
}

function contextWithHostResourceLease(
  context: CommandContext,
  lease: HostResourceLease,
): CommandContext {
  return contextWithApplicationHostResourceLease(context, {
    assertOwned: async () => await lease.assertOwned(),
    claims: lease.claims,
    inheritedFileDescriptor: lease.inheritedFileDescriptor,
    inheritedFileDescriptors: [lease.inheritedFileDescriptor],
    profile: lease.profile,
    ticket: lease.ticket,
  });
}

function contextWithApplicationHostResourceLease(
  context: CommandContext,
  lease: NonNullable<ApplicationContext["hostResourceLease"]>,
): CommandContext {
  const existingLease = context.hostResourceLease;
  const existingDescriptors = existingLease?.inheritedFileDescriptors ?? [];
  const leaseAlreadyIncluded = lease.inheritedFileDescriptors.every(
    descriptor => existingDescriptors.includes(descriptor),
  );
  const existingAlreadyIncluded = existingDescriptors.every(
    descriptor => lease.inheritedFileDescriptors.includes(descriptor),
  );
  if (
    existingLease !== undefined
    && (
      existingLease.profile.id !== lease.profile.id
      || existingLease.profile.capacities.length
        !== lease.profile.capacities.length
      || existingLease.profile.capacities.some((capacity) => {
        const nestedCapacity = lease.profile.capacities.find(
          candidate => candidate.resource === capacity.resource,
        );
        return nestedCapacity?.limit !== capacity.limit;
      })
    )
  ) {
    throw new CliError(
      "unavailable",
      "Nested host-resource phases must use the same machine profile.",
    );
  }
  const inheritedFileDescriptors = [
    ...existingDescriptors,
    ...lease.inheritedFileDescriptors,
  ].filter((descriptor, index, descriptors) => (
    descriptors.indexOf(descriptor) === index
  ));
  if (inheritedFileDescriptors.length > 16) {
    throw new CliError(
      "unavailable",
      "A direct Atet subprocess cannot inherit more than 16 file descriptors.",
    );
  }
  const combinedLease: NonNullable<ApplicationContext["hostResourceLease"]> =
    existingLease === undefined || existingAlreadyIncluded
      ? lease
      : leaseAlreadyIncluded
        ? existingLease
        : {
            assertOwned: async () => {
              await existingLease.assertOwned();
              await lease.assertOwned();
            },
            claims: combineHostResourceClaims(existingLease.claims, lease.claims),
            inheritedFileDescriptor: lease.inheritedFileDescriptor,
            inheritedFileDescriptors,
            profile: lease.profile,
            ticket: lease.ticket,
          };
  const withLeaseDescriptors = (
    descriptors: readonly number[] = [],
  ): readonly number[] => [
    ...descriptors,
    ...combinedLease.inheritedFileDescriptors,
  ].filter((descriptor, index, candidates) => (
    candidates.indexOf(descriptor) === index
  ));
  return {
    ...context,
    capabilities: async descriptors => await context.capabilities(
      withLeaseDescriptors(descriptors),
    ),
    capability: async (name, signal, descriptors) => await context.capability(
      name,
      signal,
      withLeaseDescriptors(descriptors),
    ),
    hostResourceLease: combinedLease,
    runner: {
      run: async (argv, options = {}) => {
        await combinedLease.assertOwned();
        const subprocessDescriptors = withLeaseDescriptors(
          options.inheritedFileDescriptors,
        );
        if (subprocessDescriptors.length > 16) {
          throw new CliError(
            "unavailable",
            "A direct Atet subprocess cannot inherit more than 16 file descriptors.",
          );
        }
        return await context.runner.run(argv, {
          ...options,
          inheritedFileDescriptors: subprocessDescriptors,
        });
      },
    },
  };
}

function directHostResourceFailure(error: HostResourceError): CliError {
  switch (error.code) {
    case "WAIT_ABORTED":
      return new CliError("cancelled", error.message);
    case "OWNERSHIP_LOST":
      return new CliError("conflict", error.message);
    case "INVALID_CLAIMS":
    case "INVALID_PROFILE":
    case "PROFILE_MISMATCH":
    case "UNSAFE_STATE":
    case "UNSUPPORTED_PLATFORM":
    case "WAIT_TIMEOUT":
      return new CliError("unavailable", error.message, {
        hostResourceCode: error.code,
      });
  }
}

async function withCommandHostResources(
  context: CommandContext,
  command: CliCommand,
  callback: (admittedContext: CommandContext) => Promise<void>,
): Promise<void> {
  const hostClaims = commandHostResourceClaims(
    command,
    context.hostResourceCoordinator,
  );
  await withHostResourceClaims(context, hostClaims, callback);
}

async function withHostResourceClaims<T>(
  context: CommandContext,
  hostClaims: readonly HostResourceClaim[],
  callback: (admittedContext: CommandContext) => Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  if (hostClaims.length === 0) {
    return await callback(context);
  }
  try {
    return await context.hostResourceCoordinator.withLease(
      hostClaims,
      async lease => {
        await lease.assertOwned();
        return await callback(contextWithHostResourceLease(context, lease));
      },
      {
        ...(signal === undefined ? {} : { signal }),
        waitTimeoutMilliseconds: HOST_RESOURCE_MAX_WAIT_MILLISECONDS,
      },
    );
  } catch (error) {
    if (error instanceof HostResourceError) {
      throw directHostResourceFailure(error);
    }
    throw error;
  }
}

function applicationContext(
  context: CommandContext,
  providerOptions?: GatewayProviderOptions,
): ApplicationContext {
  const recordingController = context.recordingController;
  const toApplicationCapability = (capability: Capability) => ({
    available: capability.available,
    ...(capability.command === undefined ? {} : { command: capability.command }),
    name: capability.name,
    ...(capability.reason === undefined ? {} : { reason: capability.reason }),
    ...(capability.version === undefined ? {} : { version: capability.version }),
  });
  const application: ApplicationContext = {
    capabilities: async inheritedFileDescriptors => (
      await context.capabilities(inheritedFileDescriptors)
    ).map(toApplicationCapability),
    capability: async name => toApplicationCapability(
      await context.capability(name),
    ),
    clock: {
      now: () => new Date(context.clock()),
      timestampMilliseconds: context.clock,
    },
    htmlOverlayRenderer: new PlaywrightHtmlOverlayRenderer({
      cacheRoot: join(
        context.paths.privateRoot,
        "html-overlay-modules-v1",
      ),
      fetch: context.fetch,
    }),
    ...(context.hostResourceLease === undefined
      ? {}
      : { hostResourceLease: context.hostResourceLease }),
    machineStateRoot: context.stateRoot,
    paths: context.paths,
    ...(recordingController === undefined
      ? {}
      : {
          recordingController: {
            execute: async (
              action: "pause" | "resume" | "start" | "stop",
              options?: unknown,
            ) => await executeRecordingAction(
              recordingController,
              action,
              options as RecordingStartOptions | undefined,
            ),
            status: async () => await recordingController.status(),
          },
        }),
    runner: context.runner,
  };
  return {
    ...application,
    gatewayPort: createGatewayApplicationPort({
      application,
      createService: async (callbacks, hostResourceLease) =>
        await createGatewayServiceForContext(
          hostResourceLease === undefined
            ? context
            : contextWithApplicationHostResourceLease(
                context,
                hostResourceLease,
              ),
          callbacks,
        ),
      inspectMedia: async (inputs, signal, hostResourceLease) => {
        const inspectionContext = hostResourceLease === undefined
          ? context
          : contextWithApplicationHostResourceLease(
              context,
              hostResourceLease,
            );
        const inspected = await inspectGatewayMediaFiles(
          inspectionContext,
          inputs.map(input => ({
            data: input.data,
            mediaType: input.mediaType,
            path: input.path,
          })),
          signal,
        );
        return inspected.map((file) => {
          if (file.url !== undefined) {
            throw new CliError(
              "internal",
              "Gateway workflow preparation unexpectedly produced a remote media input.",
            );
          }
          const facts = file.facts;
          return {
            ...(facts?.durationSeconds === undefined
              ? {}
              : { durationSeconds: facts.durationSeconds }),
            ...(facts?.height === undefined ? {} : { height: facts.height }),
            ...(facts?.width === undefined ? {} : { width: facts.width }),
          };
        });
      },
      now: context.io.now,
      resolveProviderOptions: (_reference, signal) => {
        if (signal.aborted) {
          throw new CliError(
            "cancelled",
            "Gateway provider-options resolution was cancelled.",
          );
        }
        return Promise.resolve(providerOptions);
      },
    }),
  };
}

function humanTime(microseconds: number): string {
  if (microseconds < 1_000) return `${microseconds}us`;
  if (microseconds < 1_000_000) return `${(microseconds / 1_000).toFixed(1).replace(/\.0$/u, "")}ms`;
  return `${(microseconds / 1_000_000).toFixed(3).replace(/0+$/u, "").replace(/\.$/u, "")}s`;
}

function requireCapability(capabilities: readonly Capability[], name: Capability["name"]): string {
  const capability = capabilityByName(capabilities, name);
  if (!capability.available || capability.command === undefined) {
    throw new CliError(
      "unavailable",
      `${name} is unavailable${capability.reason === undefined ? "." : `: ${capability.reason}`}`,
      { capability: name },
    );
  }
  return capability.command;
}

async function requestedCapabilities(
  context: CommandContext,
  names: readonly CapabilityName[],
): Promise<readonly Capability[]> {
  return await Promise.all(names.map(async name => (
    await context.capability(name)
  )));
}

async function requireRequestedCapability(
  context: CommandContext,
  name: CapabilityName,
): Promise<string> {
  return requireCapability(
    [await context.capability(name)],
    name,
  );
}

function writeValue(io: CliIo, json: boolean, value: unknown, human: () => string): void {
  if (json) writeJson(io, value);
  else writeLine(io, human());
}

function isWithin(root: string, candidate: string): boolean {
  const pathRelative = relative(root, candidate);
  return pathRelative === "" || (!pathRelative.startsWith("..") && !isAbsolute(pathRelative));
}

async function resolveRenderOutput(recording: OpenRecording, requested: string): Promise<string> {
  const output = await resolveSafePath(recording.directory.path, requested);
  const relativeOutput = bundleRelativePath(recording, output);
  if (!relativeOutput.startsWith("renders/")) {
    throw new CliError("unsafe-path", "Render outputs must remain under the bundle's renders/ directory so raw capture files stay immutable.");
  }
  const rendersRoot = await resolveSafePath(recording.directory.path, "renders");
  await ensurePrivateDirectory(rendersRoot);
  await ensurePrivateDirectory(dirname(output));
  const [realRendersRoot, realParent] = await Promise.all([realpath(rendersRoot), realpath(dirname(output))]);
  if (!isWithin(realRendersRoot, realParent)) {
    throw new CliError("unsafe-path", `Render output crosses a symlink outside renders/: ${requested}`);
  }
  try {
    if ((await lstat(output)).isSymbolicLink()) {
      throw new CliError("unsafe-path", `Render output may not be a symlink: ${requested}`);
    }
  } catch (error) {
    if (error instanceof CliError) throw error;
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
  }
  return output;
}

async function resolveRecordingRenderPlanOutput(
  recording: OpenRecording,
  requested: string,
  canonicalArtifactPath: string,
): Promise<{ readonly absolute: string; readonly relative: string }> {
  const absolute = await resolveRenderOutput(recording, requested);
  const relativePath = bundleRelativePath(recording, absolute);
  const normalized = relativePath.toLowerCase();
  if (extname(relativePath).toLowerCase() !== ".json") {
    throw new CliError("usage", "A resolved render plan output must use a .json path under renders/.");
  }
  if (normalized.endsWith(".mp4.plan.json")) {
    throw new CliError("unsafe-path", `A render plan alias may not overwrite a video receipt: ${requested}`);
  }
  if (
    /^renders\/resolved-[a-f0-9]{64}\.json$/u.test(normalized)
    && relativePath !== canonicalArtifactPath
  ) {
    throw new CliError("unsafe-path", `A render plan alias may not use the canonical resolved-plan namespace: ${requested}`);
  }
  return { absolute, relative: relativePath };
}

async function resolveProjectRenderLeaf(
  projectDirectory: string,
  requested: string,
  options: { readonly videoOutput?: boolean } = {},
): Promise<{ readonly absolute: string; readonly relative: string }> {
  const absolute = await resolveSafePath(projectDirectory, requested);
  const projectRelative = relative(projectDirectory, absolute);
  if (!projectRelative.startsWith("renders/") || isAbsolute(projectRelative)) {
    throw new CliError("unsafe-path", "Project render artifacts must remain under the project's renders/ directory.");
  }
  if (options.videoOutput) {
    const relativeSegments = projectRelative.split("/");
    const leaf = relativeSegments.at(-1);
    const reservedSubtrees = new Set([".filter-graphs", ".overlay-cache", "derived", "plans"]);
    if (relativeSegments[0] !== "renders" || reservedSubtrees.has(relativeSegments[1]?.toLowerCase() ?? "")) {
      throw new CliError("unsafe-path", `Project video output may not use a reserved render-artifact subtree: ${requested}`);
    }
    if (leaf === undefined || leaf.toLowerCase() === ".mp4" || extname(leaf).toLowerCase() !== ".mp4") {
      throw new CliError("usage", "Project render output must be a final .mp4 file under renders/.");
    }
  }
  const rendersRoot = join(projectDirectory, "renders");
  await ensurePrivateDirectory(rendersRoot);
  await ensurePrivateDirectory(dirname(absolute));
  const [physicalRoot, physicalParent] = await Promise.all([
    realpath(rendersRoot),
    realpath(dirname(absolute)),
  ]);
  if (!isWithin(physicalRoot, physicalParent)) {
    throw new CliError("unsafe-path", `Project render path crosses a symlink outside renders/: ${requested}`);
  }
  try {
    const details = await lstat(absolute);
    if (details.isSymbolicLink() || !details.isFile()) {
      throw new CliError("unsafe-path", `Project render leaf must be a physical regular file: ${requested}`);
    }
  } catch (error) {
    if (error instanceof CliError) throw error;
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
  }
  return { absolute, relative: projectRelative };
}

async function loadAllEvents(recording: OpenRecording): Promise<readonly RecordingEventV1[]> {
  return await loadRecordingEvents(recording);
}

function mutationReceipt(
  recording: OpenRecording,
  operation: string,
  plan: EditPlanV1,
): Readonly<Record<string, unknown>> {
  return {
    operation,
    planHash: hashEditPlan(plan),
    planId: plan.planId,
    planPath: CURRENT_EDIT_PLAN_PATH,
    recordingId: recording.manifest.recordingId,
  };
}

async function persistMutation(
  recording: OpenRecording,
  operation: string,
  plan: EditPlanV1,
  json: boolean,
  io: CliIo,
): Promise<void> {
  const persistedPlan = canonicalAtetPersistenceDocument(plan);
  await ensurePrivateDirectory(join(recording.directory.path, "edits"));
  await saveEditPlan(recording.fileSystem, persistedPlan, CURRENT_EDIT_PLAN_PATH);
  const receipt = mutationReceipt(recording, operation, persistedPlan);
  writeValue(io, json, receipt, () => `${operation} ${plan.planId} ${String(receipt.planHash)}`);
}

function easing(value: string): ZoomOperation["easing"] {
  if (value !== "linear" && value !== "ease-in" && value !== "ease-out" && value !== "ease-in-out" && value !== "spring") {
    throw new CliError("usage", `Unsupported easing: ${value}`);
  }
  return { kind: value };
}

function animation(
  value: string | undefined,
  duration: string | undefined,
  defaults: string,
  easingValue: string,
  scaleAmount: number,
  slideDistancePx: number,
): OverlayOperation["entrance"] {
  const kind = value ?? "none";
  if (kind === "none") return { kind: "none" };
  const durationUs = parseCliTime(duration ?? defaults);
  if (kind === "fade") return { durationUs, easing: easing(easingValue), kind };
  if (kind === "scale") {
    return { durationUs, easing: easing(easingValue), fromScale: scaleAmount, kind };
  }
  const match = /^slide-(up|down|left|right)$/u.exec(kind);
  if (match?.[1] === "up" || match?.[1] === "down" || match?.[1] === "left" || match?.[1] === "right") {
    return {
      direction: match[1],
      distancePx: slideDistancePx,
      durationUs,
      easing: easing(easingValue),
      kind: "slide",
    };
  }
  throw new CliError("usage", `Unsupported overlay animation: ${kind}`);
}

function emojiSelector(query: string): EmojiSelector {
  const normalized = query.trim().toLocaleLowerCase().replaceAll("u+", "").replaceAll(/[_\s]+/gu, "-");
  if (/^[a-f0-9]+(?:-[a-f0-9]+)*$/u.test(normalized)) return { kind: "id", value: normalized };
  if ([...query].length <= 16 && /[^\p{L}\p{N}\p{P}\p{Z}]/u.test(query)) return { kind: "unicode", value: query };
  return { kind: "name", value: query };
}

function sourceRange(from: string, to: string, fps?: number): { readonly endUs: number; readonly startUs: number } {
  const startUs = parseCliTime(from, fps);
  const endUs = parseCliTime(to, fps);
  if (endUs <= startUs) throw new CliError("usage", `Time range must increase: ${from}..${to}`);
  return { endUs, startUs };
}

function overlayId(overlays: readonly OverlayOperation[]): string {
  let index = overlays.length + 1;
  while (overlays.some(({ overlayId: id }) => id === `overlay_manual${String(index).padStart(4, "0")}`)) index += 1;
  return `overlay_manual${String(index).padStart(4, "0")}`;
}

function zoomId(existingIds: readonly string[]): string {
  let index = existingIds.length + 1;
  while (existingIds.includes(`zoom_manual${String(index).padStart(4, "0")}`)) index += 1;
  return `zoom_manual${String(index).padStart(4, "0")}`;
}

async function overlayOperation(
  context: CommandContext,
  bundleDirectory: string,
  overlays: readonly OverlayOperation[],
  edit: Extract<EditCommand, { readonly operation: "overlay-add" }>,
  fps: number | undefined,
  outputDurationForRange?: (range: { readonly endUs: number; readonly startUs: number }) => number,
): Promise<{
  readonly operation: ProjectEditPlanV1["overlays"][number];
  rollback(): Promise<void>;
}> {
  const { startUs, endUs } = sourceRange(edit.from, edit.to, fps);
  const mappedOutputDurationUs = outputDurationForRange?.({ endUs, startUs }) ?? endUs - startUs;
  if (mappedOutputDurationUs <= 0) {
    throw new CliError("conflict", "Overlay range has no visible kept output time.");
  }
  const resolvedEmoji = edit.overlayKind === "emoji"
    ? await resolveEmojiAsset(
        context.paths.repositoryRoot,
        edit.source,
        edit.variant ?? (edit.provider === "brand-catalog" ? "duotone" : "color"),
        edit.provider,
      )
    : undefined;
  const ingested = edit.overlayKind === "emoji"
    ? await ingestEmojiAsset(bundleDirectory, resolvedEmoji!)
    : await ingestOverlayAsset(bundleDirectory, edit.source, edit.overlayKind);
  const { created, ...asset } = ingested;
  const rollback = async (): Promise<void> => {
    const alreadyReferenced = overlays.some(overlay => overlay.source.asset.path === asset.path);
    if (created && !alreadyReferenced) {
      await rm(join(bundleDirectory, asset.path), { force: true });
    }
  };
  try {
    const assetPath = await resolveSafePath(bundleDirectory, asset.path);
    const visual = asset.mediaType === "image/svg+xml"
      ? {
          ...await inspectSvgIntrinsicSize(assetPath),
          audioEndUs: null,
          audioStartUs: 0,
          audioStreamIndex: null,
          durationUs: null,
          hasAudio: false,
          videoStartUs: 0,
          videoStreamIndex: null,
        }
      : await probeVisualMediaSummary(
        await requireRequestedCapability(context, "ffprobe"),
        context.runner,
        assetPath,
      );
    const intrinsicSize = {
      height: "pixelHeight" in visual ? visual.pixelHeight : visual.height,
      width: "pixelWidth" in visual ? visual.pixelWidth : visual.width,
    };
    let source: unknown;
    if (edit.overlayKind === "image" || edit.overlayKind === "svg") {
      source = { asset, kind: edit.overlayKind };
    } else if (edit.overlayKind === "emoji") {
      source = {
        asset,
        kind: "emoji",
        provider: resolvedEmoji!.provider,
        selector: emojiSelector(edit.source),
      };
    } else {
      if (edit.loop && edit.freezeEnd) throw new CliError("usage", "Use only one of --loop and --freeze-end.");
      const sourceInUs = parseCliTime(edit.sourceIn ?? "0us", fps);
      const sourceOutUs = edit.sourceOut === undefined ? undefined : parseCliTime(edit.sourceOut, fps);
      if (visual.durationUs === null || visual.durationUs <= 0) {
        throw new CliError("invalid-data", "Animated overlay media must report a positive finite duration.");
      }
      if (edit.overlayKind === "video" && edit.animatedAudio !== "mute" && !visual.hasAudio) {
        throw new CliError(
          "conflict",
          `Video overlay audio policy ${edit.animatedAudio} requires an audio stream in the source media.`,
        );
      }
      const playbackWindow = resolveAnimatedPlaybackWindow({
        mediaDurationUs: visual.durationUs,
        outputDurationUs: mappedOutputDurationUs,
        playbackRate: edit.playbackRate,
        sourceInUs,
        sourceOutUs,
      });
      const playback = {
        audioEndUs: visual.audioEndUs,
        audioStartUs: visual.audioStartUs,
        audioStreamIndex: visual.audioStreamIndex,
        endBehavior: edit.loop ? "loop" as const : edit.freezeEnd ? "freeze-end" as const : "hide" as const,
        playbackRate: edit.playbackRate,
        streamStartUs: visual.videoStartUs,
        videoStreamIndex: visual.videoStreamIndex,
        ...playbackWindow,
      };
      if (edit.overlayKind === "gif") {
        source = { asset, audioPolicy: { kind: "mute" }, kind: "gif", playback };
      } else {
        const audioPolicy = edit.animatedAudio === "mute"
          ? { kind: "mute" as const }
          : edit.animatedAudio === "mix"
            ? { kind: "mix" as const, volume: edit.audioVolume }
            : { duckPrimaryTo: edit.duckPrimaryTo, kind: "duck-primary" as const, volume: edit.audioVolume };
        source = { asset, audioPolicy, kind: "video", playback };
      }
    }
    if ((edit.width === undefined) !== (edit.height === undefined)) {
      throw new CliError("usage", "Overlay pixel size requires both --width and --height.");
    }
    const parsed = OverlayOperationSchema.safeParse({
      anchor: edit.anchor,
      blendMode: edit.blendMode,
      coordinateSpace: "output-pixels",
      crop: edit.crop === undefined
        ? { kind: "none" }
        : { bottom: edit.crop[3], kind: "normalized-insets", left: edit.crop[0], right: edit.crop[2], top: edit.crop[1] },
      entrance: animation(
        edit.entrance,
        edit.entranceDuration,
        "250ms",
        edit.easing,
        edit.entranceFromScale,
        edit.slideDistance,
      ),
      exit: animation(
        edit.exit,
        edit.exitDuration,
        "250ms",
        edit.easing,
        edit.exitToScale,
        edit.slideDistance,
      ),
      fit: edit.fit,
      intrinsicSize,
      mask: edit.cornerRadius === undefined
        ? { kind: "none" }
        : { kind: "rounded-rectangle", radiusPx: edit.cornerRadius },
      motion: edit.motionKeyframes.length === 0
        ? { kind: "none" }
        : {
            keyframes: edit.motionKeyframes.map(keyframe => ({
              easing: easing(edit.easing),
              offset: keyframe.offset,
              opacityMultiplier: keyframe.opacity,
              positionOffset: { x: keyframe.position[0], y: keyframe.position[1] },
              rotationOffsetDegrees: keyframe.rotation,
              scaleMultiplier: keyframe.scale,
            })),
            kind: "keyframes",
            timeline: "visible-output",
          },
      opacity: edit.opacity,
      overlayId: overlayId(overlays),
      position: { x: edit.position[0], y: edit.position[1] },
      range: { endUs, startUs },
      rotationDegrees: edit.rotation,
      scale: edit.scale,
      size: edit.width === undefined || edit.height === undefined
        ? { kind: "intrinsic" }
        : { height: edit.height, kind: "pixels", width: edit.width },
      source,
      zIndex: edit.zIndex,
    });
    if (!parsed.success) throw new CliError("usage", `Invalid overlay: ${parsed.error.issues[0]?.message ?? "unknown error"}`);
    return { operation: parsed.data, rollback };
  } catch (error) {
    await rollback();
    throw error;
  }
}

function zoomOperation(
  edit: Extract<EditCommand, { readonly operation: "zoom-add" }>,
  existingZoomIds: readonly string[],
  manifest: RecordingManifestV1,
  fps: number | undefined,
): ZoomOperation {
  const intent = manualProjectZoomInput(
    edit,
    existingZoomIds,
    undefined,
    fps,
  );
  const displayId = intent.displayId
    ?? manifest.sources.displays.find(({ isPrimary }) => isPrimary)?.displayId;
  if (displayId === undefined) throw new CliError("not-found", "Manual zoom requires a selected or primary display.");
  return ZoomOperationSchema.parse({
    ...intent,
    displayId,
    kind: "manual",
  });
}

function manualProjectZoomInput(
  edit: Extract<EditCommand, { readonly operation: "zoom-add" }>,
  existingZoomIds: readonly string[],
  placementId: ProjectPlacementV1["placementId"] | undefined,
  fps: number | undefined,
) {
  const { startUs, endUs } = sourceRange(edit.from, edit.to, fps);
  const target: ZoomOperation["target"] = edit.target === "rect"
    ? { kind: "rect", rect: { height: edit.rect![3], width: edit.rect![2], x: edit.rect![0], y: edit.rect![1] } }
    : edit.target === "point"
      ? { kind: "point", point: { x: edit.point![0], y: edit.point![1] } }
      : edit.target === "cursor"
        ? { kind: "cursor", sampling: "interpolated" }
        : edit.target === "focused-input"
          ? { kind: "focused-input", paddingPx: 24 }
          : edit.window === "frontmost"
            ? { kind: "window", paddingPx: 24, selector: { kind: "frontmost" } }
            : edit.window!.startsWith("bundle:")
              ? { kind: "window", paddingPx: 24, selector: { applicationBundleId: edit.window!.slice(7), kind: "application" } }
              : { kind: "window", paddingPx: 24, selector: { kind: "window-id", windowId: edit.window! } };
  const durationUs = endUs - startUs;
  const defaultTransitionUs = Math.min(300_000, Math.max(0, Math.floor(durationUs / 2)));
  const enterDurationUs = edit.enterDuration === undefined
    ? defaultTransitionUs
    : parseCliTime(edit.enterDuration, fps);
  const exitDurationUs = edit.exitDuration === undefined
    ? defaultTransitionUs
    : parseCliTime(edit.exitDuration, fps);
  const parsed = ManualProjectZoomInputV3Schema.safeParse({
    ...(edit.display === undefined ? {} : { displayId: edit.display }),
    easing: easing(edit.easing),
    enterDurationUs,
    exitDurationUs,
    ...(placementId === undefined ? {} : { placementId }),
    range: { endUs, startUs },
    scale: edit.scale,
    target,
    zoomId: zoomId(existingZoomIds),
  });
  if (!parsed.success) throw new CliError("usage", `Invalid zoom: ${parsed.error.issues[0]?.message ?? "unknown error"}`);
  return parsed.data;
}

async function handleEdit(context: CommandContext, command: Extract<CliCommand, { readonly kind: "edit" }>): Promise<void> {
  const recording = await openRecording(context.paths.artifactRoot, command.recording);
  if (recording.manifest.state !== "stopped") {
    throw new CliError("conflict", "Editing requires a stopped recording with an immutable timeline, media, and events.");
  }
  if (command.edit.operation === "init") {
    const existing = await tryLoadCurrentPlan(recording);
    const plan = existing ?? createDefaultEditPlan(
      recording.manifest,
      defaultPlanId(recording.manifest) as EditPlanV1["planId"],
      context.io.now().toISOString(),
    );
    await persistMutation(recording, existing === null ? "init" : "init-existing", plan, command.json, context.io);
    return;
  }
  const plan = await loadCurrentPlan(recording);
  if (command.edit.operation === "show") {
    writeValue(context.io, command.json, plan, () =>
      `${plan.planId} ${hashEditPlan(plan)} keep=${plan.keep.length} speed=${plan.speed.length} zooms=${plan.zooms.length} overlays=${plan.overlays.length}`
    );
    return;
  }
  const timestamp = context.io.now().toISOString();
  let next: EditPlanV1;
  const edit = command.edit;
  switch (edit.operation) {
    case "trim":
      next = trimPlan(plan, sourceRange(edit.from, edit.to, command.fps), timestamp);
      break;
    case "cut":
      next = cutPlan(plan, sourceRange(edit.from, edit.to, command.fps), timestamp);
      break;
    case "speed":
      next = setSpeed(
        plan,
        sourceRange(edit.from, edit.to, command.fps),
        edit.rate,
        timestamp,
      );
      break;
    case "zoom-add": next = addZoom(
      plan,
      zoomOperation(edit, plan.zooms.map(zoom => zoom.zoomId), recording.manifest, command.fps),
      timestamp,
    ); break;
    case "zoom-remove": next = removeZoom(plan, edit.id, timestamp); break;
    case "overlay-add":
      {
        const prepared = await overlayOperation(
          context,
          recording.directory.path,
          plan.overlays,
          edit,
          command.fps,
          range => mapSourceInterval(buildSourceTimeMap(plan), range)
            .reduce((total, slice) => total + slice.output.endUs - slice.output.startUs, 0),
        );
        try {
          next = canonicalAtetPersistenceDocument(
            addOverlay(plan, prepared.operation, timestamp),
          );
          await ensurePrivateDirectory(join(recording.directory.path, "edits"));
          await saveEditPlan(recording.fileSystem, next, CURRENT_EDIT_PLAN_PATH);
        } catch (error) {
          await prepared.rollback();
          throw error;
        }
        const receipt = mutationReceipt(recording, edit.operation, next);
        writeValue(
          context.io,
          command.json,
          receipt,
          () => `${edit.operation} ${next.planId} ${String(receipt.planHash)}`,
        );
        return;
      }
    case "overlay-remove": next = removeOverlay(plan, edit.id, timestamp); break;
    case "cursor":
      next = normalizeEditPlan({
        ...plan,
        effects: {
          ...plan.effects,
          ...(edit.clickHighlight === undefined
            ? {}
            : { clicks: edit.clickHighlight
                ? { color: "#ffcc00cc", durationUs: 350_000, enabled: true as const, radiusPx: 28, style: "pulse" as const }
                : { enabled: false as const } }),
          cursor: edit.enabled
            ? {
                enabled: true,
                scale: 1,
                smoothing: { algorithm: "exponential", strength: edit.smoothing ?? 0.7 },
                style: "captured",
              }
            : { enabled: false },
        },
        updatedAt: timestamp,
      });
      break;
    case "clicks":
      next = normalizeEditPlan({
        ...plan,
        effects: {
          ...plan.effects,
          clicks: edit.enabled
            ? {
                color: edit.color,
                durationUs: parseCliTime(edit.duration, command.fps),
                enabled: true,
                radiusPx: edit.radius,
                style: edit.style,
              }
            : { enabled: false },
        },
        updatedAt: timestamp,
      });
      break;
    case "keystrokes":
      next = normalizeEditPlan({
        ...plan,
        effects: {
          ...plan.effects,
          keystrokes: edit.enabled
            ? {
                enabled: true,
                holdUs: parseCliTime(edit.stopAfter ?? "1200ms", command.fps),
                maxKeys: 8,
                position: "bottom-right",
                secureText: "hide",
              }
            : { enabled: false },
        },
        updatedAt: timestamp,
      });
      break;
    case "typed-text":
      if (edit.enabled && recording.manifest.capture.typedText !== "enabled") {
        throw new CliError(
          "conflict",
          "Typed-text rendering cannot be enabled because typed-text capture was disabled for this recording.",
        );
      }
      next = normalizeEditPlan({
        ...plan,
        effects: {
          ...plan.effects,
          typedText: edit.enabled
            ? {
                enabled: true,
                idleTimeoutUs: parseCliTime(edit.idleTimeout, command.fps),
                maxCharacters: edit.maxCharacters,
                placement: edit.placement,
                secureText: "hide",
              }
            : { enabled: false },
        },
        updatedAt: timestamp,
      });
      break;
  }
  await persistMutation(recording, edit.operation, next, command.json, context.io);
}

async function analyzeInactivity(
  context: CommandContext,
  recording: OpenRecording,
  options: {
    readonly minDurationUs: number;
    readonly motionThreshold: number;
    readonly protectAudio: boolean;
  },
): Promise<{
  readonly evidence: AnalyzerEvidenceV1;
  readonly result: ReturnType<typeof planAutomaticInactivityCuts>;
}> {
  if (recording.manifest.state !== "stopped") {
    throw new CliError("conflict", "Inactivity analysis requires a stopped recording with immutable media and events.");
  }
  const capabilities = await requestedCapabilities(
    context,
    ["ffmpeg", "ffprobe"],
  );
  const ffmpeg = requireCapability(capabilities, "ffmpeg");
  const ffprobe = requireCapability(capabilities, "ffprobe");
  const analyzer = new FfmpegInactivityAnalyzer({ ffmpeg, ffprobe, runner: context.runner });
  const displayTracks = recording.manifest.tracks.filter((track) => track.enabled && track.kind === "display-video");
  if (displayTracks.length === 0) throw new CliError("invalid-data", "Recording has no enabled display tracks to analyze.");
  const displays = await mapBounded(displayTracks, 4, async track => {
    const intervals = [];
    for (const segment of track.segments) {
      if (segment.integrity.state !== "verified" || segment.integrity.bytes <= 0) {
        throw new CliError("invalid-data", `Inactivity media ${segment.path} does not have verified integrity.`);
      }
      const path = await resolveVerifiedProjectMedia({
        expected: segment.integrity,
        label: `Inactivity media ${segment.path}:${segment.streamIndex}`,
        path: segment.path,
        repositoryRoot: recording.directory.path,
      });
      const detected = await analyzer.freeze(
        path,
        segment.streamIndex,
        options.minDurationUs,
        options.motionThreshold,
        segment.startUs,
      );
      intervals.push(...detected.filter(({ startUs, endUs }) => startUs < segment.endUs && endUs > segment.startUs)
        .map(({ startUs, endUs }) => ({
          confidence: 1,
          meanFrameDifference: options.motionThreshold,
          range: { startUs: Math.max(startUs, segment.startUs), endUs: Math.min(endUs, segment.endUs) },
        })));
    }
    return { intervals, trackId: track.trackId };
  });
  const audioTracks = options.protectAudio
    ? recording.manifest.tracks.filter((track) =>
        track.enabled && (track.kind === "system-audio" || track.kind === "microphone-audio")
      )
    : [];
  const audio = await mapBounded(audioTracks, 4, async track => {
    const intervals = [];
    for (const segment of track.segments) {
      if (segment.integrity.state !== "verified" || segment.integrity.bytes <= 0) {
        throw new CliError("invalid-data", `Inactivity media ${segment.path} does not have verified integrity.`);
      }
      const path = await resolveVerifiedProjectMedia({
        expected: segment.integrity,
        label: `Inactivity media ${segment.path}:${segment.streamIndex}`,
        path: segment.path,
        repositoryRoot: recording.directory.path,
      });
      const detected = await analyzer.silence(
        path,
        segment.streamIndex,
        options.minDurationUs,
        segment.startUs,
      );
      intervals.push(...detected.filter(({ startUs, endUs }) => startUs < segment.endUs && endUs > segment.startUs)
        .map(({ startUs, endUs }) => ({
          peakDb: -45,
          range: { startUs: Math.max(startUs, segment.startUs), endUs: Math.min(endUs, segment.endUs) },
        })));
    }
    return { intervals, trackId: track.trackId };
  });
  const ffmpegVersion = capabilityByName(capabilities, "ffmpeg").version ?? "unknown";
  const evidence = AnalyzerEvidenceV1Schema.parse({
    audio,
    displays,
    kind: "atet.analyzer-evidence",
    schemaVersion: 1,
    sourceDurationUs: recording.manifest.timeline.durationUs,
    tool: { name: "ffmpeg-freezedetect-silencedetect", version: ffmpegVersion.slice(0, 128) },
  });
  await ensurePrivateDirectory(join(recording.directory.path, "analysis"));
  await recording.fileSystem.writeTextAtomic("analysis/inactivity-v1.json", `${canonicalJson(evidence)}\n`);
  const events = await loadAllEvents(recording);
  const result = planAutomaticInactivityCuts(evidence, events, {
    edgeHandleUs: 250_000,
    interactionHandleUs: 750_000,
    minimumCutUs: options.minDurationUs,
    cursorMovementThresholdPx: 2,
    requireAudioSilence: options.protectAudio,
  });
  return { evidence, result };
}

async function handleRecordingInactivity(
  context: CommandContext,
  command: Extract<CliCommand, { readonly kind: "analyze-inactivity" }>,
): Promise<void> {
  const recording = await openRecording(context.paths.artifactRoot, command.recording);
  if (recording.manifest.state !== "stopped") {
    throw new CliError("conflict", "Inactivity analysis requires a stopped recording with immutable media and events.");
  }
  const plan = await loadCurrentPlan(recording);
  const analysis = await analyzeInactivity(context, recording, {
    minDurationUs: parseCliTime(command.minDuration),
    motionThreshold: command.motionThreshold,
    protectAudio: command.protectAudio,
  });
  let next = plan;
  if (command.apply && command.handle !== "keep") {
    for (const range of analysis.result.cuts) {
      next = command.handle === "cut"
        ? cutPlan(next, range, context.io.now().toISOString())
        : setSpeed(next, range, command.speedRate, context.io.now().toISOString());
    }
    next = canonicalAtetPersistenceDocument(next);
    await ensurePrivateDirectory(join(recording.directory.path, "edits"));
    await saveEditPlan(recording.fileSystem, next, CURRENT_EDIT_PLAN_PATH);
  }
  const output = {
    applied: command.apply && command.handle !== "keep",
    candidateCount: analysis.result.candidateCount,
    cuts: analysis.result.cuts,
    evidencePath: "analysis/inactivity-v1.json",
    handle: command.handle,
    planHash: hashEditPlan(next),
    protectedInteractionCount: analysis.result.protectedInteractionCount,
    recordingId: recording.manifest.recordingId,
  };
  writeValue(context.io, command.json, output, () =>
    `${output.cuts.length} inactivity range(s), ${output.applied ? "applied" : "dry-run"}; plan ${output.planHash}`
  );
}

async function handleProjectInactivity(
  context: CommandContext,
  command: Extract<CliCommand, { readonly kind: "analyze-inactivity" }>,
): Promise<void> {
  const project = await openProject(context.paths.projectRoot, command.recording);
  if (command.apply && command.handle !== "keep") {
    assertVerifiedStructuralAutomationSync(project.project, "Automated project inactivity edits");
  }
  const capabilities = await requestedCapabilities(
    context,
    ["ffmpeg", "ffprobe"],
  );
  const ffmpeg = requireCapability(capabilities, "ffmpeg");
  const ffprobe = requireCapability(capabilities, "ffprobe");
  const ffmpegVersion = capabilityByName(capabilities, "ffmpeg").version ?? "unknown";
  const persisted = await analyzeAndPersistProjectInactivity({
    artifactRoot: context.paths.artifactRoot,
    config: {
      ...DEFAULT_PROJECT_INACTIVITY_CONFIG,
      minimumCutUs: parseCliTime(command.minDuration),
      motionThreshold: command.motionThreshold,
      requireAudioSilence: command.protectAudio,
    },
    ffmpeg,
    ffmpegVersion,
    ffprobe,
    now: context.io.now(),
    project,
    repositoryRoot: context.paths.repositoryRoot,
    runner: context.runner,
    toolVersion: context.version,
  });
  let next = await loadCurrentProjectPlan(project);
  const shouldApply = command.apply
    && command.handle !== "keep"
    && persisted.analysis.result.recommendedRanges.length > 0;
  if (shouldApply) {
    const timestamp = context.io.now().toISOString();
    const application = applyProjectInactivityPlan({
      analysis: persisted.analysis,
      decisionIds: persisted.analysis.result.recommendedRanges.map(() => (
        `decision_${randomUUID().replaceAll("-", "")}`
      )),
      operation: command.handle === "cut" ? "cut" : "speed",
      plan: next,
      project: persisted.project,
      speedRate: command.speedRate,
      updatedAt: timestamp,
    });
    if (application.status === "rejected") {
      throw new CliError("conflict", `Inactivity application was rejected: ${application.reason}`, application);
    }
    next = canonicalAtetPersistenceDocument(application.plan);
    await saveProjectEditPlan(project.fileSystem, next);
  }
  const output = {
    analysisId: persisted.analysis.analysisId,
    applied: shouldApply,
    candidateCount: persisted.analysis.result.candidateCount,
    cuts: persisted.analysis.result.recommendedRanges,
    evidencePath: persisted.analysisPath,
    handle: command.handle,
    planHash: hashProjectEditPlan(next),
    projectId: persisted.project.projectId,
    protectedInteractionCount: persisted.analysis.result.protectedInteractionCount,
    referenceRecording: persisted.analysis.referenceRecording?.recordingId ?? null,
  };
  writeValue(context.io, command.json, output, () => (
    `${output.cuts.length} project inactivity range(s), ${output.applied ? "applied" : "evidence only"}; analysis ${output.analysisId}; plan ${output.planHash}`
  ));
}

async function handleInactivity(
  context: CommandContext,
  command: Extract<CliCommand, { readonly kind: "analyze-inactivity" }>,
): Promise<void> {
  if (command.recording.startsWith("project_")) {
    await handleProjectInactivity(context, command);
    return;
  }
  await handleRecordingInactivity(context, command);
}

async function handleAutomaticZooms(
  context: CommandContext,
  command: Extract<CliCommand, { readonly kind: "analyze-zooms" }>,
): Promise<void> {
  const recording = await openRecording(context.paths.artifactRoot, command.recording);
  if (recording.manifest.state !== "stopped") {
    throw new CliError("conflict", "Automatic zoom analysis requires a stopped recording with immutable events.");
  }
  const plan = await loadCurrentPlan(recording);
  if (command.plan !== undefined && command.plan !== "current" && command.plan !== plan.planId) {
    throw new CliError("not-found", `Only current (${plan.planId}) is available; requested ${command.plan}.`);
  }
  const suggestions = planAutomaticZooms(await loadAllEvents(recording), plan.sourceDurationUs, {
    enterDurationUs: 300_000,
    exitDurationUs: 300_000,
    intentMergeGapUs: 750_000,
    maxDurationUs: 8_000_000,
    maxScale: 3,
    minDurationUs: 1_500_000,
    postHandleUs: 1_000_000,
    preHandleUs: 500_000,
    scale: 2,
  });
  let next = plan;
  if (command.apply) {
    next = normalizeEditPlan({
      ...plan,
      updatedAt: context.io.now().toISOString(),
      zooms: [...plan.zooms.filter(({ kind }) => kind !== "automatic"), ...suggestions],
    });
    next = canonicalAtetPersistenceDocument(next);
    await ensurePrivateDirectory(join(recording.directory.path, "edits"));
    await saveEditPlan(recording.fileSystem, next, CURRENT_EDIT_PLAN_PATH);
  }
  const output = {
    applied: command.apply,
    planHash: hashEditPlan(next),
    recordingId: recording.manifest.recordingId,
    suggestions: suggestions.map((zoom) => ({
      confidence: zoom.confidence,
      range: zoom.range,
      reason: zoom.reason,
      scale: zoom.scale,
      target: zoom.target,
      zoomId: zoom.zoomId,
    })),
  };
  writeValue(context.io, command.json, output, () =>
    `${suggestions.length} automatic zoom suggestion(s), ${command.apply ? "applied" : "dry-run"}; plan ${output.planHash}`
  );
}

function selectedDisplay(manifest: RecordingManifestV1, selector: string): Extract<RecordingManifestV1["tracks"][number], { readonly kind: "display-video" }> {
  const tracks = manifest.tracks.filter((track): track is Extract<typeof track, { readonly kind: "display-video" }> =>
    track.enabled && track.kind === "display-video"
  );
  const selected = selector === "primary"
    ? tracks.find((track) => manifest.sources.displays.some((display) =>
        display.isPrimary && display.displayId === track.source.displayId
      ))
    : tracks.find((track) => track.source.displayId === selector || track.trackId === selector);
  if (selected === undefined) {
    throw new CliError("not-found", `No enabled display track matches ${selector}.`);
  }
  return selected;
}

async function resolvedRenderPlan(
  context: CommandContext,
  recording: OpenRecording,
  plan: EditPlanV1,
  autoInactivity: boolean,
  displaySelector: string,
): Promise<{ readonly effectivePlan: EditPlanV1; readonly renderPlan: ReturnType<typeof compileRenderPlan> }> {
  let effectivePlan = plan;
  if (autoInactivity) {
    const analysis = await analyzeInactivity(context, recording, {
      minDurationUs: 3_000_000,
      motionThreshold: 0.003,
      protectAudio: true,
    });
    for (const cut of analysis.result.cuts) effectivePlan = cutPlan(effectivePlan, cut, plan.updatedAt);
  }
  const displayTrack = selectedDisplay(recording.manifest, displaySelector);
  const display = recording.manifest.sources.displays.find(({ displayId }) => displayId === displayTrack.source.displayId)!;
  const events = await loadAllEvents(recording);
  const audioTrackIds = recording.manifest.tracks.filter((track) =>
    track.enabled && (track.kind === "system-audio" || track.kind === "microphone-audio")
  ).map(({ trackId }) => trackId);
  return {
    effectivePlan,
    renderPlan: compileRenderPlan(recording.manifest, effectivePlan, events, {
      audioTrackIds,
      camera: { kind: "none" },
      displayTrackId: displayTrack.trackId,
      frameRate: Math.min(60, display.refreshRateHz),
      pixelHeight: display.pixelSize.height,
      pixelWidth: display.pixelSize.width,
    }),
  };
}

async function handleRender(
  context: CommandContext,
  command: Extract<CliCommand, { readonly kind: "render-plan" | "render-run" }>,
): Promise<void> {
  const recording = await openRecording(context.paths.artifactRoot, command.recording);
  if (recording.manifest.state !== "stopped") {
    throw new CliError("conflict", "Rendering requires a stopped recording with immutable media and events.");
  }
  const plan = await loadCurrentPlan(recording);
  const resolved = await resolvedRenderPlan(context, recording, plan, command.autoInactivity, command.display);
  const resolvedPlanHash = sha256Hex(canonicalJson(resolved.renderPlan));
  const artifactPath = `renders/resolved-${resolvedPlanHash}.json`;
  const defaultOutput = `renders/${resolvedPlanHash}.mp4`;
  await ensurePrivateDirectory(join(recording.directory.path, "renders"));
  const customPlanOutput = command.kind === "render-plan" && command.output !== undefined
    ? await resolveRecordingRenderPlanOutput(recording, command.output, artifactPath)
    : undefined;
  await recording.fileSystem.writeTextAtomic(artifactPath, `${canonicalJson(resolved.renderPlan)}\n`);
  if (command.kind === "render-plan") {
    if (customPlanOutput !== undefined && customPlanOutput.relative !== artifactPath) {
      await recording.fileSystem.writeTextAtomic(
        customPlanOutput.relative,
        `${canonicalJson(resolved.renderPlan)}\n`,
      );
    }
    const value = {
      artifactPath,
      defaultOutputPath: defaultOutput,
      display: resolved.renderPlan.composition.baseDisplay,
      renderPlan: resolved.renderPlan,
    };
    writeValue(context.io, command.json, value, () =>
      `${resolved.renderPlan.recordingId} display=${resolved.renderPlan.composition.baseDisplay.displayId} duration=${humanTime(resolved.renderPlan.output.durationUs)} plan=${artifactPath}`
    );
    return;
  }
  const capabilities = await requestedCapabilities(
    context,
    ["ffmpeg", "ffprobe", "rsvg-convert"],
  );
  const ffmpeg = requireCapability(capabilities, "ffmpeg");
  const ffprobe = requireCapability(capabilities, "ffprobe");
  const rsvg = capabilityByName(capabilities, "rsvg-convert");
  const outputAbsolute = await resolveRenderOutput(recording, command.output ?? defaultOutput);
  if (extname(outputAbsolute).toLocaleLowerCase() !== ".mp4") {
    throw new CliError("usage", "The current renderer writes MP4 output; use a .mp4 path under renders/.");
  }
  const outputRelative = bundleRelativePath(recording, outputAbsolute);
  const receiptPath = `${outputRelative}.plan.json`;
  const receiptAbsolute = command.dryRun
    ? null
    : await resolveRenderOutput(recording, receiptPath);
  const preparation = await prepareOverlaySources(resolved.renderPlan, {
    bundleRoot: recording.directory.path,
    dryRun: command.dryRun,
    ffprobe,
    rsvgConvert: rsvg.available ? rsvg.command : undefined,
    runner: context.runner,
  });
  const built = await buildFfmpegInvocation(recording.manifest, resolved.renderPlan, {
    bundleRoot: recording.directory.path,
    ffmpeg,
    outputPath: outputAbsolute,
    overlaySources: preparation.sources,
  });
  const output = {
    artifactPath,
    dryRun: command.dryRun,
    invocation: built.invocation,
    outputPath: outputRelative,
    preprocessing: preparation.steps,
    receiptPath: command.dryRun ? null : receiptPath,
  };
  if (command.dryRun) {
    writeValue(context.io, command.json, output, () => `${built.argv.join(" ")}\nplan=${artifactPath}`);
    return;
  }
  if (receiptAbsolute === null) throw new CliError("internal", "Recording render receipt path was not resolved.");
  if (!command.json) context.io.stderr(`Rendering ${recording.manifest.recordingId} -> ${output.outputPath}\n`);
  const outputIntegrity = await executeAtomicRender({
    argv: built.argv,
    companion: {
      finalPath: receiptAbsolute,
      publish: async integrity => await recording.fileSystem.writeTextAtomic(
        receiptPath,
        `${canonicalJson(RecordingRenderReceiptV1Schema.parse({
          createdAt: context.io.now().toISOString(),
          display: resolved.renderPlan.composition.baseDisplay,
          kind: "atet.recording-render-receipt",
          output: { ...integrity, path: outputRelative },
          plan: { path: artifactPath, sha256: resolvedPlanHash },
          recordingId: recording.manifest.recordingId,
          schemaVersion: 1,
        }))}\n`,
      ),
    },
    failureLabel: "FFmpeg render failed",
    finalOutputPath: outputAbsolute,
    maximumOutputBytes: MAXIMUM_LEGACY_RECORDING_RENDER_OUTPUT_BYTES,
    runner: context.runner,
  });
  const completed = { ...output, output: outputIntegrity };
  writeValue(context.io, command.json, completed, () => `rendered ${output.outputPath}; plan=${artifactPath}`);
}

function snapshotHuman(snapshot: RecordingSnapshot): string {
  if (snapshot.state === "idle") return "idle";
  return `${snapshot.state} ${snapshot.recordingId ?? "unknown"} ${humanTime(snapshot.logicalTimeUs)} segments=${snapshot.completedSegmentCount}`;
}

async function handleProjectEdit(
  context: CommandContext,
  command: Extract<CliCommand, { readonly kind: "project-edit" }>,
): Promise<void> {
  const project = await openProject(context.paths.projectRoot, command.project);
  const plan = await loadCurrentProjectPlan(project);
  const range = sourceRange(command.from, command.to);
  const timestamp = context.io.now().toISOString();
  const registry = createApplicationOperationRegistry({
    toolVersion: context.version,
  });
  const executionContext: OperationExecutionContext = {
    abortSignal: new AbortController().signal,
    application: applicationContext(context),
  };
  const ordered = command.operation === "speed"
    ? [{ kind: command.operation, range, rate: command.rate }]
    : [{ kind: command.operation, range }];
  const derived = await registry.execute(executionContext, {
    input: { ordered },
    kind: "derive.edit-batch",
    version: 1,
  });
  const batch = ProjectEditBatchSchema.parse(derived.output);
  const committed = await registry.execute(executionContext, {
    input: {
      basis: projectEditBasis(project.project, plan),
      batch,
      project: project.project.projectId,
      updatedAt: timestamp,
    },
    kind: "project.commit-edits",
    version: 1,
  });
  const operationReceipt = ProjectEditCommitReceiptSchema.parse(
    committed.output,
  );
  const receipt = {
    operation: operationReceipt.operation,
    planHash: operationReceipt.planHash,
    planId: operationReceipt.planId,
    projectId: operationReceipt.projectId,
  };
  writeValue(context.io, command.json, receipt, () => (
    `${receipt.operation} ${receipt.planId} ${receipt.planHash}`
  ));
}

function nextCameraMoveId(plan: ProjectEditPlanV1): string {
  let index = plan.cameraMoves.length + 1;
  while (
    plan.cameraMoves.some(
      move => move.cameraMoveId === `camera_manual${String(index).padStart(4, "0")}`,
    )
  ) {
    index += 1;
  }
  return `camera_manual${String(index).padStart(4, "0")}`;
}

function cameraReceiptHuman(receipt: ProjectCameraEditReceipt): string {
  const selection = "selection" in receipt && receipt.selection !== null
    ? ` selection=${receipt.selection.kind} require-all=${String(receipt.selection.requireAllSelected)}`
      + ` tracks=${receipt.selection.trackIds.join(",")}`
    : "";
  return [
    `${receipt.operation} ${receipt.cameraMoveId} keyframes=${receipt.keyframeCount}`
      + ` camera-moves=${receipt.cameraMoves}${selection}`,
    `plan ${receipt.planHash}`,
    `show: ${receipt.nextCommands.show}`,
    ...("remove" in receipt.nextCommands
      ? [`remove: ${receipt.nextCommands.remove}`]
      : []),
  ].join("\n");
}

function parsedProjectVideoLayer(
  project: VideoProjectV1,
  placementInput: string,
  streamInput: string,
): {
  readonly placement: VideoProjectV1["placements"][number];
  readonly streamId: VideoProjectV1["placements"][number]["video"][number]["streamId"];
} {
  const placementId = ProjectPlacementIdSchema.safeParse(placementInput);
  const streamId = ProjectStreamIdSchema.safeParse(streamInput);
  if (!placementId.success || !streamId.success) {
    throw new CliError(
      "usage",
      `Invalid project video layer: ${placementInput}:${streamInput}`,
    );
  }
  const placement = project.placements.find(
    candidate => candidate.placementId === placementId.data,
  );
  if (placement === undefined) {
    throw new CliError("not-found", `Unknown project placement: ${placementInput}`);
  }
  const configured = placement.video.find(candidate => candidate.streamId === streamId.data);
  if (configured?.presentation.enabled !== true) {
    throw new CliError(
      "not-found",
      `Project placement ${placementInput} has no enabled video stream ${streamInput}.`,
    );
  }
  return { placement, streamId: configured.streamId };
}

async function handleProjectCameraEdit(
  context: CommandContext,
  command: Extract<CliCommand, { readonly kind: "project-camera-edit" }>,
): Promise<void> {
  const project = await openProject(context.paths.projectRoot, command.project);
  const plan = await loadCurrentProjectPlan(project);
  if (command.action === "show") {
    const output = {
      cameraMoves: plan.cameraMoves,
      planHash: hashProjectEditPlan(plan),
      projectId: project.project.projectId,
    };
    writeValue(context.io, command.json, output, () => (
      plan.cameraMoves.length === 0
        ? "No camera moves."
        : plan.cameraMoves.map(move => (
            `${move.cameraMoveId} ${move.placementId}:${move.streamId} `
            + `${humanTime(move.projectRange.startUs)}..${humanTime(move.projectRange.endUs)} `
            + `keyframes=${move.keyframes.length} origin=${move.origin.kind}`
          )).join("\n")
    ));
    return;
  }

  const timestamp = context.io.now().toISOString();
  let next: ProjectEditPlanV1;
  let editedMove: ProjectCameraMove | undefined;
  let selectionReceipt: ProjectCameraSelectionReceipt | null = null;
  if (command.action === "remove") {
    editedMove = plan.cameraMoves.find(move => move.cameraMoveId === command.cameraMoveId);
    if (editedMove === undefined) {
      throw new CliError("not-found", `Unknown project camera move: ${command.cameraMoveId}`);
    }
    next = normalizeProjectEditPlan({
      ...plan,
      cameraMoves: plan.cameraMoves.filter(move => move.cameraMoveId !== command.cameraMoveId),
      updatedAt: timestamp,
    });
  } else if (command.action === "follow-faces") {
    const loaded = await loadVerifiedProjectFaceAnalysis({
      analysisId: command.analysis,
      project,
    });
    const planned = planProjectFaceCamera({
      analysis: loaded.analysis,
      cameraMoveId: nextCameraMoveId(plan),
      easing: easing(command.easing),
      framing: command.framing,
      gapPolicy: command.gapPolicy,
      headroom: command.headroom,
      maximumZoom: command.maxZoom,
      minimumZoom: command.minZoom,
      outputHeight: command.outputHeight,
      outputWidth: command.outputWidth,
      placementId: command.placement,
      plan,
      project: project.project,
      projectRange: sourceRange(command.from, command.to),
      reference: loaded.reference,
      requireAllSelectedFaces: command.requireAllSelected,
      selection: command.select === undefined
        ? { kind: "explicit", trackIds: command.tracks }
        : { kind: command.select },
      smoothingSeconds: command.smoothing,
    });
    try {
      assertProjectCameraMoveBindings(project.project, planned.move);
    } catch (error) {
      throw new CliError(
        "conflict",
        error instanceof Error ? error.message : "Face-follow camera binding could not be validated.",
      );
    }
    editedMove = planned.move;
    selectionReceipt = {
      kind: command.select ?? "explicit",
      requireAllSelected: command.requireAllSelected,
      trackIds: planned.selectedTrackIds,
    };
    next = normalizeProjectEditPlan({
      ...plan,
      cameraMoves: [...plan.cameraMoves, planned.move],
      updatedAt: timestamp,
    });
  } else {
    const layer = parsedProjectVideoLayer(project.project, command.placement, command.stream);
    const pathKeyframes = command.action === "path"
      ? command.keyframes.map((keyframe, index) => ({
          outgoingEasing: index === command.keyframes.length - 1
            ? { kind: "linear" as const }
            : easing(command.easing),
          pose: {
            centerX: keyframe.frame[0],
            centerY: keyframe.frame[1],
            space: "prepared-video-layer-normalized-v1" as const,
            zoom: keyframe.frame[2],
          },
          projectTimeUs: parseCliTime(keyframe.at),
        }))
      : undefined;
    const projectRange = command.action === "path"
      ? {
          endUs: pathKeyframes!.at(-1)!.projectTimeUs,
          startUs: pathKeyframes![0]!.projectTimeUs,
        }
      : sourceRange(command.from, command.to);
    if (projectRange.endUs > project.project.timeline.durationUs) {
      throw new CliError("usage", "Camera move range exceeds the project timeline.");
    }
    const startPose = command.action === "path"
      ? undefined
      : command.action === "push"
        ? {
            centerX: 0.5,
            centerY: 0.5,
            space: "prepared-video-layer-normalized-v1" as const,
            zoom: command.startZoom,
          }
        : {
            centerX: command.fromFrame[0],
            centerY: command.fromFrame[1],
            space: "prepared-video-layer-normalized-v1" as const,
            zoom: command.fromFrame[2],
          };
    const endPose = command.action === "path"
      ? undefined
      : command.action === "push"
        ? {
            centerX: command.center[0],
            centerY: command.center[1],
            space: "prepared-video-layer-normalized-v1" as const,
            zoom: command.endZoom,
          }
        : {
            centerX: command.toFrame[0],
            centerY: command.toFrame[1],
            space: "prepared-video-layer-normalized-v1" as const,
            zoom: command.toFrame[2],
          };
    const parsed = ProjectCameraMoveSchema.safeParse({
      binding: {
        geometrySha256: hashProjectCameraGeometry(
          project.project,
          layer.placement.placementId,
          layer.streamId,
        ),
        syncSha256: hashProjectCameraSync(layer.placement),
      },
      cameraMoveId: nextCameraMoveId(plan),
      keyframes: pathKeyframes ?? [
        {
          outgoingEasing: easing(command.easing),
          pose: startPose,
          projectTimeUs: projectRange.startUs,
        },
        {
          outgoingEasing: { kind: "linear" },
          pose: endPose,
          projectTimeUs: projectRange.endUs,
        },
      ],
      origin: { kind: "manual" },
      placementId: layer.placement.placementId,
      projectRange,
      streamId: layer.streamId,
    });
    if (!parsed.success) {
      throw new CliError(
        "usage",
        `Invalid camera move: ${parsed.error.issues[0]?.message ?? "unknown error"}`,
      );
    }
    try {
      assertProjectCameraMoveBindings(project.project, parsed.data);
    } catch (error) {
      throw new CliError(
        "conflict",
        error instanceof Error ? error.message : "Camera move binding could not be validated.",
      );
    }
    editedMove = parsed.data;
    next = normalizeProjectEditPlan({
      ...plan,
      cameraMoves: [...plan.cameraMoves, parsed.data],
      updatedAt: timestamp,
    });
  }

  if (editedMove === undefined) {
    throw new CliError("internal", "Camera edit completed without a bounded mutation receipt.");
  }
  next = canonicalAtetPersistenceDocument(next);
  const planHash = hashProjectEditPlan(next);
  const nextCommands = projectCameraNextCommands(
    project.project.projectId,
    editedMove.cameraMoveId,
  );
  const receipt = command.action === "remove"
    ? ProjectCameraRemoveReceiptSchema.parse({
      cameraMoveId: editedMove.cameraMoveId,
      cameraMoves: next.cameraMoves.length,
      keyframeCount: editedMove.keyframes.length,
      nextCommands: { show: nextCommands.show },
      operation: command.action,
      planHash,
      projectId: project.project.projectId,
    })
    : ProjectCameraCreateReceiptSchema.parse({
      cameraMoveId: editedMove.cameraMoveId,
      cameraMoves: next.cameraMoves.length,
      keyframeCount: editedMove.keyframes.length,
      nextCommands,
      operation: command.action,
      planHash,
      projectId: project.project.projectId,
      selection: selectionReceipt,
    });
  await saveProjectEditPlan(project.fileSystem, next);
  writeValue(context.io, command.json, receipt, () => cameraReceiptHuman(receipt));
}

async function projectMetadataContext(
  context: CommandContext,
  project: OpenProject,
  requestedPlacementId: string,
): Promise<ProjectMetadataContext> {
  const parsedPlacementId = ProjectPlacementIdSchema.safeParse(requestedPlacementId);
  if (!parsedPlacementId.success) {
    throw new CliError("usage", `Invalid project metadata placement: ${requestedPlacementId}`);
  }
  const placement = project.project.placements.find(
    candidate => candidate.placementId === parsedPlacementId.data,
  );
  if (placement === undefined) {
    throw new CliError("not-found", `Unknown project metadata placement: ${requestedPlacementId}`);
  }
  const asset = project.project.assets.find(candidate => candidate.assetId === placement.assetId);
  if (asset?.source.kind !== "recording") {
    throw new CliError(
      "conflict",
      `Placement ${placement.placementId} is not backed by an Atet recording with window and input metadata.`,
    );
  }
  const recording = await openRecording(context.paths.artifactRoot, asset.source.recordingId);
  return {
    events: await loadAllEvents(recording),
    manifest: recording.manifest,
    placementId: placement.placementId,
  };
}

function projectMetadataPlacementId(
  project: OpenProject,
  plan: ProjectEditPlanV1,
  requested: string | undefined,
): ProjectPlacementV1["placementId"] {
  if (requested !== undefined) {
    const parsed = ProjectPlacementIdSchema.safeParse(requested);
    if (!parsed.success) throw new CliError("usage", `Invalid project metadata placement: ${requested}`);
    return parsed.data;
  }
  return plan.effects.metadataPlacementId ?? project.project.referencePlacementId;
}

async function handleProjectMetadataEdit(
  context: CommandContext,
  command: Extract<CliCommand, { readonly kind: "project-metadata-edit" }>,
): Promise<void> {
  const project = await openProject(context.paths.projectRoot, command.project);
  const plan = await loadCurrentProjectPlan(project);
  const timestamp = context.io.now().toISOString();
  const edit = command.edit;

  if (edit.operation === "zoom-remove" || edit.operation === "zoom-add") {
    if (command.sourcePlacement !== undefined) {
      if (edit.operation === "zoom-remove") {
        throw new CliError("usage", "--source-placement is not valid when removing a project zoom.");
      }
    }
    const ordered = edit.operation === "zoom-remove"
      ? [{ kind: "remove-zooms" as const, zoomIds: [edit.id] }]
      : (() => {
          const zoom = manualProjectZoomInput(
            edit,
            plan.zooms.map(candidate => candidate.operation.zoomId),
            projectMetadataPlacementId(
              project,
              plan,
              command.sourcePlacement,
            ),
            command.fps,
          );
          if (zoom.range.endUs > project.project.timeline.durationUs) {
            throw new CliError(
              "usage",
              "Project zoom range exceeds the project timeline.",
            );
          }
          return [{
            kind: "add-manual-zooms" as const,
            zooms: [zoom],
          }];
        })();
    const registry = createApplicationOperationRegistry({
      toolVersion: context.version,
    });
    const application = applicationContext(context);
    const executionContext: OperationExecutionContext = {
      abortSignal: new AbortController().signal,
      application,
    };
    const derived = await registry.execute(executionContext, {
      input: { ordered },
      kind: "derive.edit-batch",
      version: 3,
    });
    const batch = ProjectEditBatchV3Schema.parse(derived.output);
    const boundInput = await bindProjectCommitEditsInputV3(application, {
      basis: projectEditBasis(project.project, plan),
      batch,
      project: project.project.projectId,
      updatedAt: timestamp,
    });
    const committed = await registry.execute(executionContext, {
      input: boundInput,
      kind: "project.commit-edits",
      version: 3,
    });
    const operationReceipt = ProjectEditCommitReceiptSchema.parse(
      committed.output,
    );
    const committedPlan = await loadCurrentProjectPlan(project);
    if (hashProjectEditPlan(committedPlan) !== operationReceipt.planHash) {
      throw new CliError(
        "internal",
        "Committed project zoom receipt does not match the published edit plan.",
      );
    }
    const receipt = {
      effects: committedPlan.effects,
      operation: edit.operation,
      planHash: operationReceipt.planHash,
      projectId: operationReceipt.projectId,
      zooms: committedPlan.zooms.length,
    };
    writeValue(context.io, command.json, receipt, () => (
      `${receipt.operation} zooms=${receipt.zooms} ${receipt.planHash}`
    ));
    return;
  }

  const enablesMetadata = edit.enabled
    || (edit.operation === "cursor" && edit.clickHighlight === true)
    || command.sourcePlacement !== undefined;
  const placementId = projectMetadataPlacementId(project, plan, command.sourcePlacement);
  const metadata = enablesMetadata
    ? await projectMetadataContext(context, project, placementId)
    : null;
  if (edit.operation === "typed-text" && edit.enabled && metadata?.manifest.capture.typedText !== "enabled") {
    throw new CliError(
      "conflict",
      "Typed-text rendering cannot be enabled because typed-text capture was disabled for the selected source placement.",
    );
  }
  const effects: ProjectEditPlanV1["effects"] = edit.operation === "cursor"
    ? {
        ...plan.effects,
        ...(edit.clickHighlight === undefined
          ? {}
          : { clicks: edit.clickHighlight
              ? { color: "#ffcc00cc", durationUs: 350_000, enabled: true as const, radiusPx: 28, style: "pulse" as const }
              : { enabled: false as const } }),
        cursor: edit.enabled
          ? {
              enabled: true,
              scale: 1,
              smoothing: { algorithm: "exponential", strength: edit.smoothing ?? 0.7 },
              style: "captured",
            }
          : { enabled: false },
        metadataPlacementId: placementId,
      }
    : edit.operation === "clicks"
      ? {
          ...plan.effects,
          clicks: edit.enabled
            ? {
                color: edit.color,
                durationUs: parseCliTime(edit.duration, command.fps),
                enabled: true,
                radiusPx: edit.radius,
                style: edit.style,
              }
            : { enabled: false },
          metadataPlacementId: placementId,
        }
      : edit.operation === "keystrokes"
        ? {
            ...plan.effects,
            keystrokes: edit.enabled
              ? {
                  enabled: true,
                  holdUs: parseCliTime(edit.stopAfter ?? "1200ms", command.fps),
                  maxKeys: 8,
                  position: "bottom-right",
                  secureText: "hide",
                }
              : { enabled: false },
            metadataPlacementId: placementId,
          }
        : {
            ...plan.effects,
            metadataPlacementId: placementId,
            typedText: edit.enabled
              ? {
                  enabled: true,
                  idleTimeoutUs: parseCliTime(edit.idleTimeout, command.fps),
                  maxCharacters: edit.maxCharacters,
                  placement: edit.placement,
                  secureText: "hide",
                }
              : { enabled: false },
          };
  const next = canonicalAtetPersistenceDocument(
    normalizeProjectEditPlan({ ...plan, effects, updatedAt: timestamp }),
  );
  await saveProjectEditPlan(project.fileSystem, next);
  const receipt = {
    effects: next.effects,
    operation: edit.operation,
    planHash: hashProjectEditPlan(next),
    projectId: project.project.projectId,
    zooms: next.zooms.length,
  };
  writeValue(context.io, command.json, receipt, () => (
    `${receipt.operation} zooms=${receipt.zooms} ${receipt.planHash}`
  ));
}

async function handleProjectOverlayEdit(
  context: CommandContext,
  command: Extract<CliCommand, { readonly kind: "project-overlay-edit" }>,
): Promise<void> {
  const project = await openProject(context.paths.projectRoot, command.project);
  const plan = await loadCurrentProjectPlan(project);
  const timestamp = context.io.now().toISOString();
  const edit = command.edit;
  let next;
  let rollback: (() => Promise<void>) | undefined;
  try {
    if (edit.operation === "overlay-remove") {
      if (!plan.overlays.some(overlay => overlay.overlayId === edit.id)) {
        throw new CliError("not-found", `Unknown project overlay: ${edit.id}`);
      }
      next = normalizeProjectEditPlan({
        ...plan,
        overlays: plan.overlays.filter(overlay => overlay.overlayId !== edit.id),
        updatedAt: timestamp,
      });
    } else {
      const range = sourceRange(edit.from, edit.to, command.fps);
      if (range.endUs > project.project.timeline.durationUs) {
        throw new CliError("usage", "Project overlay range exceeds the project timeline.");
      }
      const prepared = await overlayOperation(
        context,
        project.directory.path,
        plan.overlays,
        edit,
        command.fps,
        candidate => mapProjectIntervalToOutputSlices(buildProjectOutputTimeMap(plan), candidate)
          .reduce((total, slice) => total + slice.output.endUs - slice.output.startUs, 0),
      );
      rollback = () => prepared.rollback();
      next = normalizeProjectEditPlan({
        ...plan,
        overlays: [...plan.overlays, prepared.operation],
        updatedAt: timestamp,
      });
    }
    next = canonicalAtetPersistenceDocument(next);
    await saveProjectEditPlan(project.fileSystem, next);
  } catch (error) {
    await rollback?.();
    throw error;
  }
  const receipt = {
    operation: command.edit.operation,
    overlays: next.overlays.length,
    planHash: hashProjectEditPlan(next),
    projectId: project.project.projectId,
  };
  writeValue(context.io, command.json, receipt, () => (
    `${receipt.operation} overlays=${receipt.overlays} ${receipt.planHash}`
  ));
}

async function handleProjectRender(
  context: CommandContext,
  command: Extract<CliCommand, { readonly kind: "project-render" }>,
): Promise<void> {
  const project = await openProject(context.paths.projectRoot, command.project);
  const edit = await loadCurrentProjectPlan(project);
  const metadataPlacementIds = new Set<string>(edit.zooms.map(zoom => zoom.placementId));
  if (
    (edit.effects.clicks.enabled
      || edit.effects.cursor.enabled
      || edit.effects.keystrokes.enabled
      || edit.effects.typedText.enabled)
    && edit.effects.metadataPlacementId !== null
  ) metadataPlacementIds.add(edit.effects.metadataPlacementId);
  const metadata = await Promise.all([...metadataPlacementIds].map(
    placementId => projectMetadataContext(context, project, placementId),
  ));
  let plan: ReturnType<typeof compileProjectRenderPlan>;
  try {
    plan = compileProjectRenderPlan(project.project, edit, {
      frameRate: command.fps,
      metadata,
      pixelHeight: command.height,
      pixelWidth: command.width,
    });
  } catch (error) {
    if (error instanceof TypeError) throw new CliError("conflict", error.message);
    throw error;
  }
  const requested = command.output ?? "renders/project.mp4";
  const renderLeaf = await resolveProjectRenderLeaf(project.directory.path, requested, { videoOutput: true });
  const outputAbsolute = renderLeaf.absolute;
  const outputRelative = renderLeaf.relative;
  const sidecarPath = `${outputRelative}.plan.json`;
  const planArtifactPath = `renders/plans/${plan.planSha256}.json`;
  const planDocumentSha256 = sha256Hex(canonicalJson(plan));
  const [sidecarLeaf] = await Promise.all([
    resolveProjectRenderLeaf(project.directory.path, sidecarPath),
    resolveProjectRenderLeaf(project.directory.path, planArtifactPath),
  ]);
  // The immutable composition-keyed plan is safe to publish before encoding
  // and remains useful for dry-runs and failed renders. The mutable output
  // sidecar is only replaced after its corresponding video has committed.
  await project.fileSystem.writeTextAtomic(planArtifactPath, `${canonicalJson(plan)}\n`);
  if (command.action === "plan") {
    writeValue(context.io, command.json, { plan, planPath: planArtifactPath }, () => (
      `project render plan ${plan.planSha256}; video=${plan.videoSlices.length} audio=${plan.audioSlices.length} warnings=${plan.warnings.length}`
    ));
    return;
  }
  if (!command.allowUnverifiedSync && plan.warnings.some(warning => warning.code === "unverified-sync")) {
    throw new CliError(
      "conflict",
      "Project contains unverified placements. Align them first, or explicitly use --allow-unverified-sync for a provisional render.",
    );
  }
  const capabilities = await requestedCapabilities(
    context,
    ["ffmpeg", "ffprobe", "rsvg-convert"],
  );
  const ffmpeg = requireCapability(capabilities, "ffmpeg");
  const ffprobe = requireCapability(capabilities, "ffprobe");
  const rsvg = capabilityByName(capabilities, "rsvg-convert");
  const built = await buildProjectFfmpegInvocation(plan, {
    dryRun: command.dryRun,
    ffmpeg,
    ffprobe,
    outputPath: outputAbsolute,
    projectDirectory: project.directory.path,
    repositoryRoot: context.paths.repositoryRoot,
    ...(rsvg.available && rsvg.command !== undefined && rsvg.version !== undefined
      ? { rsvgConvert: rsvg.command, rsvgConvertVersion: rsvg.version }
      : {}),
    runner: context.runner,
  });
  const output = {
    invocation: built.invocation,
    planPath: planArtifactPath,
    projectId: project.project.projectId,
    provisional: plan.warnings.some(warning => warning.code === "unverified-sync"),
    receiptPath: command.dryRun ? null : sidecarPath,
  };
  if (command.dryRun) {
    writeValue(context.io, command.json, output, () => `dry-run ${built.argv.join(" ")}`);
    return;
  }
  const outputIntegrity = await executeAtomicRender({
    argv: built.argv,
    companion: {
      finalPath: sidecarLeaf.absolute,
      publish: async integrity => await project.fileSystem.writeTextAtomic(
        sidecarPath,
        `${canonicalJson(ProjectRenderReceiptV1Schema.parse({
          createdAt: context.io.now().toISOString(),
          kind: "atet.project-render-receipt",
          output: { ...integrity, path: outputRelative },
          plan: { path: planArtifactPath, sha256: planDocumentSha256 },
          projectId: project.project.projectId,
          schemaVersion: 1,
        }))}\n`,
      ),
    },
    failureLabel: "FFmpeg project render failed",
    finalOutputPath: outputAbsolute,
    maximumOutputBytes: MAXIMUM_LEGACY_PROJECT_RENDER_OUTPUT_BYTES,
    runner: context.runner,
  });
  const completed = { ...output, output: outputIntegrity };
  writeValue(context.io, command.json, completed, () => `rendered ${outputRelative}; plan=${planArtifactPath}`);
}

function projectPlacement(
  project: Awaited<ReturnType<typeof openProject>>,
  assetId: string,
  requested: string | undefined,
  label: string,
) {
  if (requested !== undefined) {
    const placementId = ProjectPlacementIdSchema.parse(requested);
    const placement = project.project.placements.find(candidate => candidate.placementId === placementId);
    if (placement === undefined || placement.assetId !== assetId) {
      throw new CliError("not-found", `${label} placement ${requested} does not place asset ${assetId}.`);
    }
    return placement;
  }
  const matches = project.project.placements.filter(placement => placement.assetId === assetId);
  if (matches.length === 0) throw new CliError("not-found", `Asset ${assetId} has no project placement.`);
  if (matches.length > 1) {
    throw new CliError(
      "conflict",
      `Asset ${assetId} has multiple placements; select ${label} with --${label}-placement.`,
      { placements: matches.map(placement => placement.placementId) },
    );
  }
  return matches[0]!;
}

function assertVerifiedStructuralAutomationSync(project: VideoProjectV1, operation: string): void {
  const unverifiedPlacements = unverifiedEnabledPlacementIds(project);
  if (unverifiedPlacements.length === 0) return;
  throw new CliError(
    "conflict",
    `${operation} require verified synchronization for every enabled placement. Align imported placements or disable them first.`,
    { unverifiedPlacements },
  );
}

async function persistAppliedAlignment(
  project: Awaited<ReturnType<typeof openProject>>,
  analysisProject: VideoProjectV1,
  analysisId: string,
  referencePlacementId: string,
  targetPlacementId: string,
  candidateId: string,
  now: Date,
): Promise<{
  readonly application: ReturnType<typeof applyAudioAlignmentCandidate>;
  readonly planHash: string | null;
  readonly project: VideoProjectV1;
}> {
  const reference = analysisProject.analyses.find(analysis => analysis.kind === "audio-alignment"
    && analysis.analysisId === analysisId
    && analysis.referencePlacementId === referencePlacementId
    && analysis.targetPlacementId === targetPlacementId);
  if (reference === undefined) throw new CliError("not-found", "Audio alignment reference is missing from the project.");
  const artifact = await loadAnalysisArtifact(project.fileSystem, reference.path);
  const analysis = AudioAlignmentAnalysisV1Schema.parse(artifact);
  if (analysis.analysisId !== reference.analysisId) {
    throw new CliError("invalid-data", `Alignment sidecar does not match ${reference.analysisId}.`);
  }
  if (sha256Hex(`${canonicalJson(analysis)}\n`) !== reference.sha256) {
    throw new CliError("invalid-data", `Alignment analysis ${reference.analysisId} failed its integrity check.`);
  }
  const referencePlacement = analysisProject.placements.find(placement => placement.placementId === referencePlacementId);
  const targetPlacement = analysisProject.placements.find(placement => placement.placementId === targetPlacementId);
  if (referencePlacement === undefined || targetPlacement === undefined) {
    throw new CliError("not-found", "Alignment placement is missing from the current project.");
  }
  if (referencePlacement.placementId === targetPlacement.placementId) {
    throw new CliError("conflict", "Alignment reference and target must use different project placements.");
  }
  const currentReference = resolveAudioAnalysisSubject(
    analysisProject,
    `${analysis.reference.assetId}:${analysis.reference.streamId}`,
  );
  const currentTarget = resolveAudioAnalysisSubject(
    analysisProject,
    `${analysis.target.assetId}:${analysis.target.streamId}`,
  );
  if (
    referencePlacement.assetId !== analysis.reference.assetId
    || targetPlacement.assetId !== analysis.target.assetId
    || currentReference.subject.integritySha256 !== analysis.reference.integritySha256
    || currentTarget.subject.integritySha256 !== analysis.target.integritySha256
    || alignmentInputDigest({
      config: analysis.config,
      reference: currentReference.subject,
      referencePlacement,
      target: currentTarget.subject,
      targetPlacement,
    }) !== analysis.inputDigest
  ) {
    throw new CliError("conflict", `Alignment analysis ${reference.analysisId} is stale for the current project inputs.`);
  }
  const application = applyAudioAlignmentCandidate({
    analysis,
    candidateId: AlignmentCandidateIdSchema.parse(candidateId),
    expectedReferenceSyncSha256: hashPlacementSync(referencePlacement),
    referencePlacement,
    targetAssetId: targetPlacement.assetId,
    targetAssetRange: targetPlacement.assetRange,
  });
  if (application.status === "rejected") return { application, planHash: null, project: analysisProject };
  const timestamp = now.toISOString();
  const placements = analysisProject.placements.map(placement => placement.placementId === targetPlacement.placementId
    ? { ...placement, assetRange: application.appliedAssetRange, sync: application.sync }
    : placement);
  const durationUs = Math.max(...placements.map(placement => placement.sync.anchors.at(-1)!.projectTimeUs));
  const nextProject = VideoProjectV1Schema.parse({
    ...analysisProject,
    placements,
    timeline: { durationUs, timebase: "microseconds" },
    updatedAt: timestamp,
  });
  const priorPlan = await loadCurrentProjectPlan(project);
  const nextPlan = rebaseProjectEditPlan(project.project, nextProject, priorPlan, timestamp);
  const persisted = await commitProjectStateTransaction({
    after: { plan: nextPlan, project: nextProject },
    before: { plan: priorPlan, project: analysisProject },
    fileSystem: project.fileSystem,
  });
  return {
    application,
    planHash: hashProjectEditPlan(persisted.plan),
    project: persisted.project,
  };
}

async function handleAlignAnalyze(
  context: CommandContext,
  command: Extract<CliCommand, { readonly kind: "align-analyze" }>,
): Promise<void> {
  const project = await openProject(context.paths.projectRoot, command.project);
  const reference = resolveAudioAnalysisSubject(project.project, command.reference);
  const target = resolveAudioAnalysisSubject(project.project, command.target);
  const referencePlacement = projectPlacement(project, reference.asset.assetId, command.referencePlacement, "reference");
  const targetPlacement = projectPlacement(project, target.asset.assetId, command.targetPlacement, "target");
  if (referencePlacement.placementId === targetPlacement.placementId) {
    throw new CliError(
      "conflict",
      "Alignment reference and target must use different placements because synchronization is placement-wide.",
    );
  }
  const ffmpeg = await requireRequestedCapability(context, "ffmpeg");
  const timestamp = context.io.now().toISOString();
  const analysisId = `analysis_${randomUUID().replaceAll("-", "")}`;
  const config = {
    analysisSampleRateHz: 8_000,
    maxDriftPpm: 5_000,
    minimumOverlapUs: 3_000_000,
    windowUs: 10_000_000,
  } as const;
  const analysis = await withAlignmentEnvelopes({
    ffmpeg,
    projectDirectory: project.directory.path,
    reference: reference.stream,
    repositoryRoot: context.paths.repositoryRoot,
    runner: context.runner,
    target: target.stream,
  }, (referenceEnvelope, targetEnvelope) => analyzeAudioAlignment({
    analysisId,
    config,
    createdAt: timestamp,
    inputDigest: alignmentInputDigest({
      config,
      reference: reference.subject,
      referencePlacement,
      target: target.subject,
      targetPlacement,
    }),
    ...(command.maxOffset === undefined ? {} : { options: { maxOffsetUs: parseCliTime(command.maxOffset) } }),
    reference: reference.subject,
    referenceEnvelope,
    target: target.subject,
    targetEnvelope,
    tool: { name: "atet-audio-aligner", profile: "envelope-correlation-v1", version: ATET_VERSION },
  }));
  const analysisPath = projectAnalysisPath("alignment", analysis.analysisId);
  await saveAnalysisArtifact(project.fileSystem, analysis, analysisPath);
  const firstCandidate = analysis.result.status === "no-match" ? undefined : analysis.result.candidates[0];
  const analysisProject = canonicalAtetPersistenceDocument(VideoProjectV1Schema.parse({
    ...project.project,
    analyses: [
      ...project.project.analyses.filter(existing => existing.analysisId !== analysis.analysisId),
      {
        analysisId: analysis.analysisId,
        confidence: firstCandidate?.confidence ?? 0,
        createdAt: timestamp,
        driftPpm: firstCandidate?.driftPpm ?? 0,
        kind: "audio-alignment",
        path: analysisPath,
        referencePlacementId: referencePlacement.placementId,
        sha256: sha256Hex(`${canonicalJson(analysis)}\n`),
        targetPlacementId: targetPlacement.placementId,
      },
    ],
    updatedAt: timestamp,
  }));
  await saveVideoProject(project.fileSystem, analysisProject);

  let application: Awaited<ReturnType<typeof persistAppliedAlignment>> | null = null;
  if (command.apply) {
    const selected = command.candidate === undefined
      ? analysis.result.status === "matched"
        ? analysis.result.candidates.find(candidate => candidate.autoApplicable)
        : undefined
      : analysis.result.status === "no-match"
        ? undefined
        : analysis.result.candidates.find(candidate => candidate.candidateId === command.candidate);
    if (selected === undefined) {
      throw new CliError(
        "conflict",
        "No safely auto-applicable alignment candidate exists; inspect the analysis and apply an explicit candidate.",
      );
    }
    application = await persistAppliedAlignment(
      project,
      analysisProject,
      analysis.analysisId,
      referencePlacement.placementId,
      targetPlacement.placementId,
      selected.candidateId,
      context.io.now(),
    );
  }
  const output = {
    analysis,
    analysisPath,
    application,
    projectId: project.project.projectId,
  };
  writeValue(context.io, command.json, output, () => {
    const candidates = analysis.result.status === "no-match" ? 0 : analysis.result.candidates.length;
    return `alignment ${analysis.analysisId} ${analysis.result.status} candidates=${candidates}${application === null ? "" : ` apply=${application.application.status}`}`;
  });
}

async function handleAlignApply(
  context: CommandContext,
  command: Extract<CliCommand, { readonly kind: "align-apply" }>,
): Promise<void> {
  const project = await openProject(context.paths.projectRoot, command.project);
  const referenceValue = project.project.analyses.find(analysis => analysis.analysisId === command.analysis);
  if (referenceValue?.kind !== "audio-alignment") {
    throw new CliError("not-found", `Unknown alignment analysis: ${command.analysis}`);
  }
  const reference = referenceValue;
  const referencePlacementId = command.referencePlacement ?? reference.referencePlacementId;
  const targetPlacementId = command.targetPlacement ?? reference.targetPlacementId;
  const result = await persistAppliedAlignment(
    project,
    project.project,
    reference.analysisId,
    referencePlacementId,
    targetPlacementId,
    command.candidate,
    context.io.now(),
  );
  if (result.application.status === "rejected") {
    throw new CliError("conflict", `Alignment candidate was rejected: ${result.application.reason}`, result.application);
  }
  writeValue(context.io, command.json, result, () => (
    `aligned ${targetPlacementId} with ${command.candidate}; plan=${result.planHash}`
  ));
}

async function configuredSceneProvider(
  context: CommandContext,
): Promise<SceneDescriptionProvider> {
  try {
    return context.sceneProviderFactory({
      credential: loadGatewayCredential(context.io.env),
      fetch: context.fetch,
    });
  } catch (error) {
    throw gatewayCliError(error);
  }
}

async function handleFaceAnalysis(
  context: CommandContext,
  command: Extract<CliCommand, { readonly kind: "analyze-faces" }>,
): Promise<void> {
  const project = await openProject(context.paths.projectRoot, command.project);
  const capabilities = await requestedCapabilities(
    context,
    ["face-analyzer", "ffprobe"],
  );
  const faceAnalyzer = requireCapability(capabilities, "face-analyzer");
  const ffprobe = requireCapability(capabilities, "ffprobe");
  const sampleIntervalUs = Math.max(1, Math.round(1_000_000 / command.sampleFps));
  const maximumGapUs = parseCliTime(command.maxTrackGap);
  if (maximumGapUs < sampleIntervalUs) {
    throw new CliError(
      "usage",
      "--max-track-gap must span at least one face-analysis sample interval.",
    );
  }
  const persisted = await analyzeAndPersistProjectFaces({
    config: {
      sampleIntervalUs,
      tracking: {
        ...DEFAULT_FACE_ANALYSIS_CONFIG.tracking,
        maximumFacesPerFrame: command.maxFaces,
        maximumGapUs,
        minimumConfidence: command.minConfidence,
      },
    },
    faceAnalyzer,
    ffprobe,
    now: context.io.now(),
    project,
    repositoryRoot: context.paths.repositoryRoot,
    runner: context.runner,
    source: command.source,
  });
  const output = {
    analysisId: persisted.analysis.analysisId,
    analyzedFrames: persisted.analysis.coverage.analyzedFrames,
    backend: persisted.analysis.backend,
    localOnly: true,
    path: persisted.analysisPath,
    privacy: persisted.analysis.privacy,
    source: command.source,
    tracks: persisted.analysis.tracks.length,
  };
  writeValue(context.io, command.json, output, () => (
    `face analysis ${output.analysisId}; frames=${output.analyzedFrames} tracks=${output.tracks} local-only`
  ));
}

async function handleFacesList(
  context: CommandContext,
  command: Extract<CliCommand, { readonly kind: "faces-list" }>,
): Promise<void> {
  const project = await openProject(context.paths.projectRoot, command.project);
  const loaded = await loadVerifiedProjectFaceAnalysis({
    analysisId: command.analysis,
    project,
  });
  const list = listFaceTrackSummaries({
    analysis: loaded.analysis,
    ...(command.at === undefined ? {} : { atUs: parseCliTime(command.at) }),
    limit: command.limit,
    minimumConfidence: command.minConfidence,
    minimumDurationUs: parseCliTime(command.minDuration),
  });
  writeValue(context.io, command.json, list, () => (
    list.tracks.length === 0
      ? `No matching face tracks in ${list.analysisId}.`
      : list.tracks.map(track => [
          track.trackId,
          `visible=${humanTime(track.visibleDurationUs)}`,
          `observations=${track.observationCount}`,
          `confidence=${track.meanConfidence.toFixed(3)}`,
          `mean-area=${track.meanArea.toFixed(5)}`,
          ...(track.sample === null
            ? []
            : [
                `at=${humanTime(track.sample.assetTimeUs)}`,
                `rect=${track.sample.rect.x.toFixed(4)},${track.sample.rect.y.toFixed(4)},${
                  track.sample.rect.width.toFixed(4)
                },${track.sample.rect.height.toFixed(4)}`,
              ]),
        ].join(" ")).join("\n")
  ));
}

async function handleSceneAnalysis(
  context: CommandContext,
  command: Extract<CliCommand, { readonly kind: "analyze-scenes" }>,
): Promise<void> {
  const project = await openProject(context.paths.projectRoot, command.project);
  const ffmpeg = await requireRequestedCapability(context, "ffmpeg");
  const maximumSceneDurationUs = parseCliTime(command.maximumSceneDuration);
  if (maximumSceneDurationUs < 1_000_000) {
    throw new CliError("usage", "--max-scene-duration must be at least one second.");
  }
  const timestamp = context.io.now().toISOString();
  const provider = command.execute
    ? await configuredSceneProvider(context)
    : undefined;
  const result = await analyzeProjectScenes({
    acknowledgedAt: timestamp,
    analysisId: `analysis_${randomUUID().replaceAll("-", "")}`,
    createdAt: timestamp,
    execute: command.execute,
    ffmpeg,
    maximumSceneDurationUs,
    model: command.model,
    project: project.project,
    projectDirectory: project.directory.path,
    ...(provider === undefined ? {} : { provider }),
    repositoryRoot: context.paths.repositoryRoot,
    runner: context.runner,
    sceneThreshold: command.sceneThreshold,
    source: command.source,
  });
  if (result.kind === "planned") {
    const output = {
      boundariesAndMaximumGapScenes: result.plan.scenes.length,
      cloudUpload: false,
      planDigest: result.plan.planDigest,
      samples: result.plan.samples.length,
      source: command.source,
    };
    writeValue(context.io, command.json, output, () => (
      `scene plan ${result.plan.planDigest}; scenes=${result.plan.scenes.length} samples=${result.plan.samples.length}; no frames uploaded`
    ));
    return;
  }
  const analysisPath = projectAnalysisPath("scenes", result.analysis.analysisId);
  await saveAnalysisArtifact(project.fileSystem, result.analysis, analysisPath);
  const subject = result.analysis.subjects[0]!;
  const reference = {
    analysisId: result.analysis.analysisId,
    assetId: subject.assetId,
    createdAt: result.analysis.createdAt,
    kind: "scenes" as const,
    model: result.analysis.model.resolvedModel ?? result.analysis.model.requestedModel,
    path: analysisPath,
    sceneCount: result.analysis.scenes.length,
    sha256: sha256Hex(`${canonicalJson(result.analysis)}\n`),
    streamIds: result.analysis.subjects.map(item => item.streamId),
  };
  const nextProject = canonicalAtetPersistenceDocument(VideoProjectV1Schema.parse({
    ...project.project,
    analyses: [
      ...project.project.analyses.filter(existing => existing.analysisId !== reference.analysisId),
      reference,
    ],
    updatedAt: timestamp,
  }));
  await saveVideoProject(project.fileSystem, nextProject);
  const failed = result.analysis.batches.filter(batch => batch.state === "failed" || batch.state === "ambiguous");
  const output = {
    analysisId: result.analysis.analysisId,
    failedBatches: failed.length,
    path: analysisPath,
    samples: result.analysis.samples.length,
    scenes: result.analysis.scenes.length,
    usage: result.analysis.usage,
  };
  writeValue(context.io, command.json, output, () => (
    `scene analysis ${output.analysisId}; scenes=${output.scenes} samples=${output.samples} failed-batches=${output.failedBatches}`
  ));
}

async function handleMusicAnalysis(
  context: CommandContext,
  command: Extract<CliCommand, { readonly kind: "analyze-music" }>,
): Promise<void> {
  const project = await openProject(context.paths.projectRoot, command.project);
  const ffmpeg = await requireRequestedCapability(context, "ffmpeg");
  const tempoWindowUs = parseCliTime(command.window);
  if (tempoWindowUs < 2_000_000) throw new CliError("usage", "Music analysis --window must be at least two seconds.");
  const persisted = await analyzeAndPersistProjectMusic({
    config: { ...DEFAULT_MUSIC_ANALYSIS_CONFIG, tempoWindowUs },
    ffmpeg,
    now: context.io.now(),
    project,
    repositoryRoot: context.paths.repositoryRoot,
    runner: context.runner,
    source: command.source,
    toolVersion: ATET_VERSION,
  });
  const tempoChanges = persisted.analysis.tempoRegions.filter(region => region.changeFromPrevious !== null).length;
  const keyChanges = persisted.analysis.keyRegions.filter(region => region.changeConfidence !== null).length;
  const output = {
    analysisId: persisted.analysis.analysisId,
    keyChanges,
    keyRegions: persisted.analysis.keyRegions.length,
    musicRegions: persisted.analysis.musicRegions.length,
    path: persisted.analysisPath,
    tempoChanges,
    tempoRegions: persisted.analysis.tempoRegions.length,
  };
  writeValue(context.io, command.json, output, () => (
    `music analysis ${output.analysisId}; music=${output.musicRegions} tempo=${output.tempoRegions} changes=${output.tempoChanges} keys=${output.keyRegions}`
  ));
}

function firstNonemptyLine(value: string): string | undefined {
  return value.split(/\r?\n/u).map(line => line.trim()).find(line => line !== "")?.slice(0, 128);
}

async function handleSpeechAnalysis(
  context: CommandContext,
  command: Extract<CliCommand, { readonly kind: "analyze-speech" }>,
): Promise<void> {
  const project = await openProject(context.paths.projectRoot, command.project);
  const ffmpeg = await requireRequestedCapability(context, "ffmpeg");
  const configuredExecutable = command.whisper
    ?? renamedEnvironmentValue(context.io.env, "ATET_WHISPER_CPP");
  const executable = configuredExecutable
    ?? await requireRequestedCapability(context, "whisper-cpp");
  const modelPathInput = command.model
    ?? renamedEnvironmentValue(context.io.env, "ATET_WHISPER_MODEL");
  if (modelPathInput === undefined) {
    throw new CliError("usage", "Speech analysis requires --model <whisper-model-path> or ATET_WHISPER_MODEL.");
  }
  let modelPath: string;
  try {
    modelPath = await realpath(modelPathInput);
    const details = await lstat(modelPath);
    if (!details.isFile() || details.isSymbolicLink() || details.size <= 0) {
      throw new Error("not a physical nonempty file");
    }
  } catch {
    throw new CliError("not-found", `Whisper model is not a physical nonempty file: ${modelPathInput}`);
  }
  const probe = await context.runner.run([executable, "--help"], { maxOutputBytes: 64_000 });
  if (probe.exitCode !== 0) {
    throw new CliError("unavailable", `whisper.cpp is unavailable: ${probe.stderr.trim().slice(-2_000) || `exit ${probe.exitCode}`}`);
  }
  const version = firstNonemptyLine(probe.stdout) ?? firstNonemptyLine(probe.stderr) ?? "whisper.cpp (version unavailable)";
  const result = await runLocalSpeechAnalysis({
    config: {
      language: command.language,
      minimumFillerConfidence: command.minimumFillerConfidence,
      processors: command.processors,
      speechHandleUs: parseCliTime(command.speechHandle),
      threads: command.threads,
      useGpu: !command.noGpu,
    },
    ffmpeg,
    fileSystem: project.fileSystem,
    now: context.io.now(),
    project: project.project,
    projectDirectory: project.directory.path,
    repositoryRoot: context.paths.repositoryRoot,
    runner: context.runner,
    runtime: { executable, modelPath, version },
    source: command.source,
    useLatestMusicAnalysis: command.protectMusic,
  });
  await persistSpeechAnalysis({
    fileSystem: project.fileSystem,
    project: project.project,
    result,
    updatedAt: context.io.now(),
  });
  const transcribed = result.analysis.result.status === "transcribed" ? result.analysis.result : null;
  const output = {
    analysisId: result.analysis.analysisId,
    autoApplicableFillers: transcribed?.fillers.filter(filler => filler.autoApplicable).length ?? 0,
    fillers: transcribed?.fillers.length ?? 0,
    musicAnalysisId: result.musicAnalysisId,
    path: result.analysisPath,
    status: result.analysis.result.status,
    words: transcribed?.words.length ?? 0,
  };
  writeValue(context.io, command.json, output, () => (
    `speech analysis ${output.analysisId}; status=${output.status} words=${output.words} fillers=${output.fillers} auto=${output.autoApplicableFillers}`
  ));
}

async function loadSpeechAnalysisForProject(
  project: Awaited<ReturnType<typeof openProject>>,
  analysisId: string,
) {
  const reference = project.project.analyses.find((candidate): candidate is Extract<
    VideoProjectV1["analyses"][number],
    { readonly kind: "speech" }
  > => candidate.kind === "speech" && candidate.analysisId === analysisId);
  if (reference === undefined) throw new CliError("not-found", `Unknown speech analysis: ${analysisId}`);
  return { artifact: await loadSpeechReferenceForProject(project, reference), reference };
}

async function loadSpeechReferenceForProject(
  project: Awaited<ReturnType<typeof openProject>>,
  reference: Extract<VideoProjectV1["analyses"][number], { readonly kind: "speech" }>,
) {
  const artifact = await loadAnalysisArtifact(project.fileSystem, reference.path);
  if (
    (artifact.kind !== "atet.speech-analysis"
      && artifact.kind !== "studio.speech-analysis")
    || artifact.analysisId !== reference.analysisId
  ) {
    throw new CliError("invalid-data", `Speech analysis sidecar does not match ${reference.analysisId}.`);
  }
  if (sha256Hex(`${canonicalJson(artifact)}\n`) !== reference.sha256) {
    throw new CliError("invalid-data", `Speech analysis ${reference.analysisId} failed its integrity check.`);
  }
  const current = resolveAudioAnalysisSubject(
    project.project,
    `${reference.assetId}:${reference.streamId}`,
  );
  if (
    artifact.subject.assetId !== current.subject.assetId
    || artifact.subject.streamId !== current.subject.streamId
    || artifact.subject.integritySha256 !== current.subject.integritySha256
    || artifact.durationUs !== current.asset.durationUs
  ) {
    throw new CliError("conflict", `Speech analysis ${reference.analysisId} is stale or incomplete for the current audio stream.`);
  }
  const wordCount = artifact.result.status === "transcribed" ? artifact.result.words.length : 0;
  const fillerCount = artifact.result.status === "transcribed" ? artifact.result.fillers.length : 0;
  if (reference.wordCount !== wordCount || reference.fillerCount !== fillerCount) {
    throw new CliError("invalid-data", `Speech analysis reference ${reference.analysisId} does not match its artifact counts.`);
  }
  return artifact;
}

async function assertOtherAudibleStreamsSpeechSafe(
  project: OpenProject,
  source: {
    readonly assetId: string;
    readonly placementId: string;
    readonly streamId: string;
  },
  projectRange: { readonly endUs: number; readonly startUs: number },
): Promise<void> {
  const missing: string[] = [];
  const overlaps: Array<{
    readonly analysisId: string;
    readonly placementId: string;
    readonly projectRange: { readonly endUs: number; readonly startUs: number };
    readonly streamId: string;
    readonly word: string;
  }> = [];
  for (const placement of project.project.placements) {
    if (!placement.enabled) continue;
    const asset = project.project.assets.find(candidate => candidate.assetId === placement.assetId);
    if (asset === undefined) throw new CliError("invalid-data", `Placement ${placement.placementId} has no asset.`);
    for (const configured of placement.audio) {
      if (!configured.presentation.enabled) continue;
      if (
        placement.placementId === source.placementId
        && asset.assetId === source.assetId
        && configured.streamId === source.streamId
      ) continue;
      const stream = asset.streams.find(candidate => candidate.streamId === configured.streamId);
      if (stream?.kind !== "audio") {
        throw new CliError("invalid-data", `Placement ${placement.placementId} has an invalid audio stream.`);
      }
      const reference = [...project.project.analyses]
        .filter((candidate): candidate is Extract<VideoProjectV1["analyses"][number], { readonly kind: "speech" }> => (
          candidate.kind === "speech"
          && candidate.assetId === asset.assetId
          && candidate.streamId === stream.streamId
        ))
        .sort((left, right) => right.createdAt.localeCompare(left.createdAt)
          || String(right.analysisId).localeCompare(String(left.analysisId)))[0];
      if (reference === undefined) {
        missing.push(`${placement.placementId}:${stream.streamId}`);
        continue;
      }
      const analysis = await loadSpeechReferenceForProject(project, reference);
      if (analysis.result.status !== "transcribed") continue;
      for (const word of analysis.result.words) {
        for (const mapped of mapAssetIntervalToProjectSlices(placement, word.range)) {
          if (mapped.project.startUs >= projectRange.endUs || mapped.project.endUs <= projectRange.startUs) continue;
          overlaps.push({
            analysisId: String(reference.analysisId),
            placementId: String(placement.placementId),
            projectRange: mapped.project,
            streamId: String(stream.streamId),
            word: word.text,
          });
        }
      }
    }
  }
  if (missing.length > 0) {
    throw new CliError(
      "conflict",
      `Speech protection is incomplete; analyze every other enabled audio stream before applying a global filler cut: ${missing.join(", ")}`,
      { missing },
    );
  }
  if (overlaps.length > 0) {
    throw new CliError(
      "conflict",
      "Global filler cut overlaps speech on another enabled audio stream.",
      { overlaps },
    );
  }
}

async function projectMusicProtectionRanges(
  project: OpenProject,
): Promise<readonly { readonly endUs: number; readonly startUs: number }[]> {
  const ranges: { endUs: number; startUs: number }[] = [];
  const missing: string[] = [];
  for (const placement of project.project.placements) {
    if (!placement.enabled) continue;
    const asset = project.project.assets.find(candidate => candidate.assetId === placement.assetId);
    if (asset === undefined) throw new CliError("invalid-data", `Placement ${placement.placementId} has no asset.`);
    for (const configured of placement.audio) {
      if (!configured.presentation.enabled) continue;
      const stream = asset.streams.find(candidate => candidate.streamId === configured.streamId);
      if (stream?.kind !== "audio") {
        throw new CliError("invalid-data", `Placement ${placement.placementId} has an invalid audio stream.`);
      }
      const current = resolveAudioAnalysisSubject(
        project.project,
        `${asset.assetId}:${stream.streamId}`,
      ).subject;
      const reference = [...project.project.analyses]
        .filter((candidate): candidate is Extract<VideoProjectV1["analyses"][number], { readonly kind: "music" }> => (
          candidate.kind === "music"
          && candidate.assetId === asset.assetId
          && candidate.streamId === stream.streamId
        ))
        .sort((left, right) => right.createdAt.localeCompare(left.createdAt)
          || String(right.analysisId).localeCompare(String(left.analysisId)))[0];
      if (reference === undefined) {
        missing.push(`${placement.placementId}:${stream.streamId}`);
        continue;
      }
      const value = await loadAnalysisArtifact(project.fileSystem, reference.path);
      if (
        value.kind !== "atet.music-analysis"
        && value.kind !== "studio.music-analysis"
      ) {
        throw new CliError("invalid-data", `Music sidecar does not match ${reference.analysisId}.`);
      }
      const analysis = MusicAnalysisV1Schema.parse(value);
      if (
        analysis.analysisId !== reference.analysisId
        || analysis.subject.assetId !== current.assetId
        || analysis.subject.streamId !== current.streamId
        || analysis.subject.integritySha256 !== current.integritySha256
      ) {
        throw new CliError("conflict", `Music analysis ${reference.analysisId} is stale for the current audio stream.`);
      }
      if (sha256Hex(`${canonicalJson(analysis)}\n`) !== reference.sha256) {
        throw new CliError("invalid-data", `Music analysis ${reference.analysisId} failed its integrity check.`);
      }
      assertCompleteMusicAnalysis(analysis, stream);
      for (const region of analysis.musicRegions) {
        ranges.push(...mapAssetIntervalToProjectSlices(placement, region.range).map(slice => ({
          endUs: slice.project.endUs,
          startUs: slice.project.startUs,
        })));
      }
    }
  }
  if (missing.length > 0) {
    throw new CliError(
      "conflict",
      `Music protection is incomplete; analyze every enabled audio stream before applying a global filler cut: ${missing.join(", ")}`,
      { missing },
    );
  }
  return unionIntervals(ranges);
}

async function verifyEnabledAudioMedia(
  project: OpenProject,
  repositoryRoot: string,
): Promise<void> {
  const files = new Map<string, { readonly bytes: number; readonly labels: string[]; readonly sha256: string }>();
  for (const placement of project.project.placements) {
    if (!placement.enabled) continue;
    const asset = project.project.assets.find(candidate => candidate.assetId === placement.assetId);
    if (asset === undefined) throw new CliError("invalid-data", `Placement ${placement.placementId} has no asset.`);
    for (const configured of placement.audio) {
      if (!configured.presentation.enabled) continue;
      const stream = asset.streams.find(candidate => candidate.streamId === configured.streamId);
      if (stream?.kind !== "audio") {
        throw new CliError("invalid-data", `Placement ${placement.placementId} has an invalid audio stream.`);
      }
      for (const segment of stream.segments) {
        const label = `${placement.placementId}:${stream.streamId}`;
        const prior = files.get(segment.path);
        if (prior !== undefined) {
          if (prior.bytes !== segment.bytes || prior.sha256 !== segment.sha256) {
            throw new CliError(
              "invalid-data",
              `Enabled audio streams disagree about recorded integrity for ${segment.path}.`,
            );
          }
          prior.labels.push(label);
          continue;
        }
        files.set(segment.path, {
          bytes: segment.bytes,
          labels: [label],
          sha256: segment.sha256,
        });
      }
    }
  }
  await mapBounded([...files.entries()], 2, async ([path, expected]) => {
    await resolveVerifiedProjectMedia({
      expected,
      label: `Enabled audio media ${expected.labels.join(", ")}`,
      path,
      repositoryRoot,
    });
  });
}

async function handleFillersList(
  context: CommandContext,
  command: Extract<CliCommand, { readonly kind: "fillers-list" }>,
): Promise<void> {
  const project = await openProject(context.paths.projectRoot, command.project);
  const { artifact } = await loadSpeechAnalysisForProject(project, command.analysis);
  const fillers = artifact.result.status === "transcribed"
    ? artifact.result.fillers.filter(filler => !command.autoOnly || filler.autoApplicable)
    : [];
  const output = { analysisId: artifact.analysisId, fillers };
  writeValue(context.io, command.json, output, () => fillers.length === 0
    ? "No matching filler candidates."
    : fillers.map(filler => (
      `${filler.candidateId}\t${humanTime(filler.range.startUs)}..${humanTime(filler.range.endUs)}\t${filler.classification}\tconfidence=${filler.confidence.toFixed(3)}\tauto=${filler.autoApplicable}`
    )).join("\n"));
}

async function handleFillersApply(
  context: CommandContext,
  command: Extract<CliCommand, { readonly kind: "fillers-apply" }>,
): Promise<void> {
  const project = await openProject(context.paths.projectRoot, command.project);
  assertVerifiedStructuralAutomationSync(project.project, "Automated global filler cuts");
  const { artifact, reference } = await loadSpeechAnalysisForProject(project, command.analysis);
  const placement = projectPlacement(project, reference.assetId, command.placement, "filler");
  const protectedProjectRanges = await projectMusicProtectionRanges(project);
  const projection = projectFillerCut({
    candidateId: command.candidate,
    decisionId: `decision_${randomUUID().replaceAll("-", "")}`,
    expectedPlacementSyncSha256: hashPlacementSync(placement),
    placement,
    projectMusicProtection: { complete: true, ranges: protectedProjectRanges },
    speech: artifact,
  });
  if (projection.status === "rejected") {
    throw new CliError("conflict", `Filler cut was rejected: ${projection.reason}`, projection);
  }
  await assertOtherAudibleStreamsSpeechSafe(project, {
    assetId: String(artifact.subject.assetId),
    placementId: String(placement.placementId),
    streamId: String(artifact.subject.streamId),
  }, projection.derivation.projectRange);
  // The sidecars bind expected digests, but a global cut must also prove those
  // bytes still exist immediately before mutating the shared project plan.
  await verifyEnabledAudioMedia(project, context.paths.repositoryRoot);
  const current = await loadCurrentProjectPlan(project);
  const timestamp = context.io.now().toISOString();
  const cut = cutProjectPlan(project.project, current, projection.derivation.projectRange, timestamp);
  const next = canonicalAtetPersistenceDocument(normalizeProjectEditPlan({
    ...cut,
    derivations: [...cut.derivations, projection.derivation],
    updatedAt: timestamp,
  }));
  await saveProjectEditPlan(project.fileSystem, next);
  const output = {
    candidateId: command.candidate,
    planHash: hashProjectEditPlan(next),
    projectRange: projection.derivation.projectRange,
  };
  writeValue(context.io, command.json, output, () => (
    `applied filler ${command.candidate}; cut=${humanTime(output.projectRange.startUs)}..${humanTime(output.projectRange.endUs)} plan=${output.planHash}`
  ));
}

interface PhysicalFileDigest {
  readonly bytes: number;
  readonly device: number;
  readonly inode: number;
  readonly modifiedAtMs: number;
  readonly sha256: string;
}

type LoadedGatewayFile =
  | Readonly<{
    readonly data: Uint8Array;
    readonly facts?: Readonly<{
      readonly durationSeconds?: number;
      readonly height?: number;
      readonly width?: number;
    }>;
    readonly mediaType: string;
    readonly path: string;
    readonly url?: never;
  }>
  | Readonly<{
    readonly data?: never;
    readonly facts?: never;
    readonly mediaType: string;
    readonly path?: never;
    readonly url: string;
  }>;

type LoadedGatewayPhysicalFile = Extract<
  LoadedGatewayFile,
  Readonly<{ readonly data: Uint8Array }>
>;

const MAXIMUM_LOCAL_EFFECT_INPUT_BYTES = 512 * 1024 * 1024 * 1024;
const MAXIMUM_LOCAL_EFFECT_DURATION_US = 24 * 60 * 60 * 1_000_000;
const MAXIMUM_LOCAL_EFFECT_PIXEL_COUNT = 67_108_864;
const MAXIMUM_LOCAL_EFFECT_DIMENSION = 16_384;
const MAXIMUM_LOCAL_EFFECT_FRAME_RATE = 240;
const MAXIMUM_LOCAL_EFFECT_AUDIO_CHANNELS = 32;
const MAXIMUM_LOCAL_EFFECT_SAMPLE_RATE = 384_000;

const GATEWAY_MEDIA_TYPE_BY_EXTENSION: Readonly<Record<string, string>> = {
  ".aac": "audio/aac",
  ".aif": "audio/aiff",
  ".aiff": "audio/aiff",
  ".avif": "image/avif",
  ".avi": "video/x-msvideo",
  ".bmp": "image/bmp",
  ".flac": "audio/flac",
  ".gif": "image/gif",
  ".jpeg": "image/jpeg",
  ".jpg": "image/jpeg",
  ".m4a": "audio/mp4",
  ".mkv": "video/x-matroska",
  ".mov": "video/quicktime",
  ".mp3": "audio/mpeg",
  ".mp4": "video/mp4",
  ".mpeg": "video/mpeg",
  ".mpg": "video/mpeg",
  ".oga": "audio/ogg",
  ".ogg": "audio/ogg",
  ".opus": "audio/opus",
  ".png": "image/png",
  ".tif": "image/tiff",
  ".tiff": "image/tiff",
  ".wav": "audio/wav",
  ".weba": "audio/webm",
  ".webm": "video/webm",
  ".webp": "image/webp",
};

async function readBoundedPhysicalBytes(
  path: string,
  maximumBytes: number,
  requirePrivate = false,
): Promise<Uint8Array> {
  const lexical = await lstat(path).catch((error: unknown) => {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      throw new CliError("not-found", `Input file does not exist: ${path}`);
    }
    throw error;
  });
  if (
    lexical.isSymbolicLink()
    || !lexical.isFile()
    || lexical.size <= 0
    || !Number.isSafeInteger(lexical.size)
    || (requirePrivate && (lexical.mode & 0o077) !== 0)
  ) {
    throw new CliError(
      "unsafe-path",
      requirePrivate
        ? `Sensitive input must be a private 0600 physical file: ${path}`
        : `Input must be a physical, nonempty regular file: ${path}`,
    );
  }
  if (lexical.size > maximumBytes) {
    throw new CliError("usage", `Input exceeds its ${maximumBytes}-byte local bound: ${path}`);
  }
  const handle = await open(
    path,
    constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0),
  ).catch((error: unknown) => {
    if (error instanceof Error && "code" in error && error.code === "ELOOP") {
      throw new CliError("unsafe-path", `Input must not be a symlink: ${path}`);
    }
    throw error;
  });
  try {
    const before = await handle.stat();
    if (
      !before.isFile()
      || before.dev !== lexical.dev
      || before.ino !== lexical.ino
      || before.size !== lexical.size
      || (requirePrivate && (before.mode & 0o077) !== 0)
    ) {
      throw new CliError("conflict", `Input changed while it was being opened: ${path}`);
    }
    const data = new Uint8Array(await handle.readFile());
    const after = await handle.stat();
    if (
      data.byteLength !== before.size
      || after.dev !== before.dev
      || after.ino !== before.ino
      || after.size !== before.size
      || after.mtimeMs !== before.mtimeMs
      || after.ctimeMs !== before.ctimeMs
      || (requirePrivate && (after.mode & 0o077) !== 0)
    ) {
      throw new CliError("conflict", `Input changed while it was being read: ${path}`);
    }
    return data;
  } finally {
    await handle.close();
  }
}

async function loadGatewayMediaFile(
  cwd: string,
  pathInput: string,
  maximumBytes: number,
  allowedPrefixes: readonly string[],
): Promise<LoadedGatewayFile> {
  const normalizedPathInput = pathInput.toLocaleLowerCase("en-US");
  const explicitRemoteSeparator = normalizedPathInput.indexOf("=https://");
  const explicitRemoteMediaType = explicitRemoteSeparator < 1
    ? undefined
    : pathInput.slice(0, explicitRemoteSeparator);
  const remoteValue = normalizedPathInput.startsWith("https://")
    ? pathInput
    : explicitRemoteMediaType === undefined
      ? undefined
      : pathInput.slice(explicitRemoteSeparator + 1);
  if (remoteValue !== undefined) {
    let url: URL;
    try {
      url = new URL(remoteValue);
    } catch {
      throw new CliError(
        "usage",
        "Remote media input must be a valid HTTPS URL.",
      );
    }
    if (
      url.protocol !== "https:"
      || url.username !== ""
      || url.password !== ""
      || url.hash !== ""
    ) {
      throw new CliError(
        "usage",
        "Remote media input must be credential-free HTTPS without a fragment.",
      );
    }
    const inferredMediaType = GATEWAY_MEDIA_TYPE_BY_EXTENSION[
      extname(url.pathname).toLocaleLowerCase("en-US")
    ];
    const mediaType = explicitRemoteMediaType?.toLocaleLowerCase("en-US")
      ?? inferredMediaType;
    if (
      mediaType === undefined
      || !/^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/iu.test(mediaType)
      || !allowedPrefixes.some(prefix => mediaType.startsWith(prefix))
    ) {
      throw new CliError(
        "usage",
        "Remote media type is unsupported or ambiguous; use <media-type>=<https-url>.",
      );
    }
    return {
      mediaType,
      url: url.href,
    };
  }
  if (
    pathInput.includes("://")
    || /^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*=http:/iu
      .test(pathInput)
  ) {
    throw new CliError("usage", "Remote media input must use HTTPS.");
  }
  const path = resolve(cwd, pathInput);
  const mediaType = GATEWAY_MEDIA_TYPE_BY_EXTENSION[
    extname(path).toLocaleLowerCase("en-US")
  ];
  if (
    mediaType === undefined
    || !allowedPrefixes.some(prefix => mediaType.startsWith(prefix))
  ) {
    throw new CliError(
      "usage",
      `Unsupported media extension for ${pathInput}; expected ${allowedPrefixes.join(" or ")} input.`,
    );
  }
  const data = await readBoundedPhysicalBytes(path, maximumBytes);
  if (!gatewayMediaBytesMatchType(data, mediaType)) {
    throw new CliError(
      "invalid-data",
      `Media bytes do not match ${mediaType}: ${pathInput}`,
    );
  }
  return {
    data,
    mediaType,
    path,
  };
}

async function loadGatewayMediaFiles(
  cwd: string,
  paths: readonly string[],
  options: Readonly<{
    allowedPrefixes: readonly string[];
    maximumFileBytes: number;
    maximumTotalBytes: number;
  }>,
): Promise<readonly LoadedGatewayFile[]> {
  const loaded: LoadedGatewayFile[] = [];
  let totalBytes = 0;
  for (const path of paths) {
    const remainingBytes = options.maximumTotalBytes - totalBytes;
    if (remainingBytes < 1) {
      throw new CliError(
        "usage",
        `Gateway media inputs exceed their ${options.maximumTotalBytes}-byte aggregate bound.`,
      );
    }
    const file = await loadGatewayMediaFile(
      cwd,
      path,
      Math.min(options.maximumFileBytes, remainingBytes),
      options.allowedPrefixes,
    );
    totalBytes += file.data?.byteLength ?? 0;
    loaded.push(file);
  }
  return loaded;
}

function gatewayProbeDuration(value: unknown): number | undefined {
  if (typeof value !== "string" && typeof value !== "number") return undefined;
  const duration = Number(value);
  return Number.isFinite(duration) && duration > 0
    ? duration
    : undefined;
}

function gatewayProbePositiveInteger(
  value: unknown,
  maximum: number,
): number | undefined {
  const parsed = typeof value === "string" ? Number(value) : value;
  return (
    typeof parsed === "number"
    && Number.isSafeInteger(parsed)
    && parsed > 0
    && parsed <= maximum
  )
    ? parsed
    : undefined;
}

function gatewayProbeFrameRate(value: unknown): number | undefined {
  if (typeof value !== "string") return undefined;
  const match = /^(\d+)\/([1-9]\d*)$/u.exec(value);
  if (match === null) return undefined;
  const numerator = Number(match[1]);
  const denominator = Number(match[2]);
  const frameRate = numerator / denominator;
  return Number.isFinite(frameRate) && frameRate > 0
    ? frameRate
    : undefined;
}

async function inspectStagedGatewayMediaFile(
  context: CommandContext,
  file: LoadedGatewayPhysicalFile,
  inspectionPath: string,
  ffmpeg: string,
  ffprobe: string,
  signal?: AbortSignal,
): Promise<LoadedGatewayPhysicalFile> {
  const probe = await context.runner.run([
    ffprobe,
    "-hide_banner",
    "-v", "error",
    "-threads", "1",
    ...SELF_CONTAINED_MEDIA_INPUT_ARGUMENTS,
    "-show_entries",
    "format=duration:stream=codec_type,width,height,duration,channels,sample_rate,avg_frame_rate,r_frame_rate",
    "-of", "json",
    inspectionPath,
  ], {
    ...(signal === undefined ? {} : { abortSignal: signal }),
    maxOutputBytes: 1_000_000,
    timeoutMs: 2 * 60_000,
  });
  if (probe.exitCode !== 0) {
    throw new CliError(
      "invalid-data",
      `FFprobe could not validate Gateway media input: ${file.path}`,
    );
  }
  let value: unknown;
  try {
    value = JSON.parse(probe.stdout) as unknown;
  } catch {
    throw new CliError(
      "invalid-data",
      `FFprobe returned invalid Gateway media metadata: ${file.path}`,
    );
  }
  if (
    typeof value !== "object"
    || value === null
    || Array.isArray(value)
    || !("streams" in value)
    || !Array.isArray(value.streams)
    || value.streams.length < 1
    || value.streams.length > 64
  ) {
    throw new CliError(
      "invalid-data",
      `Gateway media input has no bounded decodable streams: ${file.path}`,
    );
  }
  const streams = value.streams.filter(
    (stream): stream is Record<string, unknown> => (
      typeof stream === "object"
      && stream !== null
      && !Array.isArray(stream)
    ),
  );
  if (streams.length !== value.streams.length) {
    throw new CliError(
      "invalid-data",
      `Gateway media input has malformed stream metadata: ${file.path}`,
    );
  }
  const format = "format" in value
    && typeof value.format === "object"
    && value.format !== null
    && !Array.isArray(value.format)
    ? value.format as Record<string, unknown>
    : {};
  const kind = file.mediaType.startsWith("image/")
    ? "image"
    : file.mediaType.startsWith("video/")
      ? "video"
      : "audio";
  const selected = kind === "audio"
    ? streams.find(stream => stream.codec_type === "audio")
    : streams.find(stream => stream.codec_type === "video");
  if (selected === undefined) {
    throw new CliError(
      "invalid-data",
      `Gateway ${kind} input does not contain a matching stream: ${file.path}`,
    );
  }
  const mediaStreams = streams.filter(
    stream => stream.codec_type === "audio" || stream.codec_type === "video",
  );
  if (mediaStreams.length > 8) {
    throw new CliError(
      "invalid-data",
      `Gateway media input exceeds its eight-stream local validation bound: ${file.path}`,
    );
  }
  let aggregatePixels = 0;
  for (const stream of mediaStreams) {
    if (stream.codec_type === "video") {
      const streamWidth = gatewayProbePositiveInteger(
        stream.width,
        MAXIMUM_LOCAL_EFFECT_DIMENSION,
      );
      const streamHeight = gatewayProbePositiveInteger(
        stream.height,
        MAXIMUM_LOCAL_EFFECT_DIMENSION,
      );
      if (
        streamWidth === undefined
        || streamHeight === undefined
        || streamWidth * streamHeight > MAXIMUM_LOCAL_EFFECT_PIXEL_COUNT
      ) {
        throw new CliError(
          "invalid-data",
          `Gateway visual input exceeds its safe dimension envelope: ${file.path}`,
        );
      }
      aggregatePixels += streamWidth * streamHeight;
      if (aggregatePixels > MAXIMUM_LOCAL_EFFECT_PIXEL_COUNT) {
        throw new CliError(
          "invalid-data",
          `Gateway visual input exceeds its aggregate pixel envelope: ${file.path}`,
        );
      }
      const frameRates = [
        gatewayProbeFrameRate(stream.avg_frame_rate),
        gatewayProbeFrameRate(stream.r_frame_rate),
      ].filter((rate): rate is number => rate !== undefined);
      if (
        frameRates.length > 0
        && Math.max(...frameRates) > MAXIMUM_LOCAL_EFFECT_FRAME_RATE
      ) {
        throw new CliError(
          "invalid-data",
          `Gateway visual input exceeds its frame-rate envelope: ${file.path}`,
        );
      }
    } else {
      if (
        gatewayProbePositiveInteger(
          stream.channels,
          MAXIMUM_LOCAL_EFFECT_AUDIO_CHANNELS,
        ) === undefined
        || gatewayProbePositiveInteger(
          stream.sample_rate,
          MAXIMUM_LOCAL_EFFECT_SAMPLE_RATE,
        ) === undefined
      ) {
        throw new CliError(
          "invalid-data",
          `Gateway audio input exceeds its safe channel or sample-rate envelope: ${file.path}`,
        );
      }
    }
  }
  const width = kind === "audio"
    ? undefined
    : gatewayProbePositiveInteger(
        selected.width,
        MAXIMUM_LOCAL_EFFECT_DIMENSION,
      );
  const height = kind === "audio"
    ? undefined
    : gatewayProbePositiveInteger(
        selected.height,
        MAXIMUM_LOCAL_EFFECT_DIMENSION,
      );
  const durationSeconds = kind === "image"
    ? undefined
    : gatewayProbeDuration(selected.duration)
      ?? gatewayProbeDuration(format.duration);
  if (
    kind !== "image"
    && (
      durationSeconds === undefined
      || durationSeconds * 1_000_000 > MAXIMUM_LOCAL_EFFECT_DURATION_US
    )
  ) {
    throw new CliError(
      "invalid-data",
      `Gateway ${kind} input has no duration inside its 24-hour local envelope: ${file.path}`,
    );
  }
  const decode = await context.runner.run([
    ffmpeg,
    "-hide_banner",
    "-nostdin",
    "-v", "error",
    "-xerror",
    ...SELF_CONTAINED_MEDIA_INPUT_ARGUMENTS,
    "-threads", "1",
    "-i", inspectionPath,
    "-map", "0:V?",
    "-map", "0:a?",
    "-sn",
    "-dn",
    "-f", "null",
    "-",
  ], {
    ...(signal === undefined ? {} : { abortSignal: signal }),
    maxOutputBytes: 1_000_000,
    timeoutMs: 10 * 60_000,
  });
  if (decode.exitCode !== 0) {
    throw new CliError(
      "invalid-data",
      `Gateway media input failed complete local decode validation: ${file.path}`,
    );
  }
  return {
    ...file,
    facts: {
      ...(durationSeconds === undefined ? {} : { durationSeconds }),
      ...(height === undefined ? {} : { height }),
      ...(width === undefined ? {} : { width }),
    },
  };
}

async function inspectGatewayMediaFile(
  context: CommandContext,
  file: LoadedGatewayPhysicalFile,
  ffmpeg: string,
  ffprobe: string,
  signal?: AbortSignal,
): Promise<LoadedGatewayPhysicalFile> {
  await ensurePrivateDirectory(context.paths.privateRoot);
  const inspectionDirectory = await ensurePhysicalPrivateDirectoryWithin(
    context.paths.privateRoot,
    join("gateway-input-inspection", randomUUID()),
  );
  const inspectionPath = join(
    inspectionDirectory,
    `input${extname(file.path).toLocaleLowerCase("en-US")}`,
  );
  try {
    const handle = await open(
      inspectionPath,
      constants.O_WRONLY
        | constants.O_CREAT
        | constants.O_EXCL
        | (constants.O_NOFOLLOW ?? 0),
      0o600,
    );
    try {
      await handle.writeFile(file.data);
      await handle.sync();
    } finally {
      await handle.close();
    }
    return await inspectStagedGatewayMediaFile(
      context,
      file,
      inspectionPath,
      ffmpeg,
      ffprobe,
      signal,
    );
  } finally {
    await rm(inspectionDirectory, { force: true, recursive: true });
  }
}

async function inspectGatewayMediaFiles(
  context: CommandContext,
  files: readonly LoadedGatewayFile[],
  signal?: AbortSignal,
): Promise<readonly LoadedGatewayFile[]> {
  if (files.length === 0) return files;
  if (files.every(file => file.url !== undefined)) return files;
  const hostClaims = physicalHostResourceClaims([
    { amount: 1, resource: "cpu" },
    { amount: 1, resource: "ffmpeg" },
    { amount: 1, resource: "local-io" },
  ], context.hostResourceCoordinator);
  const inspect = async (
    admittedContext: CommandContext,
  ): Promise<readonly LoadedGatewayFile[]> => {
      const [ffmpegCapability, ffprobeCapability] = await Promise.all([
        admittedContext.capability("ffmpeg", signal),
        admittedContext.capability("ffprobe", signal),
      ]);
      const ffmpeg = requireCapability([ffmpegCapability], "ffmpeg");
      const ffprobe = requireCapability([ffprobeCapability], "ffprobe");
      const inspected: LoadedGatewayFile[] = [];
      for (const file of files) {
        inspected.push(file.url === undefined
          ? await inspectGatewayMediaFile(
              admittedContext,
              file,
              ffmpeg,
              ffprobe,
              signal,
            )
          : file);
      }
      return inspected;
  };
  if (context.hostResourceLease !== undefined) {
    await context.hostResourceLease.assertOwned();
    if (hostResourceClaimsCover(context.hostResourceLease.claims, hostClaims)) {
      return await inspect(context);
    }
    // Cloud commands retain only their network/paid-call lease while waiting.
    // The coordinator admits this disjoint local phase atomically, and the
    // nested runner carries both kernel lease descriptors into FFmpeg.
    return await withHostResourceClaims(
      context,
      missingHostResourceClaims(context.hostResourceLease.claims, hostClaims),
      inspect,
      signal,
    );
  }
  return await withHostResourceClaims(context, hostClaims, inspect, signal);
}

function requiredGatewayMediaFile(
  files: readonly LoadedGatewayFile[],
  index: number,
): LoadedGatewayFile {
  const file = files[index];
  if (file === undefined) {
    throw new CliError(
      "internal",
      `Gateway input loader returned ${files.length} files; expected index ${index}.`,
    );
  }
  return file;
}

async function readGatewayTextFile(
  cwd: string,
  pathInput: string,
  maximumBytes = 512 * 1024,
  requirePrivate = false,
): Promise<string> {
  const bytes = await readBoundedPhysicalBytes(
    resolve(cwd, pathInput),
    maximumBytes,
    requirePrivate,
  );
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new CliError("invalid-data", `Text file is not valid UTF-8: ${pathInput}`);
  }
}

async function readGatewayProviderOptionsFile(
  cwd: string,
  pathInput: string | undefined,
): Promise<ReturnType<typeof parseGatewayProviderOptions> | undefined> {
  if (pathInput === undefined) return undefined;
  const source = await readGatewayTextFile(
    cwd,
    pathInput,
    64 * 1024,
    true,
  );
  let value: unknown;
  try {
    value = JSON.parse(source) as unknown;
  } catch {
    throw new CliError("invalid-data", `Provider options are not valid JSON: ${pathInput}`);
  }
  try {
    return parseGatewayProviderOptions(value);
  } catch (error) {
    if (error instanceof GatewayProviderOptionsError) {
      throw new CliError("usage", error.message);
    }
    throw error;
  }
}

async function digestPhysicalFile(path: string): Promise<PhysicalFileDigest> {
  const lexical = await lstat(path).catch((error: unknown) => {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      throw new CliError("not-found", `Media input does not exist: ${path}`);
    }
    throw error;
  });
  if (
    lexical.isSymbolicLink()
    || !lexical.isFile()
    || lexical.size <= 0
    || !Number.isSafeInteger(lexical.size)
  ) {
    throw new CliError("unsafe-path", `Media input must be a physical, nonempty regular file: ${path}`);
  }
  if (lexical.size > MAXIMUM_LOCAL_EFFECT_INPUT_BYTES) {
    throw new CliError(
      "usage",
      `Media input exceeds the ${MAXIMUM_LOCAL_EFFECT_INPUT_BYTES}-byte local-effects limit.`,
    );
  }
  const handle = await open(
    path,
    constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0),
  ).catch((error: unknown) => {
    if (error instanceof Error && "code" in error && error.code === "ELOOP") {
      throw new CliError("unsafe-path", `Media input must not be a symlink: ${path}`);
    }
    throw error;
  });
  try {
    const before = await handle.stat();
    if (
      !before.isFile()
      || before.dev !== lexical.dev
      || before.ino !== lexical.ino
      || before.size !== lexical.size
      || !Number.isSafeInteger(before.size)
    ) {
      throw new CliError("conflict", `Media input changed while it was being opened: ${path}`);
    }
    const hash = createHash("sha256");
    const buffer = Buffer.allocUnsafe(1024 * 1024);
    let offset = 0;
    while (offset < before.size) {
      const read = await handle.read(
        buffer,
        0,
        Math.min(buffer.byteLength, before.size - offset),
        offset,
      );
      if (read.bytesRead === 0) break;
      hash.update(buffer.subarray(0, read.bytesRead));
      offset += read.bytesRead;
    }
    const after = await handle.stat();
    if (
      offset !== before.size
      || after.dev !== before.dev
      || after.ino !== before.ino
      || after.size !== before.size
      || after.mtimeMs !== before.mtimeMs
      || after.ctimeMs !== before.ctimeMs
    ) {
      throw new CliError("conflict", `Media input changed while it was being hashed: ${path}`);
    }
    return {
      bytes: before.size,
      device: before.dev,
      inode: before.ino,
      modifiedAtMs: before.mtimeMs,
      sha256: hash.digest("hex"),
    };
  } finally {
    await handle.close();
  }
}

function positiveFrameRate(value: string | undefined): number | undefined {
  if (value === undefined || !/^\d+(?:\/\d+)?$/u.test(value)) {
    return undefined;
  }
  const [numeratorSource, denominatorSource = "1"] = value.split("/", 2);
  const numerator = Number(numeratorSource);
  const denominator = Number(denominatorSource);
  const result = numerator / denominator;
  return Number.isFinite(result) && result > 0 ? result : undefined;
}

function assertLocalEffectsProbeEnvelope(
  probe: Awaited<ReturnType<typeof probeProjectMedia>>,
): void {
  if (
    probe.durationUs > MAXIMUM_LOCAL_EFFECT_DURATION_US
    || probe.streams.length > 64
  ) {
    throw new CliError(
      "invalid-data",
      "Media exceeds the local-effects duration or stream-count limit.",
    );
  }
  for (const stream of probe.streams) {
    if (stream.codec_type === "audio") {
      const sampleRate = Number(stream.sample_rate);
      if (
        stream.channels === undefined
        || stream.channels > MAXIMUM_LOCAL_EFFECT_AUDIO_CHANNELS
        || !Number.isSafeInteger(sampleRate)
        || sampleRate > MAXIMUM_LOCAL_EFFECT_SAMPLE_RATE
      ) {
        throw new CliError(
          "invalid-data",
          "Audio stream exceeds the local-effects channel or sample-rate limit.",
        );
      }
      continue;
    }
    const frameRates = [
      positiveFrameRate(stream.avg_frame_rate),
      positiveFrameRate(stream.r_frame_rate),
    ].filter((value): value is number => value !== undefined);
    const frameRate = frameRates.length === 0
      ? undefined
      : Math.max(...frameRates);
    if (
      stream.width === undefined
      || stream.height === undefined
      || stream.width > MAXIMUM_LOCAL_EFFECT_DIMENSION
      || stream.height > MAXIMUM_LOCAL_EFFECT_DIMENSION
      || stream.width * stream.height > MAXIMUM_LOCAL_EFFECT_PIXEL_COUNT
      || frameRate === undefined
      || frameRate > MAXIMUM_LOCAL_EFFECT_FRAME_RATE
    ) {
      throw new CliError(
        "invalid-data",
        "Video stream exceeds the local-effects dimension, pixel-count, or frame-rate limit.",
      );
    }
  }
}

function assertLocalEffectsCoverage(
  source: Readonly<{ readonly assetRange: Readonly<{ readonly endUs: number; readonly startUs: number }> }>,
  outputProbe: Awaited<ReturnType<typeof probeProjectMedia>>,
  kind: "audio" | "video",
): number {
  assertLocalEffectsProbeEnvelope(outputProbe);
  const outputStream = outputProbe.streams.find(
    stream => stream.codec_type === kind,
  );
  if (outputStream === undefined) {
    throw new CliError(
      "invalid-data",
      `Derived media contains no ${kind} stream.`,
    );
  }
  const sourceDurationUs = source.assetRange.endUs - source.assetRange.startUs;
  const outputDurationUs = outputStream.assetRange.endUs
    - outputStream.assetRange.startUs;
  const toleranceUs = 250_000;
  if (outputDurationUs + toleranceUs < sourceDurationUs) {
    throw new CliError(
      "invalid-data",
      `Derived ${kind} coverage is shorter than the selected source stream.`,
    );
  }
  if (
    kind === "video"
    && outputDurationUs > sourceDurationUs + toleranceUs
  ) {
    throw new CliError(
      "invalid-data",
      "Derived video coverage exceeds the selected source stream.",
    );
  }
  if (
    kind === "audio"
    && outputDurationUs > sourceDurationUs + 31_000_000
  ) {
    throw new CliError(
      "invalid-data",
      "Derived audio exceeds the bounded delay/reverb tail.",
    );
  }
  return outputDurationUs;
}

function samePhysicalDigest(left: PhysicalFileDigest, right: PhysicalFileDigest): boolean {
  return left.bytes === right.bytes
    && left.device === right.device
    && left.inode === right.inode
    && left.modifiedAtMs === right.modifiedAtMs
    && left.sha256 === right.sha256;
}

type PhysicalIdentity = Pick<PhysicalFileDigest, "device" | "inode">;

async function generatedOutputIdentity(path: string): Promise<PhysicalIdentity> {
  const details = await lstat(path);
  if (details.isSymbolicLink() || !details.isFile() || details.nlink !== 1) {
    throw new CliError(
      "conflict",
      "Generated output changed before post-render verification.",
    );
  }
  return { device: details.dev, inode: details.ino };
}

async function removeGeneratedOutputIfSame(
  path: string,
  expected: PhysicalIdentity,
): Promise<void> {
  const details = await lstat(path).catch((error: unknown) => {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return undefined;
    }
    throw error;
  });
  if (
    details !== undefined
    && !details.isSymbolicLink()
    && details.isFile()
    && details.dev === expected.device
    && details.ino === expected.inode
  ) {
    await rm(path, { force: true });
  }
}

function shellArgument(value: string): string {
  return /^[A-Za-z0-9_./:@%+=,-]+$/u.test(value)
    ? value
    : `'${value.replaceAll("'", "'\"'\"'")}'`;
}

interface GeneratedOutputPaths {
  readonly outputPath: string;
  readonly receiptPath: string;
}

async function resolveGeneratedOutputPaths(
  paths: RepositoryPaths,
  category: string,
  requested: string | undefined,
  defaultExtension: string,
): Promise<GeneratedOutputPaths> {
  const generatedRoot = join(dirname(paths.artifactRoot), "generated");
  await ensurePrivateDirectory(generatedRoot);
  if (requested === undefined) {
    const jobDirectory = await ensurePhysicalPrivateDirectoryWithin(
      generatedRoot,
      `${category}/${category}_${randomUUID().replaceAll("-", "")}`,
    );
    return {
      outputPath: join(jobDirectory, `output${defaultExtension}`),
      receiptPath: join(jobDirectory, "receipt.json"),
    };
  }
  if (requested.trim() === "" || isAbsolute(requested)) {
    throw new CliError(
      "unsafe-path",
      `--output must be a nonempty path relative to ${displayPath(paths.repositoryRoot, generatedRoot)}.`,
    );
  }
  const outputPath = await resolveSafePath(generatedRoot, requested);
  const relativeParent = relative(generatedRoot, dirname(outputPath));
  if (relativeParent !== "") {
    await ensurePhysicalPrivateDirectoryWithin(generatedRoot, relativeParent);
  }
  return {
    outputPath,
    receiptPath: `${outputPath}.atet.json`,
  };
}

function audioOutputProfile(
  outputPath: string,
  inputVideoStreamIndex: number | undefined,
): Readonly<
  | { readonly kind: "audio-only"; readonly profile: "wav-pcm-s16le" | "flac" | "mp3" | "aac" | "opus" }
  | {
      readonly inputVideoStreamIndex: number;
      readonly kind: "preserve-video";
      readonly profile: "aac" | "opus";
      readonly videoStreamIndex: 0;
    }
> {
  const extension = extname(outputPath).toLocaleLowerCase("en-US");
  if (inputVideoStreamIndex !== undefined) {
    if ([".mp4", ".mov", ".m4v"].includes(extension)) {
      return {
        inputVideoStreamIndex,
        kind: "preserve-video",
        profile: "aac",
        videoStreamIndex: 0,
      };
    }
    if ([".mkv", ".webm"].includes(extension)) {
      return {
        inputVideoStreamIndex,
        kind: "preserve-video",
        profile: "opus",
        videoStreamIndex: 0,
      };
    }
    throw new CliError("usage", "Audio effects on video require an .mp4, .mov, .m4v, .mkv, or .webm output.");
  }
  if (extension === ".wav") return { kind: "audio-only", profile: "wav-pcm-s16le" };
  if (extension === ".flac") return { kind: "audio-only", profile: "flac" };
  if (extension === ".mp3") return { kind: "audio-only", profile: "mp3" };
  if ([".aac", ".m4a", ".mp4"].includes(extension)) return { kind: "audio-only", profile: "aac" };
  if ([".ogg", ".opus", ".webm"].includes(extension)) return { kind: "audio-only", profile: "opus" };
  throw new CliError("usage", "Audio-only effects require a .wav, .flac, .mp3, .aac, .m4a, .mp4, .ogg, .opus, or .webm output.");
}

function colorOutputProfile(outputPath: string): "h264-mp4" | "prores-mov" | "vp9-webm" {
  const extension = extname(outputPath).toLocaleLowerCase("en-US");
  if (extension === ".mp4") return "h264-mp4";
  if (extension === ".mov") return "prores-mov";
  if (extension === ".webm") return "vp9-webm";
  throw new CliError("usage", "Color-grade output must use .mp4, .mov, or .webm.");
}

async function publishGeneratedReceipt(
  paths: RepositoryPaths,
  receiptPath: string,
  receipt: unknown,
): Promise<void> {
  const generatedRoot = join(paths.repositoryRoot, "artifacts", "atet", "generated");
  if (!isWithin(generatedRoot, receiptPath) || receiptPath === generatedRoot) {
    throw new CliError("unsafe-path", "Generated receipt escaped the repository artifact boundary.");
  }
  const parent = dirname(receiptPath);
  const temporaryPath = join(
    parent,
    `.${basename(receiptPath)}.${randomUUID()}.tmp`,
  );
  let handle: Awaited<ReturnType<typeof open>> | null = null;
  try {
    handle = await open(
      temporaryPath,
      constants.O_CREAT
        | constants.O_EXCL
        | constants.O_WRONLY
        | (constants.O_NOFOLLOW ?? 0),
      0o600,
    );
    await handle.writeFile(`${canonicalJson(receipt)}\n`, "utf8");
    await handle.sync();
    await handle.close();
    handle = null;
    // A same-directory hard link is an atomic no-replace publication: an
    // existing file or symlink at the receipt path makes link(2) fail.
    await link(temporaryPath, receiptPath);
    await rm(temporaryPath, { force: true }).catch(() => undefined);
    const directoryHandle = await open(
      parent,
      constants.O_RDONLY | (constants.O_DIRECTORY ?? 0),
    );
    try {
      await directoryHandle.sync();
    } finally {
      await directoryHandle.close();
    }
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "EEXIST") {
      throw new CliError(
        "conflict",
        `Generated receipt already exists: ${receiptPath}`,
      );
    }
    throw error;
  } finally {
    await handle?.close().catch(() => undefined);
    await rm(temporaryPath, { force: true }).catch(() => undefined);
  }
}

async function assertFreshGeneratedReceiptDestination(
  inputPath: string,
  receiptPath: string,
): Promise<void> {
  if (resolve(inputPath) === resolve(receiptPath)) {
    throw new CliError(
      "unsafe-path",
      "Generated receipt must differ from the immutable media input.",
    );
  }
  try {
    await lstat(receiptPath);
    throw new CliError(
      "conflict",
      `Generated receipt already exists: ${receiptPath}`,
    );
  } catch (error) {
    if (error instanceof CliError) throw error;
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) {
      throw error;
    }
  }
}

function audioEffectsForCommand(
  command: Extract<CliCommand, { readonly kind: "media-audio" }>,
): readonly AudioEffect[] {
  const effects: AudioEffect[] = [];
  // Cleanup and dynamics run before level and time-based effects.
  if (command.denoise) {
    effects.push({
      kind: "denoise",
      noiseFloorDb: -50,
      noiseReductionDb: command.denoiseReductionDb,
      trackNoise: true,
    });
  }
  if (command.compressor) {
    effects.push({
      attackMs: command.compressorAttackMs,
      knee: 2.828,
      kind: "compressor",
      makeupGainDb: command.compressorMakeupDb,
      ratio: command.compressorRatio,
      releaseMs: command.compressorReleaseMs,
      thresholdDb: command.compressorThresholdDb,
    });
  }
  if (command.volumeDb !== undefined) {
    effects.push({ gainDb: command.volumeDb, kind: "volume" });
  }
  if (command.delayMs !== undefined) {
    effects.push({
      decay: command.delayFeedback,
      delayMs: command.delayMs,
      kind: "delay",
      mix: command.delayMix,
    });
  }
  if (command.reverb !== undefined) {
    effects.push({
      kind: "reverb",
      mix: command.reverbWet,
      preset: command.reverb === "room"
        ? "small-room"
        : command.reverb === "hall"
          ? "large-hall"
          : "plate",
    });
  }
  return effects;
}

function colorControlsForCommand(
  command: Extract<CliCommand, { readonly kind: "media-color" }>,
): ColorGradeControls {
  return {
    ...(command.brightness === undefined ? {} : { brightness: command.brightness }),
    ...(command.contrast === undefined ? {} : { contrast: command.contrast }),
    ...(command.gamma === undefined ? {} : { gamma: command.gamma }),
    ...(command.hueDegrees === undefined ? {} : { hue: command.hueDegrees }),
    ...(command.saturation === undefined ? {} : { saturation: command.saturation }),
    ...(command.temperature === undefined ? {} : { temperature: command.temperature }),
    ...(command.tint === undefined ? {} : { tint: command.tint }),
  };
}

function gatewayCatalogCache(context: CommandContext) {
  return createGatewayMediaCatalogCache({
    snapshotStore: createFileGatewayMediaCatalogSnapshotStore(
      join(context.paths.privateRoot, "gateway-media-catalog-v1.json"),
    ),
    transport: context.gatewayCatalogTransport,
  });
}

function gatewayCliError(error: unknown): CliError {
  if (error instanceof CliError) return error;
  if (error instanceof GatewayCredentialError) {
    return new CliError(
      error.code === "invalid" ? "invalid-data" : "unavailable",
      error.message,
    );
  }
  if (error instanceof GatewayMediaCatalogError) {
    return new CliError(
      error.code === "invalid-request"
        ? "usage"
        : error.code === "catalog-invalid"
          ? "invalid-data"
          : "unavailable",
      error.message,
    );
  }
  if (error instanceof GatewayMediaExecutionError) {
    const code = error.code === "model-not-found"
      ? "not-found"
      : error.code === "provider-failed" || error.code === "download-failed"
        ? "unavailable"
        : error.code === "invalid-response"
          ? "invalid-data"
          : "usage";
    return new CliError(
      code,
      error.message,
      error.reconciliation === undefined
        ? undefined
        : { gatewayReconciliation: error.reconciliation },
    );
  }
  if (error instanceof GatewayMediaArtifactError) {
    return new CliError(
      error.code === "unsafe-output"
        ? "unsafe-path"
        : error.code === "artifact-unavailable"
          ? "unavailable"
          : "invalid-data",
      error.message,
    );
  }
  if (error instanceof GatewayProviderOptionsError) {
    return new CliError("usage", error.message);
  }
  return asCliError(error);
}

async function withGatewayErrors<Result>(
  operation: () => Promise<Result>,
): Promise<Result> {
  try {
    return await operation();
  } catch (error) {
    throw gatewayCliError(error);
  }
}

async function catalogViewForCommand(
  context: CommandContext,
  refresh: boolean,
) {
  return await gatewayCatalogCache(context).get({
    forceRefresh: refresh,
    freshness: "allow-stale",
  });
}

async function handleAiModelsList(
  context: CommandContext,
  command: Extract<CliCommand, { readonly kind: "ai-models-list" }>,
): Promise<void> {
  await withGatewayErrors(async () => {
    const view = await catalogViewForCommand(context, command.refresh);
    const candidates = listGatewayMediaModels(view.snapshot, {
      ...(command.modelType === "all" ? {} : { kind: command.modelType }),
      limit: 500,
      ...(command.query === undefined ? {} : { query: command.query }),
    });
    const provider = command.provider?.toLocaleLowerCase("en-US");
    const models = candidates.filter(summary => {
      if (provider === undefined) return true;
      const model = inspectGatewayMediaModel(view.snapshot, summary.id);
      return model !== null && (
        model.ownedBy.toLocaleLowerCase("en-US") === provider
        || model.id.toLocaleLowerCase("en-US").startsWith(`${provider}/`)
      );
    }).slice(0, command.limit);
    const output = {
      catalog: {
        fetchedAt: view.snapshot.fetchedAt,
        snapshotId: view.snapshot.snapshotId,
        source: view.source,
        status: view.status,
        validatedAt: view.snapshot.validatedAt,
      },
      count: models.length,
      models,
    };
    writeValue(context.io, command.json, output, () => models.length === 0
      ? `No matching Gateway media models. catalog=${view.snapshot.snapshotId} ${view.status}`
      : [
          `catalog ${view.snapshot.snapshotId} ${view.status} source=${view.source}`,
          ...models.map(model => (
            `${model.id}\t${model.kind}\t${model.executionMode}`
            + (model.operations.length === 0 ? "" : `\t${model.operations.join(",")}`)
          )),
        ].join("\n"));
  });
}

async function handleAiModelsShow(
  context: CommandContext,
  command: Extract<CliCommand, { readonly kind: "ai-models-show" }>,
): Promise<void> {
  await withGatewayErrors(async () => {
    const view = await catalogViewForCommand(context, command.refresh);
    const model = inspectGatewayMediaModel(view.snapshot, command.model);
    if (model === null) {
      throw new CliError("not-found", `Gateway media model is not in the current catalog: ${command.model}`);
    }
    const parameterInput = gatewayProviderParameterHints(model);
    const output = {
      catalog: {
        fetchedAt: view.snapshot.fetchedAt,
        snapshotId: view.snapshot.snapshotId,
        source: view.source,
        status: view.status,
        validatedAt: view.snapshot.validatedAt,
      },
      model,
      parameterInput,
    };
    writeValue(context.io, command.json, output, () => [
      `${model.id} ${model.kind} ${model.executionMode}`,
      model.description,
      `catalog ${view.snapshot.snapshotId} ${view.status}`,
      `parameters ${parameterInput.common.join(",")}`,
      ...Object.entries(parameterInput.providerOptions).map(
        ([namespace, fields]) => `${namespace} options ${fields.join(",")}`,
      ),
      `raw options ${parameterInput.rawProviderOptions.flag} (${parameterInput.rawProviderOptions.maximumBytes} bytes)`,
    ].join("\n"));
  });
}

const CLI_GATEWAY_IMAGE_INPUT_BYTES = 50 * 1024 * 1024;
const CLI_GATEWAY_IMAGE_INPUT_TOTAL_BYTES = 200 * 1024 * 1024;
const CLI_GATEWAY_REFERENCE_INPUT_BYTES = 256 * 1024 * 1024;
const CLI_GATEWAY_REFERENCE_INPUT_TOTAL_BYTES = 512 * 1024 * 1024;
const CLI_GATEWAY_TRANSCRIPTION_INPUT_BYTES = 256 * 1024 * 1024;

type GatewayJobState =
  | "ambiguous"
  | "completed"
  | "dispatched"
  | "failed"
  | "prepared";

interface GatewayJobTracker {
  readonly displayPath: string;
  readonly path: string;
  complete(bundle: GatewayMediaArtifactBundle): Promise<void>;
  dispatch(event: GatewayMediaDispatchEvent): Promise<void>;
  fail(error: unknown): Promise<GatewayJobState>;
  state(): GatewayJobState;
}

function gatewayTimeoutMs(value: string): number {
  const microseconds = parseCliTime(value);
  if (
    !Number.isSafeInteger(microseconds)
    || microseconds % 1_000 !== 0
    || microseconds < 1_000_000
    || microseconds > 30 * 60 * 1_000_000
  ) {
    throw new CliError(
      "usage",
      "--timeout must resolve to a whole number of milliseconds from 1s through 30m.",
    );
  }
  return microseconds / 1_000;
}

function gatewayConsent(context: CommandContext) {
  return {
    acknowledgedAt: context.io.now().toISOString(),
    allowCloudUpload: true,
    policy: GATEWAY_MEDIA_UPLOAD_POLICY,
  } as const;
}

async function gatewayCommandText(
  context: CommandContext,
  inline: string | undefined,
  file: string | undefined,
): Promise<string> {
  if (inline !== undefined) return inline;
  if (file !== undefined) return await readGatewayTextFile(context.io.cwd(), file);
  return "";
}

function gatewayInputJobSummary(
  context: CommandContext,
  input: LoadedGatewayFile,
  role: string,
): Readonly<Record<string, unknown>> {
  if (input.url !== undefined) {
    return {
      bytes: 0,
      mediaType: input.mediaType,
      role,
      sha256: sha256Hex(input.url),
      source: "url",
    };
  }
  return {
    bytes: input.data.byteLength,
    mediaType: input.mediaType,
    path: displayPath(context.paths.repositoryRoot, input.path),
    role,
    sha256: createHash("sha256").update(input.data).digest("hex"),
    source: "inline",
  };
}

function gatewayServiceInput(
  input: LoadedGatewayFile,
): GatewayMediaInput {
  return input.url === undefined
    ? {
        data: input.data,
        ...(input.facts === undefined ? {} : { facts: input.facts }),
        mediaType: input.mediaType,
      }
    : {
        mediaType: input.mediaType,
        url: input.url,
      };
}

function gatewayProviderOptionsSha256(
  value: ReturnType<typeof parseGatewayProviderOptions> | undefined,
): string | undefined {
  return value === undefined ? undefined : sha256Hex(canonicalJson(value));
}

async function createGatewayJobTracker(
  context: CommandContext,
  input: Readonly<{
    model: string;
    operation: GatewayMediaDispatchEvent["operation"];
    request: Readonly<Record<string, unknown>>;
  }>,
): Promise<GatewayJobTracker> {
  const generatedRoot = join(
    context.paths.repositoryRoot,
    "artifacts",
    "atet",
    "generated",
  );
  await ensurePrivateDirectory(generatedRoot);
  const jobRoot = await ensurePhysicalPrivateDirectoryWithin(
    generatedRoot,
    "gateway-jobs",
  );
  const jobId = `gateway_${randomUUID().replaceAll("-", "")}`;
  const fileName = `${jobId}.json`;
  const path = join(jobRoot, fileName);
  const display = displayPath(context.paths.repositoryRoot, path);
  const fileSystem = createNodeBundleFileSystem(jobRoot);
  let record: Readonly<Record<string, unknown>> = {
    chargeMayHaveOccurred: false,
    clientMaxRetries: 0,
    createdAt: context.io.now().toISOString(),
    jobId,
    kind: "atet.gateway-media-job",
    model: input.model,
    gatewayProviderFailover: "may-attempt-multiple-providers",
    noAtetRetry: true,
    operation: input.operation,
    request: input.request,
    requestSha256: sha256Hex(canonicalJson(input.request)),
    schemaVersion: 1,
    state: "prepared",
    updatedAt: context.io.now().toISOString(),
  };
  let state: GatewayJobState = "prepared";

  const persist = async (
    nextState: GatewayJobState,
    extra: Readonly<Record<string, unknown>>,
  ): Promise<void> => {
    const next = {
      ...record,
      ...extra,
      state: nextState,
      updatedAt: context.io.now().toISOString(),
    };
    await fileSystem.writeTextAtomic(fileName, `${canonicalJson(next)}\n`);
    record = next;
    state = nextState;
  };

  await fileSystem.writeTextAtomic(fileName, `${canonicalJson(record)}\n`);
  return {
    complete: async bundle => await persist("completed", {
      artifacts: {
        directory: displayPath(context.paths.repositoryRoot, bundle.directory),
        outputs: bundle.outputs.map(output => ({
          bytes: output.bytes,
          mediaType: output.mediaType,
          path: displayPath(context.paths.repositoryRoot, output.path),
          sha256: output.sha256,
        })),
        receiptPath: displayPath(
          context.paths.repositoryRoot,
          bundle.receiptPath,
        ),
        ...(bundle.receipt.sampleFulfillment === undefined
          ? {}
          : { sampleFulfillment: bundle.receipt.sampleFulfillment }),
      },
      chargeMayHaveOccurred: true,
      completedAt: context.io.now().toISOString(),
      routing: bundle.receipt.routing,
    }),
    dispatch: async event => {
      if (
        event.model !== input.model
        || event.operation !== input.operation
        || state !== "prepared"
      ) {
        throw new CliError(
          "internal",
          "Gateway dispatch state did not match the prepared local job.",
        );
      }
      await persist("dispatched", {
        chargeMayHaveOccurred: true,
        dispatchedAt: event.startedAt,
        interruptionSemantics: "A nonterminal dispatched job is ambiguous and must not be retried by Atet; AI Gateway may have attempted multiple providers internally.",
      });
    },
    displayPath: display,
    fail: async error => {
      const failure = gatewayCliError(error);
      const nextState = state === "dispatched" ? "ambiguous" : "failed";
      const artifactCommitted =
        failure.details?.artifactCommitted === true;
      await persist(nextState, {
        ...(nextState === "ambiguous"
          ? {
              ambiguity: artifactCommitted
                ? "The Gateway request reached one or more paid providers and preserved local artifacts, but local validation or finalization did not complete successfully."
                : "The Gateway request may have reached one or more paid providers, but no complete local artifact was committed.",
              chargeMayHaveOccurred: true,
            }
          : { chargeMayHaveOccurred: false }),
        ...(artifactCommitted
          ? {
              artifacts: {
                directory: failure.details?.artifactDirectory,
                receiptPath: failure.details?.artifactReceiptPath,
              },
            }
          : {}),
        failure: {
          code: failure.code,
          message: failure.message,
          ...(failure.details?.gatewayReconciliation === undefined
            ? {}
            : {
                gatewayReconciliation:
                  failure.details.gatewayReconciliation,
              }),
        },
        failedAt: context.io.now().toISOString(),
      });
      return nextState;
    },
    path,
    state: () => state,
  };
}

async function createGatewayServiceForContext(
  context: CommandContext,
  callbacks: GatewayApplicationServiceCallbacks,
): Promise<GatewayMediaService> {
  const generatedRoot = join(
    context.paths.repositoryRoot,
    "artifacts",
    "atet",
    "generated",
  );
  await ensurePrivateDirectory(generatedRoot);
  const gatewayRoot = await ensurePhysicalPrivateDirectoryWithin(
    generatedRoot,
    "gateway",
  );
  const repositoryRoot = await realpath(context.paths.repositoryRoot);
  return createGatewayMediaService({
    artifactStore: createFileGatewayMediaArtifactStore({
      beforePublication: callbacks.beforePublication,
      outputRoot: gatewayRoot,
      repositoryRoot,
      validateMediaFile: async (file, signal) => {
        await inspectGatewayMediaFiles(context, [{
          data: file.uint8Array,
          mediaType: file.mediaType,
          path: file.path,
        }], signal);
      },
    }),
    catalog: gatewayCatalogCache(context),
    download: context.gatewayMediaDownload,
    loadCredential: async () => loadGatewayCredential(context.io.env),
    now: context.io.now,
    onDispatch: callbacks.onDispatch,
    sdk: context.gatewayMediaSdk,
  });
}

async function executeTrackedGatewayOperation<Result>(
  context: CommandContext,
  tracker: GatewayJobTracker,
  execute: (service: GatewayMediaService) => Promise<Result>,
  artifact: (result: Result) => GatewayMediaArtifactBundle,
): Promise<Result> {
  let result: Result;
  try {
    const service = await createGatewayServiceForContext(
      context,
      {
        beforePublication: () => Promise.resolve(),
        onDispatch: async event => await tracker.dispatch(event),
      },
    );
    result = await execute(service);
  } catch (error) {
    const failure = gatewayCliError(error);
    let state = tracker.state();
    try {
      state = await tracker.fail(failure);
    } catch {
      // Preserve the execution error. A previously persisted dispatched state
      // still communicates the conservative no-retry outcome.
    }
    throw new CliError(
      failure.code,
      `${failure.message} Local job: ${tracker.displayPath} (${state}).`,
      {
        ...(failure.details === undefined ? {} : failure.details),
        jobPath: tracker.displayPath,
        jobState: state,
        noAtetRetry: true,
      },
    );
  }
  const bundle = artifact(result);
  if (bundle.receipt.localValidation.status === "decode-failed") {
    const failure = new CliError(
      "invalid-data",
      "Gateway media bytes were preserved, but one or more generated outputs failed complete local decode validation.",
      {
        artifactCommitted: true,
        artifactDirectory: displayPath(
          context.paths.repositoryRoot,
          bundle.directory,
        ),
        artifactReceiptPath: displayPath(
          context.paths.repositoryRoot,
          bundle.receiptPath,
        ),
        localValidation: bundle.receipt.localValidation,
      },
    );
    let state = tracker.state();
    try {
      state = await tracker.fail(failure);
    } catch {
      // The durable receipt still identifies the preserved paid outputs.
    }
    throw new CliError(
      failure.code,
      `${failure.message} Local job: ${tracker.displayPath} (${state}).`,
      {
        ...failure.details,
        jobPath: tracker.displayPath,
        jobState: state,
        noAtetRetry: true,
      },
    );
  }
  try {
    await tracker.complete(bundle);
  } catch {
    throw new CliError(
      "unavailable",
      `Gateway artifacts were committed, but the local job index could not be finalized. Do not rerun the paid request; use the committed receipt at ${displayPath(context.paths.repositoryRoot, bundle.receiptPath)}.`,
      {
        artifactCommitted: true,
        artifactDirectory: displayPath(
          context.paths.repositoryRoot,
          bundle.directory,
        ),
        artifactReceiptPath: displayPath(
          context.paths.repositoryRoot,
          bundle.receiptPath,
        ),
        jobPath: tracker.displayPath,
        jobState: tracker.state(),
        noAtetRetry: true,
      },
    );
  }
  return result;
}

function gatewayArtifactSummary(
  context: CommandContext,
  bundle: GatewayMediaArtifactBundle,
  jobPath: string,
): Readonly<Record<string, unknown>> {
  const outputs = bundle.outputs.map(output => ({
    bytes: output.bytes,
    mediaType: output.mediaType,
    path: displayPath(context.paths.repositoryRoot, output.path),
    sha256: output.sha256,
  }));
  return {
    catalog: bundle.receipt.catalog,
    directory: displayPath(context.paths.repositoryRoot, bundle.directory),
    jobPath,
    localValidation: bundle.receipt.localValidation,
    model: bundle.receipt.model,
    nextCommands: bundle.receipt.nextCommands,
    operation: bundle.receipt.operation,
    outputs,
    receiptPath: displayPath(
      context.paths.repositoryRoot,
      bundle.receiptPath,
    ),
    ...(bundle.receipt.sampleFulfillment === undefined
      ? {}
      : { sampleFulfillment: bundle.receipt.sampleFulfillment }),
    warnings: bundle.receipt.warnings,
  };
}

function gatewayArtifactHuman(summary: Readonly<Record<string, unknown>>): string {
  const outputs = summary.outputs as readonly Readonly<Record<string, unknown>>[];
  const nextCommands = summary.nextCommands as readonly string[];
  return [
    `${String(summary.operation)} completed with ${outputs.length} output${outputs.length === 1 ? "" : "s"}`,
    ...outputs.map(output => (
      `${String(output.path)}\t${String(output.mediaType)}\t${String(output.bytes)} bytes\tsha256=${String(output.sha256)}`
    )),
    `receipt ${String(summary.receiptPath)}`,
    `job ${String(summary.jobPath)}`,
    ...nextCommands.map(command => `next ${command}`),
  ].join("\n");
}

async function handleAiImageGenerate(
  context: CommandContext,
  command: Extract<CliCommand, { readonly kind: "ai-image-generate" }>,
): Promise<void> {
  await withGatewayErrors(async () => {
    const hasLocalMedia = command.images.length > 0 || command.mask !== undefined;
    if (hasLocalMedia && !command.allowCloudUpload) {
      throw new CliError(
        "usage",
        "Image references require explicit --allow-cloud-upload.",
      );
    }
    const localMediaPaths = [
      ...command.images,
      ...(command.mask === undefined ? [] : [command.mask]),
    ];
    const [prompt, providerOptions, loadedMedia] = await Promise.all([
      gatewayCommandText(context, command.prompt, command.promptFile),
      readGatewayProviderOptionsFile(context.io.cwd(), command.providerOptions),
      loadGatewayMediaFiles(
        context.io.cwd(),
        localMediaPaths,
        {
          allowedPrefixes: ["image/"],
          maximumFileBytes: CLI_GATEWAY_IMAGE_INPUT_BYTES,
          maximumTotalBytes: CLI_GATEWAY_IMAGE_INPUT_TOTAL_BYTES,
        },
      ),
    ]);
    const localMedia = await inspectGatewayMediaFiles(context, loadedMedia);
    const images = localMedia.slice(0, command.images.length);
    const mask = command.mask === undefined
      ? undefined
      : requiredGatewayMediaFile(localMedia, command.images.length);
    const request = {
      ...(command.aspectRatio === undefined
        ? {}
        : { aspectRatio: command.aspectRatio }),
      consent: gatewayConsent(context),
      images: images.map(gatewayServiceInput),
      ...(mask === undefined
        ? {}
        : { mask: gatewayServiceInput(mask) }),
      ...(command.maxPerCall === undefined
        ? {}
        : { maxImagesPerCall: command.maxPerCall }),
      ...(command.maxOutputTokens === undefined
        ? {}
        : { maxOutputTokens: command.maxOutputTokens }),
      model: command.model,
      ...(command.count === 1 ? {} : { n: command.count }),
      prompt,
      ...(providerOptions === undefined ? {} : { providerOptions }),
      ...(command.seed === undefined ? {} : { seed: command.seed }),
      ...(command.size === undefined ? {} : { size: command.size }),
      ...(command.stopSequences.length === 0
        ? {}
        : { stopSequences: command.stopSequences }),
      ...(command.temperature === undefined
        ? {}
        : { temperature: command.temperature }),
    };
    const tracker = await createGatewayJobTracker(context, {
      model: command.model,
      operation: "image.generate",
      request: {
        ...(command.aspectRatio === undefined
          ? {}
          : { aspectRatio: command.aspectRatio }),
        count: command.count,
        inputs: [
          ...images.map((image, index) => gatewayInputJobSummary(
            context,
            image,
            `image.${index + 1}`,
          )),
          ...(mask === undefined
            ? []
            : [gatewayInputJobSummary(context, mask, "mask")]),
        ],
        ...(command.maxPerCall === undefined
          ? {}
          : { maxImagesPerCall: command.maxPerCall }),
        ...(command.maxOutputTokens === undefined
          ? {}
          : { maxOutputTokens: command.maxOutputTokens }),
        promptCharacters: prompt.length,
        promptSha256: sha256Hex(prompt),
        ...(gatewayProviderOptionsSha256(providerOptions) === undefined
          ? {}
          : {
              providerOptionsSha256: gatewayProviderOptionsSha256(
                providerOptions,
              ),
            }),
        ...(command.seed === undefined ? {} : { seed: command.seed }),
        ...(command.size === undefined ? {} : { size: command.size }),
        ...(command.stopSequences.length === 0
          ? {}
          : {
              stopSequenceLengths: command.stopSequences.map(
                sequence => sequence.length,
              ),
              stopSequencesCount: command.stopSequences.length,
              stopSequencesSha256: sha256Hex(
                canonicalJson(command.stopSequences),
              ),
            }),
        ...(command.temperature === undefined
          ? {}
          : { temperature: command.temperature }),
      },
    });
    const bundle = await executeTrackedGatewayOperation(
      context,
      tracker,
      async service => await service.generateImage(request, {
        timeoutMs: gatewayTimeoutMs(command.timeout),
      }),
      result => result,
    );
    const summary = gatewayArtifactSummary(
      context,
      bundle,
      tracker.displayPath,
    );
    writeValue(
      context.io,
      command.json,
      summary,
      () => gatewayArtifactHuman(summary),
    );
  });
}

async function handleAiVideoGenerate(
  context: CommandContext,
  command: Extract<CliCommand, { readonly kind: "ai-video-generate" }>,
): Promise<void> {
  await withGatewayErrors(async () => {
    const hasLocalMedia = command.image !== undefined
      || command.frameImages.length > 0
      || command.inputReferences.length > 0;
    if (hasLocalMedia && !command.allowCloudUpload) {
      throw new CliError(
        "usage",
        "Video generation inputs require explicit --allow-cloud-upload.",
      );
    }
    const imagePaths = [
      ...(command.image === undefined ? [] : [command.image]),
      ...command.frameImages.map(frame => frame.path),
    ];
    const [prompt, providerOptions, loadedImages, loadedReferences] =
      await Promise.all([
        gatewayCommandText(context, command.prompt, command.promptFile),
        readGatewayProviderOptionsFile(context.io.cwd(), command.providerOptions),
        loadGatewayMediaFiles(
          context.io.cwd(),
          imagePaths,
          {
            allowedPrefixes: ["image/"],
            maximumFileBytes: CLI_GATEWAY_IMAGE_INPUT_BYTES,
            maximumTotalBytes: CLI_GATEWAY_IMAGE_INPUT_TOTAL_BYTES,
          },
        ),
        loadGatewayMediaFiles(
          context.io.cwd(),
          command.inputReferences,
          {
            allowedPrefixes: ["audio/", "image/", "video/"],
            maximumFileBytes: CLI_GATEWAY_REFERENCE_INPUT_BYTES,
            maximumTotalBytes: CLI_GATEWAY_REFERENCE_INPUT_TOTAL_BYTES,
          },
        ),
      ]);
    const [inspectedImages, references] = await Promise.all([
      inspectGatewayMediaFiles(context, loadedImages),
      inspectGatewayMediaFiles(context, loadedReferences),
    ]);
    let loadedImageIndex = 0;
    const promptImage = command.image === undefined
      ? undefined
      : requiredGatewayMediaFile(inspectedImages, loadedImageIndex++);
    const frameImages = command.frameImages.map(frame => ({
      frameType: frame.frameType,
      image: requiredGatewayMediaFile(inspectedImages, loadedImageIndex++),
    }));
    const request = {
      ...(command.aspectRatio === undefined
        ? {}
        : { aspectRatio: command.aspectRatio }),
      consent: gatewayConsent(context),
      ...(command.durationSeconds === undefined
        ? {}
        : { duration: command.durationSeconds }),
      ...(command.fps === undefined ? {} : { fps: command.fps }),
      frameImages: frameImages.map(frame => ({
        frameType: frame.frameType,
        image: gatewayServiceInput(frame.image),
      })),
      ...(command.generateAudio === undefined
        ? {}
        : { generateAudio: command.generateAudio }),
      inputReferences: references.map(gatewayServiceInput),
      ...(command.maxPerCall === undefined
        ? {}
        : { maxVideosPerCall: command.maxPerCall }),
      model: command.model,
      ...(command.count === 1 ? {} : { n: command.count }),
      prompt,
      ...(promptImage === undefined
        ? {}
        : { promptImage: gatewayServiceInput(promptImage) }),
      ...(providerOptions === undefined ? {} : { providerOptions }),
      ...(command.resolution === undefined
        ? {}
        : { resolution: command.resolution }),
      ...(command.seed === undefined ? {} : { seed: command.seed }),
    };
    const providerOptionsSha256 = gatewayProviderOptionsSha256(providerOptions);
    const tracker = await createGatewayJobTracker(context, {
      model: command.model,
      operation: "video.generate",
      request: {
        ...(command.aspectRatio === undefined
          ? {}
          : { aspectRatio: command.aspectRatio }),
        count: command.count,
        ...(command.durationSeconds === undefined
          ? {}
          : { duration: command.durationSeconds }),
        ...(command.fps === undefined ? {} : { fps: command.fps }),
        ...(command.generateAudio === undefined
          ? {}
          : { generateAudio: command.generateAudio }),
        inputs: [
          ...(promptImage === undefined
            ? []
            : [gatewayInputJobSummary(context, promptImage, "prompt-image")]),
          ...frameImages.map((frame, index) => gatewayInputJobSummary(
            context,
            frame.image,
            `frame.${index + 1}.${frame.frameType}`,
          )),
          ...references.map((reference, index) => gatewayInputJobSummary(
            context,
            reference,
            `reference.${index + 1}`,
          )),
        ],
        ...(command.maxPerCall === undefined
          ? {}
          : { maxVideosPerCall: command.maxPerCall }),
        promptCharacters: prompt.length,
        promptSha256: sha256Hex(prompt),
        ...(providerOptionsSha256 === undefined
          ? {}
          : { providerOptionsSha256 }),
        ...(command.resolution === undefined
          ? {}
          : { resolution: command.resolution }),
        ...(command.seed === undefined ? {} : { seed: command.seed }),
      },
    });
    const bundle = await executeTrackedGatewayOperation(
      context,
      tracker,
      async service => await service.generateVideo(request, {
        timeoutMs: gatewayTimeoutMs(command.timeout),
      }),
      result => result,
    );
    const summary = gatewayArtifactSummary(
      context,
      bundle,
      tracker.displayPath,
    );
    writeValue(
      context.io,
      command.json,
      summary,
      () => gatewayArtifactHuman(summary),
    );
  });
}

async function handleAiSpeechGenerate(
  context: CommandContext,
  command: Extract<CliCommand, { readonly kind: "ai-speech-generate" }>,
): Promise<void> {
  await withGatewayErrors(async () => {
    const [text, instructions, providerOptions] = await Promise.all([
      gatewayCommandText(context, command.text, command.textFile),
      gatewayCommandText(
        context,
        command.instructions,
        command.instructionsFile,
      ),
      readGatewayProviderOptionsFile(context.io.cwd(), command.providerOptions),
    ]);
    const request = {
      consent: gatewayConsent(context),
      ...(instructions.length === 0 ? {} : { instructions }),
      ...(command.language === undefined
        ? {}
        : { language: command.language }),
      model: command.model,
      ...(command.outputFormat === undefined
        ? {}
        : { outputFormat: command.outputFormat }),
      ...(providerOptions === undefined ? {} : { providerOptions }),
      ...(command.speed === undefined ? {} : { speed: command.speed }),
      text,
      ...(command.voice === undefined ? {} : { voice: command.voice }),
    };
    const providerOptionsSha256 = gatewayProviderOptionsSha256(providerOptions);
    const tracker = await createGatewayJobTracker(context, {
      model: command.model,
      operation: "speech.generate",
      request: {
        ...(instructions.length === 0
          ? {}
          : {
              instructionsCharacters: instructions.length,
              instructionsSha256: sha256Hex(instructions),
            }),
        ...(command.language === undefined
          ? {}
          : { language: command.language }),
        ...(command.outputFormat === undefined
          ? {}
          : { outputFormat: command.outputFormat }),
        ...(providerOptionsSha256 === undefined
          ? {}
          : { providerOptionsSha256 }),
        ...(command.speed === undefined ? {} : { speed: command.speed }),
        textCharacters: text.length,
        textSha256: sha256Hex(text),
        ...(command.voice === undefined ? {} : { voice: command.voice }),
      },
    });
    const bundle = await executeTrackedGatewayOperation(
      context,
      tracker,
      async service => await service.generateSpeech(request, {
        timeoutMs: gatewayTimeoutMs(command.timeout),
      }),
      result => result,
    );
    const summary = gatewayArtifactSummary(
      context,
      bundle,
      tracker.displayPath,
    );
    writeValue(
      context.io,
      command.json,
      summary,
      () => gatewayArtifactHuman(summary),
    );
  });
}

async function handleAiTranscribe(
  context: CommandContext,
  command: Extract<CliCommand, { readonly kind: "ai-transcribe" }>,
): Promise<void> {
  await withGatewayErrors(async () => {
    if (!command.allowCloudAudioUpload) {
      throw new CliError(
        "usage",
        "Transcription requires explicit --allow-cloud-audio-upload.",
      );
    }
    const [loadedAudio, providerOptions] = await Promise.all([
      loadGatewayMediaFile(
        context.io.cwd(),
        command.input,
        CLI_GATEWAY_TRANSCRIPTION_INPUT_BYTES,
        ["audio/"],
      ),
      readGatewayProviderOptionsFile(context.io.cwd(), command.providerOptions),
    ]);
    const [audio] = await inspectGatewayMediaFiles(context, [loadedAudio]);
    if (audio === undefined) {
      throw new CliError("internal", "Gateway audio inspection returned no input.");
    }
    const request = {
      audio: {
        data: audio.data,
        ...(audio.facts === undefined ? {} : { facts: audio.facts }),
        mediaType: audio.mediaType,
      },
      consent: gatewayConsent(context),
      model: command.model,
      ...(providerOptions === undefined ? {} : { providerOptions }),
    };
    const providerOptionsSha256 = gatewayProviderOptionsSha256(providerOptions);
    const tracker = await createGatewayJobTracker(context, {
      model: command.model,
      operation: "transcription.create",
      request: {
        input: gatewayInputJobSummary(context, audio, "audio"),
        ...(providerOptionsSha256 === undefined
          ? {}
          : { providerOptionsSha256 }),
        requestedFormat: command.format,
      },
    });
    const result = await executeTrackedGatewayOperation(
      context,
      tracker,
      async service => await service.transcribe(request, {
        timeoutMs: gatewayTimeoutMs(command.timeout),
      }),
      transcription => transcription.artifact,
    );
    const summary = gatewayArtifactSummary(
      context,
      result.artifact,
      tracker.displayPath,
    );
    const mediaType = command.format === "json"
      ? "application/json"
      : command.format === "text"
        ? "text/plain"
        : command.format === "srt"
          ? "application/x-subrip"
          : command.format === "vtt"
            ? "text/vtt"
            : undefined;
    const selectedOutput = mediaType === undefined
      ? undefined
      : result.artifact.outputs.find(output => output.mediaType === mediaType);
    const output = {
      ...summary,
      transcript: {
        characters: result.text.length,
        ...(result.durationInSeconds === undefined
          ? {}
          : { durationInSeconds: result.durationInSeconds }),
        ...(result.language === undefined ? {} : { language: result.language }),
        requestedFormat: command.format,
        segments: result.segments.length,
        ...(selectedOutput === undefined
          ? {}
          : {
              selectedOutput: displayPath(
                context.paths.repositoryRoot,
                selectedOutput.path,
              ),
            }),
      },
    };
    writeValue(context.io, command.json, output, () => [
      gatewayArtifactHuman(summary),
      `transcript ${result.text.length} characters ${result.segments.length} segments`,
      ...(selectedOutput === undefined
        ? []
        : [
            `selected ${displayPath(context.paths.repositoryRoot, selectedOutput.path)}`,
          ]),
    ].join("\n"));
  });
}

async function handleMediaAudio(
  context: CommandContext,
  command: Extract<CliCommand, { readonly kind: "media-audio" }>,
): Promise<void> {
  const inputPath = resolve(context.io.cwd(), command.input);
  const before = await digestPhysicalFile(inputPath);
  const capabilities = await requestedCapabilities(
    context,
    ["ffmpeg", "ffprobe"],
  );
  const ffmpeg = requireCapability(capabilities, "ffmpeg");
  const ffprobe = requireCapability(capabilities, "ffprobe");
  const probe = await probeProjectMedia(ffprobe, context.runner, inputPath);
  assertLocalEffectsProbeEnvelope(probe);
  const audioStreams = probe.streams.filter(stream => stream.codec_type === "audio");
  const hasAudio = audioStreams.length > 0;
  const videoStreams = probe.streams.filter(stream => stream.codec_type === "video");
  const hasVideo = videoStreams.length > 0;
  if (!hasAudio) throw new CliError("invalid-data", "The selected media has no audio stream.");
  if (command.audioStreamIndex >= audioStreams.length) {
    throw new CliError(
      "usage",
      `--audio-stream ${command.audioStreamIndex} is out of range; the input has ${audioStreams.length} audio stream${audioStreams.length === 1 ? "" : "s"}.`,
    );
  }
  const selectedAudioStream = audioStreams[command.audioStreamIndex]!;
  const output = await resolveGeneratedOutputPaths(
    context.paths,
    "audio-effects",
    command.output,
    hasVideo ? ".mkv" : ".wav",
  );
  await assertFreshGeneratedReceiptDestination(inputPath, output.receiptPath);
  const transform = {
    audioStreamIndex: command.audioStreamIndex,
    effects: audioEffectsForCommand(command),
    kind: "atet.audio-effects-transform",
    output: audioOutputProfile(output.outputPath, videoStreams[0]?.index),
    schemaVersion: 1,
  } as const;
  const result = await new LocalMediaEffectsService({ ffmpeg, runner: context.runner }).renderAudio({
    expectedInput: before,
    inputPath,
    outputPath: output.outputPath,
    transform,
  });
  const outputIdentity = await generatedOutputIdentity(result.outputPath);
  const {
    nextCommands,
    outputDisplay,
    receipt,
    receiptDisplay,
  } = await (async () => {
    const outputDurationUs = assertLocalEffectsCoverage(
      selectedAudioStream,
      await probeProjectMedia(ffprobe, context.runner, result.outputPath),
      "audio",
    );
    const after = await digestPhysicalFile(inputPath);
    if (!samePhysicalDigest(before, after)) {
      throw new CliError(
        "conflict",
        "Media input changed while audio effects were rendering.",
      );
    }
    const verifiedOutput = await digestPhysicalFile(result.outputPath);
    if (
      verifiedOutput.device !== outputIdentity.device
      || verifiedOutput.inode !== outputIdentity.inode
      || verifiedOutput.bytes !== result.bytes
      || verifiedOutput.sha256 !== result.sha256
    ) {
      throw new CliError(
        "conflict",
        "Derived audio changed before its receipt could be published.",
      );
    }
    const outputDisplay = displayPath(
      context.paths.repositoryRoot,
      result.outputPath,
    );
    const receiptDisplay = displayPath(
      context.paths.repositoryRoot,
      output.receiptPath,
    );
    const nextCommands = {
      addToProject: `atet project add <project> ${shellArgument(outputDisplay)} --role ${hasVideo ? "b-roll" : "dialogue"}`,
    };
    const receipt = {
      createdAt: context.io.now().toISOString(),
      ffmpeg: capabilityByName(capabilities, "ffmpeg").version ?? null,
      filterGraph: result.filterGraph,
      input: {
        bytes: before.bytes,
        path: displayPath(context.paths.repositoryRoot, inputPath),
        sha256: before.sha256,
      },
      kind: "atet.local-media-transform-receipt",
      nextCommands,
      operation: "audio-effects",
      output: {
        bytes: result.bytes,
        durationUs: outputDurationUs,
        path: outputDisplay,
        sha256: result.sha256,
      },
      schemaVersion: 1,
      transform: result.transform,
    } as const;
    await publishGeneratedReceipt(context.paths, output.receiptPath, receipt);
    const receiptIdentity = await generatedOutputIdentity(output.receiptPath);
    try {
      const finalOutput = await digestPhysicalFile(result.outputPath);
      if (!samePhysicalDigest(verifiedOutput, finalOutput)) {
        throw new CliError(
          "conflict",
          "Derived audio changed while its receipt was being published.",
        );
      }
    } catch (error) {
      await removeGeneratedOutputIfSame(
        output.receiptPath,
        receiptIdentity,
      );
      throw error;
    }
    return { nextCommands, outputDisplay, receipt, receiptDisplay };
  })().catch(async (error: unknown) => {
    await removeGeneratedOutputIfSame(result.outputPath, outputIdentity);
    throw error;
  });
  writeValue(context.io, command.json, {
    ...receipt,
    receiptPath: receiptDisplay,
  }, () => [
    `audio effects ${outputDisplay} ${result.bytes} bytes sha256=${result.sha256}`,
    `receipt ${receiptDisplay}`,
    `next ${nextCommands.addToProject}`,
  ].join("\n"));
}

async function handleMediaColor(
  context: CommandContext,
  command: Extract<CliCommand, { readonly kind: "media-color" }>,
): Promise<void> {
  const inputPath = resolve(context.io.cwd(), command.input);
  const before = await digestPhysicalFile(inputPath);
  const capabilities = await requestedCapabilities(
    context,
    ["ffmpeg", "ffprobe"],
  );
  const ffmpeg = requireCapability(capabilities, "ffmpeg");
  const ffprobe = requireCapability(capabilities, "ffprobe");
  const probe = await probeProjectMedia(ffprobe, context.runner, inputPath);
  assertLocalEffectsProbeEnvelope(probe);
  const videoStreams = probe.streams.filter(stream => stream.codec_type === "video");
  if (videoStreams.length === 0) {
    throw new CliError("invalid-data", "The selected media has no video stream.");
  }
  const selectedVideoStream = videoStreams[command.videoStreamIndex];
  if (selectedVideoStream === undefined) {
    throw new CliError(
      "usage",
      `--video-stream ${command.videoStreamIndex} is out of range; the input has ${videoStreams.length} video stream${videoStreams.length === 1 ? "" : "s"}.`,
    );
  }
  const output = await resolveGeneratedOutputPaths(
    context.paths,
    "color-grade",
    command.output,
    ".mp4",
  );
  await assertFreshGeneratedReceiptDestination(inputPath, output.receiptPath);
  const controls = colorControlsForCommand(command);
  const grade = command.preset === undefined
    ? { controls, kind: "custom" as const }
    : {
        kind: "preset" as const,
        ...(Object.keys(controls).length === 0 ? {} : { overrides: controls }),
        preset: command.preset === "mono" ? "monochrome" as const : command.preset,
      };
  const transform = {
    grade,
    inputStreamIndex: selectedVideoStream.index,
    kind: "atet.color-grade-transform",
    outputProfile: colorOutputProfile(output.outputPath),
    schemaVersion: 1,
    videoStreamIndex: command.videoStreamIndex,
  } as const;
  const result = await new LocalMediaEffectsService({ ffmpeg, runner: context.runner }).renderColor({
    expectedInput: before,
    inputPath,
    outputPath: output.outputPath,
    transform,
  });
  const outputIdentity = await generatedOutputIdentity(result.outputPath);
  const {
    nextCommands,
    outputDisplay,
    receipt,
    receiptDisplay,
  } = await (async () => {
    const outputDurationUs = assertLocalEffectsCoverage(
      selectedVideoStream,
      await probeProjectMedia(ffprobe, context.runner, result.outputPath),
      "video",
    );
    const after = await digestPhysicalFile(inputPath);
    if (!samePhysicalDigest(before, after)) {
      throw new CliError(
        "conflict",
        "Media input changed while color grading.",
      );
    }
    const verifiedOutput = await digestPhysicalFile(result.outputPath);
    if (
      verifiedOutput.device !== outputIdentity.device
      || verifiedOutput.inode !== outputIdentity.inode
      || verifiedOutput.bytes !== result.bytes
      || verifiedOutput.sha256 !== result.sha256
    ) {
      throw new CliError(
        "conflict",
        "Color-graded media changed before its receipt could be published.",
      );
    }
    const outputDisplay = displayPath(
      context.paths.repositoryRoot,
      result.outputPath,
    );
    const receiptDisplay = displayPath(
      context.paths.repositoryRoot,
      output.receiptPath,
    );
    const nextCommands = {
      addToProject: `atet project add <project> ${shellArgument(outputDisplay)} --role b-roll`,
    };
    const receipt = {
      createdAt: context.io.now().toISOString(),
      ffmpeg: capabilityByName(capabilities, "ffmpeg").version ?? null,
      filterGraph: result.filterGraph,
      input: {
        bytes: before.bytes,
        path: displayPath(context.paths.repositoryRoot, inputPath),
        sha256: before.sha256,
      },
      kind: "atet.local-media-transform-receipt",
      nextCommands,
      operation: "color-grade",
      output: {
        bytes: result.bytes,
        durationUs: outputDurationUs,
        path: outputDisplay,
        sha256: result.sha256,
      },
      schemaVersion: 1,
      transform: result.transform,
    } as const;
    await publishGeneratedReceipt(context.paths, output.receiptPath, receipt);
    const receiptIdentity = await generatedOutputIdentity(output.receiptPath);
    try {
      const finalOutput = await digestPhysicalFile(result.outputPath);
      if (!samePhysicalDigest(verifiedOutput, finalOutput)) {
        throw new CliError(
          "conflict",
          "Color-graded media changed while its receipt was being published.",
        );
      }
    } catch (error) {
      await removeGeneratedOutputIfSame(
        output.receiptPath,
        receiptIdentity,
      );
      throw error;
    }
    return { nextCommands, outputDisplay, receipt, receiptDisplay };
  })().catch(async (error: unknown) => {
    await removeGeneratedOutputIfSame(result.outputPath, outputIdentity);
    throw error;
  });
  writeValue(context.io, command.json, {
    ...receipt,
    receiptPath: receiptDisplay,
  }, () => [
    `color grade ${outputDisplay} ${result.bytes} bytes sha256=${result.sha256}`,
    `receipt ${receiptDisplay}`,
    `next ${nextCommands.addToProject}`,
  ].join("\n"));
}

async function dispatch(context: CommandContext, command: CliCommand): Promise<void> {
  switch (command.kind) {
    case "help": writeLine(context.io, commandHelp(command.topic)); return;
    case "version": writeLine(context.io, context.version); return;
    case "operations-list": {
      const operations = operationDiscoveryList(
        createApplicationOperationRegistry({ toolVersion: context.version }),
      );
      writeValue(
        context.io,
        command.json,
        { operations },
        () => humanOperationList(operations),
      );
      return;
    }
    case "operations-show": {
      const operation = operationDiscovery(
        createApplicationOperationRegistry({ toolVersion: context.version }),
        command.operation,
      );
      writeValue(
        context.io,
        command.json,
        operation,
        () => humanOperation(operation),
      );
      return;
    }
    case "diagram-check": {
      const registry = createApplicationOperationRegistry({ toolVersion: context.version });
      const result = await registry.execute({
        abortSignal: new AbortController().signal,
        application: applicationContext(context),
      }, {
        input: { path: command.path },
        kind: "atet.diagram.check",
        version: 1,
      });
      const output = AtetDiagramCheckOutputSchema.parse(result.output);
      writeValue(context.io, command.json, output, () => [
        `checked ${output.source.path} sha256=${output.source.sha256}`,
        ...output.findings.map(finding => (
          `${finding.code}: ${finding.message}${finding.shapeIds.length === 0 ? "" : ` [${finding.shapeIds.join(", ")}]`}`
        )),
        output.findings.length === 0 ? "findings none" : `findings ${String(output.findings.length)}`,
      ].join("\n"));
      return;
    }
    case "diagram-render": {
      const registry = createApplicationOperationRegistry({ toolVersion: context.version });
      const result = await registry.execute({
        abortSignal: new AbortController().signal,
        application: applicationContext(context),
      }, {
        input: {
          path: command.path,
          ...(command.scale === undefined ? {} : { scale: command.scale }),
        },
        kind: "atet.diagram.render",
        version: 1,
      });
      const output = AtetDiagramRenderOutputSchema.parse(result.output);
      writeValue(context.io, command.json, output, () => [
        `rendered ${output.source.path} findings=${String(output.findings.length)}`,
        `light-png ${output.artifacts.lightPng.path}`,
        `dark-png ${output.artifacts.darkPng.path}`,
        `light-svg ${output.artifacts.lightSvg.path}`,
        `dark-svg ${output.artifacts.darkSvg.path}`,
        `tldr ${output.artifacts.tldr.path}`,
        `receipt ${output.receipt.path}`,
      ].join("\n"));
      return;
    }
    case "image-vectorize": {
      const registry = createApplicationOperationRegistry({ toolVersion: context.version });
      const result = await registry.execute({
        abortSignal: new AbortController().signal,
        application: applicationContext(context),
      }, {
        input: {
          inputPath: command.inputPath,
          ...(command.alphaCutoff === undefined ? {} : { alphaCutoff: command.alphaCutoff }),
          ...(command.duotone === undefined ? {} : { duotone: command.duotone }),
          ...(command.timeoutMs === undefined ? {} : { timeoutMs: command.timeoutMs }),
        },
        kind: "atet.image.vectorize",
        version: 1,
      });
      const output = AtetImageVectorizeOutputSchema.parse(result.output);
      writeValue(context.io, command.json, output, () => [
        `vectorized ${output.source.path} -> ${output.artifact.path}`,
        `sha256 ${output.artifact.sha256} paths=${String(output.vectorizer.pathCount)}`,
        `receipt ${output.receipt.path}`,
      ].join("\n"));
      return;
    }
    case "workflows-list": {
      const workflows = BUILT_IN_WORKFLOWS.map(workflowCatalogEntry);
      writeValue(
        context.io,
        command.json,
        { workflows },
        () => BUILT_IN_WORKFLOWS.map(workflow => (
          `${workflow.id}@${String(workflow.version)}\t${workflow.title}`
        )).join("\n"),
      );
      return;
    }
    case "workflows-show": {
      const workflow = builtInWorkflow(command.workflow);
      if (workflow === undefined) {
        throw new CliError("not-found", `Unknown built-in workflow: ${command.workflow}`);
      }
      const output = workflowCatalogDescription(workflow);
      writeValue(
        context.io,
        command.json,
        output,
        () => humanWorkflow(workflow),
      );
      return;
    }
    case "workflows-plan": {
      const workflow = builtInWorkflow(command.workflow);
      if (workflow === undefined) {
        throw new CliError("not-found", `Unknown built-in workflow: ${command.workflow}`);
      }
      const planned = await planCatalogWorkflow({
        application: applicationContext(context),
        inputPath: command.input,
        registry: createApplicationOperationRegistry({ toolVersion: context.version }),
        workflow,
      });
      const summary = workflowPlanSummary(planned.plan);
      writeValue(
        context.io,
        command.json,
        summary,
        () => humanWorkflowPlan(summary),
      );
      return;
    }
    case "code-init": {
      const initialized = await initializeWorkflowSource(
        applicationContext(context),
        command.path,
      );
      writeLine(
        context.io,
        `created ${initialized.path} (${String(initialized.bytes)} bytes)`,
      );
      return;
    }
    case "code-check": {
      const checked = await checkCustomWorkflow({
        application: applicationContext(context),
        sourcePath: command.path,
      });
      writeValue(
        context.io,
        command.json,
        checked,
        () => [
          `${checked.entrypoint} ${checked.bundleSha256} ${String(checked.bytes)} bytes`,
          `source ${checked.sourceSha256}`,
          `dependencies ${checked.dependencyGraphSha256}`,
          `imports ${checked.importedModules.join(" ") || "none"}`,
          `warning ${checked.warning}`,
        ].join("\n"),
      );
      return;
    }
    case "code-plan": {
      const planned = await planCustomWorkflow({
        application: applicationContext(context),
        inputPath: command.input,
        registry: createApplicationOperationRegistry({ toolVersion: context.version }),
        sourcePath: command.path,
      });
      const summary = {
        ...workflowPlanSummary(planned.plan),
        diagnostics: planned.diagnostics,
      };
      writeValue(
        context.io,
        command.json,
        summary,
        () => humanWorkflowPlan(summary),
      );
      return;
    }
    case "workflows-run": {
      const workflow = builtInWorkflow(command.workflow);
      if (workflow === undefined) {
        throw new CliError("not-found", `Unknown built-in workflow: ${command.workflow}`);
      }
      const providerOptions = await readGatewayProviderOptionsFile(
        context.io.cwd(),
        command.providerOptions,
      );
      const application = applicationContext(context, providerOptions);
      const registry = createApplicationOperationRegistry({ toolVersion: context.version });
      const preparationClaims = codePreparationHostResourceClaims(
        context.hostResourceCoordinator,
      );
      const planned = await withHostResourceClaims(
        context,
        preparationClaims,
        async admittedContext => await planCatalogWorkflow({
          application: applicationContext(admittedContext, providerOptions),
          inputPath: command.input,
          registry,
          workflow,
        }),
      );
      const created = await createWorkflowRun({
        application,
        bundleBytes: planned.bundleBytes,
        graphPlan: planned.plan,
        registry,
        sourceLocator: `builtin:${workflow.id}@${String(workflow.version)}`,
      });
      const result = await runWorkflow({
        application,
        hostResourceCoordinator: context.hostResourceCoordinator,
        jobs: command.jobs,
        ...(command.jsonl
          ? { onEvent: event => writeJson(context.io, event) }
          : {}),
        registry,
        runId: created.runId,
        store: created.store,
      });
      if (command.jsonl) {
        writeJson(context.io, { kind: "run-summary", ...result });
      } else {
        writeValue(
          context.io,
          command.json,
          result,
          () => humanRunSummary(result),
        );
      }
      return;
    }
    case "code-run": {
      const providerOptions = await readGatewayProviderOptionsFile(
        context.io.cwd(),
        command.providerOptions,
      );
      const application = applicationContext(context, providerOptions);
      const registry = createApplicationOperationRegistry({ toolVersion: context.version });
      const preparationClaims = codePreparationHostResourceClaims(
        context.hostResourceCoordinator,
      );
      const planned = await withHostResourceClaims(
        context,
        preparationClaims,
        async admittedContext => await prepareCustomWorkflowRun({
          application: applicationContext(admittedContext, providerOptions),
          inputPath: command.input,
          registry,
          sourcePath: command.path,
        }),
      );
      let workerPool: CodeWorkerPool | undefined;
      try {
        assertPlanHash(planned.plan, command.plan);
        const sourceLocator = displayPath(
          context.paths.repositoryRoot,
          resolve(context.paths.repositoryRoot, command.path),
        );
        const created = await createWorkflowRun({
          application,
          bundleBytes: planned.bundle.bytes,
          graphPlan: planned.plan,
          registry,
          sourceLocator,
        });
        const computeNodes = planned.plan.graph.nodes.filter(node => (
          node.executor.kind === "compute"
        )).length;
        if (computeNodes === 0) {
          await planned.worker.close();
        } else {
          workerPool = await withHostResourceClaims(
            context,
            preparationClaims,
            async admittedContext => {
              const descriptor = admittedContext.hostResourceLease
                ?.inheritedFileDescriptor;
              return await planned.startWorkerPool(
                computeWorkerPoolSize(
                  command.jobs,
                  computeNodes,
                  admittedContext.hostResourceCoordinator,
                ),
                descriptor === undefined
                  ? {}
                  : { inheritedHostResourceFileDescriptor: descriptor },
              );
            },
          );
        }
        const result = await runWorkflow({
          application,
          ...(workerPool === undefined
            ? {}
            : {
                compute: {
                  executor: workerPool,
                  kind: "fresh" as const,
                },
              }),
          jobs: command.jobs,
          hostResourceCoordinator: context.hostResourceCoordinator,
          ...(command.jsonl
            ? { onEvent: event => writeJson(context.io, event) }
            : {}),
          registry,
          runId: created.runId,
          store: created.store,
        });
        if (command.jsonl) {
          writeJson(context.io, { kind: "run-summary", ...result });
        } else {
          writeValue(
            context.io,
            command.json,
            result,
            () => humanRunSummary(result),
          );
        }
      } finally {
        if (workerPool === undefined) {
          await planned.worker.close();
        } else {
          await workerPool.close();
        }
      }
      return;
    }
    case "runs-list": {
      const runs = await listWorkflowRuns(
        applicationContext(context),
        command.limit,
      );
      writeValue(
        context.io,
        command.json,
        { runs },
        () => runs.map(run => (
          `${run.runId}\t${run.status}\t${run.updatedAt}\t`
          + `completed=${String(run.counts.completed)} failed=${String(run.counts.failed)} `
          + `pending=${String(run.counts.pending)}`
        )).join("\n"),
      );
      return;
    }
    case "runs-show": {
      const details = await workflowRunDetails({
        application: applicationContext(context),
        nodes: command.nodes,
        runId: command.runId,
      });
      writeValue(
        context.io,
        command.json,
        details,
        () => [
          `${details.summary.runId} ${details.summary.status} ${details.graphPlanSha256}`,
          `workflow ${details.workflow.id}@${String(details.workflow.version)}`,
          `nodes completed=${String(details.summary.counts.completed)} failed=${String(details.summary.counts.failed)} skipped=${String(details.summary.counts.skipped)} pending=${String(details.summary.counts.pending)} cancelled=${String(details.summary.counts.cancelled)}`,
          ...details.nodes.map(node => {
            const pendingPlan = node.status === "approval-required"
              ? node.executionPlan?.nodePlanSha256
                ?? node.preparationPlan?.preparationPlanSha256
              : undefined;
            return `${node.nodeKey}\t${node.status}${pendingPlan === undefined ? "" : `\t${pendingPlan}`}`;
          }),
          ...details.nodes
            .filter(node => node.status === "ambiguous-code")
            .map(node => (
              `replay atet runs resume ${details.summary.runId} `
              + `--replay-ambiguous-code ${node.nodeKey}`
            )),
        ].join("\n"),
      );
      return;
    }
    case "runs-resume": {
      const providerOptions = await readGatewayProviderOptionsFile(
        context.io.cwd(),
        command.providerOptions,
      );
      const application = applicationContext(context, providerOptions);
      const result = await runWorkflow({
        application,
        jobs: command.jobs,
        hostResourceCoordinator: context.hostResourceCoordinator,
        ...(command.jsonl
          ? { onEvent: event => writeJson(context.io, event) }
          : {}),
        replayAmbiguousCode: command.replayAmbiguousCode,
        registry: createApplicationOperationRegistry({ toolVersion: context.version }),
        runId: command.runId,
        store: workflowRunStore(application),
      });
      if (command.jsonl) {
        writeJson(context.io, { kind: "run-summary", ...result });
      } else {
        writeValue(
          context.io,
          command.json,
          result,
          () => humanRunSummary(result),
        );
      }
      return;
    }
    case "runs-approve": {
      const grant = await approveWorkflowRun({
        application: applicationContext(context),
        nodeKey: command.nodeKey,
        planHash: command.planHash,
        planKind: command.planKind,
        runId: command.runId,
      });
      writeValue(
        context.io,
        command.json,
        grant,
        () => [
          `approved ${grant.kind} ${command.nodeKey} ${command.planHash}`,
          `next atet runs resume ${command.runId}`,
        ].join("\n"),
      );
      return;
    }
    case "runs-cancel": {
      const cancellation = await cancelWorkflowRun({
        application: applicationContext(context),
        runId: command.runId,
      });
      writeValue(
        context.io,
        command.json,
        cancellation,
        () => `cancellation requested ${cancellation.runId} ${cancellation.requestedAt}`,
      );
      return;
    }
    case "complete":
      for (const completion of completions(command.words)) writeLine(context.io, completion);
      return;
    case "doctor": {
      const [capabilities, emoji, active, macVersion] = await Promise.all([
        context.capabilities(),
        inspectEmojiAssets(context.paths.repositoryRoot),
        context.recordingController === undefined
          ? Promise.resolve(null)
          : context.recordingController.status(),
        context.io.platform === "darwin"
          ? context.runner.run(["/usr/bin/sw_vers", "-productVersion"], { maxOutputBytes: 4_096 })
          : Promise.resolve({ exitCode: 0, stderr: "", stdout: "not-macos" }),
      ]);
      const output = {
        activeRecording: active,
        artifactRoot: displayPath(context.paths.repositoryRoot, context.paths.artifactRoot),
        gatewayCredential: inspectGatewayCredential(context.io.env),
        emoji: {
          ...emoji,
          assetRoot: displayPath(context.paths.repositoryRoot, emoji.assetRoot),
          catalogPath: displayPath(context.paths.repositoryRoot, emoji.catalogPath),
          manifestPath: displayPath(context.paths.repositoryRoot, emoji.manifestPath),
        },
        platform: { architecture: process.arch, macOSVersion: macVersion.stdout.trim(), name: context.io.platform },
        repositoryRoot: context.paths.repositoryRoot,
        tools: Object.fromEntries(capabilities.map((capability) => [capability.name, capability])),
        version: context.version,
      };
      writeValue(context.io, command.json, output, () => [
        `repo ${output.repositoryRoot}`,
        `artifacts ${output.artifactRoot}`,
        `platform ${output.platform.name} ${output.platform.macOSVersion}`,
        ...capabilities.map((item) => `${item.name} ${item.available ? item.version ?? item.command : "unavailable"}`),
        `recording ${active === null ? "controller-unavailable" : snapshotHuman(active)}`,
        `emoji ${emoji.provenance} ${emoji.installedCount}/${emoji.catalogCount}; generate: ${emoji.generationCommand}`,
      ].join("\n"));
      return;
    }
    case "ai-provider-options-inspect": {
      const providerOptions = await readGatewayProviderOptionsFile(
        context.io.cwd(),
        command.path,
      );
      if (providerOptions === undefined) {
        throw new CliError(
          "internal",
          "Provider-options inspection lost its required file.",
        );
      }
      const summary = gatewayProviderOptionsSummary(providerOptions);
      writeValue(
        context.io,
        command.json,
        summary,
        () => [
          `sha256\t${summary.sha256}`,
          `namespaces\t${summary.namespaces.join(" ") || "none"}`,
        ].join("\n"),
      );
      return;
    }
    case "ai-models-list": await handleAiModelsList(context, command); return;
    case "ai-models-show": await handleAiModelsShow(context, command); return;
    case "ai-image-generate": await handleAiImageGenerate(context, command); return;
    case "ai-video-generate": await handleAiVideoGenerate(context, command); return;
    case "ai-speech-generate": await handleAiSpeechGenerate(context, command); return;
    case "ai-transcribe": await handleAiTranscribe(context, command); return;
    case "media-audio": await handleMediaAudio(context, command); return;
    case "media-color": await handleMediaColor(context, command); return;
    case "recordings-list": {
      const directories = (await listRecordingDirectories(context.paths.artifactRoot)).slice(0, command.limit);
      const recordings = await Promise.all(directories.map(async ({ id }) => {
        try {
          const recording = await openRecording(context.paths.artifactRoot, id);
          return {
            createdAt: recording.manifest.createdAt,
            durationUs: recording.manifest.timeline.durationUs,
            recordingId: recording.manifest.recordingId,
            state: recording.manifest.state,
            tracks: recording.manifest.tracks.length,
          };
        } catch (error) {
          return { error: asCliError(error).message, recordingId: id, state: "invalid" as const };
        }
      }));
      writeValue(context.io, command.json, { recordings }, () => recordings.length === 0
        ? "No recordings."
        : recordings.map((item) => "durationUs" in item
          ? `${item.recordingId} ${item.state} ${humanTime(item.durationUs)} tracks=${item.tracks}`
          : `${item.recordingId} invalid ${item.error}`).join("\n"));
      return;
    }
    case "projects-list": {
      const directories = (await listProjectDirectories(context.paths.projectRoot)).slice(0, command.limit);
      const projects = await Promise.all(directories.map(async directory => {
        try {
          const project = await openProject(context.paths.projectRoot, directory.id);
          return {
            assets: project.project.assets.length,
            durationUs: project.project.timeline.durationUs,
            name: project.project.name,
            placements: project.project.placements.length,
            projectId: project.project.projectId,
            updatedAt: project.project.updatedAt,
          };
        } catch (error) {
          return { error: asCliError(error).message, projectId: directory.id, state: "invalid" as const };
        }
      }));
      writeValue(context.io, command.json, { projects }, () => projects.length === 0
        ? "No projects."
        : projects.map(project => "durationUs" in project
          ? `${project.projectId} ${project.name} ${humanTime(project.durationUs)} assets=${project.assets} placements=${project.placements}`
          : `${project.projectId} invalid ${project.error}`).join("\n"));
      return;
    }
    case "projects-create": {
      const recording = await openRecording(context.paths.artifactRoot, command.recording);
      const project = await createProjectFromRecording({
        ...(command.name === undefined ? {} : { name: command.name }),
        now: context.io.now(),
        projectRoot: context.paths.projectRoot,
        recording,
        repositoryRoot: context.paths.repositoryRoot,
      });
      const plan = await loadCurrentProjectPlan(project);
      const output = projectSummary(project, plan);
      writeValue(context.io, command.json, output, () => (
        `created ${project.project.projectId} from ${recording.manifest.recordingId}; assets=${project.project.assets.length}`
      ));
      return;
    }
    case "project-inspect": {
      const project = await openProject(context.paths.projectRoot, command.project);
      const summary = projectSummary(project, await loadCurrentProjectPlan(project));
      writeValue(context.io, command.json, summary, () => {
        const assets = summary.assets as readonly Readonly<Record<string, unknown>>[];
        const placements = summary.placements as readonly Readonly<Record<string, unknown>>[];
        return [
          `${String(summary.projectId)} ${String(summary.name)} ${humanTime(Number(summary.durationUs))}`,
          `assets ${assets.length} placements ${placements.length}`,
          `analysis ${(summary.analyses as readonly unknown[]).length}`,
          `edit ${JSON.stringify(summary.edit)}`,
        ].join("\n");
      });
      return;
    }
    case "project-add": {
      const project = await openProject(context.paths.projectRoot, command.project);
      const ffprobe = await requireRequestedCapability(context, "ffprobe");
      const ingested = await ingestProjectMedia({
        ffprobe,
        now: context.io.now(),
        projectDirectory: project.directory.path,
        repositoryRoot: context.paths.repositoryRoot,
        role: command.role,
        runner: context.runner,
        sourcePath: command.path,
      });
      let result: Awaited<ReturnType<typeof addAssetToProject>>;
      try {
        result = await addAssetToProject(
          project,
          ingested.asset,
          parseCliTime(command.at),
          context.io.now(),
        );
      } catch (error) {
        // An unresolved commit-ready transaction must retain the content-addressed
        // blob: recovery can still roll the after-generation forward and reference it.
        // A harmless orphan is safer than publishing a project with missing media.
        if (ingested.created && !projectStateTransactionMayHaveCommitted(error)) {
          await rm(ingested.absolutePath, { force: true });
        }
        throw error;
      }
      const output = {
        assetId: ingested.asset.assetId,
        importedPath: displayPath(context.paths.repositoryRoot, ingested.absolutePath),
        placementId: result.placement.placementId,
        projectId: result.project.projectId,
        projectPlanHash: hashProjectEditPlan(result.plan),
        syncStatus: result.placement.sync.provenance.kind,
      };
      writeValue(context.io, command.json, output, () => (
        `added ${output.assetId} as ${output.placementId}; sync=${output.syncStatus}; align before final render`
      ));
      return;
    }
    case "project-edit": await handleProjectEdit(context, command); return;
    case "project-camera-edit": await handleProjectCameraEdit(context, command); return;
    case "project-metadata-edit": await handleProjectMetadataEdit(context, command); return;
    case "project-overlay-edit": await handleProjectOverlayEdit(context, command); return;
    case "project-render": await handleProjectRender(context, command); return;
    case "align-analyze": await handleAlignAnalyze(context, command); return;
    case "align-apply": await handleAlignApply(context, command); return;
    case "inspect": {
      const recording = await openRecording(context.paths.artifactRoot, command.recording);
      const summary = recordingSummary(recording, await tryLoadCurrentPlan(recording));
      const allowed = new Set(Object.keys(summary));
      const selected = command.fields === undefined
        ? summary
        : Object.fromEntries(command.fields.map((field) => {
            if (!allowed.has(field)) throw new CliError("usage", `Unknown inspect field: ${field}`);
            return [field, summary[field]];
          }));
      writeValue(context.io, command.json, selected, () => {
        if (command.fields !== undefined) {
          return command.fields.map((field) => `${field}\t${JSON.stringify(selected[field])}`).join("\n");
        }
        const tracks = summary.tracks as readonly Readonly<Record<string, unknown>>[];
        const events = summary.eventStreams as readonly Readonly<Record<string, unknown>>[];
        const edit = summary.edit as Readonly<Record<string, unknown>> | null;
        return [
          `${String(summary.recordingId)} ${String(summary.state)} ${humanTime(Number(summary.durationUs))}`,
          `tracks ${tracks.map((track) => `${String(track.kind)}:${String(track.segmentCount)}`).join(" ") || "none"}`,
          `events ${events.reduce((sum, stream) => sum + Number(stream.recordCount), 0)} across ${events.length} stream(s)`,
          `edit ${edit === null ? "none" : `${String(edit.planId)} ${String(edit.hash)}`}`,
        ].join("\n");
      });
      return;
    }
    case "events": {
      const recording = await openRecording(context.paths.artifactRoot, command.recording);
      const types = command.eventKinds.map((kind) => {
        const result = EventKindSchema.safeParse(kind);
        if (!result.success) throw new CliError("usage", `Unknown event kind: ${kind}`);
        return result.data;
      });
      if (command.around !== undefined && (command.from !== undefined || command.to !== undefined)) {
        throw new CliError("usage", "--around cannot be combined with --from or --to.");
      }
      const aroundUs = command.around === undefined ? undefined : parseCliTime(command.around, command.fps);
      const startUs = aroundUs === undefined
        ? command.from === undefined ? undefined : parseCliTime(command.from, command.fps)
        : Math.max(0, aroundUs - 2_000_000);
      const endUs = aroundUs === undefined
        ? command.to === undefined ? undefined : parseCliTime(command.to, command.fps)
        : aroundUs + 2_000_001;
      const events = await loadRecordingEvents(recording, {
        ...(endUs === undefined ? {} : { endUs }),
        limit: command.limit,
        ...(startUs === undefined ? {} : { startUs }),
        types,
      });
      if (command.format === "json") writeJson(context.io, { events, recordingId: recording.manifest.recordingId });
      else if (command.format === "jsonl") for (const event of events) writeJson(context.io, event);
      else writeLine(context.io, events.map((event) =>
        `${event.sourceTimeUs}\t${event.type}\t${JSON.stringify(event)}`
      ).join("\n"));
      return;
    }
    case "record": {
      if (context.recordingController === undefined) throw new CliError("unavailable", "Recording controller is unavailable.");
      const options = command.action === "start"
        ? {
            camera: !command.webcam
              ? { kind: "disabled" as const }
              : command.cameraDeviceId === undefined
              ? { kind: "default" as const }
              : { deviceId: command.cameraDeviceId, kind: "device" as const },
            displays: command.displays.length === 0
              ? { kind: "all" as const }
              : { displayIds: command.displays, kind: "selected" as const },
            microphone: !command.microphone
              ? { kind: "disabled" as const }
              : command.microphoneDeviceId === undefined
              ? { kind: "default" as const }
              : { deviceId: command.microphoneDeviceId, kind: "device" as const },
            strictInputs: command.strictInputs,
            systemAudio: command.systemAudio,
            typedText: command.typedText,
          }
        : undefined;
      const snapshot = await executeRecordingAction(context.recordingController, command.action, options);
      writeValue(context.io, command.json, snapshot, () => snapshotHuman(snapshot));
      return;
    }
    case "edit": await handleEdit(context, command); return;
    case "analyze-inactivity": await handleInactivity(context, command); return;
    case "analyze-faces": await handleFaceAnalysis(context, command); return;
    case "analyze-music": await handleMusicAnalysis(context, command); return;
    case "analyze-speech": await handleSpeechAnalysis(context, command); return;
    case "analyze-zooms": await handleAutomaticZooms(context, command); return;
    case "analyze-scenes": await handleSceneAnalysis(context, command); return;
    case "fillers-list": await handleFillersList(context, command); return;
    case "fillers-apply": await handleFillersApply(context, command); return;
    case "faces-list": await handleFacesList(context, command); return;
    case "render-plan":
    case "render-run": await handleRender(context, command); return;
    case "emoji-search": {
      const results = await searchEmojiAssets(
        context.paths.repositoryRoot,
        command.query,
        command.limit,
        command.variant,
        command.provider,
      );
      writeValue(context.io, command.json, { results }, () => results.map((item) =>
        `${item.emoji}\t${item.id}\t${item.name}\tprovider=${item.provider} color=${item.available.color} duotone=${item.available.duotone}`
      ).join("\n"));
      return;
    }
    case "emoji-resolve": {
      const asset = await resolveEmojiAsset(
        context.paths.repositoryRoot,
        command.query,
        command.variant,
        command.provider,
      );
      const output = { ...asset, path: displayPath(context.paths.repositoryRoot, asset.path) };
      writeValue(context.io, command.json, output, () => `${asset.emoji} ${asset.name}\t${output.path}\t${asset.sha256}`);
      return;
    }
  }
}

interface MutationTarget {
  readonly command: string;
  readonly directory: string;
  readonly label: string;
  readonly scope: "private" | "project" | "recording";
}

type MutationReference =
  | { readonly kind: "private" }
  | { readonly kind: "workspace-private" }
  | { readonly kind: "project"; readonly reference: string }
  | { readonly kind: "recording"; readonly reference: string };

function commandMutationReference(command: CliCommand): MutationReference | undefined {
  switch (command.kind) {
    case "project-camera-edit": return command.action === "show"
      ? undefined
      : { kind: "project", reference: command.project };
    case "project-add":
    case "project-edit":
    case "project-metadata-edit":
    case "project-overlay-edit":
    case "project-render":
    case "align-analyze":
    case "align-apply":
    case "analyze-faces":
    case "analyze-music":
    case "analyze-speech":
    case "fillers-apply": return { kind: "project", reference: command.project };
    case "analyze-scenes": return command.execute
      ? { kind: "project", reference: command.project }
      : undefined;
    case "analyze-inactivity": return command.recording.startsWith("project_")
      ? { kind: "project", reference: command.recording }
      : { kind: "recording", reference: command.recording };
    case "edit": return command.edit.operation === "show"
      ? undefined
      : { kind: "recording", reference: command.recording };
    case "analyze-zooms": return command.apply
      ? { kind: "recording", reference: command.recording }
      : undefined;
    case "render-plan":
    case "render-run": return { kind: "recording", reference: command.recording };
    case "ai-provider-options-inspect": return undefined;
    case "ai-models-list":
    case "ai-models-show":
    case "media-audio":
    case "media-color":
    case "diagram-render":
    case "image-vectorize": return { kind: "workspace-private" };
    case "ai-image-generate":
    case "ai-video-generate":
    case "ai-speech-generate":
    case "ai-transcribe": return undefined;
    case "help":
    case "version":
    case "operations-list":
    case "operations-show":
    case "diagram-check":
    case "workflows-list":
    case "workflows-show":
    case "workflows-plan":
    case "workflows-run":
    case "code-init":
    case "code-check":
    case "code-plan":
    case "code-run":
    case "runs-list":
    case "runs-show":
    case "runs-resume":
    case "runs-approve":
    case "runs-cancel":
    case "doctor":
    case "recordings-list":
    case "projects-list":
    case "project-inspect":
    case "inspect":
    case "events":
    case "faces-list":
    case "fillers-list":
    case "emoji-search":
    case "emoji-resolve":
    case "complete": return undefined;
    // These write outside an existing mutable bundle: fresh projects publish by
    // atomic rename and capture has its own controller.
    case "projects-create":
    case "record": return undefined;
  }
}

function mutationCommandName(command: CliCommand): string {
  if (command.kind === "edit") return `${command.kind}:${command.edit.operation}`;
  if (command.kind === "project-edit") return `${command.kind}:${command.operation}`;
  if (command.kind === "project-camera-edit") return `${command.kind}:${command.action}`;
  if (command.kind === "project-metadata-edit" || command.kind === "project-overlay-edit") {
    return `${command.kind}:${command.edit.operation}`;
  }
  if (command.kind === "project-render") return `${command.kind}:${command.action}`;
  return command.kind;
}

async function resolveMutationTarget(
  paths: RepositoryPaths,
  stateRoot: string,
  command: CliCommand,
): Promise<MutationTarget | undefined> {
  const reference = commandMutationReference(command);
  if (reference?.kind === "private") {
    await ensurePrivateDirectory(stateRoot);
    return {
      command: mutationCommandName(command),
      directory: stateRoot,
      label: "Atet local state",
      scope: "private",
    };
  }
  if (reference?.kind === "workspace-private") {
    await ensurePrivateDirectory(paths.privateRoot);
    return {
      command: mutationCommandName(command),
      directory: paths.privateRoot,
      label: "Atet repository-private media state",
      scope: "private",
    };
  }
  if (reference?.kind === "project") {
    const project = await resolveProjectDirectory(paths.projectRoot, reference.reference);
    return {
      command: mutationCommandName(command),
      directory: project.path,
      label: `project ${project.id}`,
      scope: "project",
    };
  }
  if (reference?.kind === "recording") {
    const recording = await resolveRecordingDirectory(paths.artifactRoot, reference.reference);
    return {
      command: mutationCommandName(command),
      directory: recording.path,
      label: `recording ${recording.id}`,
      scope: "recording",
    };
  }
  return undefined;
}

export async function runCli(argv: readonly string[], dependencies: CliDependencies = {}): Promise<number> {
  const io = dependencies.io ?? processIo;
  let jsonRequested = argv.includes("--json") || argv.includes("--jsonl");
  try {
    const command = parseCliArgs(argv);
    jsonRequested = "json" in command ? command.json : command.kind === "events" && command.format !== "human";
    if (command.kind === "help") {
      writeLine(io, commandHelp(command.topic));
      return 0;
    }
    if (command.kind === "version") {
      writeLine(io, dependencies.version ?? ATET_VERSION);
      return 0;
    }
    if (command.kind === "complete") {
      for (const completion of completions(command.words)) writeLine(io, completion);
      return 0;
    }
    const paths = dependencies.paths ?? await resolveRepositoryPaths(io.cwd(), io.env);
    const stateRoot = resolve(dependencies.stateRoot
      ?? defaultCliStateRoot(io.platform, io.env));
    const runner = dependencies.runner ?? new BunProcessRunner();
    const fetchImplementation = dependencies.fetch ?? globalThis.fetch;
    let capabilityPromise: Promise<readonly Capability[]> | undefined;
    const capabilityPromises = new Map<CapabilityName, Promise<Capability>>();
    const capability = (
      name: CapabilityName,
      signal?: AbortSignal,
      inheritedFileDescriptors?: readonly number[],
    ): Promise<Capability> => {
      if (signal !== undefined || inheritedFileDescriptors !== undefined) {
        return probeCapability(
          runner,
          paths.desktopRoot,
          io.env,
          name,
          signal,
          inheritedFileDescriptors,
        );
      }
      const existing = capabilityPromises.get(name);
      if (existing !== undefined) return existing;
      const pending = probeCapability(runner, paths.desktopRoot, io.env, name);
      capabilityPromises.set(name, pending);
      return pending;
    };
    const context: CommandContext = {
      stateRoot,
      capability,
      capabilities: inheritedFileDescriptors => {
        if (inheritedFileDescriptors !== undefined) {
          return Promise.all(
            capabilityCandidates(paths.desktopRoot, io.env)
              .map(async definition => await capability(
                definition.name,
                undefined,
                inheritedFileDescriptors,
              )),
          );
        }
        capabilityPromise ??= Promise.all(
          capabilityCandidates(paths.desktopRoot, io.env)
            .map(async definition => await capability(definition.name)),
        );
        return capabilityPromise;
      },
      clock: dependencies.clock ?? (() => io.now().getTime()),
      fetch: fetchImplementation,
      gatewayCatalogTransport: dependencies.gatewayCatalogTransport
        ?? createHttpGatewayMediaCatalogTransport({
          fetch: fetchImplementation,
        }),
      gatewayMediaDownload: dependencies.gatewayMediaDownload
        ?? createBoundedGatewayMediaDownload(),
      gatewayMediaSdk: dependencies.gatewayMediaSdk ?? createAiSdkGatewayMediaSdk({
        fetch: fetchImplementation,
      }),
      hostResourceCoordinator: dependencies.hostResourceCoordinator
        ?? createDefaultHostResourceCoordinator(),
      io,
      paths,
      recordingController: dependencies.recordingController,
      runner,
      sceneProviderFactory: dependencies.sceneProviderFactory
        ?? (options => createGatewaySceneProvider(options)),
      sleep: dependencies.sleep ?? (async milliseconds => await Bun.sleep(milliseconds)),
      version: dependencies.version ?? ATET_VERSION,
    };
    const mutationTarget = await resolveMutationTarget(paths, stateRoot, command);
    await withCommandHostResources(context, command, async admittedContext => {
      if (mutationTarget === undefined) {
        await dispatch(admittedContext, command);
        return;
      }
      await withMutationLock(mutationTarget.directory, mutationTarget, async () => {
        if (mutationTarget.scope === "project") {
          await recoverProjectStateTransaction(createNodeBundleFileSystem(mutationTarget.directory));
        }
        await dispatch(admittedContext, command);
      });
    });
    return 0;
  } catch (error) {
    const failure = asCliError(error);
    const payload = {
      error: {
        code: failure.code,
        ...(failure.details === undefined ? {} : { details: failure.details }),
        message: failure.message,
      },
    };
    if (jsonRequested) io.stderr(`${JSON.stringify(payload)}\n`);
    else io.stderr(`atet: ${failure.message}\n`);
    return EXIT_CODE[failure.code];
  }
}
