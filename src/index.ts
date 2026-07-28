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
  transmuteAuthStatus,
  loginTransmute,
  logoutTransmute,
  requireTransmuteAuthentication,
} from "./auth.js"
import { fetchTransmuteDiscovery, parseTransmuteDiscovery } from "./discovery.js"
import {
  generateTransmuteImage,
  generateTransmuteImageFile,
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
  executeTransmuteOperation,
  transmuteOperationRegistry,
  searchTransmuteOperations,
} from "./operations.js"
import {
  transmuteMcpProtocolVersion,
  transmuteMcpServerName,
  transmuteMcpTools,
  TransmuteMcpToolRuntime,
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

export const diagramApi = Object.freeze({
  artifactSummary,
  builtInIcons,
  bundledSkillPath,
  checkDiagramFile,
  desktopDownloadPage,
  desktopStatus,
  DiagramValidationError,
  findDesktopApplication,
  fetchTransmuteDiscovery,
  generateTransmuteImage,
  generateTransmuteImageFile,
  getLatestDesktopRelease,
  transmuteAuthStatus,
  transmuteMcpProtocolVersion,
  transmuteMcpServerName,
  transmuteMcpTools,
  transmuteOperationRegistry,
  TransmuteMcpToolRuntime,
  installDesktop,
  installSkill,
  lintDiagram,
  loginTransmute,
  logoutTransmute,
  mcpMaximumRenderedPixels,
  mcpMaximumScale,
  mcpSourceByteLimit,
  openInDesktop,
  parseDiagramSource,
  parseDiagramSpec,
  parseTransmuteDiscovery,
  readDiagramFile,
  renderDiagramFile,
  renderPng,
  renderSvg,
  resolveEdge,
  resolveDiagramSource,
  resolveStackLayout,
  requireTransmuteAuthentication,
  runMcpServer,
  searchTransmuteOperations,
  selectDesktopAsset,
  serializeTldr,
  stackLayoutDefaults,
  StackLayoutError,
  vectorizeImage,
  WorkspaceBoundary,
  WorkspaceBoundaryError,
  executeTransmuteOperation,
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
  fetchTransmuteDiscovery,
  generateTransmuteImage,
  generateTransmuteImageFile,
  getLatestDesktopRelease,
  transmuteAuthStatus,
  transmuteMcpProtocolVersion,
  transmuteMcpServerName,
  transmuteMcpTools,
  transmuteOperationRegistry,
  TransmuteMcpToolRuntime,
  installDesktop,
  installSkill,
  lintDiagram,
  loginTransmute,
  logoutTransmute,
  mcpMaximumRenderedPixels,
  mcpMaximumScale,
  mcpSourceByteLimit,
  openInDesktop,
  parseDiagramSource,
  parseDiagramSpec,
  parseTransmuteDiscovery,
  readDiagramFile,
  renderDiagramFile,
  renderPng,
  renderSvg,
  resolveDiagramSource,
  resolveEdge,
  resolveStackLayout,
  requireTransmuteAuthentication,
  runMcpServer,
  searchTransmuteOperations,
  selectDesktopAsset,
  serializeTldr,
  stackLayoutDefaults,
  StackLayoutError,
  vectorizeImage,
  WorkspaceBoundary,
  WorkspaceBoundaryError,
  executeTransmuteOperation,
}
export * from "./auth.js"
export * from "./cloud-errors.js"
export * from "./discovery.js"
export * from "./generate.js"
export * from "./operations.js"
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
