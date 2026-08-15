import type { HostResourceLease } from "@hraness/atet/host-resources";

import type { ApplicationGatewayPort } from "./gateway-port";
import type { HtmlOverlayRenderer } from "./html-overlay-renderer";

export interface ApplicationPaths {
  readonly artifactRoot: string;
  readonly desktopRoot: string;
  readonly privateRoot: string;
  readonly projectRoot: string;
  readonly repositoryRoot: string;
}

export interface ApplicationProcessRunOptions {
  readonly abortSignal?: AbortSignal;
  readonly cwd?: string;
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly inheritedFileDescriptors?: readonly number[];
  readonly maxOutputBytes?: number;
  readonly stdin?: "ignore";
  readonly timeoutMs?: number;
}

export interface ApplicationProcessRunResult {
  readonly exitCode: number;
  readonly stderr: string;
  readonly stdout: string;
}

export interface ApplicationProcessRunner {
  run(
    argv: readonly [string, ...string[]],
    options?: ApplicationProcessRunOptions,
  ): Promise<ApplicationProcessRunResult>;
}

export type ApplicationCapabilityName =
  | "ffmpeg"
  | "ffprobe"
  | "rsvg-convert"
  | "whisper-cpp"
  | "capture-helper"
  | "face-analyzer"
  | "html-browser";

export interface ApplicationCapability {
  readonly available: boolean;
  readonly command?: string;
  readonly name: ApplicationCapabilityName;
  readonly reason?: string;
  readonly version?: string;
}

export interface ApplicationRecordingController {
  execute(
    action: "pause" | "resume" | "start" | "stop",
    options?: unknown,
  ): Promise<unknown>;
  status(): Promise<unknown>;
}

export interface ApplicationClock {
  readonly now: () => Date;
  readonly timestampMilliseconds: () => number;
}

export interface ApplicationHostResourceLease extends HostResourceLease {
  readonly inheritedFileDescriptors: readonly number[];
}

export interface ApplicationContext {
  readonly capability: (
    name: ApplicationCapabilityName,
  ) => Promise<ApplicationCapability>;
  readonly capabilities: (
    inheritedFileDescriptors?: readonly number[],
  ) => Promise<readonly ApplicationCapability[]>;
  readonly clock: ApplicationClock;
  readonly gatewayPort?: ApplicationGatewayPort;
  readonly hostResourceLease?: ApplicationHostResourceLease;
  readonly htmlOverlayRenderer?: HtmlOverlayRenderer;
  /** Per-user host state shared by repository worktrees for mutation leases. */
  readonly machineStateRoot?: string;
  readonly paths: ApplicationPaths;
  readonly recordingController?: ApplicationRecordingController;
  readonly runner: ApplicationProcessRunner;
}
