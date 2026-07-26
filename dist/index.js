// @bun
var __require = import.meta.require;

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
var configNames = [
  { current: "graphics.config.ts", legacy: "diagram.config.ts" },
  { current: "graphics.config.mjs", legacy: "diagram.config.mjs" },
  { current: "graphics.config.js", legacy: "diagram.config.js" },
  { current: "graphics.config.json", legacy: "diagram.config.json" }
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
    throw new Error("Graphics config must export an object");
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
  for (const names of configNames) {
    const candidate = resolve(directory, names.current);
    if (await pathExists(candidate))
      return candidate;
  }
  for (const names of configNames) {
    const candidate = resolve(directory, names.legacy);
    if (await pathExists(candidate)) {
      const replacement = resolve(directory, names.current);
      throw new Error(`Legacy Graphics config found at ${candidate}. Rename it to ${replacement}; Graphics does not auto-load diagram.config.*.`);
    }
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
function parseStackShape(value, index, issues) {
  const at = `shapes[${index}]`;
  if (!isRecord2(value)) {
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
    ...icon === undefined ? {} : { icon },
    ...iconSize === undefined ? {} : { iconSize },
    ...strokeWidth === undefined ? {} : { strokeWidth },
    ...typeof fill === "boolean" ? { fill } : {}
  };
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
function parseStackLayout(value, issues) {
  if (!isRecord2(value)) {
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
  if (!isRecord2(value))
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
      "User-Agent": "hraness-graphics",
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
    headers: { "User-Agent": "hraness-graphics" },
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
  const cacheDirectory = join2(homedir(), ".cache", "graphics", "installers", release.tag_name);
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
    throw new Error(`tldraw Offline is not installed. Run "graphics desktop install" or visit ${desktopDownloadPage}`);
  }
  if (hostPlatform() === "darwin") {
    spawnDetached(["open", "-a", application, absolutePath]);
  } else if (hostPlatform() === "win32") {
    spawnDetached(["cmd.exe", "/d", "/s", "/c", "start", "", absolutePath]);
  } else {
    spawnDetached([application, absolutePath]);
  }
}

// src/auth.ts
import { createHash as createHash3, randomBytes as randomBytes2, timingSafeEqual } from "crypto";
import { createServer } from "http";

// src/cloud-errors.ts
class GraphicsCloudError extends Error {
  code;
  constructor(code, message, options) {
    super(`[${code}] ${message}`, options);
    this.name = "GraphicsCloudError";
    this.code = code;
  }
}

// src/discovery.ts
var graphicsDiscoveryUrl = "https://hraness.graphics/.well-known/graphics-cli.json";
var graphicsRedirectUri = "http://127.0.0.1:49671/oauth/callback";
var graphicsProductionContract = Object.freeze({
  environment: "production",
  apiBaseUrl: "https://hraness.graphics/api/v1",
  operationsUrl: "https://hraness.graphics/api/v1/operations",
  issuer: "https://account.hraness.com",
  authorizationEndpoint: "https://account.hraness.com/api/auth/oauth2/authorize",
  tokenEndpoint: "https://account.hraness.com/api/auth/oauth2/token",
  revocationEndpoint: "https://account.hraness.com/api/auth/oauth2/revoke",
  clientId: "hraness:graphics:production:v1",
  resource: "https://hraness.com/suite",
  generateImage: "https://hraness.graphics/api/v1/images/generate",
  maximumPromptBytes: 8192,
  maximumRawImageBytes: 3145728
});
var graphicsImageModels = Object.freeze([
  "openai/gpt-image-1.5",
  "recraft/recraft-v4.1-utility"
]);
var graphicsResponseMediaTypes = Object.freeze([
  "image/webp"
]);
var graphicsImageGenerationQuota = Object.freeze({
  accountDailyLimit: 10,
  globalDailySafetyLimit: 100,
  paymentEnforced: false,
  period: "utc-day"
});
var graphicsDiscoveryMaximumBytes = 32 * 1024;
var graphicsMaximumPromptBytes = graphicsProductionContract.maximumPromptBytes;
var graphicsMaximumRawImageBytes = graphicsProductionContract.maximumRawImageBytes;
function invalidDiscovery() {
  throw new GraphicsCloudError("DISCOVERY_INVALID", "Graphics service discovery returned an invalid contract.");
}
function isRecord4(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function exactKeys(value, expected) {
  const actual = Object.keys(value).sort();
  const canonical = [...expected].sort();
  if (actual.length !== canonical.length || actual.some((key, index) => key !== canonical[index])) {
    invalidDiscovery();
  }
}
function positiveInteger(value, maximum) {
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
    invalidDiscovery();
  }
  return value;
}
function exactStringTuple(value, expected) {
  if (!Array.isArray(value) || value.length !== expected.length || value.some((entry, index) => entry !== expected[index])) {
    invalidDiscovery();
  }
}
function parseAuthorization(value) {
  if (!isRecord4(value))
    invalidDiscovery();
  exactKeys(value, [
    "type",
    "issuer",
    "authorizationEndpoint",
    "tokenEndpoint",
    "revocationEndpoint",
    "clientId",
    "redirectUri",
    "scopes",
    "resource",
    "pkce"
  ]);
  if (value.type !== "oauth2-authorization-code" || value.issuer !== graphicsProductionContract.issuer || value.authorizationEndpoint !== graphicsProductionContract.authorizationEndpoint || value.tokenEndpoint !== graphicsProductionContract.tokenEndpoint || value.revocationEndpoint !== graphicsProductionContract.revocationEndpoint || value.clientId !== graphicsProductionContract.clientId || value.redirectUri !== graphicsRedirectUri || value.resource !== graphicsProductionContract.resource || value.pkce !== "S256") {
    invalidDiscovery();
  }
  exactStringTuple(value.scopes, ["openid", "offline_access"]);
  return {
    type: "oauth2-authorization-code",
    issuer: graphicsProductionContract.issuer,
    authorizationEndpoint: graphicsProductionContract.authorizationEndpoint,
    tokenEndpoint: graphicsProductionContract.tokenEndpoint,
    revocationEndpoint: graphicsProductionContract.revocationEndpoint,
    clientId: graphicsProductionContract.clientId,
    redirectUri: graphicsRedirectUri,
    scopes: ["openid", "offline_access"],
    resource: graphicsProductionContract.resource,
    pkce: "S256"
  };
}
function parseImageGeneration(value) {
  if (!isRecord4(value))
    invalidDiscovery();
  exactKeys(value, [
    "access",
    "billing",
    "models",
    "maximumPromptBytes",
    "maximumRawImageBytes",
    "imagesPerRequest",
    "responseMediaTypes",
    "quota",
    "idempotency"
  ]);
  if (value.access !== "authenticated" || value.billing !== "free-preview") {
    invalidDiscovery();
  }
  exactStringTuple(value.models, graphicsImageModels);
  if (value.imagesPerRequest !== 1)
    invalidDiscovery();
  exactStringTuple(value.responseMediaTypes, ["image/webp"]);
  if (!isRecord4(value.quota))
    invalidDiscovery();
  exactKeys(value.quota, [
    "accountDailyLimit",
    "globalDailySafetyLimit",
    "paymentEnforced",
    "period"
  ]);
  if (value.quota.accountDailyLimit !== graphicsImageGenerationQuota.accountDailyLimit || value.quota.globalDailySafetyLimit !== graphicsImageGenerationQuota.globalDailySafetyLimit || value.quota.paymentEnforced !== graphicsImageGenerationQuota.paymentEnforced || value.quota.period !== graphicsImageGenerationQuota.period) {
    invalidDiscovery();
  }
  if (!isRecord4(value.idempotency))
    invalidDiscovery();
  exactKeys(value.idempotency, ["header", "durable", "scope"]);
  if (value.idempotency.header !== "Idempotency-Key" || value.idempotency.durable !== true || value.idempotency.scope !== "suite-account") {
    invalidDiscovery();
  }
  return {
    access: "authenticated",
    billing: "free-preview",
    models: graphicsImageModels,
    maximumPromptBytes: positiveInteger(value.maximumPromptBytes, graphicsMaximumPromptBytes) === graphicsProductionContract.maximumPromptBytes ? graphicsProductionContract.maximumPromptBytes : invalidDiscovery(),
    maximumRawImageBytes: positiveInteger(value.maximumRawImageBytes, graphicsMaximumRawImageBytes) === graphicsProductionContract.maximumRawImageBytes ? graphicsProductionContract.maximumRawImageBytes : invalidDiscovery(),
    imagesPerRequest: 1,
    responseMediaTypes: ["image/webp"],
    quota: graphicsImageGenerationQuota,
    idempotency: {
      header: "Idempotency-Key",
      durable: true,
      scope: "suite-account"
    }
  };
}
function parseFeatures(value) {
  if (!isRecord4(value))
    invalidDiscovery();
  exactKeys(value, ["vectorize"]);
  if (!isRecord4(value.vectorize))
    invalidDiscovery();
  exactKeys(value.vectorize, ["access", "billing", "execution"]);
  if (value.vectorize.access !== "authenticated" || value.vectorize.billing !== "free" || value.vectorize.execution !== "local") {
    invalidDiscovery();
  }
  return {
    vectorize: {
      access: "authenticated",
      billing: "free",
      execution: "local"
    }
  };
}
function deepFreeze(value) {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) {
    return value;
  }
  for (const nested of Object.values(value))
    deepFreeze(nested);
  return Object.freeze(value);
}
function parseGraphicsDiscovery(value) {
  if (!isRecord4(value))
    invalidDiscovery();
  exactKeys(value, [
    "schemaVersion",
    "product",
    "environment",
    "apiBaseUrl",
    "operationsUrl",
    "authorization",
    "endpoints",
    "imageGeneration",
    "features"
  ]);
  if (value.schemaVersion !== 1 || value.product !== "graphics") {
    invalidDiscovery();
  }
  if (!isRecord4(value.endpoints))
    invalidDiscovery();
  exactKeys(value.endpoints, ["generateImage"]);
  return deepFreeze({
    schemaVersion: 1,
    product: "graphics",
    environment: value.environment === graphicsProductionContract.environment ? graphicsProductionContract.environment : invalidDiscovery(),
    apiBaseUrl: value.apiBaseUrl === graphicsProductionContract.apiBaseUrl ? graphicsProductionContract.apiBaseUrl : invalidDiscovery(),
    operationsUrl: value.operationsUrl === graphicsProductionContract.operationsUrl ? graphicsProductionContract.operationsUrl : invalidDiscovery(),
    authorization: parseAuthorization(value.authorization),
    endpoints: {
      generateImage: value.endpoints.generateImage === graphicsProductionContract.generateImage ? graphicsProductionContract.generateImage : invalidDiscovery()
    },
    imageGeneration: parseImageGeneration(value.imageGeneration),
    features: parseFeatures(value.features)
  });
}
async function readBoundedResponseBytes(response, maximumBytes, error) {
  const contentLength = response.headers.get("content-length");
  if (contentLength !== null && (!/^(?:0|[1-9][0-9]*)$/u.test(contentLength) || Number(contentLength) > maximumBytes)) {
    await response.body?.cancel().catch(() => {
      return;
    });
    throw error;
  }
  if (response.body === null)
    return new Uint8Array;
  const reader = response.body.getReader();
  const chunks = [];
  let length = 0;
  try {
    for (;; ) {
      const next = await reader.read();
      if (next.done)
        break;
      length += next.value.byteLength;
      if (length > maximumBytes) {
        await reader.cancel();
        throw error;
      }
      chunks.push(next.value);
    }
  } catch (caught) {
    if (caught === error)
      throw caught;
    throw error;
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}
async function readBoundedJson(response, maximumBytes, error) {
  const bytes = await readBoundedResponseBytes(response, maximumBytes, error);
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return JSON.parse(text);
  } catch {
    throw error;
  }
}
async function fetchGraphicsDiscovery(fetchImplementation = fetch) {
  const unavailable = new GraphicsCloudError("DISCOVERY_UNAVAILABLE", "Graphics service discovery is unavailable.");
  let response;
  try {
    response = await fetchImplementation(graphicsDiscoveryUrl, {
      headers: {
        accept: "application/json",
        "user-agent": "hraness-graphics-cli/0.4.0"
      },
      redirect: "error",
      signal: AbortSignal.timeout(1e4)
    });
  } catch (cause) {
    throw new GraphicsCloudError("DISCOVERY_UNAVAILABLE", "Graphics service discovery is unavailable.", { cause });
  }
  if (response.status !== 200) {
    await response.body?.cancel().catch(() => {
      return;
    });
    throw unavailable;
  }
  const contentType = response.headers.get("content-type");
  if (contentType === null || !/^application\/json(?:\s*;\s*charset=(?:utf-8|"utf-8"))?$/iu.test(contentType)) {
    await response.body?.cancel().catch(() => {
      return;
    });
    throw new GraphicsCloudError("DISCOVERY_INVALID", "Graphics service discovery returned an invalid content type.");
  }
  const value = await readBoundedJson(response, graphicsDiscoveryMaximumBytes, new GraphicsCloudError("DISCOVERY_INVALID", "Graphics service discovery returned an invalid contract."));
  return parseGraphicsDiscovery(value);
}

// src/credential-lease.ts
import { createHash as createHash2, randomBytes } from "crypto";
import {
  lstat,
  mkdir as mkdir3,
  open,
  readFile as readFile5,
  readlink,
  readdir,
  unlink
} from "fs/promises";
import { homedir as homedir2 } from "os";
import { isAbsolute as isAbsolute2, join as join3 } from "path";
import { performance as performance2 } from "perf_hooks";
var choosingMarkerPattern = /^choosing-v4-([0-9a-f]{32})-(\d{1,10})-([0-9a-f]{32})-([0-9a-f]{32})$/u;
var leaseMarkerPattern = /^lease-v4-([0-9a-f]{16})-([0-9a-f]{32})-(\d{1,10})-([0-9a-f]{32})-([0-9a-f]{32})$/u;
var maximumDirectoryEntries = 256;
var defaultWaitMilliseconds = 35000;
var defaultStaleMilliseconds = 30000;
var defaultPollMilliseconds = 50;
var maximumDurationMilliseconds = 5 * 60000;
var maximumPathBytes = 4096;
var maximumTicket = 0xffff_ffff_ffff_ffffn;
var graphicsCredentialMutationPlatforms = Object.freeze([
  "darwin",
  "linux"
]);
function errorCode(purpose) {
  return purpose === "refresh" ? "TOKEN_REFRESH_FAILED" : "TOKEN_STORAGE_FAILED";
}
function defaultFailureMessage(purpose) {
  return purpose === "refresh" ? "Graphics could not safely coordinate a login refresh." : "Graphics could not safely coordinate credential storage.";
}
function leaseFailure(purpose, message = defaultFailureMessage(purpose), cause) {
  return new GraphicsCloudError(errorCode(purpose), message, cause === undefined ? undefined : { cause });
}
function isErrorCode(error, code) {
  return typeof error === "object" && error !== null && "code" in error && error.code === code;
}
function isGraphicsCredentialMutationPlatformSupported(platform) {
  return graphicsCredentialMutationPlatforms.some((supported) => supported === platform);
}
function assertGraphicsCredentialMutationPlatformSupported(purpose, platform = process.platform) {
  if (isGraphicsCredentialMutationPlatformSupported(platform))
    return;
  throw leaseFailure(purpose, "Graphics cannot safely mutate shared credentials on this platform.");
}
function duration(value, fallback) {
  if (value === undefined)
    return fallback;
  if (!Number.isSafeInteger(value) || value < 1 || value > maximumDurationMilliseconds) {
    throw new GraphicsCloudError("INVALID_ARGUMENT", "Invalid Graphics credential lease configuration.");
  }
  return value;
}
function resolveOptions(dependencies) {
  const configured = dependencies.credentialLease;
  const directory = configured?.directory ?? join3(homedir2(), ".cache", "hraness-graphics-cli", "credential-lease-v4");
  if (!isAbsolute2(directory) || directory.includes("\x00") || Buffer.byteLength(directory, "utf8") > maximumPathBytes) {
    throw new GraphicsCloudError("INVALID_ARGUMENT", "Invalid Graphics credential lease configuration.");
  }
  return {
    directory,
    waitTimeoutMilliseconds: duration(configured?.waitTimeoutMilliseconds, defaultWaitMilliseconds),
    staleAfterMilliseconds: duration(configured?.staleAfterMilliseconds, defaultStaleMilliseconds),
    pollIntervalMilliseconds: duration(configured?.pollIntervalMilliseconds, defaultPollMilliseconds),
    signal: configured?.signal,
    heartbeat: configured?.heartbeat
  };
}
function throwIfCancelled(signal, purpose) {
  if (signal?.aborted !== true)
    return;
  throw leaseFailure(purpose, purpose === "refresh" ? "Graphics login refresh was cancelled." : "Graphics credential mutation was cancelled.");
}
function throwIfGraphicsCredentialMutationCancelled(dependencies, purpose) {
  throwIfCancelled(dependencies.credentialLease?.signal, purpose);
}
async function waitForLease(milliseconds, signal, purpose) {
  throwIfCancelled(signal, purpose);
  await new Promise((resolve4, reject) => {
    let settled = false;
    let timer;
    const cleanup = () => {
      if (timer !== undefined)
        clearTimeout(timer);
      signal?.removeEventListener("abort", cancel);
    };
    const finish = () => {
      if (settled)
        return;
      settled = true;
      cleanup();
      resolve4();
    };
    const cancel = () => {
      if (settled)
        return;
      settled = true;
      cleanup();
      reject(leaseFailure(purpose, purpose === "refresh" ? "Graphics login refresh was cancelled." : "Graphics credential mutation was cancelled."));
    };
    timer = setTimeout(finish, milliseconds);
    signal?.addEventListener("abort", cancel, { once: true });
    if (signal?.aborted === true)
      cancel();
  });
}
async function prepareDirectory(directory, purpose) {
  try {
    await mkdir3(directory, { recursive: true, mode: 448 });
    const details = await lstat(directory);
    const currentUid = credentialOwnerUid();
    if (!details.isDirectory() || details.isSymbolicLink() || details.uid !== currentUid || (details.mode & 63) !== 0) {
      throw leaseFailure(purpose);
    }
  } catch (cause) {
    if (cause instanceof GraphicsCloudError)
      throw cause;
    throw leaseFailure(purpose, undefined, cause);
  }
}
function parsedPid(value) {
  const pid = Number(value);
  return Number.isSafeInteger(pid) && pid >= 1 && pid <= 2147483647 ? pid : null;
}
function parseMarkerName(name) {
  const choosing = choosingMarkerPattern.exec(name);
  if (choosing !== null) {
    const processScopeIdentity2 = choosing[1];
    const pidText2 = choosing[2];
    const processIdentity2 = choosing[3];
    const ownerId2 = choosing[4];
    if (processScopeIdentity2 === undefined || pidText2 === undefined || processIdentity2 === undefined || ownerId2 === undefined)
      return null;
    const pid2 = parsedPid(pidText2);
    return pid2 === null ? null : {
      kind: "choosing",
      name,
      processScopeIdentity: processScopeIdentity2,
      pid: pid2,
      processIdentity: processIdentity2,
      ownerId: ownerId2
    };
  }
  const lease = leaseMarkerPattern.exec(name);
  if (lease === null)
    return null;
  const ticketText = lease[1];
  const processScopeIdentity = lease[2];
  const pidText = lease[3];
  const processIdentity = lease[4];
  const ownerId = lease[5];
  if (ticketText === undefined || processScopeIdentity === undefined || pidText === undefined || processIdentity === undefined || ownerId === undefined) {
    return null;
  }
  const pid = parsedPid(pidText);
  if (pid === null)
    return null;
  return {
    kind: "lease",
    name,
    processScopeIdentity,
    pid,
    processIdentity,
    ownerId,
    ticket: BigInt(`0x${ticketText}`)
  };
}
function processIsAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (cause) {
    return !isErrorCode(cause, "ESRCH");
  }
}
var linuxBootIdPath = "/proc/sys/kernel/random/boot_id";
var linuxMachineIdPaths = ["/etc/machine-id", "/var/lib/dbus/machine-id"];
var maximumProcStatBytes = 8192;
var macProcessInfoFlavor = 3;
var macProcessInfoSize = 136;
var macProcessStartSecondsOffset = 120;
var macProcessStartMicrosecondsOffset = 128;
var macHostUuidBytes = 16;
var macHostUuidWaitSeconds = 1n;
var cachedMacProcessScopeIdentity;
var cachedLinuxHostIdentity;
function processIdentityDigest(value) {
  return createHash2("sha256").update(value).digest("hex").slice(0, 32);
}
async function linuxHostIdentity() {
  if (cachedLinuxHostIdentity !== undefined)
    return cachedLinuxHostIdentity;
  for (const path of linuxMachineIdPaths) {
    try {
      const source = (await readFile5(path, "utf8")).trim().toLowerCase();
      if (/^(?!0{32}$)[0-9a-f]{32}$/u.test(source)) {
        cachedLinuxHostIdentity = processIdentityDigest(`linux-host:${source}`);
        return cachedLinuxHostIdentity;
      }
    } catch {}
  }
  return null;
}
async function linuxProcessIdentity(pid) {
  const [bootIdSource, statSource, pidNamespaceSource, hostIdentity] = await Promise.all([
    readFile5(linuxBootIdPath, "utf8"),
    readFile5(`/proc/${pid}/stat`, "utf8"),
    readlink(`/proc/${pid}/ns/pid`),
    linuxHostIdentity()
  ]);
  if (Buffer.byteLength(bootIdSource, "utf8") > 128 || Buffer.byteLength(statSource, "utf8") > maximumProcStatBytes)
    return null;
  const bootId = bootIdSource.trim().toLowerCase();
  if (!/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/u.test(bootId)) {
    return null;
  }
  if (hostIdentity === null)
    return null;
  if (!/^pid:\[[1-9][0-9]{0,31}\]$/u.test(pidNamespaceSource))
    return null;
  const commandEnd = statSource.lastIndexOf(") ");
  if (commandEnd < 2)
    return null;
  const fields = statSource.slice(commandEnd + 2).trim().split(/\s+/u);
  const startTicks = fields[19];
  if (startTicks === undefined || !/^[1-9][0-9]{0,31}$/u.test(startTicks))
    return null;
  const processScopeIdentity = processIdentityDigest(`linux-pid-namespace:${hostIdentity}:${pidNamespaceSource}`);
  return {
    processScopeIdentity,
    value: processIdentityDigest(`linux-process:${processScopeIdentity}:${startTicks}`)
  };
}
async function macProcessIdentity(pid) {
  const { dlopen, ptr } = await import("bun:ffi");
  const library = dlopen("/usr/lib/libproc.dylib", {
    proc_pidinfo: {
      args: ["i32", "i32", "u64", "ptr", "i32"],
      returns: "i32"
    }
  });
  try {
    const bytes = new Uint8Array(macProcessInfoSize);
    const returned = library.symbols.proc_pidinfo(pid, macProcessInfoFlavor, 0, ptr(bytes), bytes.byteLength);
    if (returned !== macProcessInfoSize)
      return null;
    const view = new DataView(bytes.buffer);
    const seconds = view.getBigUint64(macProcessStartSecondsOffset, true);
    const microseconds = view.getBigUint64(macProcessStartMicrosecondsOffset, true);
    if (seconds < 1n || microseconds >= 1000000n)
      return null;
    return processIdentityDigest(`darwin:${seconds}:${microseconds}`);
  } finally {
    library.close();
  }
}
async function macProcessScopeIdentity() {
  if (cachedMacProcessScopeIdentity !== undefined) {
    return cachedMacProcessScopeIdentity;
  }
  const { dlopen } = await import("bun:ffi");
  const library = dlopen("/usr/lib/libSystem.B.dylib", {
    gethostuuid: {
      args: ["ptr", "ptr"],
      returns: "i32"
    }
  });
  try {
    const uuid = new Uint8Array(macHostUuidBytes);
    const wait = new BigInt64Array([macHostUuidWaitSeconds, 0n]);
    if (library.symbols.gethostuuid(uuid, wait) !== 0)
      return null;
    const source = Buffer.from(uuid).toString("hex");
    if (!/^(?!0{32}$)[0-9a-f]{32}$/u.test(source))
      return null;
    cachedMacProcessScopeIdentity = processIdentityDigest(`darwin-host:${source}`);
    return cachedMacProcessScopeIdentity;
  } finally {
    library.close();
  }
}
async function darwinProcessIdentity(pid) {
  const [value, processScopeIdentity] = await Promise.all([
    macProcessIdentity(pid),
    macProcessScopeIdentity()
  ]);
  return value === null || processScopeIdentity === null ? null : { processScopeIdentity, value };
}
async function queryProcessIdentity(pid) {
  if (!processIsAlive(pid))
    return { kind: "missing" };
  try {
    const identity = process.platform === "linux" ? await linuxProcessIdentity(pid) : process.platform === "darwin" ? await darwinProcessIdentity(pid) : null;
    if (identity !== null)
      return { kind: "identified", ...identity };
  } catch {}
  return processIsAlive(pid) ? { kind: "unavailable" } : { kind: "missing" };
}
async function markerProcessIsOwner(marker, inspectingProcessScopeIdentity) {
  if (marker.processScopeIdentity !== inspectingProcessScopeIdentity)
    return true;
  const processIdentity = await queryProcessIdentity(marker.pid);
  return processIdentity.kind === "unavailable" || processIdentity.kind === "identified" && processIdentity.processScopeIdentity === marker.processScopeIdentity && processIdentity.value === marker.processIdentity;
}
function identity(value) {
  return { device: value.dev, inode: value.ino };
}
function credentialOwnerUid() {
  if (typeof process.getuid !== "function") {
    throw new Error("credential owner uid unavailable");
  }
  return process.getuid();
}
function sameIdentity(left, right) {
  const device = "device" in right ? right.device : right.dev;
  const inode = "inode" in right ? right.inode : right.ino;
  return left.device === device && left.inode === inode;
}
function markerIsPrivateRegularFile(details) {
  return details.isFile() && !details.isSymbolicLink() && details.uid === credentialOwnerUid() && (details.mode & 63) === 0 && details.size === 0;
}
async function removeStaleUniqueMarker(marker, options, processScopeIdentity) {
  try {
    const confirmed = await lstat(marker.path);
    if (!sameIdentity(marker.identity, confirmed) || !markerIsPrivateRegularFile(confirmed) || await markerProcessIsOwner(marker, processScopeIdentity) || Date.now() - confirmed.mtimeMs < options.staleAfterMilliseconds) {
      return;
    }
    await unlink(marker.path);
  } catch {}
}
async function scanActiveMarkers(options, purpose, processScopeIdentity) {
  let entries;
  try {
    entries = await readdir(options.directory, { withFileTypes: true });
  } catch (cause) {
    throw leaseFailure(purpose, undefined, cause);
  }
  if (entries.length > maximumDirectoryEntries) {
    throw leaseFailure(purpose);
  }
  const active = [];
  for (const entry of entries) {
    const parsed = parseMarkerName(entry.name);
    if (parsed === null)
      continue;
    if (parsed.processScopeIdentity !== processScopeIdentity) {
      throw leaseFailure(purpose, "Graphics cannot safely coordinate credentials across process scopes.");
    }
    const path = join3(options.directory, entry.name);
    let details;
    try {
      details = await lstat(path);
    } catch (cause) {
      if (isErrorCode(cause, "ENOENT"))
        continue;
      throw leaseFailure(purpose, undefined, cause);
    }
    if (!markerIsPrivateRegularFile(details)) {
      throw leaseFailure(purpose);
    }
    const marker = {
      ...parsed,
      path,
      identity: identity(details),
      modifiedAtMilliseconds: details.mtimeMs
    };
    if (Date.now() - marker.modifiedAtMilliseconds < options.staleAfterMilliseconds || await markerProcessIsOwner(marker, processScopeIdentity)) {
      active.push(marker);
      continue;
    }
    await removeStaleUniqueMarker(marker, options, processScopeIdentity);
  }
  return active;
}
async function publishMarker(directory, name, processScopeIdentity, pid, processIdentity, ownerId, purpose, ticket) {
  const path = join3(directory, name);
  let handle;
  try {
    handle = await open(path, "wx+", 384);
    const details = await handle.stat();
    if (!markerIsPrivateRegularFile(details))
      throw leaseFailure(purpose);
    return {
      name,
      path,
      processScopeIdentity,
      pid,
      processIdentity,
      ownerId,
      ...ticket === undefined ? {} : { ticket },
      handle,
      identity: identity(details)
    };
  } catch (cause) {
    await handle?.close().catch(() => {
      return;
    });
    if (cause instanceof GraphicsCloudError)
      throw cause;
    throw leaseFailure(purpose, undefined, cause);
  }
}
async function markerStillOwned(marker) {
  try {
    const [held, named] = await Promise.all([
      marker.handle.stat(),
      lstat(marker.path)
    ]);
    return sameIdentity(marker.identity, held) && sameIdentity(marker.identity, named) && markerIsPrivateRegularFile(held) && markerIsPrivateRegularFile(named);
  } catch {
    return false;
  }
}
async function removePublishedMarkerOnce(marker) {
  let held;
  let named;
  try {
    held = await marker.handle.stat();
  } catch {
    return "lost";
  }
  try {
    named = await lstat(marker.path);
  } catch (cause) {
    return isErrorCode(cause, "ENOENT") ? "removed" : "retry";
  }
  if (!sameIdentity(marker.identity, held) || !sameIdentity(marker.identity, named) || !markerIsPrivateRegularFile(held) || !markerIsPrivateRegularFile(named)) {
    return "lost";
  }
  try {
    await unlink(marker.path);
    return "removed";
  } catch (cause) {
    return isErrorCode(cause, "ENOENT") ? "removed" : "retry";
  }
}
async function removePublishedMarker(marker, pollMilliseconds) {
  for (let attempt = 0;attempt < 3; attempt += 1) {
    const result = await removePublishedMarkerOnce(marker);
    if (result !== "retry")
      return result;
    if (attempt < 2)
      await waitForLease(pollMilliseconds, undefined, "logout");
  }
  return "retry";
}
function closeAfterBackgroundCleanup(marker, pollMilliseconds) {
  let cleanup = Promise.resolve();
  const timer = setInterval(() => {
    cleanup = cleanup.then(async () => {
      const result = await removePublishedMarkerOnce(marker);
      if (result === "retry")
        return;
      clearInterval(timer);
      await marker.handle.close().catch(() => {
        return;
      });
    }).catch(() => {
      return;
    });
  }, pollMilliseconds);
  timer.unref();
}
function compareLeases(left, right) {
  const leftTicket = left.ticket;
  const rightTicket = right.ticket;
  if (leftTicket === undefined || rightTicket === undefined)
    return 0;
  if (leftTicket < rightTicket)
    return -1;
  if (leftTicket > rightTicket)
    return 1;
  if (left.ownerId < right.ownerId)
    return -1;
  if (left.ownerId > right.ownerId)
    return 1;
  return 0;
}
function managedLease(marker, options, purpose) {
  let releaseRequested = false;
  let released = false;
  let heartbeat = Promise.resolve();
  const heartbeatMilliseconds = Math.max(10, Math.min(5000, Math.floor(options.staleAfterMilliseconds / 3)));
  const touch = async () => {
    if (!await markerStillOwned(marker))
      throw leaseFailure(purpose);
    const timestamp = new Date;
    await marker.handle.utimes(timestamp, timestamp);
  };
  const timer = setInterval(() => {
    if (releaseRequested || released)
      return;
    heartbeat = heartbeat.then(async () => {
      try {
        await (options.heartbeat ?? ((operation) => operation()))(touch);
      } catch {}
    }).catch(() => {
      return;
    });
  }, heartbeatMilliseconds);
  timer.unref();
  const assertOwnedOnce = async () => {
    if (released || !await markerStillOwned(marker)) {
      throw leaseFailure(purpose);
    }
    const markers = await scanActiveMarkers(options, purpose, marker.processScopeIdentity);
    const leases = markers.filter((candidate) => candidate.kind === "lease").sort(compareLeases);
    const owner = leases[0];
    if (owner === undefined || owner.ownerId !== marker.ownerId || owner.ticket !== marker.ticket || !sameIdentity(marker.identity, owner.identity)) {
      throw leaseFailure(purpose);
    }
  };
  return {
    assertOwned: async () => {
      let lastFailure;
      for (let attempt = 0;attempt < 3; attempt += 1) {
        try {
          await assertOwnedOnce();
          return;
        } catch (cause) {
          lastFailure = cause;
          if (attempt < 2) {
            await waitForLease(options.pollIntervalMilliseconds, undefined, purpose);
          }
        }
      }
      if (lastFailure instanceof GraphicsCloudError)
        throw lastFailure;
      throw leaseFailure(purpose, undefined, lastFailure);
    },
    release: async () => {
      if (releaseRequested)
        return;
      releaseRequested = true;
      clearInterval(timer);
      heartbeat.catch(() => {
        return;
      });
      const removal = await removePublishedMarker(marker, options.pollIntervalMilliseconds);
      if (removal !== "retry") {
        released = true;
        await marker.handle.close().catch(() => {
          return;
        });
        return;
      }
      closeAfterBackgroundCleanup(marker, options.pollIntervalMilliseconds);
    }
  };
}
async function cleanupUnacquiredMarker(marker, pollMilliseconds) {
  if (marker === undefined)
    return;
  if (await removePublishedMarker(marker, pollMilliseconds) !== "retry") {
    await marker.handle.close().catch(() => {
      return;
    });
    return;
  }
  closeAfterBackgroundCleanup(marker, pollMilliseconds);
}
async function acquireGraphicsCredentialMutationLease(dependencies, purpose) {
  assertGraphicsCredentialMutationPlatformSupported(purpose);
  const options = resolveOptions(dependencies);
  await prepareDirectory(options.directory, purpose);
  const deadline = performance2.now() + options.waitTimeoutMilliseconds;
  const ownerId = randomBytes(16).toString("hex");
  const processIdentity = await queryProcessIdentity(process.pid);
  if (processIdentity.kind !== "identified")
    throw leaseFailure(purpose);
  const choosingName = `choosing-v4-${processIdentity.processScopeIdentity}-${process.pid}-${processIdentity.value}-${ownerId}`;
  let choosing;
  let owner;
  let lease;
  try {
    throwIfCancelled(options.signal, purpose);
    choosing = await publishMarker(options.directory, choosingName, processIdentity.processScopeIdentity, process.pid, processIdentity.value, ownerId, purpose);
    const initialMarkers = await scanActiveMarkers(options, purpose, processIdentity.processScopeIdentity);
    let highestTicket = 0n;
    for (const marker of initialMarkers) {
      if (marker.kind === "lease" && marker.ticket !== undefined && marker.ticket > highestTicket) {
        highestTicket = marker.ticket;
      }
    }
    if (highestTicket >= maximumTicket)
      throw leaseFailure(purpose);
    const ticket = highestTicket + 1n;
    const ticketText = ticket.toString(16).padStart(16, "0");
    const ownerName = `lease-v4-${ticketText}-${processIdentity.processScopeIdentity}-${process.pid}-${processIdentity.value}-${ownerId}`;
    owner = await publishMarker(options.directory, ownerName, processIdentity.processScopeIdentity, process.pid, processIdentity.value, ownerId, purpose, ticket);
    if (await removePublishedMarker(choosing, options.pollIntervalMilliseconds) !== "removed") {
      throw leaseFailure(purpose);
    }
    await choosing.handle.close().catch(() => {
      return;
    });
    choosing = undefined;
    lease = managedLease(owner, options, purpose);
    for (;; ) {
      throwIfCancelled(options.signal, purpose);
      if (!await markerStillOwned(owner))
        throw leaseFailure(purpose);
      const markers = await scanActiveMarkers(options, purpose, processIdentity.processScopeIdentity);
      const anotherChooser = markers.some((marker) => marker.kind === "choosing" && marker.ownerId !== ownerId);
      const leases = markers.filter((marker) => marker.kind === "lease").sort(compareLeases);
      const first = leases[0];
      if (!anotherChooser && first !== undefined && first.ownerId === ownerId && first.ticket === ticket && sameIdentity(owner.identity, first.identity)) {
        return lease;
      }
      const remaining = deadline - performance2.now();
      if (remaining <= 0) {
        throw leaseFailure(purpose, purpose === "refresh" ? "Graphics timed out waiting for another login refresh." : "Graphics timed out waiting for another credential mutation.");
      }
      await waitForLease(Math.min(options.pollIntervalMilliseconds, remaining), options.signal, purpose);
    }
  } catch (cause) {
    await lease?.release();
    if (lease === undefined) {
      await cleanupUnacquiredMarker(owner, options.pollIntervalMilliseconds);
    }
    await cleanupUnacquiredMarker(choosing, options.pollIntervalMilliseconds);
    throw cause;
  }
}

// src/auth.ts
var graphicsSecretsService = "com.hraness.graphics.cli";
var graphicsSecretsName = "oauth2-tokens";
var tokenResponseMaximumBytes = 64 * 1024;
var storedCredentialMaximumBytes = 64 * 1024;
var maximumTokenLength = 16 * 1024;
var callbackPort = 49671;
var callbackPath = "/oauth/callback";
var callbackMaximumRequests = 32;
var expirySkewMilliseconds = 60000;
var maximumExpiresInSeconds = 365 * 24 * 60 * 60;
function secretStore(dependencies) {
  return dependencies.secrets ?? Bun.secrets;
}
function boundedToken(value) {
  if (typeof value !== "string" || value.length < 1 || value.length > maximumTokenLength || /[\u0000-\u0020\u007f]/u.test(value)) {
    throw new GraphicsCloudError("TOKEN_EXCHANGE_FAILED", "Graphics rejected the authorization token response.");
  }
  return value;
}
function isRecord5(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function parseStoredCredentials(value) {
  if (Buffer.byteLength(value, "utf8") > storedCredentialMaximumBytes) {
    throw new GraphicsCloudError("TOKEN_STORAGE_FAILED", "Stored Graphics credentials are invalid.");
  }
  let parsed;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new GraphicsCloudError("TOKEN_STORAGE_FAILED", "Stored Graphics credentials are invalid.");
  }
  if (!isRecord5(parsed) || parsed.schemaVersion !== 1 || typeof parsed.issuer !== "string" || parsed.issuer.length > 2048 || typeof parsed.clientId !== "string" || parsed.clientId.length > 256 || typeof parsed.resource !== "string" || parsed.resource.length > 2048 || !Number.isSafeInteger(parsed.expiresAt) || parsed.expiresAt < 0 || parsed.expiresAt > 8640000000000000) {
    throw new GraphicsCloudError("TOKEN_STORAGE_FAILED", "Stored Graphics credentials are invalid.");
  }
  let accessToken;
  let refreshToken;
  try {
    accessToken = boundedToken(parsed.accessToken);
    refreshToken = parsed.refreshToken === undefined ? undefined : boundedToken(parsed.refreshToken);
  } catch (cause) {
    throw new GraphicsCloudError("TOKEN_STORAGE_FAILED", "Stored Graphics credentials are invalid.", { cause });
  }
  const keys = Object.keys(parsed);
  if (keys.some((key) => ![
    "schemaVersion",
    "issuer",
    "clientId",
    "resource",
    "accessToken",
    "refreshToken",
    "expiresAt"
  ].includes(key))) {
    throw new GraphicsCloudError("TOKEN_STORAGE_FAILED", "Stored Graphics credentials are invalid.");
  }
  return {
    schemaVersion: 1,
    issuer: parsed.issuer,
    clientId: parsed.clientId,
    resource: parsed.resource,
    accessToken,
    ...refreshToken === undefined ? {} : { refreshToken },
    expiresAt: parsed.expiresAt
  };
}
async function loadCredentials(dependencies) {
  let stored;
  try {
    stored = await secretStore(dependencies).get({
      service: graphicsSecretsService,
      name: graphicsSecretsName
    });
  } catch (cause) {
    throw new GraphicsCloudError("TOKEN_STORAGE_FAILED", "Graphics could not read credentials from the operating-system credential store.", { cause });
  }
  return stored === null ? null : parseStoredCredentials(stored);
}
async function storeCredentials(credentials, dependencies) {
  const value = JSON.stringify(credentials);
  if (Buffer.byteLength(value, "utf8") > storedCredentialMaximumBytes) {
    throw new GraphicsCloudError("TOKEN_STORAGE_FAILED", "Graphics credentials exceed the credential-store limit.");
  }
  try {
    await secretStore(dependencies).set({
      service: graphicsSecretsService,
      name: graphicsSecretsName,
      value
    });
  } catch (cause) {
    throw new GraphicsCloudError("TOKEN_STORAGE_FAILED", "Graphics could not write credentials to the operating-system credential store.", { cause });
  }
}
async function deleteCredentials(dependencies) {
  try {
    return await secretStore(dependencies).delete({
      service: graphicsSecretsService,
      name: graphicsSecretsName
    });
  } catch (cause) {
    throw new GraphicsCloudError("TOKEN_STORAGE_FAILED", "Graphics could not remove credentials from the operating-system credential store.", { cause });
  }
}
function base64Url(bytes) {
  return Buffer.from(bytes).toString("base64url");
}
function createPkcePair() {
  const verifier = base64Url(randomBytes2(32));
  const challenge = createHash3("sha256").update(verifier, "ascii").digest("base64url");
  return { verifier, challenge };
}
function buildGraphicsAuthorizationUrl(discovery, state, challenge) {
  const trustedDiscovery = parseGraphicsDiscovery(discovery);
  if (state.length < 32 || state.length > 256 || challenge.length !== 43 || !/^[A-Za-z0-9_-]+$/u.test(state) || !/^[A-Za-z0-9_-]+$/u.test(challenge)) {
    throw new GraphicsCloudError("INVALID_ARGUMENT", "Invalid OAuth state or PKCE challenge.");
  }
  const url = new URL(trustedDiscovery.authorization.authorizationEndpoint);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", trustedDiscovery.authorization.clientId);
  url.searchParams.set("redirect_uri", graphicsRedirectUri);
  url.searchParams.set("scope", trustedDiscovery.authorization.scopes.join(" "));
  url.searchParams.set("resource", trustedDiscovery.authorization.resource);
  url.searchParams.set("state", state);
  url.searchParams.set("code_challenge", challenge);
  url.searchParams.set("code_challenge_method", "S256");
  return url.href;
}
function safeEqual(left, right) {
  const leftBytes = Buffer.from(left, "utf8");
  const rightBytes = Buffer.from(right, "utf8");
  return leftBytes.byteLength === rightBytes.byteLength && timingSafeEqual(leftBytes, rightBytes);
}
function callbackPage(success) {
  return [
    "<!doctype html>",
    '<meta charset="utf-8">',
    `<title>Graphics ${success ? "login complete" : "login failed"}</title>`,
    `<p>Graphics login ${success ? "is complete. You can close this window." : "could not be completed. Return to the terminal."}</p>`
  ].join("");
}
async function closeServer(server) {
  if (!server.listening)
    return;
  await new Promise((resolve4) => {
    server.close(() => resolve4());
  });
}
async function startAuthorizationCallback(expectedState, timeoutMilliseconds) {
  let resolveCode;
  let rejectCode;
  let settled = false;
  let requestCount = 0;
  const codePromise = new Promise((resolve4, reject) => {
    resolveCode = resolve4;
    rejectCode = reject;
  });
  const server = createServer((request, response) => {
    requestCount += 1;
    response.setHeader("connection", "close");
    response.setHeader("cache-control", "no-store");
    response.setHeader("content-security-policy", "default-src 'none'; style-src 'unsafe-inline'");
    response.setHeader("content-type", "text/html; charset=utf-8");
    if (requestCount > callbackMaximumRequests) {
      response.statusCode = 429;
      response.end(callbackPage(false));
      if (!settled) {
        settled = true;
        rejectCode(new GraphicsCloudError("AUTHORIZATION_FAILED", "Graphics login received too many invalid callback requests."));
      }
      return;
    }
    if (request.method !== "GET" || request.headers.host !== `127.0.0.1:${callbackPort}`) {
      response.statusCode = 404;
      response.end(callbackPage(false));
      return;
    }
    let url;
    try {
      if ((request.url?.length ?? 0) > 8192)
        throw new Error("oversized callback");
      url = new URL(request.url ?? "", graphicsRedirectUri);
    } catch {
      response.statusCode = 400;
      response.end(callbackPage(false));
      return;
    }
    if (url.pathname !== callbackPath) {
      response.statusCode = 404;
      response.end(callbackPage(false));
      return;
    }
    const states = url.searchParams.getAll("state");
    if (states.length !== 1 || states[0] === undefined || states[0].length > 256 || !safeEqual(states[0], expectedState)) {
      response.statusCode = 400;
      response.end(callbackPage(false));
      return;
    }
    const oauthErrors = url.searchParams.getAll("error");
    if (oauthErrors.length > 0) {
      response.statusCode = 400;
      response.end(callbackPage(false));
      if (!settled) {
        settled = true;
        rejectCode(new GraphicsCloudError("AUTHORIZATION_FAILED", "Graphics authorization was denied or failed."));
      }
      return;
    }
    const codes = url.searchParams.getAll("code");
    const code = codes[0];
    if (codes.length !== 1 || code === undefined || code.length < 1 || code.length > 4096 || /[\u0000-\u0020\u007f]/u.test(code)) {
      response.statusCode = 400;
      response.end(callbackPage(false));
      return;
    }
    response.statusCode = 200;
    response.end(callbackPage(true));
    if (!settled) {
      settled = true;
      resolveCode(code);
    }
  });
  await new Promise((resolve4, reject) => {
    server.once("error", reject);
    server.listen(callbackPort, "127.0.0.1", () => resolve4());
  }).catch((cause) => {
    throw new GraphicsCloudError("AUTH_CALLBACK_UNAVAILABLE", `Graphics login requires ${graphicsRedirectUri}, but the loopback callback could not start.`, { cause });
  });
  const timeout = setTimeout(() => {
    if (settled)
      return;
    settled = true;
    rejectCode(new GraphicsCloudError("AUTH_TIMEOUT", "Graphics login timed out before authorization completed."));
  }, timeoutMilliseconds);
  let closed = false;
  const close = async () => {
    if (closed)
      return;
    closed = true;
    clearTimeout(timeout);
    if (!settled) {
      settled = true;
      rejectCode(new GraphicsCloudError("AUTHORIZATION_FAILED", "Graphics login was cancelled before authorization completed."));
    }
    server.closeIdleConnections();
    server.closeAllConnections();
    await closeServer(server);
  };
  return { code: codePromise, close };
}
async function defaultOpenUrl(url) {
  const command = process.platform === "darwin" ? ["open", url] : process.platform === "win32" ? ["rundll32", "url.dll,FileProtocolHandler", url] : ["xdg-open", url];
  let subprocess;
  try {
    subprocess = Bun.spawn(command, {
      stdin: "ignore",
      stdout: "ignore",
      stderr: "ignore"
    });
  } catch (cause) {
    throw new GraphicsCloudError("AUTHORIZATION_FAILED", "Graphics could not open the authorization page.", { cause });
  }
  const exitCode = await Promise.race([
    subprocess.exited,
    Bun.sleep(1e4).then(() => null)
  ]);
  if (exitCode === null) {
    subprocess.kill();
    await subprocess.exited.catch(() => {
      return;
    });
  }
  if (exitCode !== 0) {
    throw new GraphicsCloudError("AUTHORIZATION_FAILED", "Graphics could not open the authorization page.");
  }
}
async function tokenRequest(discovery, body, failureCode, dependencies) {
  const failure = new GraphicsCloudError(failureCode, failureCode === "TOKEN_EXCHANGE_FAILED" ? "Graphics could not exchange the authorization code." : "Graphics could not refresh the login.");
  let response;
  try {
    response = await (dependencies.fetch ?? fetch)(discovery.authorization.tokenEndpoint, {
      method: "POST",
      headers: {
        accept: "application/json",
        "content-type": "application/x-www-form-urlencoded",
        "user-agent": "hraness-graphics-cli/0.4.0"
      },
      body,
      redirect: "error",
      signal: AbortSignal.timeout(15000)
    });
  } catch (cause) {
    throw new GraphicsCloudError(failureCode, failure.message.slice(failure.message.indexOf("]") + 2), {
      cause
    });
  }
  const contentType = response.headers.get("content-type");
  if (contentType === null || !/^application\/json(?:\s*;\s*charset=(?:utf-8|"utf-8"))?$/iu.test(contentType)) {
    await response.body?.cancel().catch(() => {
      return;
    });
    throw failure;
  }
  const bytes = await readBoundedResponseBytes(response, tokenResponseMaximumBytes, failure);
  if (!response.ok)
    throw failure;
  let value;
  try {
    value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    throw failure;
  }
  if (!isRecord5(value) || typeof value.token_type !== "string" || value.token_type.toLowerCase() !== "bearer" || !Number.isSafeInteger(value.expires_in) || value.expires_in < 1 || value.expires_in > maximumExpiresInSeconds) {
    throw failure;
  }
  let accessToken;
  let refreshToken;
  try {
    accessToken = boundedToken(value.access_token);
    refreshToken = value.refresh_token === undefined ? undefined : boundedToken(value.refresh_token);
  } catch {
    throw failure;
  }
  return {
    accessToken,
    ...refreshToken === undefined ? {} : { refreshToken },
    expiresIn: value.expires_in
  };
}
function credentialsFromToken(discovery, token, now, retainedRefreshToken) {
  const refreshToken = token.refreshToken ?? retainedRefreshToken;
  return {
    schemaVersion: 1,
    issuer: discovery.authorization.issuer,
    clientId: discovery.authorization.clientId,
    resource: discovery.authorization.resource,
    accessToken: token.accessToken,
    ...refreshToken === undefined ? {} : { refreshToken },
    expiresAt: now + token.expiresIn * 1000
  };
}
async function loginGraphics(dependencies = {}) {
  assertGraphicsCredentialMutationPlatformSupported("login");
  const discovery = await fetchGraphicsDiscovery(dependencies.fetch);
  const { verifier, challenge } = createPkcePair();
  const state = base64Url(randomBytes2(32));
  const callback = await startAuthorizationCallback(state, 5 * 60000);
  callback.code.catch(() => {
    return;
  });
  const authorizationUrl = buildGraphicsAuthorizationUrl(discovery, state, challenge);
  try {
    const launch = (async () => {
      try {
        await (dependencies.openUrl ?? defaultOpenUrl)(authorizationUrl);
      } catch (cause) {
        if (cause instanceof GraphicsCloudError)
          throw cause;
        throw new GraphicsCloudError("AUTHORIZATION_FAILED", "Graphics could not open the authorization page.", { cause });
      }
    })();
    launch.catch(() => {
      return;
    });
    const code = await Promise.race([
      callback.code,
      launch.then(() => callback.code)
    ]);
    await callback.close();
    const form = new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: graphicsRedirectUri,
      client_id: discovery.authorization.clientId,
      resource: discovery.authorization.resource,
      code_verifier: verifier
    });
    const token = await tokenRequest(discovery, form, "TOKEN_EXCHANGE_FAILED", dependencies);
    const now = (dependencies.now ?? Date.now)();
    const credentials = credentialsFromToken(discovery, token, now);
    const lease = await acquireGraphicsCredentialMutationLease(dependencies, "login");
    try {
      throwIfGraphicsCredentialMutationCancelled(dependencies, "login");
      await loadCredentials(dependencies);
      await lease.assertOwned();
      throwIfGraphicsCredentialMutationCancelled(dependencies, "login");
      await storeCredentials(credentials, dependencies);
    } finally {
      await lease.release();
    }
    return {
      authenticated: true,
      expiresAt: new Date(credentials.expiresAt).toISOString(),
      refreshable: credentials.refreshToken !== undefined
    };
  } finally {
    await callback.close();
  }
}
function credentialsMatchDiscovery(credentials, discovery) {
  return credentials.issuer === discovery.authorization.issuer && credentials.clientId === discovery.authorization.clientId && credentials.resource === discovery.authorization.resource;
}
async function refreshAccessToken(discovery, dependencies) {
  const lease = await acquireGraphicsCredentialMutationLease(dependencies, "refresh");
  try {
    const credentials = await loadCredentials(dependencies);
    if (credentials === null || !credentialsMatchDiscovery(credentials, discovery)) {
      throw new GraphicsCloudError("AUTH_REQUIRED", "Graphics login is missing or expired. Run `graphics login`.");
    }
    const now = (dependencies.now ?? Date.now)();
    if (credentials.expiresAt > now + expirySkewMilliseconds) {
      return credentials.accessToken;
    }
    const refreshToken = credentials.refreshToken;
    if (refreshToken === undefined) {
      throw new GraphicsCloudError("AUTH_REQUIRED", "Graphics login is missing or expired. Run `graphics login`.");
    }
    const form = new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      client_id: discovery.authorization.clientId,
      resource: discovery.authorization.resource
    });
    await lease.assertOwned();
    throwIfGraphicsCredentialMutationCancelled(dependencies, "refresh");
    const token = await tokenRequest(discovery, form, "TOKEN_REFRESH_FAILED", dependencies);
    const next = credentialsFromToken(discovery, token, (dependencies.now ?? Date.now)(), refreshToken);
    await lease.assertOwned();
    await storeCredentials(next, dependencies);
    return next.accessToken;
  } finally {
    await lease.release();
  }
}
async function getGraphicsAccessToken(discovery, dependencies = {}) {
  const trustedDiscovery = parseGraphicsDiscovery(discovery);
  const credentials = await loadCredentials(dependencies);
  if (credentials === null || credentials.issuer !== trustedDiscovery.authorization.issuer || credentials.clientId !== trustedDiscovery.authorization.clientId || credentials.resource !== trustedDiscovery.authorization.resource) {
    throw new GraphicsCloudError("AUTH_REQUIRED", "Graphics login is missing or expired. Run `graphics login`.");
  }
  const now = (dependencies.now ?? Date.now)();
  if (credentials.expiresAt > now + expirySkewMilliseconds) {
    return credentials.accessToken;
  }
  return refreshAccessToken(trustedDiscovery, dependencies);
}
async function requireGraphicsAuthentication(dependencies = {}) {
  const discovery = await fetchGraphicsDiscovery(dependencies.fetch);
  await getGraphicsAccessToken(discovery, dependencies);
  return discovery;
}
async function graphicsAuthStatus(dependencies = {}) {
  const credentials = await loadCredentials(dependencies);
  if (credentials === null) {
    return { authenticated: false, expiresAt: null, refreshable: false };
  }
  if (credentials.issuer !== graphicsProductionContract.issuer || credentials.clientId !== graphicsProductionContract.clientId || credentials.resource !== graphicsProductionContract.resource) {
    return { authenticated: false, expiresAt: null, refreshable: false };
  }
  return {
    authenticated: credentials.expiresAt > (dependencies.now ?? Date.now)() || credentials.refreshToken !== undefined,
    expiresAt: new Date(credentials.expiresAt).toISOString(),
    refreshable: credentials.refreshToken !== undefined
  };
}
async function logoutGraphics(dependencies = {}) {
  assertGraphicsCredentialMutationPlatformSupported("logout");
  const lease = await acquireGraphicsCredentialMutationLease(dependencies, "logout");
  try {
    const credentials = await loadCredentials(dependencies);
    if (credentials === null)
      return { removed: false, revoked: false };
    let revocationError;
    let revoked = false;
    try {
      const discovery = await fetchGraphicsDiscovery(dependencies.fetch);
      if (!credentialsMatchDiscovery(credentials, discovery)) {
        throw new GraphicsCloudError("REVOCATION_FAILED", "Graphics could not verify the stored login before revocation.");
      }
      const token = credentials.refreshToken ?? credentials.accessToken;
      const tokenTypeHint = credentials.refreshToken === undefined ? "access_token" : "refresh_token";
      let response;
      try {
        await lease.assertOwned();
        response = await (dependencies.fetch ?? fetch)(discovery.authorization.revocationEndpoint, {
          method: "POST",
          headers: {
            accept: "application/json",
            "content-type": "application/x-www-form-urlencoded",
            "user-agent": "hraness-graphics-cli/0.4.0"
          },
          body: new URLSearchParams({
            token,
            token_type_hint: tokenTypeHint,
            client_id: discovery.authorization.clientId
          }),
          redirect: "error",
          signal: AbortSignal.timeout(15000)
        });
      } catch (cause) {
        throw new GraphicsCloudError("REVOCATION_FAILED", "Graphics could not revoke the remote login.", { cause });
      }
      await readBoundedResponseBytes(response, 16 * 1024, new GraphicsCloudError("REVOCATION_FAILED", "Graphics received an invalid revocation response."));
      if (!response.ok) {
        throw new GraphicsCloudError("REVOCATION_FAILED", "Graphics could not revoke the remote login.");
      }
      revoked = true;
    } catch (error) {
      revocationError = error instanceof GraphicsCloudError ? error : new GraphicsCloudError("REVOCATION_FAILED", "Graphics could not revoke the remote login.", { cause: error });
    }
    await lease.assertOwned();
    const removed = await deleteCredentials(dependencies);
    if (revocationError !== undefined)
      throw revocationError;
    return { removed, revoked };
  } finally {
    await lease.release();
  }
}

