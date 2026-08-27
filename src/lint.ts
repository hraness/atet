import { estimateDiagramTextWidth, layoutBoxContent } from "./label-layout.js"
import { resolveEdge } from "./render.js"
import type { BoxShape, DiagramSpec, LintFinding } from "./types.js"

function boxOutsideCanvas(shape: BoxShape, spec: DiagramSpec): boolean {
  return (
    shape.x < 0 ||
    shape.y < 0 ||
    shape.x + shape.width > spec.canvas.width ||
    shape.y + shape.height > spec.canvas.height
  )
}

export function lintDiagram(spec: DiagramSpec): readonly LintFinding[] {
  const findings: LintFinding[] = []
  const boxes = spec.shapes.filter(
    (shape): shape is BoxShape => shape.type === "rect" || shape.type === "ellipse",
  )

  for (const shape of boxes) {
    if (boxOutsideCanvas(shape, spec)) {
      findings.push({
        code: "outside-canvas",
        message: `${shape.id} extends beyond the canvas`,
        shapeIds: [shape.id],
      })
    }
    const labels =
      shape.labelRows?.map((row) => row.text) ?? (shape.label === undefined ? [] : [shape.label])
    const longLabel = labels.find((label) => label.length > 32)
    if (longLabel !== undefined) {
      findings.push({
        code: "long-label",
        message: `${shape.id} has a ${longLabel.length}-character label; prefer a short noun phrase`,
        shapeIds: [shape.id],
      })
    }
    const iconSize =
      shape.icon === undefined
        ? undefined
        : Math.min(shape.iconSize ?? 52, shape.height * 0.45, shape.width * 0.32)
    const content = layoutBoxContent(shape, iconSize)
    const contentTop = content.icon?.y ?? content.rows[0]?.y
    const finalRow = content.rows.at(-1)
    const contentBottom =
      finalRow === undefined
        ? content.icon === undefined
          ? undefined
          : content.icon.y + content.icon.size
        : finalRow.y + finalRow.height
    const contentWidth = Math.max(1, shape.width - 32)
    const exceedsWidth = content.rows.some((row) =>
      row.lines.some(
        (line) => estimateDiagramTextWidth(line, row.fontSize, row.fontFamily) > contentWidth,
      ),
    )
    if (
      contentTop !== undefined &&
      contentBottom !== undefined &&
      (contentTop < shape.y || contentBottom > shape.y + shape.height || exceedsWidth)
    ) {
      findings.push({
        code: "label-overflow",
        message: `${shape.id} label and icon content exceeds the box bounds; increase the box or reduce authored sizes`,
        shapeIds: [shape.id],
      })
    }
    if (shape.width < 120 || shape.height < 64) {
      findings.push({
        code: "small-target",
        message: `${shape.id} is small enough to make its label or icon hard to scan`,
        shapeIds: [shape.id],
      })
    }
  }

  if (boxes.length > 9) {
    findings.push({
      code: "too-many-elements",
      message: `The diagram has ${boxes.length} primary shapes; consider a higher-level visual`,
      shapeIds: boxes.map((shape) => shape.id),
    })
  }

  const sharedTerminals = new Map<string, { readonly edgeId: string; readonly shapeId: string }[]>()
  for (const edge of spec.edges ?? []) {
    const resolved = resolveEdge(spec, edge)
    for (const terminal of [
      { kind: "start", point: resolved.start, shapeId: edge.from },
      { kind: "end", point: resolved.end, shapeId: edge.to },
    ] as const) {
      const key = `${terminal.kind}:${terminal.shapeId}:${terminal.point.x.toFixed(3)}:${terminal.point.y.toFixed(3)}`
      const group = sharedTerminals.get(key) ?? []
      group.push({ edgeId: edge.id, shapeId: terminal.shapeId })
      sharedTerminals.set(key, group)
    }
    const length = Math.hypot(
      resolved.end.x - resolved.start.x,
      resolved.end.y - resolved.start.y,
    )
    if (length < 96) {
      findings.push({
        code: "short-arrow",
        message: `${edge.id} is ${Math.round(length)}px long; leave more space between connected shapes`,
        shapeIds: [edge.from, edge.to],
      })
    }
    if (edge.label !== undefined && edge.label.length > 24) {
      findings.push({
        code: "long-edge-label",
        message: `${edge.id} has a long connector label; prefer one short relation`,
        shapeIds: [edge.from, edge.to],
      })
    }
  }

  for (const group of sharedTerminals.values()) {
    if (group.length < 2) continue
    findings.push({
      code: "shared-edge-port",
      message: `${group.map(({ edgeId }) => edgeId).join(", ")} share one connector port; set distinct startPosition or endPosition values`,
      shapeIds: [group[0]!.shapeId],
    })
  }

  return findings
}
