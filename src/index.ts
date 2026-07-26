import {
  artifactSummary,
  checkDiagramFile,
  readDiagramFile,
  renderDiagramFile,
} from "./artifacts.ts"
import {
  desktopDownloadPage,
  desktopStatus,
  findDesktopApplication,
  getLatestDesktopRelease,
  installDesktop,
  openInDesktop,
  selectDesktopAsset,
} from "./desktop.ts"
import {
  graphicsAuthStatus,
  loginGraphics,
  logoutGraphics,
  requireGraphicsAuthentication,
} from "./auth.ts"
import { fetchGraphicsDiscovery, parseGraphicsDiscovery } from "./discovery.ts"
import {
  generateGraphicsImage,
  generateGraphicsImageFile,
} from "./generate.ts"
import { builtInIcons } from "./icons.ts"
import {
  resolveDiagramSource,
  resolveStackLayout,
  stackLayoutDefaults,
  StackLayoutError,
} from "./layout.ts"
import { lintDiagram } from "./lint.ts"
import {
  executeGraphicsOperation,
  graphicsOperationRegistry,
  searchGraphicsOperations,
} from "./operations.ts"
import {
  graphicsMcpProtocolVersion,
  graphicsMcpServerName,
  graphicsMcpTools,
  GraphicsMcpToolRuntime,
  mcpMaximumRenderedPixels,
  mcpMaximumScale,
  mcpSourceByteLimit,
  runMcpServer,
  WorkspaceBoundary,
  WorkspaceBoundaryError,
} from "./mcp/index.ts"
import {
  DiagramValidationError,
  parseDiagramSource,
  parseDiagramSpec,
} from "./parse.ts"
import { renderPng, renderSvg, resolveEdge } from "./render.ts"
import { bundledSkillPath, installSkill } from "./skill-install.ts"
import { serializeTldr } from "./tldr.ts"
import { vectorizeImage } from "./vectorize/vectorize.ts"

export const diagramApi = Object.freeze({
  artifactSummary,
  builtInIcons,
  bundledSkillPath,
  checkDiagramFile,
  desktopDownloadPage,
  desktopStatus,
  DiagramValidationError,
  findDesktopApplication,
  fetchGraphicsDiscovery,
  generateGraphicsImage,
  generateGraphicsImageFile,
  getLatestDesktopRelease,
  graphicsAuthStatus,
  graphicsMcpProtocolVersion,
  graphicsMcpServerName,
  graphicsMcpTools,
  graphicsOperationRegistry,
  GraphicsMcpToolRuntime,
  installDesktop,
  installSkill,
  lintDiagram,
  loginGraphics,
  logoutGraphics,
  mcpMaximumRenderedPixels,
  mcpMaximumScale,
  mcpSourceByteLimit,
  openInDesktop,
  parseDiagramSource,
  parseDiagramSpec,
  parseGraphicsDiscovery,
  readDiagramFile,
  renderDiagramFile,
  renderPng,
  renderSvg,
  resolveEdge,
  resolveDiagramSource,
  resolveStackLayout,
  requireGraphicsAuthentication,
  runMcpServer,
  searchGraphicsOperations,
  selectDesktopAsset,
  serializeTldr,
  stackLayoutDefaults,
  StackLayoutError,
  vectorizeImage,
  WorkspaceBoundary,
  WorkspaceBoundaryError,
  executeGraphicsOperation,
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
  fetchGraphicsDiscovery,
  generateGraphicsImage,
  generateGraphicsImageFile,
  getLatestDesktopRelease,
  graphicsAuthStatus,
  graphicsMcpProtocolVersion,
  graphicsMcpServerName,
  graphicsMcpTools,
  graphicsOperationRegistry,
  GraphicsMcpToolRuntime,
  installDesktop,
  installSkill,
  lintDiagram,
  loginGraphics,
  logoutGraphics,
  mcpMaximumRenderedPixels,
  mcpMaximumScale,
  mcpSourceByteLimit,
  openInDesktop,
  parseDiagramSource,
  parseDiagramSpec,
  parseGraphicsDiscovery,
  readDiagramFile,
  renderDiagramFile,
  renderPng,
  renderSvg,
  resolveDiagramSource,
  resolveEdge,
  resolveStackLayout,
  requireGraphicsAuthentication,
  runMcpServer,
  searchGraphicsOperations,
  selectDesktopAsset,
  serializeTldr,
  stackLayoutDefaults,
  StackLayoutError,
  vectorizeImage,
  WorkspaceBoundary,
  WorkspaceBoundaryError,
  executeGraphicsOperation,
}
export * from "./auth.ts"
export * from "./cloud-errors.ts"
export * from "./discovery.ts"
export * from "./generate.ts"
export * from "./operations.ts"
export type * from "./types.ts"
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
} from "./mcp/index.ts"
export {
  VectorizeError,
  vectorizeDefaultLimits,
  vectorizeHardLimits,
  vectorizeProfileNames,
  VTRACER_VERSION,
  vtracerReleases,
} from "./vectorize/index.ts"
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
} from "./vectorize/index.ts"
