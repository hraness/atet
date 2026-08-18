import type {
  HostResourceClaim,
  HostResourceCoordinator,
} from "@hraness/transmute/host-resources";

import type { OperationResourceClaim } from "../application/operation";
import { physicalHostResourceClaims } from "../code/host-resource-policy";
import type { CliCommand } from "./args";

function claims(
  coordinator: HostResourceCoordinator,
  resources: readonly OperationResourceClaim["resource"][],
): readonly HostResourceClaim[] {
  return physicalHostResourceClaims(
    [...new Set(resources)].map(resource => ({ amount: 1, resource })),
    coordinator,
  );
}

export function hostResourceClaimsCover(
  available: readonly HostResourceClaim[],
  required: readonly HostResourceClaim[],
): boolean {
  const totals = new Map<string, number>();
  for (const claim of available) {
    totals.set(claim.resource, (totals.get(claim.resource) ?? 0) + claim.amount);
  }
  return required.every(claim => (
    (totals.get(claim.resource) ?? 0) >= claim.amount
  ));
}

/** The exact additional vector needed beside an already-owned phase lease. */
export function missingHostResourceClaims(
  available: readonly HostResourceClaim[],
  required: readonly HostResourceClaim[],
): readonly HostResourceClaim[] {
  const totals = new Map<string, number>();
  for (const claim of available) {
    totals.set(claim.resource, (totals.get(claim.resource) ?? 0) + claim.amount);
  }
  return required.flatMap((claim) => {
    const missing = claim.amount - (totals.get(claim.resource) ?? 0);
    return missing > 0 ? [{ amount: missing, resource: claim.resource }] : [];
  });
}

/** Combine independently owned phase vectors without losing partial claims. */
export function combineHostResourceClaims(
  ...claimSets: readonly (readonly HostResourceClaim[])[]
): readonly HostResourceClaim[] {
  const totals = new Map<string, number>();
  for (const claim of claimSets.flat()) {
    totals.set(claim.resource, (totals.get(claim.resource) ?? 0) + claim.amount);
  }
  return [...totals]
    .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
    .map(([resource, amount]) => ({ amount, resource }));
}

/**
 * Bundling and worker-pool initialization have no proven execution-wide
 * thread budget. Admit them against the complete CPU pool and one local-I/O
 * slot, then release the lease before scheduler-owned node execution begins.
 */
export function codePreparationHostResourceClaims(
  coordinator: HostResourceCoordinator,
): readonly HostResourceClaim[] {
  const cpu = coordinator.profile.capacities.find(
    capacity => capacity.resource === "cpu",
  );
  const localIo = coordinator.profile.capacities.find(
    capacity => capacity.resource === "local-io",
  );
  return [
    ...(cpu === undefined ? [] : [{ amount: cpu.limit, resource: "cpu" }]),
    ...(localIo === undefined ? [] : [{ amount: 1, resource: "local-io" }]),
  ];
}

/**
 * A trusted-code worker can consume one scheduler CPU claim. Starting more
 * workers than the machine profile can ever admit only adds build time and
 * resident memory while those workers wait.
 */
export function computeWorkerPoolSize(
  requestedJobs: number,
  computeNodes: number,
  coordinator: HostResourceCoordinator,
): number {
  if (
    !Number.isSafeInteger(requestedJobs)
    || requestedJobs < 1
    || !Number.isSafeInteger(computeNodes)
    || computeNodes < 1
  ) {
    throw new TypeError("Compute worker pool bounds must be positive safe integers.");
  }
  const cpuCapacity = coordinator.profile.capacities.find(
    capacity => capacity.resource === "cpu",
  )?.limit ?? 1;
  return Math.min(requestedJobs, computeNodes, cpuCapacity);
}

/** Apply the same physical-CPU ceiling when a run reloads persisted workers. */
export function replayComputeWorkerPoolSize(
  requestedJobs: number,
  replayNodeKeys: readonly string[],
  coordinator: HostResourceCoordinator,
): number {
  return computeWorkerPoolSize(
    requestedJobs,
    new Set(replayNodeKeys).size,
    coordinator,
  );
}

/**
 * Map CLI commands onto the same physical host pools used by Code Mode.
 * Workflow commands are intentionally omitted because their node scheduler
 * admits each exact operation independently.
 */
export function commandHostResourceClaims(
  command: CliCommand,
  coordinator: HostResourceCoordinator,
): readonly HostResourceClaim[] {
  switch (command.kind) {
    case "align-analyze":
    case "analyze-inactivity":
    case "analyze-music":
    case "media-audio":
    case "media-color":
      return claims(coordinator, ["cpu", "ffmpeg", "local-io"]);
    case "media-compose":
      return claims(coordinator, [
        "cpu",
        "ffmpeg",
        "local-io",
        "project-render",
      ]);
    case "analyze-scenes":
      return claims(
        coordinator,
        command.execute
          ? ["cpu", "ffmpeg", "local-io", "network", "paid-call"]
          : ["cpu", "ffmpeg", "local-io"],
      );
    case "analyze-speech":
      return claims(coordinator, [
        "cpu",
        "ffmpeg",
        "local-io",
        "whisper",
      ]);
    case "render-run":
      return claims(coordinator, [
        "cpu",
        "ffmpeg",
        "local-io",
        "project-render",
      ]);
    case "render-plan":
      return command.autoInactivity
        ? claims(coordinator, ["cpu", "ffmpeg", "local-io"])
        : claims(coordinator, ["cpu", "local-io"]);
    case "project-render":
      return command.action === "run"
        ? claims(coordinator, [
            "cpu",
            "ffmpeg",
            "local-io",
            "project-render",
          ])
        : claims(coordinator, ["cpu", "local-io"]);
    case "analyze-faces":
      return claims(coordinator, ["cpu", "local-io", "vision"]);
    case "analyze-zooms":
    case "diagram-check":
    case "diagram-render":
    case "image-vectorize":
      return claims(coordinator, ["cpu", "local-io"]);
    case "project-add":
    case "project-overlay-edit":
      return claims(coordinator, ["cpu", "local-io"]);
    case "edit":
      return command.edit.operation === "overlay-add"
        ? claims(coordinator, ["cpu", "local-io"])
        : [];
    case "ai-image-generate":
    case "ai-transcribe":
    case "ai-video-generate":
    case "ai-speech-generate":
      // Local media inspection acquires its complete CPU/FFmpeg/I/O vector
      // only while validating bytes. Paid provider waits must not pin render
      // capacity across agents for their potentially long network lifetime.
      return claims(coordinator, ["network", "paid-call"]);
    case "ai-models-list":
    case "ai-models-show":
      return claims(coordinator, ["network"]);
    case "ai-provider-options-inspect":
    case "align-apply":
    case "code-init":
    case "code-run":
    case "complete":
    case "doctor":
    case "emoji-resolve":
    case "emoji-search":
    case "events":
    case "faces-list":
    case "fillers-apply":
    case "fillers-list":
    case "help":
    case "inspect":
    case "operations-list":
    case "operations-show":
    case "project-camera-edit":
    case "project-edit":
    case "project-inspect":
    case "project-metadata-edit":
    case "projects-create":
    case "projects-list":
    case "record":
    case "recordings-list":
    case "runs-approve":
    case "runs-cancel":
    case "runs-list":
    case "runs-resume":
    case "runs-show":
    case "version":
    case "workflows-list":
    case "workflows-run":
    case "workflows-show":
      return [];
    case "code-check":
    case "code-plan":
    case "workflows-plan":
      return codePreparationHostResourceClaims(coordinator);
  }
}
