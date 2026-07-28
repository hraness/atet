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
    if (shape.label !== undefined && shape.label.length > 32) {
      findings.push({
        code: "long-label",
        message: `${shape.id} has a ${shape.label.length}-character label; prefer a short noun phrase`,
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

  for (const edge of spec.edges ?? []) {
    const resolved = resolveEdge(spec, edge)
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

  return findings
}