// src/generate.ts
import { randomUUID } from "crypto";
import { rename as rename3, rm as rm3, writeFile as writeFile2 } from "fs/promises";
import { dirname as dirname4, resolve as resolve4 } from "path";
var maximumIdempotencyKeyLength = 128;
var minimumIdempotencyKeyLength = 16;
var responseEnvelopeAllowanceBytes = 8 * 1024;
function invalidArgument(message) {
  throw new GraphicsCloudError("INVALID_ARGUMENT", message);
}
function validateGraphicsIdempotencyKey(value) {
  if (value.length < minimumIdempotencyKeyLength || value.length > maximumIdempotencyKeyLength || !/^[A-Za-z0-9][A-Za-z0-9._:-]*$/u.test(value)) {
    invalidArgument("Idempotency key must be 16\u2013128 characters using letters, digits, `.`, `_`, `:`, or `-`.");
  }
  return value;
}
function validateInput(input, discovery) {
  if (!graphicsImageModels.includes(input.model)) {
    invalidArgument(`Model must be ${graphicsImageModels[0]} or ${graphicsImageModels[1]}.`);
  }
  if (typeof input.prompt !== "string" || input.prompt.trim().length === 0 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(input.prompt) || Buffer.byteLength(input.prompt, "utf8") > discovery.imageGeneration.maximumPromptBytes) {
    invalidArgument(`Prompt must be non-empty and no more than ${discovery.imageGeneration.maximumPromptBytes} UTF-8 bytes.`);
  }
  const idempotencyKey = validateGraphicsIdempotencyKey(input.idempotencyKey ?? randomUUID());
  return {
    idempotencyKey,
    requestBody: JSON.stringify({
      model: input.model,
      prompt: input.prompt
    })
  };
}
function isRecord6(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function exactKeys2(value, expected) {
  const actual = Object.keys(value).sort();
  const canonical = [...expected].sort();
  return actual.length === canonical.length && actual.every((entry, index) => entry === canonical[index]);
}
function isCanonicalBase64(value) {
  return value.length > 0 && value.length % 4 === 0 && /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(value);
}
function hasExpectedMagic(bytes, _mediaType) {
  return bytes.byteLength >= 16 && Buffer.from(bytes.subarray(0, 4)).toString("ascii") === "RIFF" && Buffer.from(bytes).readUInt32LE(4) === bytes.byteLength - 8 && Buffer.from(bytes.subarray(8, 12)).toString("ascii") === "WEBP" && ["VP8 ", "VP8L", "VP8X"].includes(Buffer.from(bytes.subarray(12, 16)).toString("ascii"));
}
function parseGeneratedGraphicsImage(value, discovery, requestedModel) {
  const trustedDiscovery = parseGraphicsDiscovery(discovery);
  const invalid = new GraphicsCloudError("GENERATION_INVALID_RESPONSE", "Graphics image generation returned an invalid bounded image.");
  if (!isRecord6(value) || !exactKeys2(value, ["apiVersion", "image", "model", "requestId"]) || value.apiVersion !== "v1" || value.model !== requestedModel || typeof value.requestId !== "string" || value.requestId.length < 1 || value.requestId.length > 256 || /[\u0000-\u001f\u007f]/u.test(value.requestId) || !isRecord6(value.image) || !exactKeys2(value.image, ["base64", "mediaType"]) || typeof value.image.base64 !== "string" || !isCanonicalBase64(value.image.base64) || typeof value.image.mediaType !== "string" || !graphicsResponseMediaTypes.includes(value.image.mediaType) || value.image.mediaType !== trustedDiscovery.imageGeneration.responseMediaTypes[0]) {
    throw invalid;
  }
  const bytes = Buffer.from(value.image.base64, "base64");
  if (bytes.byteLength < 1 || bytes.byteLength > trustedDiscovery.imageGeneration.maximumRawImageBytes || bytes.toString("base64") !== value.image.base64 || !hasExpectedMagic(bytes, value.image.mediaType)) {
    throw invalid;
  }
  return {
    response: {
      apiVersion: "v1",
      image: {
        base64: value.image.base64,
        mediaType: value.image.mediaType
      },
      model: requestedModel,
      requestId: value.requestId
    },
    bytes
  };
}
async function performGeneration(input, dependencies) {
  const discovery = dependencies.discovery === undefined ? await fetchGraphicsDiscovery(dependencies.fetch) : parseGraphicsDiscovery(dependencies.discovery);
  const { idempotencyKey, requestBody } = validateInput(input, discovery);
  const accessToken = await getGraphicsAccessToken(discovery, dependencies);
  const maximumResponseBytes = Math.ceil(discovery.imageGeneration.maximumRawImageBytes / 3) * 4 + responseEnvelopeAllowanceBytes;
  const failed = new GraphicsCloudError("GENERATION_FAILED", "Graphics image generation failed; the request was not retried.");
  let response;
  try {
    response = await (dependencies.fetch ?? fetch)(discovery.endpoints.generateImage, {
      method: "POST",
      headers: {
        accept: "application/json",
        authorization: `Bearer ${accessToken}`,
        "content-type": "application/json",
        [discovery.imageGeneration.idempotency.header]: idempotencyKey,
        "user-agent": "hraness-graphics-cli/0.4.0"
      },
      body: requestBody,
      redirect: "error",
      signal: AbortSignal.timeout(120000)
    });
  } catch (cause) {
    throw new GraphicsCloudError("GENERATION_FAILED", "Graphics image generation failed; the request was not retried.", { cause });
  }
  const contentType = response.headers.get("content-type");
  if (contentType === null || !/^application\/json(?:\s*;\s*charset=(?:utf-8|"utf-8"))?$/iu.test(contentType)) {
    await response.body?.cancel().catch(() => {
      return;
    });
    throw failed;
  }
  const responseBytes = await readBoundedResponseBytes(response, maximumResponseBytes, failed);
  if (!response.ok)
    throw failed;
  let value;
  try {
    value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(responseBytes));
  } catch {
    throw new GraphicsCloudError("GENERATION_INVALID_RESPONSE", "Graphics image generation returned invalid JSON.");
  }
  const parsed = parseGeneratedGraphicsImage(value, discovery, input.model);
  return { ...parsed, idempotencyKey };
}
async function generateGraphicsImage(input, dependencies = {}) {
  const generated = await performGeneration(input, dependencies);
  return { ...generated.response, idempotencyKey: generated.idempotencyKey };
}
async function atomicImageWrite(outputPath, bytes) {
  const absolutePath = resolve4(outputPath);
  const temporaryPath = resolve4(dirname4(absolutePath), `.${randomUUID()}.graphics-generate.tmp`);
  try {
    await writeFile2(temporaryPath, bytes, { flag: "wx" });
    await rename3(temporaryPath, absolutePath);
    return absolutePath;
  } catch (cause) {
    throw new GraphicsCloudError("OUTPUT_WRITE_FAILED", "Graphics could not atomically write the generated image.", { cause });
  } finally {
    await rm3(temporaryPath, { force: true }).catch(() => {
      return;
    });
  }
}
async function generateGraphicsImageFile(input, dependencies = {}) {
  if (typeof input.outputPath !== "string" || input.outputPath.length < 1 || input.outputPath.length > 4096 || input.outputPath.includes("\x00")) {
    invalidArgument("Output path must be a non-empty local path.");
  }
  if (!input.outputPath.toLowerCase().endsWith(".webp")) {
    invalidArgument("Output path must end in .webp.");
  }
  const generated = await performGeneration(input, dependencies);
  const outputPath = await atomicImageWrite(input.outputPath, generated.bytes);
  return {
    bytes: generated.bytes.byteLength,
    idempotencyKey: generated.idempotencyKey,
    mediaType: generated.response.image.mediaType,
    model: generated.response.model,
    outputPath,
    requestId: generated.response.requestId
  };
}

