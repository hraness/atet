import type {
  HostResourceClaim,
  HostResourceCoordinator,
} from "@hraness/atet/host-resources";

import type {
  OperationResourceClaim,
  OperationResourceKind,
} from "../application/operation";

const PHYSICAL_HOST_RESOURCE_BY_OPERATION: Readonly<Partial<Record<
  OperationResourceKind,
  HostResourceClaim["resource"]
>>> = Object.freeze({
  browser: "browser",
  "capture-device": "capture-device",
  cpu: "cpu",
  ffmpeg: "ffmpeg",
  "local-io": "local-io",
  network: "network",
  "paid-call": "paid-call",
  "project-render": "video-encode",
  vision: "vision",
  whisper: "whisper",
});

/**
 * Convert semantic operation claims into the machine-wide physical budget.
 * Every FFmpeg recipe remains conservatively single-flight until its complete
 * decoder, filter, and encoder thread budget is bound into the exact plan.
 */
export function physicalHostResourceClaims(
  resources: readonly OperationResourceClaim[],
  coordinator: HostResourceCoordinator,
): readonly HostResourceClaim[] {
  const totals = new Map<string, number>();
  for (const claim of resources) {
    const resource = PHYSICAL_HOST_RESOURCE_BY_OPERATION[claim.resource];
    if (resource === undefined) continue;
    totals.set(resource, (totals.get(resource) ?? 0) + claim.amount);
  }
  if (resources.some(claim => (
    claim.resource === "ffmpeg" || claim.resource === "project-render"
  ))) {
    for (const resource of ["cpu", "ffmpeg"] as const) {
      const capacity = coordinator.profile.capacities.find(
        candidate => candidate.resource === resource,
      );
      if (capacity !== undefined) totals.set(resource, capacity.limit);
    }
  }
  return [...totals]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([resource, amount]) => ({ amount, resource }));
}
