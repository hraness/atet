// @bun
// src/artifacts.ts
import { mkdir, readFile as readFile3, rename, rm, writeFile } from "fs/promises";
import { basename, dirname as dirname2, join, resolve as resolve2 } from "path";

// src/config.ts
import { readFile } from "fs/promises";
import { dirname, extname, isAbsolute, resolve } from "path";
import { pathToFileURL } from "url";

// src/fs.ts
import { access } from "fs/promises";
async function pathExists(filePath) {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

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

// src/config.ts
var defaultNames = [
  "diagram.config.ts",
  "diagram.config.mjs",
  "diagram.config.js",
  "diagram.config.json"
];
function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function parseFont(value, at) {
  if (!isRecord(value) || typeof value.family !== "string" || value.family.trim() === "") {
    throw new Error(`${at} must have a non-empty family`);
  }
  if (value.files !== undefined && !Array.isArray(value.files)) {
    throw new Error(`${at}.files must be an array`);
  }
  const files = (value.files ?? []).map((file, index) => {
    if (!isRecord(file) || typeof file.path !== "string" || file.path.trim() === "") {
      throw new Error(`${at}.files[${index}].path must be a non-empty string`);
    }
    if (file.weight !== undefined && (typeof file.weight !== "number" || !Number.isFinite(file.weight))) {
      throw new Error(`${at}.files[${index}].weight must be a finite number`);
    }
    if (file.style !== undefined && file.style !== "normal" && file.style !== "italic") {
      throw new Error(`${at}.files[${index}].style must be normal or italic`);
    }
    if (file.embed !== undefined && typeof file.embed !== "boolean") {
      throw new Error(`${at}.files[${index}].embed must be a boolean`);
    }
    const style = file.style;
    return {
      path: file.path,
      ...file.weight === undefined ? {} : { weight: file.weight },
      ...style === undefined ? {} : { style },
      ...file.embed === undefined ? {} : { embed: file.embed }
    };
  });
  return { family: value.family, ...files.length === 0 ? {} : { files } };
}
function parseIcons(value, at) {
  if (!isRecord(value))
    throw new Error(`${at} must be an object`);
  return Object.fromEntries(Object.entries(value).map(([name, icon]) => {
    if (!isRecord(icon) || typeof icon.viewBox !== "string" || typeof icon.body !== "string") {
      throw new Error(`${at}.${name} must have string viewBox and body fields`);
    }
    return [name, sanitizeIcon({ viewBox: icon.viewBox, body: icon.body })];
  }));
}
function parseTheme(value, at) {
  if (!isRecord(value))
    throw new Error(`${at} must be an object`);
  const scalarKeys = ["background", "foreground", "muted", "stroke"];
  for (const key of scalarKeys) {
    if (value[key] !== undefined && typeof value[key] !== "string") {
      throw new Error(`${at}.${key} must be a CSS color string`);
    }
  }
  if (value.tones !== undefined && !isRecord(value.tones)) {
    throw new Error(`${at}.tones must be an object`);
  }
  return value;
}
function parseConfig(value) {
  if (!isRecord(value))
    throw new Error("Diagram config must export an object");
  const font = value.font === undefined ? undefined : parseFont(value.font, "font");
  const icons = value.icons === undefined ? undefined : parseIcons(value.icons, "icons");
  let theme;
  if (value.theme !== undefined) {
    if (!isRecord(value.theme))
      throw new Error("theme must be an object");
    theme = {
      ...value.theme.light === undefined ? {} : { light: parseTheme(value.theme.light, "theme.light") },
      ...value.theme.dark === undefined ? {} : { dark: parseTheme(value.theme.dark, "theme.dark") }
    };
  }
  return {
    ...font === undefined ? {} : { font },
    ...icons === undefined ? {} : { icons: { ...builtInIcons, ...icons } },
    ...theme === undefined ? {} : { theme }
  };
}
async function discoverConfig(directory) {
  for (const name of defaultNames) {
    const candidate = resolve(directory, name);
    if (await pathExists(candidate))
      return candidate;
  }
  return null;
}
async function loadDiagramConfig(options) {
  const filePath = options.explicitPath === undefined ? await discoverConfig(options.searchDirectory) : resolve(options.explicitPath);
  if (filePath === null) {
    return {
      filePath: null,
      baseDirectory: options.searchDirectory,
      value: { icons: builtInIcons }
    };
  }
  if (!await pathExists(filePath))
    throw new Error(`Config does not exist: ${filePath}`);
  const raw = extname(filePath) === ".json" ? JSON.parse(await readFile(filePath, "utf8")) : (await import(`${pathToFileURL(filePath).href}?v=${Date.now()}`)).default;
  const value = parseConfig(raw);
  const baseDirectory = dirname(filePath);
  const font = value.font === undefined ? undefined : {
    ...value.font,
    ...value.font.files === undefined ? {} : {
      files: value.font.files.map((file) => ({
        ...file,
        path: isAbsolute(file.path) ? file.path : resolve(baseDirectory, file.path)
      }))
    }
  };
  return {
    filePath,
    baseDirectory,
    value: {
      ...value,
      icons: { ...builtInIcons, ...value.icons },
      ...font === undefined ? {} : { font }
    }
  };
}

// src/render.ts
import { readFile as readFile2 } from "fs/promises";
import { extname as extname2 } from "path";
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
  switch (extname2(filePath).toLowerCase()) {
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
    const encoded = (await readFile2(file.path)).toString("base64");
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
    y: icon === undefined ? shape.y + shape.height / 2 - 12 : shape.y + shape.height * 0.68,
    width: shape.width - 32,
    fontSize: 22,
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
function isRecord2(value) {
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
  if (!isRecord2(value)) {
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
function parseEdge(value, index, issues) {
  const at = `edges[${index}]`;
  if (!isRecord2(value)) {
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
function parseDiagramSpec(value) {
  const issues = [];
  if (!isRecord2(value))
    throw new DiagramValidationError(["root must be an object"]);
  validateKnownKeys(value, new Set(["$schema", "version", "name", "canvas", "shapes", "edges"]), "root", issues);
  if (value.version !== diagramVersion)
    issues.push(`version must be ${diagramVersion}`);
  const name = readString(value, "name", "root", issues);
  if (name !== undefined && !namePattern.test(name)) {
    issues.push("name must be lowercase kebab-case");
  }
  const canvasValue = value.canvas;
  let canvas = null;
  if (!isRecord2(canvasValue)) {
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
  const shapesValue = value.shapes;
  const shapes = [];
  if (!Array.isArray(shapesValue)) {
    issues.push("shapes must be an array");
  } else {
    for (const [index, shape] of shapesValue.entries()) {
      const parsed = parseShape(shape, index, issues);
      if (parsed !== null)
        shapes.push(parsed);
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
  if (issues.length > 0 || name === undefined || canvas === null) {
    throw new DiagramValidationError(issues);
  }
  return {
    ..."$schema" in value && typeof value.$schema === "string" ? { $schema: value.$schema } : {},
    version: diagramVersion,
    name,
    canvas,
    shapes,
    ...edgesValue === undefined ? {} : { edges }
  };
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
      scale: 1,
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
          richText: richText(hasIcon ? "" : box.label ?? "")
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
        if (box.label !== undefined) {
          generatedIndex += 1;
          records.push(textShape({
            id: `${box.id}-label`,
            sourceId: box.id,
            x: box.x + 16,
            y: box.y + box.height * 0.68,
            width: box.width - 32,
            text: box.label,
            tone: box.tone ?? "neutral",
            size: "l",
            align: "middle",
            index: generatedIndex,
            ...box.opacity === undefined ? {} : { opacity: box.opacity }
          }));
        }
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

// src/artifacts.ts
async function atomicWrite(filePath, data) {
  const temporary = `${filePath}.tmp-${process.pid}-${crypto.randomUUID()}`;
  try {
    await writeFile(temporary, data);
    await rename(temporary, filePath);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
}
async function readDiagramFile(filePath) {
  const absolutePath = resolve2(filePath);
  let parsed;
  try {
    parsed = JSON.parse(await readFile3(absolutePath, "utf8"));
  } catch (error) {
    throw new Error(`Could not read diagram JSON at ${absolutePath}`, { cause: error });
  }
  return { absolutePath, spec: parseDiagramSpec(parsed) };
}
async function checkDiagramFile(options) {
  const { absolutePath, spec } = await readDiagramFile(options.filePath);
  const config = await loadDiagramConfig({
    ...options.configPath === undefined ? {} : { explicitPath: options.configPath },
    searchDirectory: dirname2(absolutePath)
  });
  for (const shape of spec.shapes) {
    if ((shape.type === "rect" || shape.type === "ellipse") && shape.icon !== undefined && config.value.icons?.[shape.icon] === undefined) {
      throw new Error(`Unknown icon "${shape.icon}" on shape ${shape.id}`);
    }
  }
  return { findings: lintDiagram(spec), configPath: config.filePath };
}
async function renderDiagramFile(options) {
  const { absolutePath, spec } = await readDiagramFile(options.filePath);
  const outDirectory = resolve2(options.outDirectory ?? dirname2(absolutePath));
  const config = await loadDiagramConfig({
    ...options.configPath === undefined ? {} : { explicitPath: options.configPath },
    searchDirectory: dirname2(absolutePath)
  });
  const scale = options.scale ?? 2;
  if (!Number.isFinite(scale) || scale <= 0 || scale > 8) {
    throw new Error("PNG scale must be greater than zero and no more than 8");
  }
  const [light, dark] = await Promise.all([
    renderSvg(spec, "light", config.value),
    renderSvg(spec, "dark", config.value)
  ]);
  const [lightPng, darkPng] = [renderPng(light, config.value, scale), renderPng(dark, config.value, scale)];
  const artifacts = {
    spec: absolutePath,
    tldr: join(outDirectory, `${spec.name}.tldr`),
    lightSvg: join(outDirectory, `${spec.name}.light.svg`),
    darkSvg: join(outDirectory, `${spec.name}.dark.svg`),
    lightPng: join(outDirectory, `${spec.name}.light.png`),
    darkPng: join(outDirectory, `${spec.name}.dark.png`)
  };
  await mkdir(outDirectory, { recursive: true });
  await Promise.all([
    atomicWrite(artifacts.tldr, serializeTldr(spec, config.value)),
    atomicWrite(artifacts.lightSvg, light.svg),
    atomicWrite(artifacts.darkSvg, dark.svg),
    atomicWrite(artifacts.lightPng, lightPng),
    atomicWrite(artifacts.darkPng, darkPng)
  ]);
  return { artifacts, findings: lintDiagram(spec), configPath: config.filePath };
}
function artifactSummary(artifacts) {
  return [
    `Rendered ${basename(artifacts.spec)}`,
    `  ${artifacts.tldr}`,
    `  ${artifacts.lightSvg}`,
    `  ${artifacts.darkSvg}`,
    `  ${artifacts.lightPng}`,
    `  ${artifacts.darkPng}`
  ].join(`
`);
}

// src/desktop.ts
import { createHash } from "crypto";
import { createReadStream, createWriteStream } from "fs";
import { chmod, mkdir as mkdir2, readFile as readFile4, rename as rename2, rm as rm2 } from "fs/promises";
import { homedir, platform as hostPlatform, arch as hostArch } from "os";
import { dirname as dirname3, join as join2, resolve as resolve3 } from "path";
import { Readable } from "stream";
import { pipeline } from "stream/promises";
var releaseApi = "https://api.github.com/repos/tldraw/tldraw-offline/releases/latest";
var desktopDownloadPage = "https://offline.tldraw.com";
function isRecord3(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function parseRelease(value) {
  if (!isRecord3(value) || typeof value.tag_name !== "string" || typeof value.html_url !== "string" || !Array.isArray(value.assets)) {
    throw new Error("GitHub returned an invalid tldraw Offline release");
  }
  const assets = value.assets.map((asset, index) => {
    if (!isRecord3(asset) || typeof asset.name !== "string" || typeof asset.browser_download_url !== "string" || typeof asset.size !== "number" || asset.digest !== null && asset.digest !== undefined && typeof asset.digest !== "string") {
      throw new Error(`GitHub returned an invalid release asset at index ${index}`);
    }
    return {
      name: asset.name,
      browser_download_url: asset.browser_download_url,
      size: asset.size,
      digest: asset.digest ?? null
    };
  });
  return { tag_name: value.tag_name, html_url: value.html_url, assets };
}
function selectDesktopAsset(release, platform = hostPlatform(), architecture = hostArch()) {
  const expectedName = platform === "darwin" ? "tldraw-offline-mac-universal.dmg" : platform === "win32" ? architecture === "arm64" ? "tldraw-offline-win-arm64.exe" : "tldraw-offline-win-x64.exe" : platform === "linux" ? architecture === "arm64" ? "tldraw-offline-linux-arm64.AppImage" : "tldraw-offline-linux-x86_64.AppImage" : null;
  if (expectedName === null) {
    throw new Error(`tldraw Offline has no automated installer for ${platform}/${architecture}`);
  }
  const asset = release.assets.find((candidate) => candidate.name === expectedName);
  if (asset === undefined) {
    throw new Error(`The latest tldraw Offline release does not contain ${expectedName}`);
  }
  return asset;
}
async function getLatestDesktopRelease() {
  const response = await fetch(releaseApi, {
    headers: {
      Accept: "application/vnd.github+json",
      "User-Agent": "CCLRTE-diagram",
      "X-GitHub-Api-Version": "2022-11-28"
    }
  });
  if (!response.ok)
    throw new Error(`GitHub release lookup failed with HTTP ${response.status}`);
  return parseRelease(await response.json());
}
async function sha256(filePath) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(filePath))
    hash.update(chunk);
  return hash.digest("hex");
}
async function download(asset, filePath) {
  const response = await fetch(asset.browser_download_url, {
    headers: { "User-Agent": "CCLRTE-diagram" },
    redirect: "follow"
  });
  if (!response.ok || response.body === null) {
    throw new Error(`Installer download failed with HTTP ${response.status}`);
  }
  const temporary = `${filePath}.part-${process.pid}`;
  await mkdir2(dirname3(filePath), { recursive: true });
  try {
    await pipeline(Readable.fromWeb(response.body), createWriteStream(temporary, { mode: 384 }));
    const expected = asset.digest?.startsWith("sha256:") ? asset.digest.slice(7) : null;
    if (expected === null) {
      throw new Error("GitHub did not publish a SHA-256 digest for this installer");
    }
    const actual = await sha256(temporary);
    if (actual !== expected) {
      throw new Error(`Installer checksum mismatch: expected ${expected}, received ${actual}`);
    }
    await rename2(temporary, filePath);
  } catch (error) {
    await rm2(temporary, { force: true });
    throw error;
  }
}
function spawnDetached(command) {
  const child = Bun.spawn([...command], {
    stdin: "ignore",
    stdout: "ignore",
    stderr: "ignore"
  });
  child.unref();
}
async function installDesktop(options) {
  const release = await getLatestDesktopRelease();
  const asset = selectDesktopAsset(release);
  const cacheDirectory = join2(homedir(), ".cache", "diagram", "installers", release.tag_name);
  const installerPath = join2(cacheDirectory, asset.name);
  let reusable = false;
  if (await pathExists(installerPath)) {
    const expected = asset.digest?.startsWith("sha256:") ? asset.digest.slice(7) : null;
    reusable = expected !== null && await sha256(installerPath) === expected;
  }
  if (!reusable)
    await download(asset, installerPath);
  if (hostPlatform() === "linux") {
    const installedPath = join2(homedir(), ".local", "bin", "tldraw-offline");
    await mkdir2(dirname3(installedPath), { recursive: true });
    const temporary = `${installedPath}.tmp-${process.pid}`;
    await Bun.write(temporary, Bun.file(installerPath));
    await chmod(temporary, 493);
    await rename2(temporary, installedPath);
    if (!options.downloadOnly)
      spawnDetached([installedPath]);
    return { filePath: installedPath, release: release.tag_name };
  }
  if (!options.downloadOnly) {
    if (hostPlatform() === "darwin") {
      spawnDetached(["open", installerPath]);
    } else {
      spawnDetached(["cmd.exe", "/d", "/s", "/c", "start", "", installerPath]);
    }
  }
  return { filePath: installerPath, release: release.tag_name };
}
async function findDesktopApplication() {
  const candidates = hostPlatform() === "darwin" ? [
    "/Applications/tldraw offline.app",
    join2(homedir(), "Applications", "tldraw offline.app")
  ] : hostPlatform() === "linux" ? [join2(homedir(), ".local", "bin", "tldraw-offline")] : [
    join2(process.env.LOCALAPPDATA ?? join2(homedir(), "AppData", "Local"), "Programs", "tldraw offline", "tldraw offline.exe")
  ];
  for (const candidate of candidates)
    if (await pathExists(candidate))
      return candidate;
  return null;
}
function serverFilePath() {
  if (hostPlatform() === "darwin") {
    return join2(homedir(), "Library", "Application Support", "tldraw", "server.json");
  }
  if (hostPlatform() === "win32") {
    return join2(process.env.APPDATA ?? join2(homedir(), "AppData", "Roaming"), "tldraw", "server.json");
  }
  return join2(process.env.XDG_CONFIG_HOME ?? join2(homedir(), ".config"), "tldraw", "server.json");
}
async function desktopStatus() {
  const installedPath = await findDesktopApplication();
  const filePath = serverFilePath();
  if (!await pathExists(filePath))
    return { installedPath, server: null };
  try {
    const parsed = JSON.parse(await readFile4(filePath, "utf8"));
    if (!isRecord3(parsed) || typeof parsed.port !== "number") {
      return { installedPath, server: null };
    }
    return {
      installedPath,
      server: {
        port: parsed.port,
        pid: typeof parsed.pid === "number" ? parsed.pid : null
      }
    };
  } catch {
    return { installedPath, server: null };
  }
}
async function openInDesktop(filePath) {
  const absolutePath = resolve3(filePath);
  if (!await pathExists(absolutePath))
    throw new Error(`File does not exist: ${absolutePath}`);
  const application = await findDesktopApplication();
  if (application === null) {
    throw new Error(`tldraw Offline is not installed. Run "diagram desktop install" or visit ${desktopDownloadPage}`);
  }
  if (hostPlatform() === "darwin") {
    spawnDetached(["open", "-a", application, absolutePath]);
  } else if (hostPlatform() === "win32") {
    spawnDetached(["cmd.exe", "/d", "/s", "/c", "start", "", absolutePath]);
  } else {
    spawnDetached([application, absolutePath]);
  }
}

// src/skill-install.ts
import { cp, mkdir as mkdir3, rm as rm3 } from "fs/promises";
import { homedir as homedir2 } from "os";
import { dirname as dirname4, join as join3, resolve as resolve4 } from "path";
import { fileURLToPath } from "url";
function bundledSkillPath() {
  return resolve4(dirname4(fileURLToPath(import.meta.url)), "../skills/diagram");
}
function targetRoot(target, scope, projectDirectory) {
  const directory = target === "codex" ? ".codex" : target === "claude" ? ".claude" : ".agents";
  return scope === "user" ? join3(homedir2(), directory, "skills") : join3(projectDirectory, directory, "skills");
}
async function installSkill(options) {
  const source = bundledSkillPath();
  if (!await pathExists(source))
    throw new Error(`Bundled skill is missing: ${source}`);
  const destination = join3(targetRoot(options.target, options.scope, resolve4(options.projectDirectory ?? process.cwd())), "diagram");
  if (await pathExists(destination)) {
    if (!options.force) {
      throw new Error(`Skill already exists at ${destination}; pass --force to replace it`);
    }
    await rm3(destination, { recursive: true, force: true });
  }
  await mkdir3(dirname4(destination), { recursive: true });
  await cp(source, destination, { recursive: true, errorOnExist: true });
  return destination;
}

// src/index.ts
var diagramApi = Object.freeze({
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
  serializeTldr
});
export {
  serializeTldr,
  selectDesktopAsset,
  resolveEdge,
  renderSvg,
  renderPng,
  renderDiagramFile,
  readDiagramFile,
  parseDiagramSpec,
  openInDesktop,
  lintDiagram,
  installSkill,
  installDesktop,
  getLatestDesktopRelease,
  findDesktopApplication,
  diagramApi,
  desktopStatus,
  desktopDownloadPage,
  checkDiagramFile,
  bundledSkillPath,
  builtInIcons,
  artifactSummary,
  DiagramValidationError
};
