import type {
  HtmlOverlayAuthoringInput,
  HtmlOverlayDeclaredResource,
  HtmlOverlayLibraryLock,
} from "../html-overlay";
import type { HtmlOverlayBrowserRuntimeBinding } from "./html-overlay-browser-runtime";
import type { HtmlOverlayExecutionIntegrity } from "./html-overlay-integrity";

export interface BoundHtmlOverlayResource extends HtmlOverlayDeclaredResource {
  /** Exact, descriptor-pinned source selected by the application boundary. */
  readonly absolutePath: string;
}

export interface HtmlOverlayFrameRenderRequest {
  readonly authoring: HtmlOverlayAuthoringInput;
  /** Complete browser runtime tree captured during node planning. */
  readonly browserRuntime: HtmlOverlayBrowserRuntimeBinding;
  readonly outputDirectory: string;
  readonly resources: readonly BoundHtmlOverlayResource[];
}

export interface HtmlOverlayFrameRenderResult {
  /** Merkle binding for the browser tree, document, runtime, modules, and assets used. */
  readonly executionIntegrity: HtmlOverlayExecutionIntegrity;
  readonly frameCount: number;
  /** Absolute printf-style path accepted by FFmpeg, for example frame-%08d.png. */
  readonly framePattern: string;
  readonly libraryLocks: readonly HtmlOverlayLibraryLock[];
}

/**
 * Effectful browser boundary. Application tests replace it with a deterministic
 * fake; the CLI host supplies the Chromium implementation.
 */
export interface HtmlOverlayRenderer {
  renderFrames(
    request: HtmlOverlayFrameRenderRequest,
    signal: AbortSignal,
  ): Promise<HtmlOverlayFrameRenderResult>;
}