// src/operations.ts
import { randomUUID as randomUUID2 } from "crypto";
import { mkdir as mkdir4, readFile as readFile6, rename as rename4, rm as rm5, writeFile as writeFile3 } from "fs/promises";
import { dirname as dirname6, join as join5, resolve as resolve5 } from "path";

// src/vectorize/types.ts
var vectorizeProfileNames = ["balanced", "detailed", "photo"];

class VectorizeError extends Error {
  code;
  details;
  constructor(code, message, details = {}, options) {
    super(message, options);
    this.name = "VectorizeError";
    this.code = code;
    this.details = details;
  }
}

// src/vectorize/limits.ts
var vectorizeHardLimits = Object.freeze({
  maxDecodedPixels: 16777216,
  maxDimension: 4096,
  maxDurationMs: 120000,
  maxInputBytes: 16 * 1024 * 1024,
  maxOutputBytes: 2000000,
  maxPaths: 12000
});
var vectorizeDefaultLimits = Object.freeze({
  ...vectorizeHardLimits,
  maxDurationMs: 30000
});
var limitNames = Object.keys(vectorizeHardLimits);
function resolveVectorizeLimits(input) {
  const resolved = {
    maxDecodedPixels: input?.maxDecodedPixels ?? vectorizeDefaultLimits.maxDecodedPixels,
    maxDimension: input?.maxDimension ?? vectorizeDefaultLimits.maxDimension,
    maxDurationMs: input?.maxDurationMs ?? vectorizeDefaultLimits.maxDurationMs,
    maxInputBytes: input?.maxInputBytes ?? vectorizeDefaultLimits.maxInputBytes,
    maxOutputBytes: input?.maxOutputBytes ?? vectorizeDefaultLimits.maxOutputBytes,
    maxPaths: input?.maxPaths ?? vectorizeDefaultLimits.maxPaths
  };
  for (const name of limitNames) {
    const value = resolved[name];
    const hardLimit = vectorizeHardLimits[name];
    if (!Number.isInteger(value) || value < 1 || value > hardLimit) {
      throw new VectorizeError("invalid_input", `${name} must be a positive integer no greater than ${hardLimit}.`, { hardLimit, name, value });
    }
  }
  return Object.freeze(resolved);
}

