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
  generateAtetImage,
  generateAtetImageFile,
  atetGatewayCredentialStatus,
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
  executeAtetOperation,
  atetOperationRegistry,
  searchAtetOperations,
} from "./operations.js"
import {
  atetMcpProtocolVersion,
  atetMcpServerName,
  atetMcpTools,
  AtetMcpToolRuntime,
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
  defineAtetWorkflow,
  runAtetWorkflow,
  AtetWorkflowError,
} from "./workflow.js"

export const diagramApi = Object.freeze({
  artifactSummary,
  builtInIcons,
  bundledSkillPath,
  checkDiagramFile,
  desktopDownloadPage,
  desktopStatus,
  DiagramValidationError,
  findDesktopApplication,
  generateAtetImage,
  generateAtetImageFile,
  getLatestDesktopRelease,
  atetGatewayCredentialStatus,
  atetMcpProtocolVersion,
  atetMcpServerName,
  atetMcpTools,
  atetOperationRegistry,
  AtetMcpToolRuntime,
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
  runMcpServer,
  searchAtetOperations,
  selectDesktopAsset,
  serializeTldr,
  stackLayoutDefaults,
  StackLayoutError,
  vectorizeImage,
  WorkspaceBoundary,
  WorkspaceBoundaryError,
  executeAtetOperation,
})

export {
  artifactSummary,
  builtInIcons,
  bundledSkillPath,
  checkDiagramFile,
  desktopDownloadPage,
  desktopStatus,
  DiagramValidationError,
  findDesktopApplication,
  generateAtetImage,
  generateAtetImageFile,
  getLatestDesktopRelease,
  atetGatewayCredentialStatus,
  atetMcpProtocolVersion,
  atetMcpServerName,
  atetMcpTools,
  atetOperationRegistry,
  AtetMcpToolRuntime,
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
  searchAtetOperations,
  selectDesktopAsset,
  serializeTldr,
  stackLayoutDefaults,
  StackLayoutError,
  vectorizeImage,
  defineAtetWorkflow,
  runAtetWorkflow,
  AtetWorkflowError,
  WorkspaceBoundary,
  WorkspaceBoundaryError,
  executeAtetOperation,
}
export * from "./cloud-errors.js"
export * from "./generate.js"
export * from "./host-resources.js"
export * from "./operations.js"
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
