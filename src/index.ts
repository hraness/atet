import {
  artifactSummary,
  checkDiagramFile,
  readDiagramFile,
  renderDiagramFile,
} from "./artifacts.js"
import {
  desktopDownloadPage,
  desktopStatus,
  findDesktopApplication,
  getLatestDesktopRelease,
  installDesktop,
  openInDesktop,
  selectDesktopAsset,
} from "./desktop.js"
import {
  generateSlopcameraImage,
  generateSlopcameraImageFile,
  slopcameraGatewayCredentialStatus,
} from "./generate.js"
import { builtInIcons } from "./icons.js"
import {
  resolveDiagramSource,
  resolveStackLayout,
  stackLayoutDefaults,
  StackLayoutError,
} from "./layout.js"
import { lintDiagram } from "./lint.js"
import {
  executeSlopcameraOperation,
  slopcameraOperationRegistry,
  searchSlopcameraOperations,
} from "./operations.js"
import {
  slopcameraMcpProtocolVersion,
  slopcameraMcpServerName,
  slopcameraMcpTools,
  SlopcameraMcpToolRuntime,
  mcpMaximumRenderedPixels,
  mcpMaximumScale,
  mcpSourceByteLimit,
  runMcpServer,
  WorkspaceBoundary,
  WorkspaceBoundaryError,
} from "./mcp/index.js"
import {
  DiagramValidationError,
  parseDiagramSource,
  parseDiagramSpec,
} from "./parse.js"
import { renderPng, renderSvg, resolveEdge } from "./render.js"
import { bundledSkillPath, installSkill } from "./skill-install.js"
import { serializeTldr } from "./tldr.js"
import { vectorizeImage } from "./vectorize/vectorize.js"
import {
  defineSlopcameraWorkflow,
  runSlopcameraWorkflow,
  SlopcameraWorkflowError,
} from "./workflow.js"
export { SLOPCAMERA_VERSION } from "./version.js"

export const slopcameraApi = Object.freeze({
  artifactSummary,
  builtInIcons,
  bundledSkillPath,
  checkDiagramFile,
  desktopDownloadPage,
  desktopStatus,
  defineSlopcameraWorkflow,
  DiagramValidationError,
  findDesktopApplication,
  generateSlopcameraImage,
  generateSlopcameraImageFile,
  getLatestDesktopRelease,
  slopcameraGatewayCredentialStatus,
  slopcameraMcpProtocolVersion,
  slopcameraMcpServerName,
  slopcameraMcpTools,
  slopcameraOperationRegistry,
  SlopcameraMcpToolRuntime,
  installDesktop,
  installSkill,
  lintDiagram,
  mcpMaximumRenderedPixels,
  mcpMaximumScale,
  mcpSourceByteLimit,
  openInDesktop,
  parseDiagramSource,
  parseDiagramSpec,
  readDiagramFile,
  renderDiagramFile,
  renderPng,
  renderSvg,
  resolveEdge,
  resolveDiagramSource,
  resolveStackLayout,
  runSlopcameraWorkflow,
  runMcpServer,
  searchSlopcameraOperations,
  selectDesktopAsset,
  serializeTldr,
  stackLayoutDefaults,
  StackLayoutError,
  SlopcameraWorkflowError,
  vectorizeImage,
  WorkspaceBoundary,
  WorkspaceBoundaryError,
  executeSlopcameraOperation,
})

/** @deprecated Use slopcameraApi. Retained through the Slopcamera 2.x line. */
export const diagramApi = slopcameraApi

export {
  artifactSummary,
  builtInIcons,
  bundledSkillPath,
  checkDiagramFile,
  desktopDownloadPage,
  desktopStatus,
  DiagramValidationError,
  findDesktopApplication,
  generateSlopcameraImage,
  generateSlopcameraImageFile,
  getLatestDesktopRelease,
  slopcameraGatewayCredentialStatus,
  slopcameraMcpProtocolVersion,
  slopcameraMcpServerName,
  slopcameraMcpTools,
  slopcameraOperationRegistry,
  SlopcameraMcpToolRuntime,
  installDesktop,
  installSkill,
  lintDiagram,
  mcpMaximumRenderedPixels,
  mcpMaximumScale,
  mcpSourceByteLimit,
  openInDesktop,
  parseDiagramSource,
  parseDiagramSpec,
  readDiagramFile,
  renderDiagramFile,
  renderPng,
  renderSvg,
  resolveDiagramSource,
  resolveEdge,
  resolveStackLayout,
  runMcpServer,
  searchSlopcameraOperations,
  selectDesktopAsset,
  serializeTldr,
  stackLayoutDefaults,
  StackLayoutError,
  vectorizeImage,
  defineSlopcameraWorkflow,
  runSlopcameraWorkflow,
  SlopcameraWorkflowError,
  WorkspaceBoundary,
  WorkspaceBoundaryError,
  executeSlopcameraOperation,
}
export * from "./cloud-errors.js"
export * from "./generate.js"
export * from "./host-resources.js"
export * from "./operations.js"
export * from "./studio/index.js"
export * from "./workflow.js"
export type * from "./types.js"
export type {
  JsonRpcFailure,
  JsonRpcId,
  JsonRpcResponseId,
  JsonRpcResponse,
  JsonRpcSuccess,
  McpServerOptions,
  McpTextContent,
  McpToolDefinition,
  McpToolResult,
} from "./mcp/index.js"
export {
  VectorizeError,
  vectorizeDefaultLimits,
  vectorizeHardLimits,
  vectorizeProfileNames,
  VTRACER_VERSION,
  vtracerReleases,
} from "./vectorize/index.js"
export type {
  VectorizeErrorCode,
  VectorizeInput,
  VectorizeLimits,
  VectorizeOptions,
  VectorizeOutputMode,
  VectorizeProfile,
  VectorizeProvenance,
  VectorizeQualityReceipt,
  VectorizeReceipt,
  VectorizeRepresentation,
  VectorizeResult,
} from "./vectorize/index.js"