class VectorizeDeadline {
  #deadline;
  constructor(durationMs) {
    this.#deadline = performance.now() + durationMs;
  }
  assert(stage) {
    if (this.remainingMs() <= 0) {
      throw new VectorizeError("timeout", `Vectorization timed out during ${stage}.`, { stage });
    }
  }
  remainingMs() {
    return Math.max(0, Math.ceil(this.#deadline - performance.now()));
  }
}
// src/vectorize/command.ts
var MAX_COMMAND_OUTPUT_BYTES = 64 * 1024;
var PRIMARY_OUTPUT_READ_BYTES = 64 * 1024;
var PRIMARY_OUTPUT_POLL_MS = 2;
var TERMINATION_GRACE_MS = 50;
var HARD_KILL_WAIT_MS = 500;
var timeoutMarker = Symbol("bounded-command-timeout");
var noCommandFailure = Symbol("no-command-failure");
var activePosixProcessGroups = new Set;
async function runBoundedCommand(command, timeoutMs, failureCode, options = {}) {
  return runBoundedCommandInternal(command, timeoutMs, failureCode, options);
}
async function runBoundedCommandInternal(command, timeoutMs, failureCode, options, primaryOutput) {
  if (command.length === 0) {
    throw new VectorizeError("invalid_input", "A bounded command requires a command.");
  }
  if (timeoutMs < 1) {
    throw new VectorizeError("timeout", "VTracer exceeded the conversion time limit.");
  }
  const maxStdoutBytes = options.maxStdoutBytes ?? MAX_COMMAND_OUTPUT_BYTES;
  assertPositiveLimit(maxStdoutBytes, "The command stdout limit must be positive.");
  let child;
  const ownsProcessGroup = process.platform !== "win32";
  try {
    child = Bun.spawn([...command], {
      detached: ownsProcessGroup,
      env: process.env,
      stderr: "pipe",
      stdin: options.stdin ?? "ignore",
      stdout: "pipe",
      windowsHide: true
    });
  } catch (error) {
    throw executionError(failureCode, error);
  }
  if (process.platform !== "win32") {
    activePosixProcessGroups.add(child.pid);
  }
  const streamAbort = new AbortController;
  let childHasExited = false;
  const childExitTask = child.exited.then((exitCode) => {
    childHasExited = true;
    if (ownsProcessGroup && process.platform !== "win32") {
      safelyKillPosixProcessGroup(child, "SIGKILL");
    }
    return exitCode;
  });
  const stdoutTask = readBoundedText(child.stdout, maxStdoutBytes, streamAbort.signal, "VTracer emitted too much primary output.");
  const stderrTask = readBoundedText(child.stderr, MAX_COMMAND_OUTPUT_BYTES, streamAbort.signal, "VTracer emitted too much diagnostic output.");
  const primaryOutputTask = primaryOutput === undefined ? Promise.resolve(undefined) : readBoundedFifo(primaryOutput.handle, primaryOutput.maximumBytes, streamAbort.signal, () => childHasExited);
  const executionTask = Promise.all([
    childExitTask,
    stdoutTask,
    stderrTask,
    primaryOutputTask
  ]).then(([exitCode, stdout, stderr, boundedPrimaryOutput]) => {
    if (exitCode !== 0) {
      throw new VectorizeError(failureCode, [
        `Command failed (${exitCode}): ${command[0] ?? "unknown"}`,
        stderr.trim()
      ].filter(Boolean).join(`
`), { exitCode });
    }
    return boundedPrimaryOutput === undefined ? { stderr, stdout } : { primaryOutput: boundedPrimaryOutput, stderr, stdout };
  });
  let timer;
  const timeoutTask = new Promise((_resolve, reject) => {
    timer = setTimeout(() => reject(timeoutMarker), timeoutMs);
  });
  try {
    return await Promise.race([executionTask, timeoutTask]);
  } catch (error) {
    let cleanupError;
    try {
      await terminateAndWait(child, ownsProcessGroup);
    } catch (caught) {
      cleanupError = caught;
    } finally {
      streamAbort.abort();
      await settlesWithin(Promise.allSettled([stdoutTask, stderrTask, primaryOutputTask]), HARD_KILL_WAIT_MS);
    }
    if (error === timeoutMarker) {
      throw new VectorizeError("timeout", cleanupError === undefined ? "VTracer exceeded the conversion time limit." : "VTracer exceeded the conversion time limit and did not terminate cleanly.", cleanupError === undefined ? {} : { cleanup: String(cleanupError) });
    }
    if (error instanceof VectorizeError)
      throw error;
    if (cleanupError instanceof VectorizeError)
      throw cleanupError;
    throw executionError(failureCode, error);
  } finally {
    if (timer !== undefined)
      clearTimeout(timer);
    activePosixProcessGroups.delete(child.pid);
  }
}
function assertPositiveLimit(value, message) {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new VectorizeError("invalid_input", message);
  }
}
async function terminateAndWait(child, ownsProcessGroup) {
  if (process.platform === "win32") {
    await killWindowsProcessTree(child.pid);
  } else if (!ownsProcessGroup) {
    safelyKillChild(child, "SIGTERM");
    await delay(TERMINATION_GRACE_MS);
    safelyKillChild(child, "SIGKILL");
  } else {
    safelyKillPosixProcessGroup(child, "SIGTERM");
    await delay(TERMINATION_GRACE_MS);
    safelyKillPosixProcessGroup(child, "SIGKILL");
  }
  if (await settlesWithin(child.exited, HARD_KILL_WAIT_MS))
    return;
  throw new VectorizeError("trace_failed", "VTracer did not exit after forced termination.");
}
function safelyKillChild(child, signal) {
  try {
    child.kill(signal);
  } catch {}
}
function safelyKillPosixProcessGroup(child, signal) {
  if (!safelyKillPosixProcessGroupByPid(child.pid, signal)) {
    try {
      child.kill(signal);
    } catch {}
  }
}
function safelyKillPosixProcessGroupByPid(pid, signal) {
  try {
    process.kill(-pid, signal);
    return true;
  } catch {
    return false;
  }
}
async function killWindowsProcessTree(pid) {
  let killer;
  try {
    killer = Bun.spawn(["taskkill.exe", "/PID", String(pid), "/T", "/F"], {
      detached: false,
      stderr: "pipe",
      stdin: "ignore",
      stdout: "pipe",
      windowsHide: true
    });
  } catch {
    return;
  }
  const drain = Promise.all([
    readBoundedText(killer.stdout, MAX_COMMAND_OUTPUT_BYTES, AbortSignal.timeout(HARD_KILL_WAIT_MS), "Process-tree cleanup emitted too much output."),
    readBoundedText(killer.stderr, MAX_COMMAND_OUTPUT_BYTES, AbortSignal.timeout(HARD_KILL_WAIT_MS), "Process-tree cleanup emitted too much output.")
  ]);
  if (!await settlesWithin(Promise.all([killer.exited, drain]), HARD_KILL_WAIT_MS)) {
    try {
      killer.kill("SIGKILL");
    } catch {}
  }
}
async function settlesWithin(promise, durationMs) {
  return new Promise((resolve5) => {
    let finished = false;
    const timer = setTimeout(() => finish(false), durationMs);
    promise.then(() => finish(true), () => finish(true));
    function finish(settled) {
      if (finished)
        return;
      finished = true;
      clearTimeout(timer);
      resolve5(settled);
    }
  });
}
async function readBoundedText(stream, maximumBytes, signal, limitMessage) {
  const reader = stream.getReader();
  const chunks = [];
  let bytes = 0;
  const cancel = () => {
    reader.cancel().catch(() => {
      return;
    });
  };
  signal.addEventListener("abort", cancel, { once: true });
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done)
        break;
      bytes += value.byteLength;
      if (bytes > maximumBytes) {
        await reader.cancel();
        throw new VectorizeError("output_limit", limitMessage, {
          bytes,
          maximumBytes
        });
      }
      chunks.push(value);
    }
    return Buffer.concat(chunks, bytes).toString("utf8");
  } finally {
    signal.removeEventListener("abort", cancel);
    reader.releaseLock();
  }
}
async function readBoundedFifo(handle, maximumBytes, signal, childHasExited) {
  const buffer = Buffer.allocUnsafe(Math.min(PRIMARY_OUTPUT_READ_BYTES, maximumBytes + 1));
  const chunks = [];
  let bytes = 0;
  while (!signal.aborted) {
    const maximumRead = Math.min(buffer.byteLength, maximumBytes - bytes + 1);
    try {
      const { bytesRead } = await handle.read(buffer, 0, maximumRead, null);
      if (bytesRead > 0) {
        bytes += bytesRead;
        if (bytes > maximumBytes) {
          throw new VectorizeError("output_limit", "VTracer emitted too much primary output.", { bytes, maximumBytes });
        }
        chunks.push(Uint8Array.from(buffer.subarray(0, bytesRead)));
        continue;
      }
    } catch (error) {
      if (!isWouldBlockError(error))
        throw error;
    }
    if (childHasExited())
      break;
    await delay(PRIMARY_OUTPUT_POLL_MS);
  }
  return Buffer.concat(chunks, bytes).toString("utf8");
}
function isWouldBlockError(error) {
  return isFileSystemError(error) && ["EAGAIN", "EINTR", "EWOULDBLOCK"].includes(String(error.code));
}
function isFileSystemError(error, code) {
  return error instanceof Error && "code" in error && (code === undefined || error.code === code);
}
function delay(durationMs) {
  return new Promise((resolve5) => {
    setTimeout(resolve5, durationMs);
  });
}
function executionError(failureCode, cause) {
  return new VectorizeError(failureCode, "VTracer could not be executed.", {}, { cause: cause instanceof Error ? cause : new Error(String(cause)) });
}

