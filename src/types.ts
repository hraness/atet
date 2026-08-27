export const diagramVersion = 1 as const

export type Tone =
  | "neutral"
  | "blue"
  | "orange"
  | "green"
  | "red"
  | "purple"
  | "yellow"

export type Anchor = "auto" | "top" | "right" | "bottom" | "left"
export type ColorMode = "light" | "dark"
export type StackDirection = "horizontal" | "vertical"
export type StackAlign = "start" | "center" | "end"

export interface DiagramCanvas {
  readonly width: number
  readonly height: number
  readonly padding?: number
}

interface BaseShape {
  readonly id: string
  readonly x: number
  readonly y: number
  readonly tone?: Tone
  readonly opacity?: number
}

export interface BoxShape extends BaseShape {
  readonly type: "rect" | "ellipse"
  readonly width: number
  readonly height: number
  readonly radius?: number
  readonly label?: string
  readonly labelFontSize?: number
  readonly icon?: string
  readonly iconSize?: number
  readonly strokeWidth?: number
  readonly fill?: boolean
}

export interface TextShape extends BaseShape {
  readonly type: "text"
  readonly text: string
  readonly width?: number
  readonly fontSize?: number
  readonly weight?: 400 | 500 | 600 | 700
  readonly align?: "start" | "middle" | "end"
}

export interface LineShape extends BaseShape {
  readonly type: "line"
  readonly x2: number
  readonly y2: number
  readonly strokeWidth?: number
}

export type DiagramShape = BoxShape | TextShape | LineShape
export type StackShape = Omit<BoxShape, "x" | "y">

export interface DiagramEdge {
  readonly id: string
  readonly from: string
  readonly to: string
  readonly label?: string
  readonly tone?: Tone
  readonly start?: Anchor
  readonly end?: Anchor
  readonly bend?: number
  readonly arrowhead?: "arrow" | "triangle" | "none"
}

export interface StackDiagramEdge
  extends Omit<DiagramEdge, "start" | "end" | "bend"> {
  readonly start?: "auto"
  readonly end?: "auto"
  readonly bend?: 0
}

export interface DiagramSpec {
  readonly $schema?: string
  readonly version: typeof diagramVersion
  readonly name: string
  readonly canvas: DiagramCanvas
  readonly shapes: readonly DiagramShape[]
  readonly edges?: readonly DiagramEdge[]
}

export interface StackLayout {
  readonly type: "stack"
  readonly direction: StackDirection
  readonly gap?: number
  readonly align?: StackAlign
}

export interface StackDiagramSource {
  readonly $schema?: string
  readonly version: typeof diagramVersion
  readonly name: string
  readonly canvas: DiagramCanvas
  readonly layout: StackLayout
  readonly shapes: readonly StackShape[]
  readonly edges?: readonly StackDiagramEdge[]
}

export type DiagramSource = DiagramSpec | StackDiagramSource

export interface IconDefinition {
  readonly viewBox: string
  readonly body: string
}

export interface FontFile {
  readonly path: string
  readonly weight?: number
  readonly style?: "normal" | "italic"
  readonly embed?: boolean
}

export interface FontConfig {
  readonly family: string
  readonly files?: readonly FontFile[]
}

export interface ThemeColors {
  readonly background: string
  readonly foreground: string
  readonly muted: string
  readonly stroke: string
  readonly tones: Readonly<
    Record<Tone, { readonly fill: string; readonly stroke: string; readonly text: string }>
  >
}

export interface DiagramConfig {
  readonly font?: FontConfig
  readonly icons?: Readonly<Record<string, IconDefinition>>
  readonly theme?: {
    readonly light?: PartialTheme
    readonly dark?: PartialTheme
  }
}

export interface PartialTheme {
  readonly background?: string
  readonly foreground?: string
  readonly muted?: string
  readonly stroke?: string
  readonly tones?: Partial<
    Record<Tone, Partial<{ readonly fill: string; readonly stroke: string; readonly text: string }>>
  >
}

export interface LoadedConfig {
  readonly filePath: string | null
  readonly baseDirectory: string
  readonly value: DiagramConfig
}

export interface LintFinding {
  readonly code: string
  readonly message: string
  readonly shapeIds: readonly string[]
}

export interface RenderedDiagram {
  readonly mode: ColorMode
  readonly svg: string
  readonly width: number
  readonly height: number
}

export interface RenderArtifacts {
  readonly spec: string
  readonly tldr: string
  readonly lightSvg: string
  readonly darkSvg: string
  readonly lightPng: string
  readonly darkPng: string
}
