// @bun
import {
  vectorizeImage
} from "./index-zhffnaj1.js";
import {
  atetMaximumPromptBytes,
  generateAtetImageFile
} from "./index-70c7xxz7.js";
import {
  createDefaultHostResourceCoordinator
} from "./index-6kb9qvnn.js";

// src/operations.ts
import { randomUUID } from "crypto";
import { mkdir, readFile as readFile2, rename, rm, writeFile } from "fs/promises";
import { dirname, join, resolve } from "path";

// src/icons.ts
var shared = 'fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"';
var builtInIcons = Object.freeze({
  brain: {
    viewBox: "0 0 24 24",
    body: `<path ${shared} d="M9.5 4.5A3.5 3.5 0 0 0 6 8v.35A3.5 3.5 0 0 0 5.5 15 3.5 3.5 0 0 0 9 19.5M14.5 4.5A3.5 3.5 0 0 1 18 8v.35a3.5 3.5 0 0 1 .5 6.65 3.5 3.5 0 0 1-3.5 4.5M9.5 4.5v15M14.5 4.5v15M6 9.5h3.5M14.5 14.5H18"/>`
  },
  check: {
    viewBox: "0 0 24 24",
    body: `<path ${shared} d="m5 12 4.25 4.25L19 6.5"/>`
  },
  code: {
    viewBox: "0 0 24 24",
    body: `<path ${shared} d="m8.5 7-5 5 5 5M15.5 7l5 5-5 5M13.5 4l-3 16"/>`
  },
  database: {
    viewBox: "0 0 24 24",
    body: `<ellipse ${shared} cx="12" cy="5" rx="7.5" ry="3"/><path ${shared} d="M4.5 5v7c0 1.66 3.36 3 7.5 3s7.5-1.34 7.5-3V5M4.5 12v7c0 1.66 3.36 3 7.5 3s7.5-1.34 7.5-3v-7"/>`
  },
  document: {
    viewBox: "0 0 24 24",
    body: `<path ${shared} d="M6 2.75h8l4 4V21.25H6zM14 2.75v4h4M9 11h6M9 15h6"/>`
  },
  globe: {
    viewBox: "0 0 24 24",
    body: `<circle ${shared} cx="12" cy="12" r="9"/><path ${shared} d="M3 12h18M12 3c2.4 2.45 3.5 5.45 3.5 9S14.4 18.55 12 21M12 3C9.6 5.45 8.5 8.45 8.5 12s1.1 6.55 3.5 9"/>`
  },
  search: {
    viewBox: "0 0 24 24",
    body: `<circle ${shared} cx="10.5" cy="10.5" r="6.5"/><path ${shared} d="m15.25 15.25 5 5"/>`
  },
  server: {
    viewBox: "0 0 24 24",
    body: `<rect ${shared} x="3" y="3.5" width="18" height="7" rx="2"/><rect ${shared} x="3" y="13.5" width="18" height="7" rx="2"/><path ${shared} d="M7 7h.01M7 17h.01M11 7h6M11 17h6"/>`
  },
  shield: {
    viewBox: "0 0 24 24",
    body: `<path ${shared} d="M12 2.75 20 6v5.5c0 5.25-3.35 8.2-8 10-4.65-1.8-8-4.75-8-10V6z"/>`
  },
  user: {
    viewBox: "0 0 24 24",
    body: `<circle ${shared} cx="12" cy="8" r="4"/><path ${shared} d="M4.5 21c.5-4.2 3-6.5 7.5-6.5s7 2.3 7.5 6.5"/>`
  }
});
function sanitizeIcon(icon) {
  const dangerous = /<\s*(script|style|foreignObject|iframe|object|embed|image|use|a)\b|on[a-z]+\s*=|(?:xlink:)?href\s*=|style\s*=|javascript:|url\s*\(/i;
  if (dangerous.test(icon.body)) {
    throw new Error("Icon body contains executable or externally embedded SVG content");
  }
  if (!/^[-+.\d\s]+$/.test(icon.viewBox.trim())) {
    throw new Error(`Invalid icon viewBox: ${icon.viewBox}`);
  }
  return icon;
}

// src/render.ts
import { readFile } from "fs/promises";
import { extname } from "path";
import { Resvg } from "@resvg/resvg-js";

// src/theme.ts
var tones = [
  "neutral",
  "blue",
  "orange",
  "green",
  "red",
  "purple",
  "yellow"
];
var defaults = {
  light: {
    background: "#ffffff",
    foreground: "#18181b",
    muted: "#71717a",
    stroke: "#27272a",
    tones: {
      neutral: { fill: "#f4f4f5", stroke: "#52525b", text: "#18181b" },
      blue: { fill: "#dbeafe", stroke: "#2563eb", text: "#1e3a8a" },
      orange: { fill: "#ffedd5", stroke: "#ea580c", text: "#7c2d12" },
      green: { fill: "#dcfce7", stroke: "#16a34a", text: "#14532d" },
      red: { fill: "#fee2e2", stroke: "#dc2626", text: "#7f1d1d" },
      purple: { fill: "#f3e8ff", stroke: "#9333ea", text: "#581c87" },
      yellow: { fill: "#fef9c3", stroke: "#ca8a04", text: "#713f12" }
    }
  },
  dark: {
    background: "#09090b",
    foreground: "#fafafa",
    muted: "#a1a1aa",
    stroke: "#d4d4d8",
    tones: {
      neutral: { fill: "#27272a", stroke: "#a1a1aa", text: "#fafafa" },
      blue: { fill: "#172554", stroke: "#60a5fa", text: "#dbeafe" },
      orange: { fill: "#431407", stroke: "#fb923c", text: "#ffedd5" },
      green: { fill: "#052e16", stroke: "#4ade80", text: "#dcfce7" },
      red: { fill: "#450a0a", stroke: "#f87171", text: "#fee2e2" },
      purple: { fill: "#3b0764", stroke: "#c084fc", text: "#f3e8ff" },
      yellow: { fill: "#422006", stroke: "#facc15", text: "#fef9c3" }
    }
  }
};
function mergeTheme(base, override) {
  if (override === undefined)
    return base;
  return {
    background: override.background ?? base.background,
    foreground: override.foreground ?? base.foreground,
    muted: override.muted ?? base.muted,
    stroke: override.stroke ?? base.stroke,
    tones: Object.fromEntries(tones.map((tone) => [
      tone,
      {
        fill: override.tones?.[tone]?.fill ?? base.tones[tone].fill,
        stroke: override.tones?.[tone]?.stroke ?? base.tones[tone].stroke,
        text: override.tones?.[tone]?.text ?? base.tones[tone].text
      }
    ]))
  };
}
function resolveTheme(mode, config) {
  return mergeTheme(defaults[mode], config.theme?.[mode]);
}

// src/render.ts
var escapeXml = (value) => value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&apos;");
function fontMime(filePath) {
  switch (extname(filePath).toLowerCase()) {
    case ".otf":
      return "font/otf";
    case ".woff":
      return "font/woff";
    case ".woff2":
      return "font/woff2";
    default:
      return "font/ttf";
  }
}
async function fontCss(config) {
  if (config.font?.files === undefined)
    return "";
  const faces = await Promise.all(config.font.files.filter((file) => file.embed === true).map(async (file) => {
    const encoded = (await readFile(file.path)).toString("base64");
    return `@font-face{font-family:"${escapeXml(config.font.family)}";src:url(data:${fontMime(file.path)};base64,${encoded});font-weight:${file.weight ?? 400};font-style:${file.style ?? "normal"};}`;
  }));
  return faces.join("");
}
function wrapText(text, maxWidth, fontSize) {
  const explicitLines = text.split(`
`);
  const maxCharacters = Math.max(1, Math.floor(maxWidth / (fontSize * 0.56)));
  const lines = [];
  for (const explicitLine of explicitLines) {
    if (explicitLine.length <= maxCharacters) {
      lines.push(explicitLine);
      continue;
    }
    const words = explicitLine.split(/\s+/);
    let current = "";
    for (const word of words) {
      const candidate = current === "" ? word : `${current} ${word}`;
      if (candidate.length <= maxCharacters || current === "") {
        current = candidate;
      } else {
        lines.push(current);
        current = word;
      }
    }
    if (current !== "")
      lines.push(current);
  }
  return lines.length === 0 ? [""] : lines;
}
function textSvg(options) {
  const lines = wrapText(options.text, options.width, options.fontSize);
  const lineHeight = options.lineHeight ?? options.fontSize * 1.25;
  const anchor = options.align;
  const x = anchor === "middle" ? options.x + options.width / 2 : anchor === "end" ? options.x + options.width : options.x;
  return `<text x="${x}" y="${options.y}" text-anchor="${anchor}" dominant-baseline="hanging" fill="${options.color}" opacity="${options.opacity}" font-family="${escapeXml(options.family)}" font-size="${options.fontSize}" font-weight="${options.weight}">${lines.map((line, index) => `<tspan x="${x}" dy="${index === 0 ? 0 : lineHeight}">${escapeXml(line)}</tspan>`).join("")}</text>`;
}
function iconSvg(options) {
  const icon = sanitizeIcon(options.icon);
  const parts = icon.viewBox.trim().split(/\s+/).map(Number);
  const width = (parts[2] ?? 24) - (parts[0] ?? 0);
  const height = (parts[3] ?? 24) - (parts[1] ?? 0);
  const scale = options.size / Math.max(width, height);
  return `<g color="${options.color}" opacity="${options.opacity}" transform="translate(${options.x} ${options.y}) scale(${scale}) translate(${-Number(parts[0] ?? 0)} ${-Number(parts[1] ?? 0)})">${icon.body}</g>`;
}
function boxSvg(shape, theme, family, icons) {
  const tone = theme.tones[shape.tone ?? "neutral"];
  const strokeWidth = shape.strokeWidth ?? 2;
  const opacity = shape.opacity ?? 1;
  const radius = shape.type === "ellipse" ? 0 : Math.min(shape.radius ?? 22, shape.height / 2);
  const geometry = shape.type === "ellipse" ? `<ellipse cx="${shape.x + shape.width / 2}" cy="${shape.y + shape.height / 2}" rx="${shape.width / 2}" ry="${shape.height / 2}" fill="${shape.fill === false ? "none" : tone.fill}" stroke="${tone.stroke}" stroke-width="${strokeWidth}"/>` : `<rect x="${shape.x}" y="${shape.y}" width="${shape.width}" height="${shape.height}" rx="${radius}" fill="${shape.fill === false ? "none" : tone.fill}" stroke="${tone.stroke}" stroke-width="${strokeWidth}"/>`;
  const icon = shape.icon === undefined ? undefined : icons[shape.icon];
  if (shape.icon !== undefined && icon === undefined) {
    throw new Error(`Unknown icon "${shape.icon}" on shape ${shape.id}`);
  }
  const iconSize = Math.min(shape.iconSize ?? 52, shape.height * 0.45, shape.width * 0.32);
  const iconMarkup = icon === undefined ? "" : iconSvg({
    icon,
    x: shape.x + (shape.width - iconSize) / 2,
    y: shape.label === undefined ? shape.y + (shape.height - iconSize) / 2 : shape.y + shape.height * 0.18,
    size: iconSize,
    color: tone.text,
    opacity
  });
  const labelMarkup = shape.label === undefined ? "" : textSvg({
    text: shape.label,
    x: shape.x + 16,
    y: icon === undefined ? shape.y + shape.height / 2 - (shape.labelFontSize === undefined ? 12 : shape.labelFontSize * 0.55) : shape.y + shape.height * 0.68,
    width: shape.width - 32,
    fontSize: shape.labelFontSize ?? 22,
    weight: 600,
    align: "middle",
    color: tone.text,
    opacity,
    family
  });
  return `<g data-shape-id="${escapeXml(shape.id)}" opacity="${opacity}">${geometry}${iconMarkup}${labelMarkup}</g>`;
}
function pointForAnchor(shape, anchor, toward) {
  const center = { x: shape.x + shape.width / 2, y: shape.y + shape.height / 2 };
  let resolved = anchor ?? "auto";
  if (resolved === "auto") {
    const dx = toward.x - center.x;
    const dy = toward.y - center.y;
    resolved = Math.abs(dx / shape.width) >= Math.abs(dy / shape.height) ? dx >= 0 ? "right" : "left" : dy >= 0 ? "bottom" : "top";
  }
  switch (resolved) {
    case "top":
      return { x: center.x, y: shape.y, normalized: { x: 0.5, y: 0 } };
    case "right":
      return {
        x: shape.x + shape.width,
        y: center.y,
        normalized: { x: 1, y: 0.5 }
      };
    case "bottom":
      return {
        x: center.x,
        y: shape.y + shape.height,
        normalized: { x: 0.5, y: 1 }
      };
    case "left":
      return { x: shape.x, y: center.y, normalized: { x: 0, y: 0.5 } };
  }
}
function resolveEdge(spec, edge) {
  const boxes = new Map(spec.shapes.filter((shape) => shape.type === "rect" || shape.type === "ellipse").map((shape) => [shape.id, shape]));
  const from = boxes.get(edge.from);
  const to = boxes.get(edge.to);
  if (from === undefined || to === undefined) {
    throw new Error(`Edge ${edge.id} references a missing box`);
  }
  const fromCenter = { x: from.x + from.width / 2, y: from.y + from.height / 2 };
  const toCenter = { x: to.x + to.width / 2, y: to.y + to.height / 2 };
  const start = pointForAnchor(from, edge.start, toCenter);
  const end = pointForAnchor(to, edge.end, fromCenter);
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  const length = Math.hypot(dx, dy) || 1;
  const bend = edge.bend ?? 0;
  return {
    edge,
    from,
    to,
    start,
    end,
    control: {
      x: (start.x + end.x) / 2 + -dy / length * bend,
      y: (start.y + end.y) / 2 + dx / length * bend
    }
  };
}
function edgeSvg(resolved, theme, family) {
  const { edge, start, end, control } = resolved;
  const toneName = edge.tone ?? "neutral";
  const tone = theme.tones[toneName];
  const marker = edge.arrowhead === "none" ? "" : edge.arrowhead === "triangle" ? `url(#arrow-triangle-${toneName})` : `url(#arrow-open-${toneName})`;
  const path = `M ${start.x} ${start.y} Q ${control.x} ${control.y} ${end.x} ${end.y}`;
  const label = edge.label === undefined ? "" : `<text x="${control.x}" y="${control.y - 10}" text-anchor="middle" fill="${tone.text}" stroke="${theme.background}" stroke-width="6" paint-order="stroke" font-family="${escapeXml(family)}" font-size="18" font-weight="600">${escapeXml(edge.label)}</text>`;
  return `<g data-edge-id="${escapeXml(edge.id)}"><path d="${path}" fill="none" stroke="${tone.stroke}" stroke-width="3" stroke-linecap="round" marker-end="${marker}"/>${label}</g>`;
}
function shapeSvg(shape, theme, family, icons) {
  if (shape.type === "rect" || shape.type === "ellipse") {
    return boxSvg(shape, theme, family, icons);
  }
  if (shape.type === "line") {
    return `<line data-shape-id="${escapeXml(shape.id)}" x1="${shape.x}" y1="${shape.y}" x2="${shape.x2}" y2="${shape.y2}" stroke="${theme.tones[shape.tone ?? "neutral"].stroke}" stroke-width="${shape.strokeWidth ?? 3}" stroke-linecap="round" opacity="${shape.opacity ?? 1}"/>`;
  }
  const text = shape;
  return textSvg({
    text: text.text,
    x: text.x,
    y: text.y,
    width: text.width ?? Math.max(text.text.length * (text.fontSize ?? 24) * 0.58, 12),
    fontSize: text.fontSize ?? 24,
    weight: text.weight ?? 500,
    align: text.align ?? "start",
    color: theme.tones[text.tone ?? "neutral"].text,
    opacity: text.opacity ?? 1,
    family
  });
}
async function renderSvg(spec, mode, config) {
  const theme = resolveTheme(mode, config);
  const family = config.font?.family ?? "system-ui, -apple-system, BlinkMacSystemFont, sans-serif";
  const icons = config.icons ?? {};
  const embeddedFonts = await fontCss(config);
  const markerDefinitions = Object.entries(theme.tones).map(([toneName, tone]) => `<marker id="arrow-open-${toneName}" markerWidth="12" markerHeight="12" refX="10" refY="6" orient="auto" markerUnits="strokeWidth"><path d="M2 2 10 6 2 10" fill="none" stroke="${tone.stroke}" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/></marker><marker id="arrow-triangle-${toneName}" markerWidth="11" markerHeight="11" refX="9" refY="5.5" orient="auto" markerUnits="strokeWidth"><path d="M1 1 10 5.5 1 10z" fill="${tone.stroke}"/></marker>`).join("");
  const edgeMarkup = (spec.edges ?? []).map((edge) => edgeSvg(resolveEdge(spec, edge), theme, family)).join("");
  const shapeMarkup = spec.shapes.map((shape) => shapeSvg(shape, theme, family, icons)).join("");
  const svg = [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${spec.canvas.width}" height="${spec.canvas.height}" viewBox="0 0 ${spec.canvas.width} ${spec.canvas.height}" role="img" aria-labelledby="diagram-title" color-scheme="${mode}">`,
    `<title id="diagram-title">${escapeXml(spec.name)}</title>`,
    `<style>${embeddedFonts}text{font-kerning:normal;text-rendering:geometricPrecision}</style>`,
    `<rect width="100%" height="100%" fill="${theme.background}"/>`,
    `<defs>${markerDefinitions}</defs>`,
    edgeMarkup,
    shapeMarkup,
    "</svg>"
  ].join("");
  return { mode, svg, width: spec.canvas.width, height: spec.canvas.height };
}
function renderPng(rendered, config, scale = 2) {
  const fontFiles = config.font?.files?.map((file) => file.path) ?? [];
  const renderer = new Resvg(rendered.svg, {
    fitTo: { mode: "zoom", value: scale },
    font: {
      loadSystemFonts: true,
      ...fontFiles.length === 0 ? {} : { fontFiles },
      defaultFontFamily: config.font?.family ?? "sans-serif"
    }
  });
  return renderer.render().asPng();
}

// src/lint.ts
function boxOutsideCanvas(shape, spec) {
  return shape.x < 0 || shape.y < 0 || shape.x + shape.width > spec.canvas.width || shape.y + shape.height > spec.canvas.height;
}
function lintDiagram(spec) {
  const findings = [];
  const boxes = spec.shapes.filter((shape) => shape.type === "rect" || shape.type === "ellipse");
  for (const shape of boxes) {
    if (boxOutsideCanvas(shape, spec)) {
      findings.push({
        code: "outside-canvas",
        message: `${shape.id} extends beyond the canvas`,
        shapeIds: [shape.id]
      });
    }
    if (shape.label !== undefined && shape.label.length > 32) {
      findings.push({
        code: "long-label",
        message: `${shape.id} has a ${shape.label.length}-character label; prefer a short noun phrase`,
        shapeIds: [shape.id]
      });
    }
    if (shape.width < 120 || shape.height < 64) {
      findings.push({
        code: "small-target",
        message: `${shape.id} is small enough to make its label or icon hard to scan`,
        shapeIds: [shape.id]
      });
    }
  }
  if (boxes.length > 9) {
    findings.push({
      code: "too-many-elements",
      message: `The diagram has ${boxes.length} primary shapes; consider a higher-level visual`,
      shapeIds: boxes.map((shape) => shape.id)
    });
  }
  for (const edge of spec.edges ?? []) {
    const resolved = resolveEdge(spec, edge);
    const length = Math.hypot(resolved.end.x - resolved.start.x, resolved.end.y - resolved.start.y);
    if (length < 96) {
      findings.push({
        code: "short-arrow",
        message: `${edge.id} is ${Math.round(length)}px long; leave more space between connected shapes`,
        shapeIds: [edge.from, edge.to]
      });
    }
    if (edge.label !== undefined && edge.label.length > 24) {
      findings.push({
        code: "long-edge-label",
        message: `${edge.id} has a long connector label; prefer one short relation`,
        shapeIds: [edge.from, edge.to]
      });
    }
  }
  return findings;
}

// src/types.ts
var diagramVersion = 1;

// src/layout.ts
var stackLayoutDefaults = {
  gap: 160,
  padding: 64,
  align: "center"
};
var coordinatePrecision = 3;
var coordinateScale = 10 ** coordinatePrecision;

class StackLayoutError extends Error {
  issues;
  constructor(issues) {
    super(`Invalid stack layout:
${issues.map((issue) => `- ${issue}`).join(`
`)}`);
    this.name = "StackLayoutError";
    this.issues = issues;
  }
}
function coordinateFromUnits(value) {
  return value / coordinateScale;
}
function normalizedScaledCoordinate(value) {
  const scaled = value * coordinateScale;
  return normalizedGridValue(scaled);
}
function normalizedGridValue(value) {
  const nearest = Math.round(value);
  return Math.abs(value - nearest) <= 0.000000001 ? nearest : value;
}
function floorGridValue(value) {
  return Math.floor(normalizedGridValue(value));
}
function ceilGridValue(value) {
  return Math.ceil(normalizedGridValue(value));
}
function coordinateUnits(value, label, positive, rounding, issues) {
  if (!Number.isFinite(value) || (positive ? value <= 0 : value < 0)) {
    issues.push(positive ? `${label} must be positive` : `${label} must not be negative`);
    return 0;
  }
  const scaled = normalizedScaledCoordinate(value);
  const units = rounding === "ceil" ? ceilGridValue(scaled) : floorGridValue(scaled);
  if (!Number.isSafeInteger(units)) {
    issues.push(`${label} must be a finite coordinate within the supported range`);
    return 0;
  }
  if (positive && units < 1) {
    issues.push(`${label} must occupy at least ${coordinateFromUnits(1)}px in the layout grid`);
    return 0;
  }
  return units;
}
function positionedShape(shape, mainPosition, crossPosition, horizontal) {
  return {
    ...shape,
    x: coordinateFromUnits(horizontal ? mainPosition : crossPosition),
    y: coordinateFromUnits(horizontal ? crossPosition : mainPosition)
  };
}
function authoredMainSize(shape, horizontal) {
  return horizontal ? shape.width : shape.height;
}
function emittedMainPlacement(shapes, horizontal, gap, issues) {
  if (shapes.length === 0)
    return { offsets: [], span: 0 };
  const offsets = [];
  let offset = 0;
  for (const [index, shape] of shapes.entries()) {
    offsets.push(offset);
    if (index === shapes.length - 1)
      break;
    const advance = coordinateUnits(authoredMainSize(shape, horizontal) + gap, `space after shape ${shape.id}`, true, "ceil", issues);
    offset += advance;
    if (!Number.isSafeInteger(offset)) {
      issues.push("stack positions exceed the supported coordinate range");
      return { offsets, span: Number.POSITIVE_INFINITY };
    }
  }
  const last = shapes.at(-1);
  const span = offset + (last === undefined ? 0 : normalizedScaledCoordinate(authoredMainSize(last, horizontal)));
  if (!Number.isFinite(span) || !Number.isSafeInteger(Math.ceil(span))) {
    issues.push("stack extent exceeds the supported coordinate range");
  }
  return { offsets, span };
}
function clampedGridPosition(ideal, minimum, maximum) {
  return Math.min(maximum, Math.max(minimum, Math.round(ideal)));
}
function resolvedAnchors(fromIndex, toIndex, horizontal) {
  const forward = fromIndex < toIndex;
  if (horizontal) {
    return forward ? { start: "right", end: "left" } : { start: "left", end: "right" };
  }
  return forward ? { start: "bottom", end: "top" } : { start: "top", end: "bottom" };
}
function resolvedEdge(edge, indexes, horizontal) {
  const fromIndex = indexes.get(edge.from);
  const toIndex = indexes.get(edge.to);
  if (fromIndex === undefined || toIndex === undefined) {
    throw new StackLayoutError([
      `edge ${edge.id} must reference shapes that belong to the stack`
    ]);
  }
  const anchors = resolvedAnchors(fromIndex, toIndex, horizontal);
  return {
    ...edge,
    start: anchors.start,
    end: anchors.end,
    bend: 0
  };
}
function stackStructureIssues(source) {
  const issues = [];
  if (source.shapes.length < 1 || source.shapes.length > 9) {
    issues.push("stack layouts must contain between 1 and 9 shapes");
  }
  const indexes = new Map;
  const recordIds = new Set;
  for (const [index, shape] of source.shapes.entries()) {
    if (recordIds.has(shape.id)) {
      issues.push(`shape id ${shape.id} is duplicated`);
    } else {
      indexes.set(shape.id, index);
      recordIds.add(shape.id);
    }
  }
  const connectedPairs = new Set;
  for (const stackEdge of source.edges ?? []) {
    const edge = stackEdge;
    if (recordIds.has(edge.id)) {
      issues.push(`edge id ${edge.id} is duplicated`);
    }
    recordIds.add(edge.id);
    const fromIndex = indexes.get(edge.from);
    const toIndex = indexes.get(edge.to);
    if (fromIndex === undefined) {
      issues.push(`edge ${edge.id} has unknown from id ${edge.from}`);
    }
    if (toIndex === undefined) {
      issues.push(`edge ${edge.id} has unknown to id ${edge.to}`);
    }
    if (fromIndex !== undefined && toIndex !== undefined) {
      if (fromIndex === toIndex) {
        issues.push(`edge ${edge.id} cannot connect a shape to itself`);
      } else {
        if (Math.abs(fromIndex - toIndex) !== 1) {
          issues.push(`edge ${edge.id} must connect adjacent stack shapes`);
        }
        const pair = [fromIndex, toIndex].sort((left, right) => left - right).join(":");
        if (connectedPairs.has(pair)) {
          issues.push(`edge ${edge.id} duplicates a connection between the same stack shapes`);
        }
        connectedPairs.add(pair);
      }
    }
    if (edge.start !== undefined && edge.start !== "auto") {
      issues.push(`edge ${edge.id}.start must be auto or omitted in a stack layout`);
    }
    if (edge.end !== undefined && edge.end !== "auto") {
      issues.push(`edge ${edge.id}.end must be auto or omitted in a stack layout`);
    }
    if (edge.bend !== undefined && edge.bend !== 0) {
      issues.push(`edge ${edge.id}.bend must be 0 or omitted in a stack layout`);
    }
  }
  return issues;
}
function resolveStackLayout(source) {
  const issues = [...stackStructureIssues(source)];
  const horizontal = source.layout.direction === "horizontal";
  coordinateUnits(source.canvas.width, "canvas width", true, "floor", issues);
  coordinateUnits(source.canvas.height, "canvas height", true, "floor", issues);
  const gapValue = source.layout.gap ?? stackLayoutDefaults.gap;
  coordinateUnits(gapValue, "stack gap", false, "ceil", issues);
  const paddingValue = source.canvas.padding ?? stackLayoutDefaults.padding;
  const padding = coordinateUnits(paddingValue, "canvas padding", false, "ceil", issues);
  for (const shape of source.shapes) {
    coordinateUnits(shape.width, `shape ${shape.id} width`, true, "ceil", issues);
    coordinateUnits(shape.height, `shape ${shape.id} height`, true, "ceil", issues);
  }
  const align = source.layout.align ?? stackLayoutDefaults.align;
  const canvasMainValue = horizontal ? source.canvas.width : source.canvas.height;
  const canvasCrossValue = horizontal ? source.canvas.height : source.canvas.width;
  const mainPlacement = emittedMainPlacement(source.shapes, horizontal, gapValue, issues);
  const maximumMainStart = floorGridValue(normalizedScaledCoordinate(canvasMainValue - paddingValue) - mainPlacement.span);
  if (padding > maximumMainStart) {
    const requiredMain = ceilGridValue(mainPlacement.span);
    const availableMain = floorGridValue(normalizedScaledCoordinate(canvasMainValue - paddingValue * 2));
    issues.push(`${source.layout.direction} stack needs ${coordinateFromUnits(requiredMain)}px but only ${coordinateFromUnits(availableMain)}px remain inside ${paddingValue}px padding`);
  }
  const crossStarts = source.shapes.map((shape) => {
    const authoredSize = horizontal ? shape.height : shape.width;
    const maximum = floorGridValue(normalizedScaledCoordinate(canvasCrossValue - paddingValue - authoredSize));
    if (padding > maximum) {
      const requiredCross = ceilGridValue(normalizedScaledCoordinate(authoredSize));
      const availableCross = floorGridValue(normalizedScaledCoordinate(canvasCrossValue - paddingValue * 2));
      issues.push(`shape ${shape.id} needs ${coordinateFromUnits(requiredCross)}px on the cross axis but only ${coordinateFromUnits(availableCross)}px remain inside ${paddingValue}px padding`);
    }
    return { authoredSize, maximum };
  });
  if (issues.length > 0)
    throw new StackLayoutError(issues);
  const mainStart = clampedGridPosition((normalizedScaledCoordinate(canvasMainValue) - mainPlacement.span) / 2, padding, maximumMainStart);
  const shapes = source.shapes.map((shape, index) => {
    const crossStart = crossStarts[index];
    if (crossStart === undefined) {
      throw new StackLayoutError([
        `shape ${shape.id} has no cross-axis placement`
      ]);
    }
    const crossPosition = align === "start" ? padding : align === "end" ? crossStart.maximum : clampedGridPosition(normalizedScaledCoordinate((canvasCrossValue - crossStart.authoredSize) / 2), padding, crossStart.maximum);
    const mainPosition = mainStart + (mainPlacement.offsets[index] ?? 0);
    const positioned = positionedShape(shape, mainPosition, crossPosition, horizontal);
    return positioned;
  });
  const indexes = new Map(shapes.map((shape, index) => [shape.id, index]));
  const edges = source.edges?.map((edge) => resolvedEdge(edge, indexes, horizontal));
  return {
    ...source.$schema === undefined ? {} : { $schema: source.$schema },
    version: source.version,
    name: source.name,
    canvas: {
      width: source.canvas.width,
      height: source.canvas.height,
      padding: paddingValue
    },
    shapes,
    ...edges === undefined ? {} : { edges }
  };
}
function resolveDiagramSource(source) {
  return "layout" in source ? resolveStackLayout(source) : source;
}

// src/parse.ts
var tones2 = new Set([
  "neutral",
  "blue",
  "orange",
  "green",
  "red",
  "purple",
  "yellow"
]);
var anchors = new Set(["auto", "top", "right", "bottom", "left"]);
var stackDirections = new Set(["horizontal", "vertical"]);
var stackAlignments = new Set(["start", "center", "end"]);
var idPattern = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;
var namePattern = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

class DiagramValidationError extends Error {
  issues;
  constructor(issues) {
    super(`Invalid diagram specification:
${issues.map((issue) => `- ${issue}`).join(`
`)}`);
    this.name = "DiagramValidationError";
    this.issues = issues;
  }
}
function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function readString(record, key, at, issues) {
  const value = record[key];
  if (typeof value !== "string") {
    issues.push(`${at}.${key} must be a string`);
    return;
  }
  return value;
}
function readOptionalString(record, key, at, issues) {
  const value = record[key];
  if (value === undefined)
    return;
  if (typeof value !== "string") {
    issues.push(`${at}.${key} must be a string when present`);
    return;
  }
  return value;
}
function readNumber(record, key, at, issues, options = {}) {
  const value = record[key];
  if (typeof value !== "number" || !Number.isFinite(value)) {
    issues.push(`${at}.${key} must be a finite number`);
    return;
  }
  if (options.positive && value <= 0) {
    issues.push(`${at}.${key} must be greater than zero`);
    return;
  }
  if (options.nonNegative && value < 0) {
    issues.push(`${at}.${key} must be zero or greater`);
    return;
  }
  return value;
}
function readOptionalNumber(record, key, at, issues, options = {}) {
  if (record[key] === undefined)
    return;
  return readNumber(record, key, at, issues, options);
}
function readOptionalTone(record, key, at, issues) {
  const value = record[key];
  if (value === undefined)
    return;
  if (typeof value !== "string" || !tones2.has(value)) {
    issues.push(`${at}.${key} must be one of ${[...tones2].join(", ")}`);
    return;
  }
  return value;
}
function validateKnownKeys(record, allowed, at, issues) {
  for (const key of Object.keys(record)) {
    if (!allowed.has(key))
      issues.push(`${at}.${key} is not supported`);
  }
}
function parseBase(record, at, issues) {
  const id = readString(record, "id", at, issues);
  if (id !== undefined && !idPattern.test(id)) {
    issues.push(`${at}.id must contain only letters, numbers, underscores, or hyphens`);
  }
  const opacity = readOptionalNumber(record, "opacity", at, issues, { nonNegative: true });
  if (opacity !== undefined && opacity > 1)
    issues.push(`${at}.opacity must not exceed 1`);
  const x = readNumber(record, "x", at, issues);
  const y = readNumber(record, "y", at, issues);
  const tone = readOptionalTone(record, "tone", at, issues);
  return {
    ...id === undefined ? {} : { id },
    ...x === undefined ? {} : { x },
    ...y === undefined ? {} : { y },
    ...tone === undefined ? {} : { tone },
    ...opacity === undefined ? {} : { opacity }
  };
}
function parseShape(value, index, issues) {
  const at = `shapes[${index}]`;
  if (!isRecord(value)) {
    issues.push(`${at} must be an object`);
    return null;
  }
  const type = readString(value, "type", at, issues);
  const base = parseBase(value, at, issues);
  if (base.id === undefined || base.x === undefined || base.y === undefined || type === undefined) {
    return null;
  }
  const requiredBase = {
    id: base.id,
    x: base.x,
    y: base.y,
    ...base.tone === undefined ? {} : { tone: base.tone },
    ...base.opacity === undefined ? {} : { opacity: base.opacity }
  };
  if (type === "rect" || type === "ellipse") {
    validateKnownKeys(value, new Set([
      "id",
      "type",
      "x",
      "y",
      "tone",
      "opacity",
      "width",
      "height",
      "radius",
      "label",
      "labelFontSize",
      "icon",
      "iconSize",
      "strokeWidth",
      "fill"
    ]), at, issues);
    const width = readNumber(value, "width", at, issues, { positive: true });
    const height = readNumber(value, "height", at, issues, { positive: true });
    const fill = value.fill;
    if (fill !== undefined && typeof fill !== "boolean")
      issues.push(`${at}.fill must be a boolean`);
    if (width === undefined || height === undefined)
      return null;
    return {
      ...requiredBase,
      type,
      width,
      height,
      ...readOptionalNumber(value, "radius", at, issues, { nonNegative: true }) === undefined ? {} : { radius: value.radius },
      ...readOptionalString(value, "label", at, issues) === undefined ? {} : { label: value.label },
      ...readOptionalNumber(value, "labelFontSize", at, issues, { positive: true }) === undefined ? {} : { labelFontSize: value.labelFontSize },
      ...readOptionalString(value, "icon", at, issues) === undefined ? {} : { icon: value.icon },
      ...readOptionalNumber(value, "iconSize", at, issues, { positive: true }) === undefined ? {} : { iconSize: value.iconSize },
      ...readOptionalNumber(value, "strokeWidth", at, issues, { nonNegative: true }) === undefined ? {} : { strokeWidth: value.strokeWidth },
      ...typeof fill === "boolean" ? { fill } : {}
    };
  }
  if (type === "text") {
    validateKnownKeys(value, new Set([
      "id",
      "type",
      "x",
      "y",
      "tone",
      "opacity",
      "text",
      "width",
      "fontSize",
      "weight",
      "align"
    ]), at, issues);
    const text = readString(value, "text", at, issues);
    const weight = value.weight;
    if (weight !== undefined && ![400, 500, 600, 700].includes(weight)) {
      issues.push(`${at}.weight must be 400, 500, 600, or 700`);
    }
    const align = value.align;
    if (align !== undefined && !["start", "middle", "end"].includes(align)) {
      issues.push(`${at}.align must be start, middle, or end`);
    }
    if (text === undefined)
      return null;
    return {
      ...requiredBase,
      type,
      text,
      ...readOptionalNumber(value, "width", at, issues, { positive: true }) === undefined ? {} : { width: value.width },
      ...readOptionalNumber(value, "fontSize", at, issues, { positive: true }) === undefined ? {} : { fontSize: value.fontSize },
      ...weight === undefined ? {} : { weight },
      ...align === undefined ? {} : { align }
    };
  }
  if (type === "line") {
    validateKnownKeys(value, new Set(["id", "type", "x", "y", "tone", "opacity", "x2", "y2", "strokeWidth"]), at, issues);
    const x2 = readNumber(value, "x2", at, issues);
    const y2 = readNumber(value, "y2", at, issues);
    if (x2 === undefined || y2 === undefined)
      return null;
    return {
      ...requiredBase,
      type,
      x2,
      y2,
      ...readOptionalNumber(value, "strokeWidth", at, issues, { positive: true }) === undefined ? {} : { strokeWidth: value.strokeWidth }
    };
  }
  issues.push(`${at}.type must be rect, ellipse, text, or line`);
  return null;
}
function parseStackShape(value, index, issues) {
  const at = `shapes[${index}]`;
  if (!isRecord(value)) {
    issues.push(`${at} must be an object`);
    return null;
  }
  validateKnownKeys(value, new Set([
    "id",
    "type",
    "tone",
    "opacity",
    "width",
    "height",
    "radius",
    "label",
    "labelFontSize",
    "icon",
    "iconSize",
    "strokeWidth",
    "fill"
  ]), at, issues);
  const id = readString(value, "id", at, issues);
  if (id !== undefined && !idPattern.test(id)) {
    issues.push(`${at}.id must contain only letters, numbers, underscores, or hyphens`);
  }
  const type = readString(value, "type", at, issues);
  if (type !== undefined && type !== "rect" && type !== "ellipse") {
    issues.push(`${at}.type must be rect or ellipse in a stack layout`);
  }
  const width = readNumber(value, "width", at, issues, { positive: true });
  const height = readNumber(value, "height", at, issues, { positive: true });
  const tone = readOptionalTone(value, "tone", at, issues);
  const opacity = readOptionalNumber(value, "opacity", at, issues, { nonNegative: true });
  if (opacity !== undefined && opacity > 1)
    issues.push(`${at}.opacity must not exceed 1`);
  const radius = readOptionalNumber(value, "radius", at, issues, { nonNegative: true });
  const label = readOptionalString(value, "label", at, issues);
  const labelFontSize = readOptionalNumber(value, "labelFontSize", at, issues, {
    positive: true
  });
  const icon = readOptionalString(value, "icon", at, issues);
  const iconSize = readOptionalNumber(value, "iconSize", at, issues, { positive: true });
  const strokeWidth = readOptionalNumber(value, "strokeWidth", at, issues, {
    nonNegative: true
  });
  const fill = value.fill;
  if (fill !== undefined && typeof fill !== "boolean")
    issues.push(`${at}.fill must be a boolean`);
  if (id === undefined || type !== "rect" && type !== "ellipse" || width === undefined || height === undefined) {
    return null;
  }
  return {
    id,
    type,
    width,
    height,
    ...tone === undefined ? {} : { tone },
    ...opacity === undefined ? {} : { opacity },
    ...radius === undefined ? {} : { radius },
    ...label === undefined ? {} : { label },
    ...labelFontSize === undefined ? {} : { labelFontSize },
    ...icon === undefined ? {} : { icon },
    ...iconSize === undefined ? {} : { iconSize },
    ...strokeWidth === undefined ? {} : { strokeWidth },
    ...typeof fill === "boolean" ? { fill } : {}
  };
}
function parseEdge(value, index, issues) {
  const at = `edges[${index}]`;
  if (!isRecord(value)) {
    issues.push(`${at} must be an object`);
    return null;
  }
  validateKnownKeys(value, new Set(["id", "from", "to", "label", "tone", "start", "end", "bend", "arrowhead"]), at, issues);
  const id = readString(value, "id", at, issues);
  const from = readString(value, "from", at, issues);
  const to = readString(value, "to", at, issues);
  if (id !== undefined && !idPattern.test(id))
    issues.push(`${at}.id has unsupported characters`);
  const start = value.start;
  const end = value.end;
  if (start !== undefined && (typeof start !== "string" || !anchors.has(start))) {
    issues.push(`${at}.start must be auto, top, right, bottom, or left`);
  }
  if (end !== undefined && (typeof end !== "string" || !anchors.has(end))) {
    issues.push(`${at}.end must be auto, top, right, bottom, or left`);
  }
  const arrowhead = value.arrowhead;
  if (arrowhead !== undefined && !["arrow", "triangle", "none"].includes(arrowhead)) {
    issues.push(`${at}.arrowhead must be arrow, triangle, or none`);
  }
  if (id === undefined || from === undefined || to === undefined)
    return null;
  return {
    id,
    from,
    to,
    ...readOptionalString(value, "label", at, issues) === undefined ? {} : { label: value.label },
    ...readOptionalTone(value, "tone", at, issues) === undefined ? {} : { tone: value.tone },
    ...start === undefined ? {} : { start },
    ...end === undefined ? {} : { end },
    ...readOptionalNumber(value, "bend", at, issues) === undefined ? {} : { bend: value.bend },
    ...arrowhead === undefined ? {} : { arrowhead }
  };
}
function parseStackLayout(value, issues) {
  if (!isRecord(value)) {
    issues.push("layout must be an object");
    return null;
  }
  validateKnownKeys(value, new Set(["type", "direction", "gap", "align"]), "layout", issues);
  if (value.type !== "stack")
    issues.push("layout.type must be stack");
  const direction = value.direction;
  if (typeof direction !== "string" || !stackDirections.has(direction)) {
    issues.push("layout.direction must be horizontal or vertical");
  }
  const gap = readOptionalNumber(value, "gap", "layout", issues, { nonNegative: true });
  const align = value.align;
  if (align !== undefined && (typeof align !== "string" || !stackAlignments.has(align))) {
    issues.push("layout.align must be start, center, or end");
  }
  if (value.type !== "stack" || typeof direction !== "string" || !stackDirections.has(direction)) {
    return null;
  }
  return {
    type: "stack",
    direction,
    ...gap === undefined ? {} : { gap },
    ...align === undefined || !stackAlignments.has(align) ? {} : { align }
  };
}
function parseDiagramSource(value) {
  const issues = [];
  if (!isRecord(value))
    throw new DiagramValidationError(["root must be an object"]);
  const isStackSource = "layout" in value;
  validateKnownKeys(value, new Set([
    "$schema",
    "version",
    "name",
    "canvas",
    "shapes",
    "edges",
    ...isStackSource ? ["layout"] : []
  ]), "root", issues);
  if (value.version !== diagramVersion)
    issues.push(`version must be ${diagramVersion}`);
  const name = readString(value, "name", "root", issues);
  if (name !== undefined && !namePattern.test(name)) {
    issues.push("name must be lowercase kebab-case");
  }
  const canvasValue = value.canvas;
  let canvas = null;
  if (!isRecord(canvasValue)) {
    issues.push("canvas must be an object");
  } else {
    validateKnownKeys(canvasValue, new Set(["width", "height", "padding"]), "canvas", issues);
    const width = readNumber(canvasValue, "width", "canvas", issues, { positive: true });
    const height = readNumber(canvasValue, "height", "canvas", issues, { positive: true });
    const padding = readOptionalNumber(canvasValue, "padding", "canvas", issues, {
      nonNegative: true
    });
    if (width !== undefined && height !== undefined) {
      canvas = { width, height, ...padding === undefined ? {} : { padding } };
    }
  }
  const layout = isStackSource ? parseStackLayout(value.layout, issues) : null;
  const shapesValue = value.shapes;
  const positionedShapes = [];
  const stackShapes = [];
  if (!Array.isArray(shapesValue)) {
    issues.push("shapes must be an array");
  } else {
    if (isStackSource && (shapesValue.length < 1 || shapesValue.length > 9)) {
      issues.push("stack layouts must contain between 1 and 9 shapes");
    }
    for (const [index, shape] of shapesValue.entries()) {
      if (isStackSource) {
        const parsed = parseStackShape(shape, index, issues);
        if (parsed !== null)
          stackShapes.push(parsed);
      } else {
        const parsed = parseShape(shape, index, issues);
        if (parsed !== null)
          positionedShapes.push(parsed);
      }
    }
  }
  const edgesValue = value.edges;
  const edges = [];
  if (edgesValue !== undefined) {
    if (!Array.isArray(edgesValue)) {
      issues.push("edges must be an array when present");
    } else {
      for (const [index, edge] of edgesValue.entries()) {
        const parsed = parseEdge(edge, index, issues);
        if (parsed !== null)
          edges.push(parsed);
      }
    }
  }
  const shapes = isStackSource ? stackShapes : positionedShapes;
  const allIds = new Set;
  for (const [kind, records] of [
    ["shape", shapes],
    ["edge", edges]
  ]) {
    for (const record of records) {
      if (allIds.has(record.id))
        issues.push(`${kind} id ${record.id} is duplicated`);
      allIds.add(record.id);
    }
  }
  const connectableIds = new Set(shapes.filter((shape) => shape.type === "rect" || shape.type === "ellipse").map((shape) => shape.id));
  for (const edge of edges) {
    if (!connectableIds.has(edge.from))
      issues.push(`edge ${edge.id} has unknown or non-connectable from id ${edge.from}`);
    if (!connectableIds.has(edge.to))
      issues.push(`edge ${edge.id} has unknown or non-connectable to id ${edge.to}`);
    if (edge.from === edge.to)
      issues.push(`edge ${edge.id} cannot connect a shape to itself`);
  }
  if (isStackSource) {
    const indexes = new Map(stackShapes.map((shape, index) => [shape.id, index]));
    const connectedPairs = new Set;
    for (const edge of edges) {
      const fromIndex = indexes.get(edge.from);
      const toIndex = indexes.get(edge.to);
      if (fromIndex !== undefined && toIndex !== undefined && Math.abs(fromIndex - toIndex) !== 1) {
        issues.push(`edge ${edge.id} must connect adjacent stack shapes`);
      }
      if (fromIndex !== undefined && toIndex !== undefined && fromIndex !== toIndex) {
        const pair = [fromIndex, toIndex].sort((left, right) => left - right).join(":");
        if (connectedPairs.has(pair)) {
          issues.push(`edge ${edge.id} duplicates a connection between the same stack shapes`);
        }
        connectedPairs.add(pair);
      }
      if (edge.start !== undefined && edge.start !== "auto") {
        issues.push(`edge ${edge.id}.start must be auto or omitted in a stack layout`);
      }
      if (edge.end !== undefined && edge.end !== "auto") {
        issues.push(`edge ${edge.id}.end must be auto or omitted in a stack layout`);
      }
      if (edge.bend !== undefined && edge.bend !== 0) {
        issues.push(`edge ${edge.id}.bend must be 0 or omitted in a stack layout`);
      }
    }
  }
  if (issues.length > 0 || name === undefined || canvas === null || isStackSource && layout === null) {
    throw new DiagramValidationError(issues);
  }
  const common = {
    ..."$schema" in value && typeof value.$schema === "string" ? { $schema: value.$schema } : {},
    version: diagramVersion,
    name,
    canvas
  };
  if (isStackSource) {
    const stackEdges = edges.map((edge) => ({
      id: edge.id,
      from: edge.from,
      to: edge.to,
      ...edge.label === undefined ? {} : { label: edge.label },
      ...edge.tone === undefined ? {} : { tone: edge.tone },
      ...edge.start === "auto" ? { start: edge.start } : {},
      ...edge.end === "auto" ? { end: edge.end } : {},
      ...edge.bend === 0 ? { bend: edge.bend } : {},
      ...edge.arrowhead === undefined ? {} : { arrowhead: edge.arrowhead }
    }));
    return {
      ...common,
      layout,
      shapes: stackShapes,
      ...edgesValue === undefined ? {} : { edges: stackEdges }
    };
  }
  return {
    ...common,
    shapes: positionedShapes,
    ...edgesValue === undefined ? {} : { edges }
  };
}
function parseDiagramSpec(value) {
  return resolveDiagramSource(parseDiagramSource(value));
}

// src/tldr.ts
var schema = {
  schemaVersion: 2,
  sequences: {
    "com.tldraw.store": 5,
    "com.tldraw.asset": 1,
    "com.tldraw.camera": 1,
    "com.tldraw.document": 2,
    "com.tldraw.instance": 26,
    "com.tldraw.instance_page_state": 5,
    "com.tldraw.page": 1,
    "com.tldraw.instance_presence": 6,
    "com.tldraw.pointer": 1,
    "com.tldraw.shape": 4,
    "com.tldraw.user": 1,
    "com.tldraw.asset.image": 6,
    "com.tldraw.asset.video": 5,
    "com.tldraw.asset.bookmark": 2,
    "com.tldraw.shape.group": 0,
    "com.tldraw.shape.text": 4,
    "com.tldraw.shape.bookmark": 2,
    "com.tldraw.shape.draw": 5,
    "com.tldraw.shape.geo": 11,
    "com.tldraw.shape.note": 13,
    "com.tldraw.shape.line": 5,
    "com.tldraw.shape.frame": 1,
    "com.tldraw.shape.arrow": 8,
    "com.tldraw.shape.highlight": 4,
    "com.tldraw.shape.embed": 4,
    "com.tldraw.shape.image": 5,
    "com.tldraw.shape.video": 4,
    "com.tldraw.binding.arrow": 1
  }
};
var tldrawColors = {
  neutral: "black",
  blue: "blue",
  orange: "orange",
  green: "green",
  red: "red",
  purple: "violet",
  yellow: "yellow"
};
function richText(text) {
  return {
    type: "doc",
    content: [
      {
        type: "paragraph",
        ...text === "" ? {} : { content: [{ type: "text", text }] }
      }
    ]
  };
}
function shapeId(id) {
  return `shape:${id}`;
}
function shapeMeta(sourceId) {
  return { diagram: { version: 1, sourceId } };
}
function indexKey(index) {
  const alphabet = "123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
  const value = alphabet[index];
  if (value === undefined) {
    throw new Error("A .tldr export currently supports at most 61 generated records");
  }
  return `a${value}`;
}
function baseShape(shape, index) {
  return {
    x: shape.x,
    y: shape.y,
    rotation: 0,
    isLocked: false,
    opacity: shape.opacity ?? 1,
    meta: shapeMeta(shape.id),
    id: shapeId(shape.id),
    parentId: "page:page",
    index: indexKey(index),
    typeName: "shape"
  };
}
function textShape(options) {
  return {
    x: options.x,
    y: options.y,
    rotation: 0,
    isLocked: false,
    opacity: options.opacity ?? 1,
    meta: shapeMeta(options.sourceId),
    id: shapeId(options.id),
    type: "text",
    props: {
      color: tldrawColors[options.tone],
      size: options.size,
      w: options.width,
      font: "sans",
      textAlign: options.align,
      autoSize: false,
      scale: options.scale ?? 1,
      richText: richText(options.text)
    },
    parentId: "page:page",
    index: indexKey(options.index),
    typeName: "shape"
  };
}
function svgIconAsset(icon, color) {
  const clean = sanitizeIcon(icon);
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="96" height="96" viewBox="${clean.viewBox}" fill="none" color="${color}">${clean.body}</svg>`;
  return `data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}`;
}
function tldrawSize(fontSize) {
  if (fontSize === undefined || fontSize < 20)
    return "m";
  if (fontSize < 28)
    return "l";
  return "xl";
}
var tldrawTextFontSizes = {
  s: 18,
  m: 24,
  l: 36,
  xl: 44
};
function scaledTldrawSize(fontSize) {
  const size = fontSize < 21 ? "s" : fontSize < 30 ? "m" : fontSize < 40 ? "l" : "xl";
  return { size, scale: fontSize / tldrawTextFontSizes[size] };
}
function serializeTldr(spec, config) {
  const records = [
    {
      gridSize: 10,
      name: spec.name,
      meta: { diagram: { version: 1 } },
      id: "document:document",
      typeName: "document"
    },
    {
      meta: {},
      id: "page:page",
      name: "Page 1",
      index: "a1",
      typeName: "page"
    }
  ];
  const icons = config.icons ?? {};
  const lightTheme = resolveTheme("light", config);
  let generatedIndex = 1;
  for (const shape of spec.shapes) {
    generatedIndex += 1;
    if (shape.type === "rect" || shape.type === "ellipse") {
      const box = shape;
      const hasIcon = box.icon !== undefined;
      const hasSeparateLabel = box.label !== undefined && (hasIcon || box.labelFontSize !== undefined);
      records.push({
        ...baseShape(box, generatedIndex),
        type: "geo",
        props: {
          w: box.width,
          h: box.height,
          geo: box.type === "ellipse" ? "ellipse" : "rectangle",
          dash: "solid",
          growY: 0,
          url: "",
          scale: 1,
          color: tldrawColors[box.tone ?? "neutral"],
          labelColor: "black",
          fill: box.fill === false ? "none" : "solid",
          size: (box.strokeWidth ?? 2) >= 4 ? "l" : "m",
          font: "sans",
          align: "middle",
          verticalAlign: "middle",
          richText: richText(hasSeparateLabel ? "" : box.label ?? "")
        }
      });
      if (box.icon !== undefined) {
        const icon = icons[box.icon];
        if (icon === undefined)
          throw new Error(`Unknown icon "${box.icon}" on shape ${box.id}`);
        const iconSize = Math.min(box.iconSize ?? 52, box.height * 0.45, box.width * 0.32);
        const assetId = `asset:icon-${box.id}`;
        records.push({
          id: assetId,
          type: "image",
          typeName: "asset",
          props: {
            name: `${box.icon}.svg`,
            src: svgIconAsset(icon, lightTheme.tones[box.tone ?? "neutral"].text),
            w: 96,
            h: 96,
            mimeType: "image/svg+xml",
            isAnimated: false
          },
          meta: { diagram: { version: 1, icon: box.icon } }
        });
        generatedIndex += 1;
        records.push({
          x: box.x + (box.width - iconSize) / 2,
          y: box.label === undefined ? box.y + (box.height - iconSize) / 2 : box.y + box.height * 0.18,
          rotation: 0,
          isLocked: false,
          opacity: box.opacity ?? 1,
          meta: shapeMeta(box.id),
          id: shapeId(`${box.id}-icon`),
          type: "image",
          props: {
            w: iconSize,
            h: iconSize,
            assetId,
            playing: true,
            url: "",
            crop: null,
            flipX: false,
            flipY: false,
            altText: box.label ?? box.icon
          },
          parentId: "page:page",
          index: indexKey(generatedIndex),
          typeName: "shape"
        });
      }
      if (hasSeparateLabel && box.label !== undefined) {
        const textStyle = box.labelFontSize === undefined ? { size: "l", scale: 1 } : scaledTldrawSize(box.labelFontSize);
        generatedIndex += 1;
        records.push(textShape({
          id: `${box.id}-label`,
          sourceId: box.id,
          x: box.x + 16,
          y: hasIcon ? box.y + box.height * 0.68 : box.y + box.height / 2 - (box.labelFontSize ?? 22) * 0.55,
          width: (box.width - 32) / textStyle.scale,
          text: box.label,
          tone: box.tone ?? "neutral",
          size: textStyle.size,
          align: "middle",
          index: generatedIndex,
          scale: textStyle.scale,
          ...box.opacity === undefined ? {} : { opacity: box.opacity }
        }));
      }
      continue;
    }
    if (shape.type === "text") {
      const text = shape;
      records.push(textShape({
        id: text.id,
        sourceId: text.id,
        x: text.x,
        y: text.y,
        width: text.width ?? Math.max(8, text.text.length * (text.fontSize ?? 24) * 0.58),
        text: text.text,
        tone: text.tone ?? "neutral",
        size: tldrawSize(text.fontSize),
        align: text.align ?? "start",
        index: generatedIndex,
        ...text.opacity === undefined ? {} : { opacity: text.opacity }
      }));
      continue;
    }
    const line = shape;
    records.push({
      ...baseShape(line, generatedIndex),
      type: "line",
      props: {
        dash: "solid",
        size: (line.strokeWidth ?? 3) >= 4 ? "l" : "m",
        color: tldrawColors[line.tone ?? "neutral"],
        spline: "line",
        points: {
          a1: { id: "a1", index: "a1", x: 0, y: 0 },
          a2: {
            id: "a2",
            index: "a2",
            x: line.x2 - line.x,
            y: line.y2 - line.y
          }
        },
        scale: 1
      }
    });
  }
  for (const edge of spec.edges ?? []) {
    const resolved = resolveEdge(spec, edge);
    generatedIndex += 1;
    const arrowId = shapeId(edge.id);
    records.push({
      x: resolved.start.x,
      y: resolved.start.y,
      rotation: 0,
      isLocked: false,
      opacity: 1,
      meta: shapeMeta(edge.id),
      id: arrowId,
      type: "arrow",
      props: {
        kind: "arc",
        elbowMidPoint: 0.5,
        dash: "solid",
        size: "m",
        fill: "none",
        color: tldrawColors[edge.tone ?? "neutral"],
        labelColor: tldrawColors[edge.tone ?? "neutral"],
        bend: edge.bend ?? 0,
        start: { x: 0, y: 0 },
        end: {
          x: resolved.end.x - resolved.start.x,
          y: resolved.end.y - resolved.start.y
        },
        arrowheadStart: "none",
        arrowheadEnd: edge.arrowhead ?? "arrow",
        richText: richText(edge.label ?? ""),
        labelPosition: 0.5,
        font: "sans",
        scale: 1
      },
      parentId: "page:page",
      index: indexKey(generatedIndex),
      typeName: "shape"
    });
    records.push({
      meta: {},
      id: `binding:${edge.id}-start`,
      fromId: arrowId,
      toId: shapeId(edge.from),
      type: "arrow",
      props: {
        isPrecise: false,
        isExact: false,
        normalizedAnchor: resolved.start.normalized,
        snap: "none",
        terminal: "start"
      },
      typeName: "binding"
    }, {
      meta: {},
      id: `binding:${edge.id}-end`,
      fromId: arrowId,
      toId: shapeId(edge.to),
      type: "arrow",
      props: {
        isPrecise: false,
        isExact: false,
        normalizedAnchor: resolved.end.normalized,
        snap: "none",
        terminal: "end"
      },
      typeName: "binding"
    });
  }
  return `${JSON.stringify({ tldrawFileFormatVersion: 1, schema, records }, null, 2)}
`;
}
// src/operations.ts
var atetOperationCodes = [
  "atet.diagram.check",
  "atet.diagram.render",
  "atet.image.vectorize",
  "atet.image.generate"
];

class AtetOperationError extends Error {
  code;
  constructor(code, message) {
    super(`[${code}] ${message}`);
    this.name = "AtetOperationError";
    this.code = code;
  }
}
var modelSchema = {
  type: "string",
  minLength: 3,
  maxLength: 256,
  pattern: "^[a-zA-Z0-9][a-zA-Z0-9._-]*/[a-zA-Z0-9][a-zA-Z0-9._:-]*$"
};
var pathSchema = {
  type: "string",
  minLength: 1,
  maxLength: 4096
};
function deepFreeze(value) {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) {
    return value;
  }
  for (const nested of Object.values(value))
    deepFreeze(nested);
  return Object.freeze(value);
}
var atetOperationRegistry = deepFreeze([
  {
    code: "atet.diagram.check",
    title: "Check diagram",
    description: "Parse and lint a checked Atet diagram source without changing its files.",
    execution: "local",
    authentication: "none",
    destructive: false,
    idempotent: true,
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["path"],
      properties: { path: pathSchema }
    },
    resources: [
      { resource: "cpu", amount: 1 },
      { resource: "local-io", amount: 1 }
    ]
  },
  {
    code: "atet.diagram.render",
    title: "Render diagram",
    description: "Render a checked Atet diagram source to its replaceable light, dark, PNG, SVG, and tldraw artifacts.",
    execution: "local",
    authentication: "none",
    destructive: true,
    idempotent: true,
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["path"],
      properties: {
        path: pathSchema,
        outDirectory: pathSchema,
        scale: {
          type: "number",
          exclusiveMinimum: 0,
          maximum: 4
        }
      }
    },
    resources: [
      { resource: "cpu", amount: 1 },
      { resource: "local-io", amount: 1 }
    ]
  },
  {
    code: "atet.image.vectorize",
    title: "Vectorize image",
    description: "Convert a local caller-owned raster into a bounded inert SVG without authentication or network access.",
    execution: "local",
    authentication: "none",
    destructive: true,
    idempotent: false,
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["inputPath", "outputPath"],
      properties: {
        inputPath: pathSchema,
        outputPath: pathSchema,
        duotone: {
          type: "array",
          minItems: 2,
          maxItems: 2,
          items: {
            type: "string",
            pattern: "^#[a-fA-F0-9]{3}(?:[a-fA-F0-9]{3})?$"
          }
        },
        alphaCutoff: { type: "integer", minimum: 1, maximum: 64 },
        timeoutMs: { type: "integer", minimum: 1, maximum: 300000 }
      }
    },
    resources: [
      { resource: "cpu", amount: 1 },
      { resource: "local-io", amount: 1 }
    ]
  },
  {
    code: "atet.image.generate",
    title: "Generate image",
    description: "Generate one bounded image directly through Vercel AI Gateway with an environment credential and no client retry.",
    execution: "gateway",
    authentication: "environment",
    destructive: true,
    idempotent: false,
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["model", "prompt", "outputPath"],
      properties: {
        model: modelSchema,
        prompt: {
          type: "string",
          minLength: 1,
          maxLength: atetMaximumPromptBytes
        },
        outputPath: pathSchema
      }
    },
    resources: [
      { resource: "local-io", amount: 1 },
      { resource: "network", amount: 1 },
      { resource: "paid-call", amount: 1 }
    ],
    transport: {
      method: "POST",
      authority: "https://ai-gateway.vercel.sh/v4/ai",
      authorization: "bearer",
      retry: "never"
    }
  }
]);
function operationFailure(message) {
  throw new AtetOperationError("INVALID_OPERATION_INPUT", message);
}
function isRecord2(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function record(value, allowedKeys) {
  if (!isRecord2(value))
    operationFailure("Operation input must be an object.");
  const unknown = Object.keys(value).filter((key) => !allowedKeys.includes(key));
  if (unknown.length > 0) {
    operationFailure(`Unsupported operation input field: ${unknown[0]}.`);
  }
  return value;
}
function pathValue(value, name) {
  if (typeof value !== "string" || value.length < 1 || value.length > 4096 || value.includes("\x00")) {
    operationFailure(`${name} must be a non-empty bounded local path.`);
  }
  return value;
}
function parseCheck(value) {
  const input = record(value, ["path"]);
  return { path: pathValue(input.path, "path") };
}
function parseRender(value) {
  const input = record(value, ["path", "outDirectory", "scale"]);
  const scale = input.scale;
  if (scale !== undefined && (typeof scale !== "number" || !Number.isFinite(scale) || scale <= 0 || scale > 4)) {
    operationFailure("scale must be greater than zero and no more than 4.");
  }
  return {
    path: pathValue(input.path, "path"),
    ...input.outDirectory === undefined ? {} : { outDirectory: pathValue(input.outDirectory, "outDirectory") },
    ...scale === undefined ? {} : { scale }
  };
}
function parseVectorize(value) {
  const input = record(value, [
    "inputPath",
    "outputPath",
    "duotone",
    "alphaCutoff",
    "timeoutMs"
  ]);
  const inputPath = pathValue(input.inputPath, "inputPath");
  const outputPath = pathValue(input.outputPath, "outputPath");
  if (!outputPath.toLowerCase().endsWith(".svg")) {
    operationFailure("outputPath must end in .svg.");
  }
  const duotone = input.duotone;
  if (duotone !== undefined && (!Array.isArray(duotone) || duotone.length !== 2 || duotone.some((color) => typeof color !== "string" || !/^#[a-f0-9]{3}(?:[a-f0-9]{3})?$/iu.test(color)))) {
    operationFailure("duotone must contain exactly two #rgb or #rrggbb colors.");
  }
  const alphaCutoff = input.alphaCutoff;
  if (alphaCutoff !== undefined && (!Number.isInteger(alphaCutoff) || alphaCutoff < 1 || alphaCutoff > 64)) {
    operationFailure("alphaCutoff must be an integer from 1 through 64.");
  }
  const timeoutMs = input.timeoutMs;
  if (timeoutMs !== undefined && (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 300000)) {
    operationFailure("timeoutMs must be an integer from 1 through 300000.");
  }
  return {
    inputPath,
    outputPath,
    ...duotone === undefined ? {} : { duotone },
    ...alphaCutoff === undefined ? {} : { alphaCutoff },
    ...timeoutMs === undefined ? {} : { timeoutMs }
  };
}
function parseGenerate(value) {
  const input = record(value, ["model", "prompt", "outputPath"]);
  if (typeof input.model !== "string" || input.model.length > 256 || !/^[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._:-]*$/iu.test(input.model)) {
    operationFailure("model must be a bounded Vercel AI Gateway provider/model id.");
  }
  if (typeof input.prompt !== "string" || input.prompt.trim().length < 1 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(input.prompt) || Buffer.byteLength(input.prompt, "utf8") > atetMaximumPromptBytes) {
    operationFailure(`prompt must be non-empty and no more than ${atetMaximumPromptBytes} UTF-8 bytes.`);
  }
  const outputPath = pathValue(input.outputPath, "outputPath");
  if (!/\.(?:jpe?g|png|webp)$/iu.test(outputPath)) {
    operationFailure("outputPath must end in .png, .jpg, .jpeg, or .webp.");
  }
  return {
    model: input.model,
    prompt: input.prompt,
    outputPath
  };
}
function parseAtetOperationInput(code, input) {
  switch (code) {
    case "atet.diagram.check":
      return parseCheck(input);
    case "atet.diagram.render":
      return parseRender(input);
    case "atet.image.vectorize":
      return parseVectorize(input);
    case "atet.image.generate":
      return parseGenerate(input);
    default:
      throw new AtetOperationError("INVALID_OPERATION", "Unknown Atet operation code.");
  }
}
function isAtetOperationCode(value) {
  return atetOperationCodes.includes(value);
}
function atetOperationHostResourceClaims(code) {
  const descriptor = atetOperationRegistry.find((candidate) => candidate.code === code);
  if (descriptor === undefined) {
    throw new AtetOperationError("INVALID_OPERATION", "Unknown Atet operation code.");
  }
  return descriptor.resources;
}
function searchAtetOperations(query = "", limit = atetOperationRegistry.length) {
  if (typeof query !== "string" || query.length > 200 || /[\u0000-\u001f\u007f]/u.test(query) || !Number.isInteger(limit) || limit < 1 || limit > 20) {
    throw new AtetOperationError("INVALID_SEARCH", "Search requires a bounded query and a limit from 1 through 20.");
  }
  const terms = query.toLowerCase().split(/\s+/u).filter((term) => term.length > 0);
  return atetOperationRegistry.filter((operation) => {
    const haystack = `${operation.code} ${operation.title} ${operation.description}`.toLowerCase();
    return terms.every((term) => haystack.includes(term));
  }).slice(0, limit);
}
function operationDependenciesWithLease(dependencies, lease) {
  const inheritedFileDescriptors = [
    ...dependencies.inheritedFileDescriptors ?? [],
    lease.inheritedFileDescriptor
  ].filter((descriptor, index, descriptors) => descriptors.indexOf(descriptor) === index);
  if (inheritedFileDescriptors.length > 16 || inheritedFileDescriptors.some((descriptor) => !Number.isSafeInteger(descriptor) || descriptor < 0 || descriptor > 2147483647)) {
    throw new AtetOperationError("INVALID_OPERATION_INPUT", "Operation host-resource inheritance exceeds its descriptor bound.");
  }
  const {
    hostResourceCoordinator: _hostResourceCoordinator,
    signal: _signal,
    waitTimeoutMilliseconds: _waitTimeoutMilliseconds,
    ...operationDependencies
  } = dependencies;
  return {
    ...operationDependencies,
    inheritedFileDescriptors
  };
}
async function withAtetOperationHostAdmission(code, callback, options = {}) {
  const coordinator = options.hostResourceCoordinator ?? createDefaultHostResourceCoordinator();
  return await coordinator.withLease(atetOperationHostResourceClaims(code), async (lease) => {
    await lease.assertOwned();
    return await callback(lease);
  }, {
    ...options.signal === undefined ? {} : { signal: options.signal },
    ...options.waitTimeoutMilliseconds === undefined ? {} : { waitTimeoutMilliseconds: options.waitTimeoutMilliseconds }
  });
}
var operationBuiltInConfig = Object.freeze({
  icons: builtInIcons
});
async function readOperationDiagram(path) {
  const absolutePath = resolve(path);
  let value;
  try {
    value = JSON.parse(await readFile2(absolutePath, "utf8"));
  } catch (cause) {
    throw new AtetOperationError("INVALID_OPERATION_INPUT", "Diagram source could not be read as JSON.");
  }
  const spec = parseDiagramSpec(value);
  for (const shape of spec.shapes) {
    if ((shape.type === "rect" || shape.type === "ellipse") && shape.icon !== undefined && !Object.hasOwn(builtInIcons, shape.icon)) {
      throw new AtetOperationError("INVALID_OPERATION_INPUT", "Diagram requests an unavailable built-in icon.");
    }
  }
  return { absolutePath, spec };
}
async function atomicOperationWrite(path, value) {
  const temporaryPath = join(dirname(path), `.${randomUUID()}.atet-operation.tmp`);
  try {
    await writeFile(temporaryPath, value, { flag: "wx" });
    await rename(temporaryPath, path);
  } finally {
    await rm(temporaryPath, { force: true }).catch(() => {
      return;
    });
  }
}
async function checkOperationDiagram(path) {
  const { spec } = await readOperationDiagram(path);
  return {
    findings: lintDiagram(spec),
    configPath: null
  };
}
async function renderOperationDiagram(input) {
  const { absolutePath, spec } = await readOperationDiagram(input.path);
  const outputDirectory = resolve(input.outDirectory ?? dirname(absolutePath));
  const scale = input.scale ?? 2;
  const [light, dark] = await Promise.all([
    renderSvg(spec, "light", operationBuiltInConfig),
    renderSvg(spec, "dark", operationBuiltInConfig)
  ]);
  const [lightPng, darkPng] = [
    renderPng(light, operationBuiltInConfig, scale),
    renderPng(dark, operationBuiltInConfig, scale)
  ];
  const artifacts = {
    spec: absolutePath,
    tldr: join(outputDirectory, `${spec.name}.tldr`),
    lightSvg: join(outputDirectory, `${spec.name}.light.svg`),
    darkSvg: join(outputDirectory, `${spec.name}.dark.svg`),
    lightPng: join(outputDirectory, `${spec.name}.light.png`),
    darkPng: join(outputDirectory, `${spec.name}.dark.png`)
  };
  await mkdir(outputDirectory, { recursive: true });
  await Promise.all([
    atomicOperationWrite(artifacts.tldr, serializeTldr(spec, operationBuiltInConfig)),
    atomicOperationWrite(artifacts.lightSvg, light.svg),
    atomicOperationWrite(artifacts.darkSvg, dark.svg),
    atomicOperationWrite(artifacts.lightPng, lightPng),
    atomicOperationWrite(artifacts.darkPng, darkPng)
  ]);
  return {
    artifacts,
    findings: lintDiagram(spec),
    configPath: null
  };
}
async function executeAtetOperationUncoordinated(code, value, dependencies = {}) {
  const input = parseAtetOperationInput(code, value);
  switch (code) {
    case "atet.diagram.check": {
      const options = input;
      return await checkOperationDiagram(options.path);
    }
    case "atet.diagram.render": {
      const options = input;
      return await renderOperationDiagram(options);
    }
    case "atet.image.vectorize": {
      const options = input;
      const result = await vectorizeImage(options.inputPath, {
        outputPath: options.outputPath,
        ...options.duotone === undefined ? {} : { duotone: options.duotone },
        ...options.alphaCutoff === undefined ? {} : { alphaCutoff: options.alphaCutoff },
        ...options.timeoutMs === undefined ? {} : { limits: { maxDurationMs: options.timeoutMs } },
        ...dependencies.inheritedFileDescriptors === undefined ? {} : {
          inheritedFileDescriptors: dependencies.inheritedFileDescriptors
        }
      });
      if (result.outputPath === null) {
        throw new AtetOperationError("INVALID_OPERATION_INPUT", "Vectorization did not publish its required output.");
      }
      return {
        outputPath: result.outputPath,
        receipt: result.receipt
      };
    }
    case "atet.image.generate": {
      const options = input;
      return await generateAtetImageFile({
        ...options,
        ...dependencies.signal === undefined ? {} : { signal: dependencies.signal }
      }, dependencies);
    }
    default:
      throw new AtetOperationError("INVALID_OPERATION", "Unknown Atet operation code.");
  }
}
async function executeAtetOperationWithLease(code, value, lease, dependencies = {}) {
  await lease.assertOwned();
  const available = new Map;
  for (const claim of lease.claims) {
    if (typeof claim.resource !== "string" || !/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/u.test(claim.resource) || !Number.isSafeInteger(claim.amount) || claim.amount < 1) {
      throw new AtetOperationError("INVALID_OPERATION", "The active host-resource lease contains invalid claims.");
    }
    const total = (available.get(claim.resource) ?? 0) + claim.amount;
    if (!Number.isSafeInteger(total)) {
      throw new AtetOperationError("INVALID_OPERATION", "The active host-resource lease contains invalid claims.");
    }
    available.set(claim.resource, total);
  }
  const missing = atetOperationHostResourceClaims(code).filter((claim) => (available.get(claim.resource) ?? 0) < claim.amount);
  if (missing.length > 0) {
    throw new AtetOperationError("INVALID_OPERATION", `The active host-resource lease does not cover ${missing.map((claim) => `${claim.resource}:${String(claim.amount)}`).join(", ")}.`);
  }
  return await executeAtetOperationUncoordinated(code, value, operationDependenciesWithLease(dependencies, lease));
}
async function executeAtetOperation(code, value, dependencies = {}) {
  const input = parseAtetOperationInput(code, value);
  return await withAtetOperationHostAdmission(code, async (lease) => await executeAtetOperationUncoordinated(code, input, operationDependenciesWithLease(dependencies, lease)), dependencies);
}

export { builtInIcons, sanitizeIcon, resolveEdge, renderSvg, renderPng, lintDiagram, stackLayoutDefaults, StackLayoutError, resolveStackLayout, resolveDiagramSource, DiagramValidationError, parseDiagramSource, parseDiagramSpec, serializeTldr, atetOperationCodes, AtetOperationError, atetOperationRegistry, parseAtetOperationInput, isAtetOperationCode, atetOperationHostResourceClaims, searchAtetOperations, withAtetOperationHostAdmission, executeAtetOperationWithLease, executeAtetOperation };