// src/vectorize/tool.ts
var VTRACER_VERSION = "0.6.4";
var frozenRelease = (release) => Object.freeze(release);
var vtracerReleases = Object.freeze({
  "darwin-arm64": frozenRelease({
    archiveSha256: "4a597fd2df8b961d60620df40a7436109427d86e5c028758e6e8796b02d3d996",
    binarySha256: "77e495bbe212448240387fba3b6d8bc62ba20ecfb6f3c22967e51600f1cc6e66",
    format: "tar.gz",
    url: `https://github.com/visioncortex/vtracer/releases/download/${VTRACER_VERSION}/vtracer-aarch64-apple-darwin.tar.gz`
  }),
  "darwin-x64": frozenRelease({
    archiveSha256: "f0d755292c2602d772d63d658a3498b23eca8b5620d4b92a991bd035d5abed16",
    binarySha256: "0f9f88f989b757e27973a5c4b42665153070183d0787656ee8af2249ab326b78",
    format: "tar.gz",
    url: `https://github.com/visioncortex/vtracer/releases/download/${VTRACER_VERSION}/vtracer-x86_64-apple-darwin.tar.gz`
  }),
  "linux-arm64": frozenRelease({
    archiveSha256: "cbd05ad4f491d12dd139ada61485ca1d24db9f981cbe1658632a083cd0ac1a71",
    binarySha256: "a4b33b6c4066a6b9187802c6efc8b89e211318e12a17164b9d1dd1f29ac5e502",
    format: "tar.gz",
    url: `https://github.com/visioncortex/vtracer/releases/download/${VTRACER_VERSION}/vtracer-aarch64-unknown-linux-musl.tar.gz`
  }),
  "linux-x64": frozenRelease({
    archiveSha256: "9290ba0c90e224d6d212836dff5491407c1718bcb72f80b2b5a4a01816df5e40",
    binarySha256: "6f31499257076bd94de3e976844cf7ca5643f1e194a2bf0599b13f3719452aec",
    format: "tar.gz",
    url: `https://github.com/visioncortex/vtracer/releases/download/${VTRACER_VERSION}/vtracer-x86_64-unknown-linux-musl.tar.gz`
  }),
  "win32-x64": frozenRelease({
    archiveSha256: "6b5bc17a6b017129ee40461df254f65d16f3b494c001a8541d41861066b716bf",
    binarySha256: "4ad8d35e566cd15caf582063b8349bd082b8fa2bd461e99d116fc63ad8fdeca0",
    format: "zip",
    url: `https://github.com/visioncortex/vtracer/releases/download/${VTRACER_VERSION}/vtracer-x86_64-pc-windows-msvc.zip`
  })
});
var MAX_ARCHIVE_BYTES = 4 * 1024 * 1024;
var MAX_TOOL_BYTES = 16 * 1024 * 1024;
var FILE_CHUNK_BYTES = 64 * 1024;
// src/vectorize/supervisor.ts
import { fileURLToPath } from "url";
import { mkdtemp, rm as rm4 } from "fs/promises";
import { tmpdir } from "os";
import { dirname as dirname5, join as join4 } from "path";

// src/vectorize/worker-protocol.ts
var VECTORIZE_WORKER_PROTOCOL = 1;
var MAX_VECTORIZE_REQUEST_BYTES = Math.ceil(vectorizeHardLimits.maxInputBytes / 3) * 4 + 512 * 1024;
var MAX_VECTORIZE_RESPONSE_BYTES = vectorizeHardLimits.maxOutputBytes * 2 + 512 * 1024;

