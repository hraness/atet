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
import { builtInIcons } from "./icons.ts"
import { lintDiagram } from "./lint.ts"
import { DiagramValidationError, parseDiagramSpec } from "./parse.ts"
import { renderPng, renderSvg, resolveEdge } from "./render.ts"
import { bundledSkillPath, installSkill } from "./skill-install.ts"
import { serializeTldr } from "./tldr.ts"

export const diagramApi = Object.freeze({
  artifactSummary,
  builtInIcons,
  bundledSkillPath,
  checkDiagramFile,
  desktopDownloadPage,
  desktopStatus,
  DiagramValidationError,
  findDesktopApplication,
  getLatestDesktopRelease,
  installDesktop,
  installSkill,
  lintDiagram,
  openInDesktop,
  parseDiagramSpec,
  readDiagramFile,
  renderDiagramFile,
  renderPng,
  renderSvg,
  resolveEdge,
  selectDesktopAsset,
  serializeTldr,
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
  getLatestDesktopRelease,
  installDesktop,
  installSkill,
  lintDiagram,
  openInDesktop,
  parseDiagramSpec,
  readDiagramFile,
  renderDiagramFile,
  renderPng,
  renderSvg,
  resolveEdge,
  selectDesktopAsset,
  serializeTldr,
}
export type * from "./types.ts"