// src/vectorize/supervisor.ts
var vectorizeErrorCodes = new Set([
  "input_limit",
  "invalid_input",
  "output_limit",
  "quality_limit",
  "timeout",
  "tool_download",
  "tool_integrity",
  "tool_platform",
  "tool_version",
  "trace_failed",
  "unsafe_svg"
]);
var WORKER_SHUTDOWN_RESERVE_MS = 250;
var WORKER_RESPONSE_RESERVE_MS = 100;
async function runVectorizeWorker(input, options) {
  const startedAt = performance.now();
  const limits = resolveVectorizeLimits(options.limits);
  if (process.platform === "win32") {
    throw new VectorizeError("tool_platform", "Bounded VTracer streaming is unavailable on Windows.", { platform: process.platform });
  }
  const workerInput = encodeInput(input, limits.maxInputBytes);
  const temporaryRoot = await mkdtemp(join4(tmpdir(), "graphics-vectorize-"));
  let result;
  try {
    result = await executeVectorizeWorker(workerInput, options, limits, startedAt, temporaryRoot);
  } finally {
    await removeTemporaryRoot(temporaryRoot);
  }
  if (performance.now() - startedAt >= limits.maxDurationMs) {
    throw new VectorizeError("timeout", "Vectorization exceeded the conversion time limit during cleanup.");
  }
  return result;
}
async function executeVectorizeWorker(workerInput, options, limits, startedAt, temporaryRoot) {
  const preparationRemainingMs = limits.maxDurationMs - (performance.now() - startedAt);
  if (preparationRemainingMs <= WORKER_SHUTDOWN_RESERVE_MS + WORKER_RESPONSE_RESERVE_MS) {
    throw new VectorizeError("timeout", "Vectorization has no remaining budget for isolated worker execution.");
  }
  const workerDurationMs = Math.floor(preparationRemainingMs - WORKER_SHUTDOWN_RESERVE_MS - WORKER_RESPONSE_RESERVE_MS);
  const request = {
    input: workerInput,
    options: cloneOptions(options, workerDurationMs),
    protocol: VECTORIZE_WORKER_PROTOCOL,
    temporaryRoot
  };
  const requestBytes = Buffer.from(JSON.stringify(request));
  if (requestBytes.byteLength > MAX_VECTORIZE_REQUEST_BYTES) {
    throw new VectorizeError("input_limit", "The vectorization worker request exceeds its IPC limit.", {
      bytes: requestBytes.byteLength,
      maximumBytes: MAX_VECTORIZE_REQUEST_BYTES
    });
  }
  const remainingMs = limits.maxDurationMs - (performance.now() - startedAt);
  if (remainingMs <= WORKER_SHUTDOWN_RESERVE_MS) {
    throw new VectorizeError("timeout", "Vectorization has no remaining budget for isolated worker startup and cleanup.");
  }
  const { stdout } = await runBoundedCommand([process.execPath, workerEntryPath()], Math.floor(remainingMs - WORKER_SHUTDOWN_RESERVE_MS), "trace_failed", {
    maxStdoutBytes: MAX_VECTORIZE_RESPONSE_BYTES,
    stdin: requestBytes
  });
  if (performance.now() - startedAt >= limits.maxDurationMs) {
    throw new VectorizeError("timeout", "Vectorization exceeded the conversion time limit.");
  }
  const response = parseResponse(stdout);
  if (!response.ok) {
    throw new VectorizeError(response.error.code, response.error.message, response.error.details);
  }
  assertResult(response.result, limits.maxOutputBytes);
  if (performance.now() - startedAt >= limits.maxDurationMs) {
    throw new VectorizeError("timeout", "Vectorization exceeded the conversion time limit.");
  }
  return response.result;
}
async function removeTemporaryRoot(temporaryRoot) {
  try {
    await rm4(temporaryRoot, { force: true, recursive: true });
  } catch (error) {
    throw new VectorizeError("trace_failed", "The isolated vectorization directory could not be removed.", { temporaryRoot }, { cause: error });
  }
}
function encodeInput(input, maximumInputBytes) {
  return typeof input === "string" ? { kind: "path", value: input } : encodeBytes(input, maximumInputBytes);
}
function encodeBytes(input, maximumInputBytes) {
  const view = input instanceof ArrayBuffer ? new Uint8Array(input) : input;
  if (view.byteLength < 1) {
    throw new VectorizeError("invalid_input", "Raster input is empty.");
  }
  if (view.byteLength > maximumInputBytes) {
    throw new VectorizeError("input_limit", `Raster input exceeds the ${maximumInputBytes}-byte limit.`, { bytes: view.byteLength, maximumBytes: maximumInputBytes });
  }
  return {
    kind: "bytes",
    value: Buffer.from(view.buffer, view.byteOffset, view.byteLength).toString("base64")
  };
}
function cloneOptions(options, workerDurationMs) {
  return {
    ...options.alphaCutoff === undefined ? {} : { alphaCutoff: options.alphaCutoff },
    ...options.cacheDirectory === undefined ? {} : { cacheDirectory: options.cacheDirectory },
    ...options.duotone === undefined ? {} : { duotone: [options.duotone[0], options.duotone[1]] },
    limits: {
      ...options.limits,
      maxDurationMs: workerDurationMs
    },
    ...options.outputPath === undefined ? {} : { outputPath: options.outputPath }
  };
}
function workerEntryPath() {
  const modulePath = fileURLToPath(import.meta.url);
  return modulePath.endsWith(".ts") ? join4(dirname5(modulePath), "worker.ts") : join4(dirname5(modulePath), "vectorize-worker.js");
}
function parseResponse(stdout) {
  let parsed;
  try {
    parsed = JSON.parse(stdout);
  } catch (error) {
    throw new VectorizeError("trace_failed", "The vectorization worker returned malformed output.", {}, { cause: error });
  }
  if (!isRecord7(parsed) || parsed.protocol !== VECTORIZE_WORKER_PROTOCOL) {
    throw new VectorizeError("trace_failed", "The vectorization worker returned an incompatible response.");
  }
  if (parsed.ok === true && isVectorizeResult(parsed.result)) {
    return parsed;
  }
  if (parsed.ok === false && isRecord7(parsed.error) && typeof parsed.error.code === "string" && vectorizeErrorCodes.has(parsed.error.code) && typeof parsed.error.message === "string" && isRecord7(parsed.error.details)) {
    return parsed;
  }
  throw new VectorizeError("trace_failed", "The vectorization worker returned an invalid response.");
}
function assertResult(result, maximumOutputBytes) {
  const bytes = Buffer.byteLength(result.svg);
  if (bytes < 1 || bytes > maximumOutputBytes || result.receipt.bytes !== bytes || result.receipt.svgSha256.length !== 64) {
    throw new VectorizeError("trace_failed", "The vectorization worker response violates its output contract.", { bytes, maximumOutputBytes });
  }
}
function isVectorizeResult(value) {
  if (!isRecord7(value) || value.outputPath !== null && typeof value.outputPath !== "string" || typeof value.svg !== "string" || !isRecord7(value.receipt)) {
    return false;
  }
  const profile = value.receipt.profile;
  return typeof value.receipt.bytes === "number" && typeof value.receipt.svgSha256 === "string" && typeof profile === "string" && vectorizeProfileNames.includes(profile);
}
function isRecord7(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// src/vectorize/vectorize.ts
function vectorizeImage(input, options = {}) {
  return runVectorizeWorker(input, options);
}
// src/operations.ts
var graphicsOperationCodes = [
  "graphics.diagram.check",
  "graphics.diagram.render",
  "graphics.image.vectorize",
  "graphics.image.generate"
];

class GraphicsOperationError extends Error {
  code;
  constructor(code, message) {
    super(`[${code}] ${message}`);
    this.name = "GraphicsOperationError";
    this.code = code;
  }
}
var modelSchema = {
  type: "string",
  enum: graphicsImageModels
};
var pathSchema = {
  type: "string",
  minLength: 1,
  maxLength: 4096
};
function deepFreeze2(value) {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) {
    return value;
  }
  for (const nested of Object.values(value))
    deepFreeze2(nested);
  return Object.freeze(value);
}
var graphicsOperationRegistry = deepFreeze2([
  {
    code: "graphics.diagram.check",
    title: "Check diagram",
    description: "Parse and lint a checked Graphics diagram source without changing its files.",
    execution: "local",
    authentication: "none",
    destructive: false,
    idempotent: true,
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["path"],
      properties: { path: pathSchema }
    }
  },
  {
    code: "graphics.diagram.render",
    title: "Render diagram",
    description: "Render a checked Graphics diagram source to its replaceable light, dark, PNG, SVG, and tldraw artifacts.",
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
    }
  },
  {
    code: "graphics.image.vectorize",
    title: "Vectorize image",
    description: "Convert a local caller-owned raster into a bounded inert SVG after proving a free Graphics login; source bytes remain local.",
    execution: "local",
    authentication: "required",
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
    }
  },
  {
    code: "graphics.image.generate",
    title: "Generate image",
    description: "Generate one bounded free-preview WebP with an explicitly supported hosted model, durable suite-account idempotency, and no ambiguous retry.",
    execution: "hosted",
    authentication: "required",
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
          maxLength: graphicsMaximumPromptBytes
        },
        outputPath: pathSchema,
        idempotencyKey: {
          type: "string",
          minLength: 16,
          maxLength: 128,
          pattern: "^[A-Za-z0-9][A-Za-z0-9._:-]*$"
        }
      }
    },
    transport: {
      method: "POST",
      endpointFromDiscovery: "endpoints.generateImage",
      authorization: "bearer",
      idempotencyHeader: "Idempotency-Key",
      retry: "never"
    }
  }
]);
function operationFailure(message) {
  throw new GraphicsOperationError("INVALID_OPERATION_INPUT", message);
}
function isRecord8(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function record(value, allowedKeys) {
  if (!isRecord8(value))
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
  const input = record(value, [
    "model",
    "prompt",
    "outputPath",
    "idempotencyKey"
  ]);
  if (typeof input.model !== "string" || !graphicsImageModels.includes(input.model)) {
    operationFailure(`model must be ${graphicsImageModels[0]} or ${graphicsImageModels[1]}.`);
  }
  if (typeof input.prompt !== "string" || input.prompt.trim().length < 1 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(input.prompt) || Buffer.byteLength(input.prompt, "utf8") > graphicsMaximumPromptBytes) {
    operationFailure(`prompt must be non-empty and no more than ${graphicsMaximumPromptBytes} UTF-8 bytes.`);
  }
  if (input.idempotencyKey !== undefined) {
    try {
      validateGraphicsIdempotencyKey(typeof input.idempotencyKey === "string" ? input.idempotencyKey : "");
    } catch {
      operationFailure("idempotencyKey is invalid.");
    }
  }
  const outputPath = pathValue(input.outputPath, "outputPath");
  if (!outputPath.toLowerCase().endsWith(".webp")) {
    operationFailure("outputPath must end in .webp.");
  }
  return {
    model: input.model,
    prompt: input.prompt,
    outputPath,
    ...input.idempotencyKey === undefined ? {} : { idempotencyKey: input.idempotencyKey }
  };
}
function parseGraphicsOperationInput(code, input) {
  switch (code) {
    case "graphics.diagram.check":
      return parseCheck(input);
    case "graphics.diagram.render":
      return parseRender(input);
    case "graphics.image.vectorize":
      return parseVectorize(input);
    case "graphics.image.generate":
      return parseGenerate(input);
    default:
      throw new GraphicsOperationError("INVALID_OPERATION", "Unknown Graphics operation code.");
  }
}
function isGraphicsOperationCode(value) {
  return graphicsOperationCodes.includes(value);
}
function searchGraphicsOperations(query = "", limit = graphicsOperationRegistry.length) {
  if (typeof query !== "string" || query.length > 200 || /[\u0000-\u001f\u007f]/u.test(query) || !Number.isInteger(limit) || limit < 1 || limit > 20) {
    throw new GraphicsOperationError("INVALID_SEARCH", "Search requires a bounded query and a limit from 1 through 20.");
  }
  const terms = query.toLowerCase().split(/\s+/u).filter((term) => term.length > 0);
  return graphicsOperationRegistry.filter((operation) => {
    const haystack = `${operation.code} ${operation.title} ${operation.description}`.toLowerCase();
    return terms.every((term) => haystack.includes(term));
  }).slice(0, limit);
}
var operationBuiltInConfig = Object.freeze({
  icons: builtInIcons
});
async function readOperationDiagram(path) {
  const absolutePath = resolve5(path);
  let value;
  try {
    value = JSON.parse(await readFile6(absolutePath, "utf8"));
  } catch (cause) {
    throw new GraphicsOperationError("INVALID_OPERATION_INPUT", "Diagram source could not be read as JSON.");
  }
  const spec = parseDiagramSpec(value);
  for (const shape of spec.shapes) {
    if ((shape.type === "rect" || shape.type === "ellipse") && shape.icon !== undefined && !Object.hasOwn(builtInIcons, shape.icon)) {
      throw new GraphicsOperationError("INVALID_OPERATION_INPUT", "Diagram requests an unavailable built-in icon.");
    }
  }
  return { absolutePath, spec };
}
async function atomicOperationWrite(path, value) {
  const temporaryPath = join5(dirname6(path), `.${randomUUID2()}.graphics-operation.tmp`);
  try {
    await writeFile3(temporaryPath, value, { flag: "wx" });
    await rename4(temporaryPath, path);
  } finally {
    await rm5(temporaryPath, { force: true }).catch(() => {
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
  const outputDirectory = resolve5(input.outDirectory ?? dirname6(absolutePath));
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
    tldr: join5(outputDirectory, `${spec.name}.tldr`),
    lightSvg: join5(outputDirectory, `${spec.name}.light.svg`),
    darkSvg: join5(outputDirectory, `${spec.name}.dark.svg`),
    lightPng: join5(outputDirectory, `${spec.name}.light.png`),
    darkPng: join5(outputDirectory, `${spec.name}.dark.png`)
  };
  await mkdir4(outputDirectory, { recursive: true });
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
async function executeGraphicsOperation(code, value, dependencies = {}) {
  const input = parseGraphicsOperationInput(code, value);
  switch (code) {
    case "graphics.diagram.check": {
      const options = input;
      return await checkOperationDiagram(options.path);
    }
    case "graphics.diagram.render": {
      const options = input;
      return await renderOperationDiagram(options);
    }
    case "graphics.image.vectorize": {
      const options = input;
      await requireGraphicsAuthentication(dependencies);
      const result = await vectorizeImage(options.inputPath, {
        outputPath: options.outputPath,
        ...options.duotone === undefined ? {} : { duotone: options.duotone },
        ...options.alphaCutoff === undefined ? {} : { alphaCutoff: options.alphaCutoff },
        ...options.timeoutMs === undefined ? {} : { limits: { maxDurationMs: options.timeoutMs } }
      });
      if (result.outputPath === null) {
        throw new GraphicsOperationError("INVALID_OPERATION_INPUT", "Vectorization did not publish its required output.");
      }
      return {
        outputPath: result.outputPath,
        receipt: result.receipt
      };
    }
    case "graphics.image.generate": {
      const options = input;
      return await generateGraphicsImageFile(options, dependencies);
    }
    default:
      throw new GraphicsOperationError("INVALID_OPERATION", "Unknown Graphics operation code.");
  }
}

// src/mcp/tools.ts
import { rename as rename5, rm as rm6, writeFile as writeFile4 } from "fs/promises";
import { dirname as dirname8, join as join7 } from "path";

// src/mcp/boundary.ts
import { open as open2, mkdir as mkdir5, realpath, stat } from "fs/promises";
import {
  basename as basename3,
  dirname as dirname7,
  isAbsolute as isAbsolute3,
  join as join6,
  relative,
  resolve as resolve6,
  win32
} from "path";
var mcpSourceByteLimit = 1024 * 1024;

class WorkspaceBoundaryError extends Error {
  code;
  constructor(code, message) {
    super(message);
    this.name = "WorkspaceBoundaryError";
    this.code = code;
  }
}
function filesystemCode(error) {
  if (typeof error === "object" && error !== null && "code" in error && typeof error.code === "string") {
    return error.code;
  }
  return;
}
function normalizeRelativePath(value, options) {
  if (value.length === 0 || value.includes("\x00")) {
    throw new WorkspaceBoundaryError("INVALID_PATH", "Path must be a non-empty root-relative path.");
  }
  if (isAbsolute3(value) || win32.isAbsolute(value) || /^[A-Za-z]:/.test(value)) {
    throw new WorkspaceBoundaryError("INVALID_PATH", "Absolute paths are not allowed.");
  }
  const segments = value.split(/[\\/]/).filter((segment) => segment !== "" && segment !== ".");
  if (segments.includes("..")) {
    throw new WorkspaceBoundaryError("INVALID_PATH", "Parent-directory traversal is not allowed.");
  }
  if (segments.length === 0) {
    if (!options.allowRoot) {
      throw new WorkspaceBoundaryError("INVALID_PATH", "Path must identify a file below the root.");
    }
    return { native: ".", portable: "." };
  }
  return {
    native: segments.join("/"),
    portable: segments.join("/")
  };
}
function isConfined(rootDirectory, target) {
  const fromRoot = relative(rootDirectory, target);
  return fromRoot === "" || !fromRoot.startsWith("..") && !isAbsolute3(fromRoot);
}
async function readUtf8WithCap(filePath) {
  let handle;
  try {
    handle = await open2(filePath, "r");
    const metadata = await handle.stat();
    if (!metadata.isFile()) {
      throw new WorkspaceBoundaryError("SOURCE_NOT_FILE", "Diagram source must be a regular file.");
    }
    if (metadata.size > mcpSourceByteLimit) {
      throw new WorkspaceBoundaryError("SOURCE_TOO_LARGE", `Diagram source exceeds the ${mcpSourceByteLimit}-byte limit.`);
    }
    const buffer = Buffer.allocUnsafe(mcpSourceByteLimit + 1);
    let bytesRead = 0;
    while (bytesRead <= mcpSourceByteLimit) {
      const next = await handle.read(buffer, bytesRead, mcpSourceByteLimit + 1 - bytesRead, null);
      if (next.bytesRead === 0)
        break;
      bytesRead += next.bytesRead;
    }
    if (bytesRead > mcpSourceByteLimit) {
      throw new WorkspaceBoundaryError("SOURCE_TOO_LARGE", `Diagram source exceeds the ${mcpSourceByteLimit}-byte limit.`);
    }
    try {
      return new TextDecoder("utf-8", { fatal: true }).decode(buffer.subarray(0, bytesRead));
    } catch {
      throw new WorkspaceBoundaryError("SOURCE_ENCODING", "Diagram source must contain valid UTF-8.");
    }
  } catch (error) {
    if (error instanceof WorkspaceBoundaryError)
      throw error;
    const code = filesystemCode(error);
    if (code === "ENOENT") {
      throw new WorkspaceBoundaryError("SOURCE_NOT_FOUND", "Diagram source does not exist.");
    }
    throw new WorkspaceBoundaryError("FILESYSTEM_ERROR", "Diagram source could not be read.");
  } finally {
    await handle?.close();
  }
}

class WorkspaceBoundary {
  rootDirectory;
  constructor(rootDirectory) {
    this.rootDirectory = rootDirectory;
  }
  static async create(rootDirectory) {
    let resolvedRoot;
    try {
      resolvedRoot = await realpath(resolve6(rootDirectory));
      if (!(await stat(resolvedRoot)).isDirectory()) {
        throw new WorkspaceBoundaryError("OUTPUT_NOT_DIRECTORY", "MCP root must be a directory.");
      }
    } catch (error) {
      if (error instanceof WorkspaceBoundaryError)
        throw error;
      throw new WorkspaceBoundaryError("FILESYSTEM_ERROR", "MCP root could not be opened.");
    }
    return new WorkspaceBoundary(resolvedRoot);
  }
  assertConfined(target) {
    if (!isConfined(this.rootDirectory, target)) {
      throw new WorkspaceBoundaryError("PATH_OUTSIDE_ROOT", "Path resolves outside the MCP root.");
    }
  }
  toRelativePath(absolutePath) {
    this.assertConfined(absolutePath);
    const fromRoot = relative(this.rootDirectory, absolutePath);
    return fromRoot === "" ? "." : fromRoot.split("\\").join("/");
  }
  async readSource(value) {
    const normalized = normalizeRelativePath(value, { allowRoot: false });
    const lexicalPath = resolve6(this.rootDirectory, normalized.native);
    this.assertConfined(lexicalPath);
    let canonicalPath;
    try {
      canonicalPath = await realpath(lexicalPath);
    } catch (error) {
      if (filesystemCode(error) === "ENOENT") {
        throw new WorkspaceBoundaryError("SOURCE_NOT_FOUND", "Diagram source does not exist.");
      }
      throw new WorkspaceBoundaryError("FILESYSTEM_ERROR", "Diagram source could not be resolved.");
    }
    this.assertConfined(canonicalPath);
    return {
      absolutePath: canonicalPath,
      relativePath: this.toRelativePath(canonicalPath),
      text: await readUtf8WithCap(canonicalPath)
    };
  }
  async resolveInputFile(value, maximumBytes) {
    const normalized = normalizeRelativePath(value, { allowRoot: false });
    const lexicalPath = resolve6(this.rootDirectory, normalized.native);
    this.assertConfined(lexicalPath);
    let canonicalPath;
    try {
      canonicalPath = await realpath(lexicalPath);
      this.assertConfined(canonicalPath);
      const metadata = await stat(canonicalPath);
      if (!metadata.isFile()) {
        throw new WorkspaceBoundaryError("SOURCE_NOT_FILE", "Input must be a regular file.");
      }
      if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 1 || metadata.size > maximumBytes) {
        throw new WorkspaceBoundaryError("SOURCE_TOO_LARGE", `Input exceeds the ${maximumBytes}-byte limit.`);
      }
    } catch (error) {
      if (error instanceof WorkspaceBoundaryError)
        throw error;
      if (filesystemCode(error) === "ENOENT") {
        throw new WorkspaceBoundaryError("SOURCE_NOT_FOUND", "Input does not exist.");
      }
      throw new WorkspaceBoundaryError("FILESYSTEM_ERROR", "Input could not be resolved.");
    }
    return {
      absolutePath: canonicalPath,
      relativePath: this.toRelativePath(canonicalPath)
    };
  }
  async prepareOutputFile(value) {
    const normalized = normalizeRelativePath(value, { allowRoot: false });
    const fileName = basename3(normalized.native);
    if (fileName === "." || fileName === ".." || fileName.length === 0) {
      throw new WorkspaceBoundaryError("INVALID_PATH", "Output path must identify a file below the root.");
    }
    const directory = await this.prepareOutputDirectory(dirname7(normalized.native));
    const absolutePath = join6(directory.absolutePath, fileName);
    this.assertConfined(absolutePath);
    return {
      absolutePath,
      relativePath: this.toRelativePath(absolutePath)
    };
  }
  async prepareOutputDirectory(value) {
    const normalized = normalizeRelativePath(value, { allowRoot: true });
    const lexicalPath = resolve6(this.rootDirectory, normalized.native);
    this.assertConfined(lexicalPath);
    let ancestor = lexicalPath;
    for (;; ) {
      try {
        const canonicalAncestor = await realpath(ancestor);
        this.assertConfined(canonicalAncestor);
        break;
      } catch (error) {
        if (error instanceof WorkspaceBoundaryError)
          throw error;
        if (filesystemCode(error) !== "ENOENT") {
          throw new WorkspaceBoundaryError("FILESYSTEM_ERROR", "Output directory could not be resolved.");
        }
        const parent = dirname7(ancestor);
        if (parent === ancestor) {
          throw new WorkspaceBoundaryError("PATH_OUTSIDE_ROOT", "Output directory resolves outside the MCP root.");
        }
        ancestor = parent;
      }
    }
    try {
      await mkdir5(lexicalPath, { recursive: true });
      const canonicalPath = await realpath(lexicalPath);
      this.assertConfined(canonicalPath);
      if (!(await stat(canonicalPath)).isDirectory()) {
        throw new WorkspaceBoundaryError("OUTPUT_NOT_DIRECTORY", "Output path must be a directory.");
      }
      return {
        absolutePath: canonicalPath,
        relativePath: this.toRelativePath(canonicalPath)
      };
    } catch (error) {
      if (error instanceof WorkspaceBoundaryError)
        throw error;
      throw new WorkspaceBoundaryError("FILESYSTEM_ERROR", "Output directory could not be created.");
    }
  }
}

// src/mcp/tools.ts
var mcpMaximumScale = 4;
var mcpMaximumRenderedPixels = 16777216;
var mcpMaximumShapes = 64;
var mcpMaximumEdges = 128;
var mcpMaximumReturnedFindings = 40;
var defaultScale = 2;
var maximumShapeIdsPerFinding = 12;
var builtInConfig = Object.freeze({ icons: builtInIcons });
var findingSchema = {
  type: "object",
  additionalProperties: false,
  required: ["code", "message", "shapeIds"],
  properties: {
    code: { type: "string" },
    message: { type: "string" },
    shapeIds: { type: "array", items: { type: "string" } }
  }
};
function deepFreeze3(value) {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) {
    return value;
  }
  for (const nested of Object.values(value))
    deepFreeze3(nested);
  return Object.freeze(value);
}
var graphicsMcpTools = deepFreeze3([
  {
    name: "check_diagram",
    title: "Check diagram",
    description: "Parse and lint one root-relative Graphics diagram source without changing files. Uses only built-in icons and themes.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["path"],
      properties: {
        path: {
          type: "string",
          description: "Root-relative path to a diagram JSON source (1 MiB maximum)."
        }
      }
    },
    outputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["ok", "source", "findings", "summary"],
      properties: {
        ok: { const: true },
        source: { type: "string" },
        findings: { type: "array", items: findingSchema },
        summary: {
          type: "object",
          additionalProperties: false,
          required: [
            "shapeCount",
            "edgeCount",
            "findingCount",
            "returnedFindingCount",
            "findingsTruncated"
          ],
          properties: {
            shapeCount: { type: "integer", minimum: 0 },
            edgeCount: { type: "integer", minimum: 0 },
            findingCount: { type: "integer", minimum: 0 },
            returnedFindingCount: { type: "integer", minimum: 0 },
            findingsTruncated: { type: "boolean" }
          }
        }
      }
    },
    annotations: {
      title: "Check diagram",
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false
    }
  },
  {
    name: "render_diagram",
    title: "Render diagram",
    description: "Render one root-relative Graphics diagram source with built-in icons and themes, overwriting its paired .tldr, light/dark SVG, and light/dark PNG artifacts.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["path"],
      properties: {
        path: {
          type: "string",
          description: "Root-relative path to a diagram JSON source (1 MiB maximum)."
        },
        out_dir: {
          type: "string",
          description: "Optional root-relative output directory. Defaults to the source directory."
        },
        scale: {
          type: "number",
          exclusiveMinimum: 0,
          maximum: mcpMaximumScale,
          default: defaultScale,
          description: "PNG scale. The scaled canvas may contain at most 16,777,216 pixels."
        }
      }
    },
    outputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["ok", "source", "scale", "findings", "artifacts", "summary"],
      properties: {
        ok: { const: true },
        source: { type: "string" },
        scale: { type: "number" },
        findings: { type: "array", items: findingSchema },
        artifacts: {
          type: "object",
          additionalProperties: false,
          required: ["tldr", "lightSvg", "darkSvg", "lightPng", "darkPng"],
          properties: {
            tldr: { type: "string" },
            lightSvg: { type: "string" },
            darkSvg: { type: "string" },
            lightPng: { type: "string" },
            darkPng: { type: "string" }
          }
        },
        summary: {
          type: "object",
          additionalProperties: false,
          required: [
            "shapeCount",
            "edgeCount",
            "findingCount",
            "returnedFindingCount",
            "findingsTruncated"
          ],
          properties: {
            shapeCount: { type: "integer", minimum: 0 },
            edgeCount: { type: "integer", minimum: 0 },
            findingCount: { type: "integer", minimum: 0 },
            returnedFindingCount: { type: "integer", minimum: 0 },
            findingsTruncated: { type: "boolean" }
          }
        }
      }
    },
    annotations: {
      title: "Render diagram",
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: true,
      openWorldHint: false
    }
  },
  {
    name: "search_graphics",
    title: "Search Graphics operations",
    description: "Search the fixed semantic Graphics operation registry by bounded text. This never executes code or changes files.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        query: {
          type: "string",
          maxLength: 200,
          description: "Optional terms matched against operation codes and descriptions."
        },
        limit: {
          type: "integer",
          minimum: 1,
          maximum: 20,
          default: 4
        }
      }
    },
    outputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["ok", "operations"],
      properties: {
        ok: { const: true },
        operations: {
          type: "array",
          maxItems: 20,
          items: {
            type: "object",
            required: [
              "code",
              "title",
              "description",
              "execution",
              "authentication",
              "inputSchema"
            ]
          }
        }
      }
    },
    annotations: {
      title: "Search Graphics operations",
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false
    }
  },
  {
    name: "execute_graphics",
    title: "Execute Graphics operation",
    description: "Execute one exact operation code with typed JSON input. Never accepts or evaluates source code. Local paths remain confined to the configured workspace root.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["operation", "input"],
      properties: {
        operation: {
          type: "string",
          enum: graphicsOperationCodes
        },
        input: {
          type: "object",
          description: "Typed input matching the selected operation's registry schema."
        }
      }
    },
    outputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["ok", "operation", "result"],
      properties: {
        ok: { const: true },
        operation: { type: "string", enum: graphicsOperationCodes },
        result: { type: "object" }
      }
    },
    annotations: {
      title: "Execute Graphics operation",
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: true
    }
  }
]);

class ToolFailure extends Error {
  code;
  issues;
  constructor(code, message, issues) {
    super(message);
    this.name = "ToolFailure";
    this.code = code;
    if (issues !== undefined)
      this.issues = issues;
  }
}
function isRecord9(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function safeFragment(value, maximumLength = 160) {
  return value.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, maximumLength);
}
function safeIssues(issues) {
  return issues.slice(0, 24).map((issue) => safeFragment(issue, 240));
}
function rejectUnknownKeys(value, allowed) {
  const unknown = Object.keys(value).filter((key) => !allowed.has(key));
  if (unknown.length > 0) {
    throw new ToolFailure("INVALID_ARGUMENTS", `Unsupported argument: ${safeFragment(unknown[0] ?? "unknown")}.`);
  }
}
function parsePath(value) {
  if (typeof value !== "string" || value.length === 0) {
    throw new ToolFailure("INVALID_ARGUMENTS", "path must be a non-empty root-relative string.");
  }
  if (!value.toLowerCase().endsWith(".diagram.json")) {
    throw new ToolFailure("INVALID_ARGUMENTS", "path must end in .diagram.json.");
  }
  return value;
}
function parseCheckArguments(value) {
  if (!isRecord9(value)) {
    throw new ToolFailure("INVALID_ARGUMENTS", "Tool arguments must be an object.");
  }
  rejectUnknownKeys(value, new Set(["path"]));
  return { path: parsePath(value.path) };
}
function parseRenderArguments(value) {
  if (!isRecord9(value)) {
    throw new ToolFailure("INVALID_ARGUMENTS", "Tool arguments must be an object.");
  }
  rejectUnknownKeys(value, new Set(["path", "out_dir", "scale"]));
  const outDirectory = value.out_dir;
  if (outDirectory !== undefined && (typeof outDirectory !== "string" || outDirectory.length === 0)) {
    throw new ToolFailure("INVALID_ARGUMENTS", "out_dir must be a non-empty root-relative string when present.");
  }
  const scale = value.scale ?? defaultScale;
  if (typeof scale !== "number" || !Number.isFinite(scale) || scale <= 0 || scale > mcpMaximumScale) {
    throw new ToolFailure("RENDER_LIMIT", `scale must be greater than zero and no more than ${mcpMaximumScale}.`);
  }
  return {
    path: parsePath(value.path),
    ...outDirectory === undefined ? {} : { outDirectory },
    scale
  };
}
function parseSearchArguments(value) {
  if (!isRecord9(value)) {
    throw new ToolFailure("INVALID_ARGUMENTS", "Tool arguments must be an object.");
  }
  rejectUnknownKeys(value, new Set(["query", "limit"]));
  const query = value.query ?? "";
  const limit = value.limit ?? graphicsOperationCodes.length;
  if (typeof query !== "string" || query.length > 200 || /[\u0000-\u001f\u007f]/u.test(query) || !Number.isInteger(limit) || limit < 1 || limit > 20) {
    throw new ToolFailure("INVALID_ARGUMENTS", "query must be a bounded string and limit must be an integer from 1 through 20.");
  }
  return { query, limit };
}
function parseExecuteArguments(value) {
  if (!isRecord9(value)) {
    throw new ToolFailure("INVALID_ARGUMENTS", "Tool arguments must be an object.");
  }
  rejectUnknownKeys(value, new Set(["operation", "input"]));
  if (typeof value.operation !== "string" || !graphicsOperationCodes.includes(value.operation) || !isRecord9(value.input)) {
    throw new ToolFailure("INVALID_ARGUMENTS", "operation must be an exact Graphics operation code and input must be an object.");
  }
  return {
    operation: value.operation,
    input: value.input
  };
}
function assertBuiltInIcons(spec) {
  for (const shape of spec.shapes) {
    if ((shape.type === "rect" || shape.type === "ellipse") && shape.icon !== undefined && !Object.hasOwn(builtInIcons, shape.icon)) {
      throw new ToolFailure("UNKNOWN_ICON", `Shape ${safeFragment(shape.id)} requests unavailable built-in icon ${safeFragment(shape.icon)}.`);
    }
  }
}
function assertComplexityLimits(spec) {
  const edgeCount = spec.edges?.length ?? 0;
  if (spec.shapes.length > mcpMaximumShapes || edgeCount > mcpMaximumEdges) {
    throw new ToolFailure("COMPLEXITY_LIMIT", `Diagram may contain at most ${mcpMaximumShapes} shapes and ${mcpMaximumEdges} edges in MCP mode.`);
  }
}
function assertRawComplexityLimits(value) {
  if (!isRecord9(value))
    return;
  const shapeCount = Array.isArray(value.shapes) ? value.shapes.length : 0;
  const edgeCount = Array.isArray(value.edges) ? value.edges.length : 0;
  if (shapeCount > mcpMaximumShapes || edgeCount > mcpMaximumEdges) {
    throw new ToolFailure("COMPLEXITY_LIMIT", `Diagram may contain at most ${mcpMaximumShapes} shapes and ${mcpMaximumEdges} edges in MCP mode.`);
  }
}
function assertRenderLimits(spec, scale) {
  const scaledWidth = spec.canvas.width * scale;
  const scaledHeight = spec.canvas.height * scale;
  const pixels = Math.ceil(scaledWidth) * Math.ceil(scaledHeight);
  if (!Number.isFinite(pixels) || scaledWidth < 1 || scaledHeight < 1 || pixels > mcpMaximumRenderedPixels) {
    throw new ToolFailure("RENDER_LIMIT", `Scaled canvas must be at least 1 pixel on each axis and no more than ${mcpMaximumRenderedPixels.toLocaleString("en-US")} pixels total.`);
  }
}
function publicFinding(finding) {
  return {
    code: safeFragment(finding.code, 64),
    message: safeFragment(finding.message, 240),
    shapeIds: finding.shapeIds.slice(0, maximumShapeIdsPerFinding).map((shapeId2) => safeFragment(shapeId2, 120))
  };
}
function publicFindings(findings) {
  return findings.slice(0, mcpMaximumReturnedFindings).map(publicFinding);
}
function diagramSummary(spec, findingCount, returnedFindingCount) {
  return {
    shapeCount: spec.shapes.length,
    edgeCount: spec.edges?.length ?? 0,
    findingCount,
    returnedFindingCount,
    findingsTruncated: returnedFindingCount < findingCount
  };
}
function successResult(text, structuredContent) {
  return {
    content: [{ type: "text", text }],
    structuredContent
  };
}
function failureResult(error) {
  let code = "INTERNAL_ERROR";
  let message = "The tool failed safely.";
  let issues;
  if (error instanceof ToolFailure) {
    code = error.code;
    message = safeFragment(error.message, 320);
    issues = error.issues;
  } else if (error instanceof WorkspaceBoundaryError) {
    code = error.code;
    message = safeFragment(error.message, 320);
  } else if (error instanceof GraphicsCloudError) {
    code = error.code;
    message = safeFragment(error.message.replace(/^\[[A-Z_]+\]\s*/u, ""), 320);
  } else if (error instanceof GraphicsOperationError) {
    code = error.code;
    message = safeFragment(error.message.replace(/^\[[A-Z_]+\]\s*/u, ""), 320);
  } else if (error instanceof VectorizeError) {
    code = `VECTORIZE_${error.code.toUpperCase()}`;
    message = "Local vectorization failed safely.";
  } else if (error instanceof DiagramValidationError) {
    code = "INVALID_DIAGRAM";
    message = "Diagram source did not pass validation.";
    issues = safeIssues(error.issues);
  } else if (typeof error === "object" && error !== null && "issues" in error && Array.isArray(error.issues) && error.issues.every((issue) => typeof issue === "string")) {
    code = "INVALID_LAYOUT";
    message = "Diagram layout could not be resolved.";
    issues = safeIssues(error.issues);
  }
  const issueText = issues === undefined || issues.length === 0 ? "" : `
${issues.map((issue) => `- ${issue}`).join(`
`)}`;
  return {
    content: [{ type: "text", text: `[${code}] ${message}${issueText}` }],
    isError: true
  };
}
function portableDirectory(filePath) {
  const separator = filePath.lastIndexOf("/");
  return separator === -1 ? "." : filePath.slice(0, separator);
}
async function atomicOverwrite(filePath, data) {
  const temporaryPath = join7(dirname8(filePath), `.${crypto.randomUUID()}.graphics-mcp.tmp`);
  try {
    await writeFile4(temporaryPath, data, { flag: "wx" });
    try {
      await rename5(temporaryPath, filePath);
    } catch (error) {
      const code = typeof error === "object" && error !== null && "code" in error && typeof error.code === "string" ? error.code : undefined;
      if (code !== "EEXIST" && code !== "EPERM")
        throw error;
      await rm6(filePath, { force: true });
      await rename5(temporaryPath, filePath);
    }
  } finally {
    await rm6(temporaryPath, { force: true });
  }
}
async function loadDiagram(boundary, path) {
  const source = await boundary.readSource(path);
  let parsed;
  try {
    parsed = JSON.parse(source.text);
  } catch {
    throw new ToolFailure("INVALID_JSON", "Diagram source is not valid JSON.");
  }
  assertRawComplexityLimits(parsed);
  const spec = parseDiagramSpec(parsed);
  assertComplexityLimits(spec);
  assertBuiltInIcons(spec);
  return { source, spec };
}

class GraphicsMcpToolRuntime {
  boundary;
  authDependencies;
  renderQueue = Promise.resolve();
  constructor(boundary, authDependencies) {
    this.boundary = boundary;
    this.authDependencies = authDependencies;
  }
  static async create(rootDirectory, authDependencies = {}) {
    return new GraphicsMcpToolRuntime(await WorkspaceBoundary.create(rootDirectory), authDependencies);
  }
  enqueueRender(operation) {
    const result = this.renderQueue.then(operation, operation);
    this.renderQueue = result.then(() => {
      return;
    }, () => {
      return;
    });
    return result;
  }
  async call(name, argumentsValue) {
    try {
      if (name === "check_diagram") {
        const options = parseCheckArguments(argumentsValue);
        return await this.check(options);
      }
      if (name === "render_diagram") {
        const options = parseRenderArguments(argumentsValue);
        return await this.enqueueRender(() => this.render(options));
      }
      if (name === "search_graphics") {
        const options = parseSearchArguments(argumentsValue);
        const operations = searchGraphicsOperations(options.query, options.limit);
        return successResult(`Found ${operations.length} Graphics operation${operations.length === 1 ? "" : "s"}.`, { ok: true, operations });
      }
      if (name === "execute_graphics") {
        const options = parseExecuteArguments(argumentsValue);
        return await this.execute(options);
      }
      throw new ToolFailure("UNKNOWN_TOOL", "Requested tool is not available.");
    } catch (error) {
      return failureResult(error);
    }
  }
  wrapSemanticResult(operation, result) {
    if (result.isError === true)
      return result;
    return {
      content: result.content,
      structuredContent: {
        ok: true,
        operation,
        result: result.structuredContent ?? {}
      }
    };
  }
  async execute(options) {
    if (options.operation === "graphics.diagram.check") {
      const input2 = parseGraphicsOperationInput(options.operation, options.input);
      return this.wrapSemanticResult(options.operation, await this.check({ path: input2.path }));
    }
    if (options.operation === "graphics.diagram.render") {
      const input2 = parseGraphicsOperationInput(options.operation, options.input);
      return this.enqueueRender(async () => this.wrapSemanticResult(options.operation, await this.render({
        path: input2.path,
        ...input2.outDirectory === undefined ? {} : { outDirectory: input2.outDirectory },
        scale: input2.scale ?? defaultScale
      })));
    }
    if (options.operation === "graphics.image.vectorize") {
      const input2 = parseGraphicsOperationInput(options.operation, options.input);
      return this.enqueueRender(async () => {
        const source = await this.boundary.resolveInputFile(input2.inputPath, vectorizeHardLimits.maxInputBytes);
        await requireGraphicsAuthentication(this.authDependencies);
        const output2 = await this.boundary.prepareOutputFile(input2.outputPath);
        const result = await vectorizeImage(source.absolutePath, {
          outputPath: output2.absolutePath,
          ...input2.duotone === undefined ? {} : { duotone: input2.duotone },
          ...input2.alphaCutoff === undefined ? {} : { alphaCutoff: input2.alphaCutoff },
          ...input2.timeoutMs === undefined ? {} : { limits: { maxDurationMs: input2.timeoutMs } }
        });
        return successResult(`Executed ${options.operation}: ${output2.relativePath}`, {
          ok: true,
          operation: options.operation,
          result: {
            inputPath: source.relativePath,
            outputPath: output2.relativePath,
            receipt: result.receipt
          }
        });
      });
    }
    const input = parseGraphicsOperationInput(options.operation, options.input);
    const discovery = await requireGraphicsAuthentication(this.authDependencies);
    const output = await this.boundary.prepareOutputFile(input.outputPath);
    const generated = await generateGraphicsImageFile({ ...input, outputPath: output.absolutePath }, { ...this.authDependencies, discovery });
    return successResult(`Executed ${options.operation}: ${output.relativePath} (request ${safeFragment(generated.requestId, 256)}).`, {
      ok: true,
      operation: options.operation,
      result: {
        bytes: generated.bytes,
        idempotencyKey: generated.idempotencyKey,
        mediaType: generated.mediaType,
        model: generated.model,
        outputPath: output.relativePath,
        requestId: generated.requestId
      }
    });
  }
  async check(options) {
    const { source, spec } = await loadDiagram(this.boundary, options.path);
    const allFindings = lintDiagram(spec);
    const findings = publicFindings(allFindings);
    const summary = diagramSummary(spec, allFindings.length, findings.length);
    const text = allFindings.length === 0 ? `Checked ${source.relativePath}: no findings.` : `Checked ${source.relativePath}: ${allFindings.length} finding${allFindings.length === 1 ? "" : "s"}; ${findings.length} returned in structured content${findings.length < allFindings.length ? " (truncated)" : ""}.`;
    return successResult(text, {
      ok: true,
      source: source.relativePath,
      findings,
      summary
    });
  }
  async render(options) {
    const { source, spec } = await loadDiagram(this.boundary, options.path);
    assertRenderLimits(spec, options.scale);
    const outputDirectory = await this.boundary.prepareOutputDirectory(options.outDirectory ?? portableDirectory(source.relativePath));
    const tldr = serializeTldr(spec, builtInConfig);
    const [light, dark] = await Promise.all([
      renderSvg(spec, "light", builtInConfig),
      renderSvg(spec, "dark", builtInConfig)
    ]);
    const lightPng = renderPng(light, builtInConfig, options.scale);
    const darkPng = renderPng(dark, builtInConfig, options.scale);
    const absoluteArtifacts = {
      spec: source.absolutePath,
      tldr: join7(outputDirectory.absolutePath, `${spec.name}.tldr`),
      lightSvg: join7(outputDirectory.absolutePath, `${spec.name}.light.svg`),
      darkSvg: join7(outputDirectory.absolutePath, `${spec.name}.dark.svg`),
      lightPng: join7(outputDirectory.absolutePath, `${spec.name}.light.png`),
      darkPng: join7(outputDirectory.absolutePath, `${spec.name}.dark.png`)
    };
    await Promise.all([
      atomicOverwrite(absoluteArtifacts.tldr, tldr),
      atomicOverwrite(absoluteArtifacts.lightSvg, light.svg),
      atomicOverwrite(absoluteArtifacts.darkSvg, dark.svg),
      atomicOverwrite(absoluteArtifacts.lightPng, lightPng),
      atomicOverwrite(absoluteArtifacts.darkPng, darkPng)
    ]);
    const artifacts = {
      tldr: this.boundary.toRelativePath(absoluteArtifacts.tldr),
      lightSvg: this.boundary.toRelativePath(absoluteArtifacts.lightSvg),
      darkSvg: this.boundary.toRelativePath(absoluteArtifacts.darkSvg),
      lightPng: this.boundary.toRelativePath(absoluteArtifacts.lightPng),
      darkPng: this.boundary.toRelativePath(absoluteArtifacts.darkPng)
    };
    const allFindings = lintDiagram(spec);
    const findings = publicFindings(allFindings);
    const summary = diagramSummary(spec, allFindings.length, findings.length);
    const text = [
      `Rendered ${source.relativePath} with built-in assets:`,
      ...Object.values(artifacts).map((artifact) => `- ${artifact}`)
    ].join(`
`);
    return successResult(text, {
      ok: true,
      source: source.relativePath,
      scale: options.scale,
      findings,
      artifacts,
      summary
    });
  }
}

// src/mcp/server.ts
var graphicsMcpProtocolVersion = "2025-11-25";
var graphicsMcpServerName = "hraness-graphics";
var maximumMessageBytes = 1024 * 1024;
function isRecord10(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function isJsonRpcId(value) {
  return typeof value === "string" || typeof value === "number" && Number.isSafeInteger(value);
}
function isInitializeParams(value) {
  return isRecord10(value) && typeof value.protocolVersion === "string" && isRecord10(value.capabilities) && isRecord10(value.clientInfo) && typeof value.clientInfo.name === "string" && typeof value.clientInfo.version === "string";
}
function parseRequest(value) {
  if (!isRecord10(value) || value.jsonrpc !== "2.0" || typeof value.method !== "string" || value.method.length === 0 || "id" in value && !isJsonRpcId(value.id)) {
    throw new Error("invalid request");
  }
  return {
    jsonrpc: "2.0",
    ..."id" in value ? { id: value.id } : {},
    method: value.method,
    ..."params" in value ? { params: value.params } : {}
  };
}
function success(id, result) {
  return { jsonrpc: "2.0", id, result };
}
function failure(id, code, message) {
  return { jsonrpc: "2.0", id, error: { code, message } };
}
function parseToolCall(params) {
  if (!isRecord10(params) || typeof params.name !== "string" || params.arguments !== undefined && !isRecord10(params.arguments)) {
    throw new Error("invalid params");
  }
  const unknownKeys = Object.keys(params).filter((key) => key !== "name" && key !== "arguments");
  if (unknownKeys.length > 0)
    throw new Error("invalid params");
  return {
    name: params.name,
    argumentsValue: params.arguments ?? {}
  };
}

class GraphicsMcpSession {
  runtime;
  serverVersion;
  state = "new";
  constructor(runtime, serverVersion) {
    this.runtime = runtime;
    this.serverVersion = serverVersion;
  }
  async handle(value) {
    let request;
    try {
      request = parseRequest(value);
    } catch {
      return failure(null, -32600, "Invalid Request");
    }
    const notification = request.id === undefined;
    if (request.method === "notifications/initialized") {
      if (!notification) {
        return failure(request.id, -32600, "Invalid Request");
      }
      if (this.state === "initializing")
        this.state = "ready";
      return null;
    }
    if (notification)
      return null;
    const id = request.id;
    if (request.method === "initialize") {
      if (this.state !== "new" || !isInitializeParams(request.params)) {
        return failure(id, -32602, "Invalid initialize parameters");
      }
      this.state = "initializing";
      return success(id, {
        protocolVersion: graphicsMcpProtocolVersion,
        capabilities: {
          tools: { listChanged: false }
        },
        serverInfo: {
          name: graphicsMcpServerName,
          version: this.serverVersion
        },
        instructions: "Use the compatibility check_diagram/render_diagram tools or search_graphics followed by execute_graphics with an exact registry code and typed JSON. Local paths are root-relative; source code is never accepted or evaluated."
      });
    }
    if (this.state !== "ready") {
      return failure(id, -32002, "Server is not initialized");
    }
    if (request.method === "ping")
      return success(id, {});
    if (request.method === "tools/list") {
      if (request.params !== undefined && (!isRecord10(request.params) || Object.keys(request.params).length > 0)) {
        return failure(id, -32602, "Invalid tools/list parameters");
      }
      return success(id, { tools: graphicsMcpTools });
    }
    if (request.method === "tools/call") {
      try {
        const toolCall = parseToolCall(request.params);
        if (!graphicsMcpTools.some((tool) => tool.name === toolCall.name)) {
          return failure(id, -32602, "Unknown tool");
        }
        return success(id, await this.runtime.call(toolCall.name, toolCall.argumentsValue));
      } catch {
        return failure(id, -32602, "Invalid tools/call parameters");
      }
    }
    return failure(id, -32601, "Method not found");
  }
}
async function defaultWriteLine(line) {
  await new Promise((resolve7, reject) => {
    process.stdout.write(`${line}
`, (error) => {
      if (error === null || error === undefined)
        resolve7();
      else
        reject(error);
    });
  });
}
function defaultInput() {
  return process.stdin;
}
async function emitResponse(writeLine, response) {
  await writeLine(JSON.stringify(response));
}
async function processLine(line, session, writeLine) {
  if (line.byteLength === 0)
    return;
  let value;
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(line);
    if (text.trim() === "")
      return;
    value = JSON.parse(text);
  } catch {
    await emitResponse(writeLine, failure(null, -32700, "Parse error"));
    return;
  }
  if (Array.isArray(value)) {
    await emitResponse(writeLine, failure(null, -32600, "Invalid Request"));
    return;
  }
  const response = await session.handle(value);
  if (response !== null)
    await emitResponse(writeLine, response);
}
async function runMcpServer(options = {}) {
  const runtime = await GraphicsMcpToolRuntime.create(options.rootDirectory ?? process.cwd(), options.authDependencies);
  const session = new GraphicsMcpSession(runtime, options.serverVersion ?? "0.4.0");
  const writeLine = options.writeLine ?? defaultWriteLine;
  let buffered = Buffer.alloc(0);
  for await (const chunk of options.input ?? defaultInput()) {
    const bytes = typeof chunk === "string" ? Buffer.from(chunk, "utf8") : Buffer.from(chunk);
    buffered = Buffer.concat([buffered, bytes]);
    if (buffered.byteLength > maximumMessageBytes && !buffered.includes(10)) {
      buffered = Buffer.alloc(0);
      await emitResponse(writeLine, failure(null, -32700, "Parse error"));
      continue;
    }
    for (;; ) {
      const newline = buffered.indexOf(10);
      if (newline === -1)
        break;
      let line = buffered.subarray(0, newline);
      buffered = buffered.subarray(newline + 1);
      if (line.at(-1) === 13)
        line = line.subarray(0, -1);
      if (line.byteLength > maximumMessageBytes) {
        await emitResponse(writeLine, failure(null, -32700, "Parse error"));
      } else {
        await processLine(line, session, writeLine);
      }
    }
  }
  if (buffered.byteLength > 0) {
    if (buffered.byteLength > maximumMessageBytes) {
      await emitResponse(writeLine, failure(null, -32700, "Parse error"));
    } else {
      await processLine(buffered, session, writeLine);
    }
  }
}
// src/skill-install.ts
import { cp, mkdir as mkdir6, rm as rm7 } from "fs/promises";
import { homedir as homedir3 } from "os";
import { dirname as dirname9, join as join8, resolve as resolve7 } from "path";
import { fileURLToPath as fileURLToPath2 } from "url";
function bundledSkillPath() {
  return resolve7(dirname9(fileURLToPath2(import.meta.url)), "../skills/graphics");
}
function targetRoot(target, scope, projectDirectory) {
  const directory = target === "codex" ? ".codex" : target === "claude" ? ".claude" : ".agents";
  return scope === "user" ? join8(homedir3(), directory, "skills") : join8(projectDirectory, directory, "skills");
}
async function installSkill(options) {
  const source = bundledSkillPath();
  if (!await pathExists(source))
    throw new Error(`Bundled skill is missing: ${source}`);
  const root = targetRoot(options.target, options.scope, resolve7(options.projectDirectory ?? process.cwd()));
  const legacy = join8(root, "diagram");
  if (await pathExists(legacy)) {
    throw new Error(`Legacy diagram skill found at ${legacy}. Remove or move that directory, then rerun "graphics skill install --target ${options.target} --scope ${options.scope}". Graphics will not install both skills side by side.`);
  }
  const destination = join8(root, "graphics");
  if (await pathExists(destination)) {
    if (!options.force) {
      throw new Error(`Skill already exists at ${destination}; pass --force to replace it`);
    }
    await rm7(destination, { recursive: true, force: true });
  }
  await mkdir6(dirname9(destination), { recursive: true });
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
  executeGraphicsOperation
});
export {
  vtracerReleases,
  vectorizeProfileNames,
  vectorizeImage,
  vectorizeHardLimits,
  vectorizeDefaultLimits,
  validateGraphicsIdempotencyKey,
  stackLayoutDefaults,
  serializeTldr,
  selectDesktopAsset,
  searchGraphicsOperations,
  runMcpServer,
  resolveStackLayout,
  resolveEdge,
  resolveDiagramSource,
  requireGraphicsAuthentication,
  renderSvg,
  renderPng,
  renderDiagramFile,
  readDiagramFile,
  readBoundedResponseBytes,
  readBoundedJson,
  parseGraphicsOperationInput,
  parseGraphicsDiscovery,
  parseDiagramSpec,
  parseDiagramSource,
  openInDesktop,
  mcpSourceByteLimit,
  mcpMaximumScale,
  mcpMaximumRenderedPixels,
  logoutGraphics,
  loginGraphics,
  lintDiagram,
  isGraphicsOperationCode,
  installSkill,
  installDesktop,
  graphicsSecretsService,
  graphicsSecretsName,
  graphicsResponseMediaTypes,
  graphicsRedirectUri,
  graphicsProductionContract,
  graphicsOperationRegistry,
  graphicsOperationCodes,
  graphicsMcpTools,
  graphicsMcpServerName,
  graphicsMcpProtocolVersion,
  graphicsMaximumRawImageBytes,
  graphicsMaximumPromptBytes,
  graphicsImageModels,
  graphicsImageGenerationQuota,
  graphicsDiscoveryUrl,
  graphicsDiscoveryMaximumBytes,
  graphicsAuthStatus,
  getLatestDesktopRelease,
  getGraphicsAccessToken,
  generateGraphicsImageFile,
  generateGraphicsImage,
  findDesktopApplication,
  fetchGraphicsDiscovery,
  executeGraphicsOperation,
  diagramApi,
  desktopStatus,
  desktopDownloadPage,
  createPkcePair,
  checkDiagramFile,
  bundledSkillPath,
  builtInIcons,
  buildGraphicsAuthorizationUrl,
  artifactSummary,
  WorkspaceBoundaryError,
  WorkspaceBoundary,
  VectorizeError,
  VTRACER_VERSION,
  StackLayoutError,
  GraphicsOperationError,
  GraphicsMcpToolRuntime,
  GraphicsCloudError,
  DiagramValidationError
};
