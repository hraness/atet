#!/usr/bin/env bun
/**
 * Compose one rubber-stamp travel field-note poster.
 *
 * Left ~58%: the source photograph (cover-cropped, never redrawn).
 * Right ~42%: warm paper + a generated stamp vignette + typewriter text.
 *
 * Usage:
 *   bun skills/atet/scripts/compose-rubber-stamp-field-note.ts \
 *     --photo /abs/photo.jpg \
 *     --stamp /abs/stamp.png \
 *     --output /abs/out.jpg \
 *     --place "VENICE" \
 *     --number "01" \
 *     --keywords "brick / bell / lagoon" \
 *     --year "2026"
 */
import { mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import sharp from "sharp";

type Args = {
  photo: string;
  stamp: string;
  output: string;
  place: string;
  number: string;
  keywords: string;
  year: string;
  width: number;
  height: number;
  leftRatio: number;
};

function usage(): never {
  console.error(`usage: compose-rubber-stamp-field-note.ts \\
  --photo <path> --stamp <path> --output <path> \\
  --place <NAME> --number <NN> --keywords "a / b / c" --year <YYYY> \\
  [--width 1600] [--height 1200] [--left-ratio 0.58]`);
  process.exit(64);
}

function readArgs(argv: string[]): Args {
  const get = (name: string): string | undefined => {
    const index = argv.indexOf(name);
    if (index < 0) return undefined;
    return argv[index + 1];
  };
  const photo = get("--photo");
  const stamp = get("--stamp");
  const output = get("--output");
  const place = get("--place");
  const number = get("--number");
  const keywords = get("--keywords");
  const year = get("--year");
  if (!photo || !stamp || !output || !place || !number || !keywords || !year) usage();
  return {
    photo: resolve(photo),
    stamp: resolve(stamp),
    output: resolve(output),
    place: place.trim().toUpperCase(),
    number: number.trim().replace(/^No\.?\s*/i, ""),
    keywords: keywords.trim().toLowerCase(),
    year: year.trim(),
    width: Number(get("--width") ?? "1600"),
    height: Number(get("--height") ?? "1200"),
    leftRatio: Number(get("--left-ratio") ?? "0.58"),
  };
}

function escapeXml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

async function paperPanel(width: number, height: number): Promise<Buffer> {
  // Warm off-white base with soft fiber noise.
  const noise = await sharp({
    create: {
      width,
      height,
      channels: 3,
      background: { r: 236, g: 228, b: 210 },
    },
  })
    .png()
    .toBuffer();

  const grainSvg = Buffer.from(`<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">
  <filter id="grain">
    <feTurbulence type="fractalNoise" baseFrequency="0.85" numOctaves="2" stitchTiles="stitch"/>
    <feColorMatrix type="matrix" values="0 0 0 0 0.72  0 0 0 0 0.68  0 0 0 0 0.58  0 0 0 0.12 0"/>
  </filter>
  <rect width="100%" height="100%" fill="#ece4d2"/>
  <rect width="100%" height="100%" filter="url(#grain)"/>
</svg>`);

  return sharp(noise)
    .composite([{ input: grainSvg, blend: "multiply" }])
    .jpeg({ quality: 95 })
    .toBuffer()
    .then((jpeg) => sharp(jpeg).png().toBuffer());
}

async function textPanel(
  width: number,
  height: number,
  args: Args,
): Promise<Buffer> {
  const font = "/usr/share/fonts/truetype/dejavu/DejaVuSansMono.ttf";
  const lines = [
    args.place,
    `No. ${args.number}`,
    args.keywords,
    args.year,
  ];
  const fontSize = Math.max(18, Math.round(width * 0.055));
  const lineGap = Math.round(fontSize * 1.35);
  const startY = Math.round(fontSize * 1.1);
  const textSvg = Buffer.from(`<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">
  <style>
    .t {
      font-family: "DejaVu Sans Mono", monospace;
      font-size: ${fontSize}px;
      fill: #1a1a1a;
      letter-spacing: 0.5px;
    }
  </style>
  ${lines
    .map(
      (line, index) =>
        `<text class="t" x="0" y="${startY + index * lineGap}">${escapeXml(line)}</text>`,
    )
    .join("\n  ")}
</svg>`);
  return sharp(textSvg).png().toBuffer();
}

async function main(): Promise<void> {
  const args = readArgs(process.argv.slice(2));
  if (
    !Number.isFinite(args.width)
    || !Number.isFinite(args.height)
    || args.width < 640
    || args.height < 480
    || args.leftRatio <= 0.4
    || args.leftRatio >= 0.7
  ) {
    throw new Error("invalid canvas size or left ratio");
  }

  const leftWidth = Math.round(args.width * args.leftRatio);
  const rightWidth = args.width - leftWidth;

  const photo = await sharp(args.photo)
    .rotate()
    .resize(leftWidth, args.height, { fit: "cover", position: "centre" })
    .modulate({ saturation: 0.92, brightness: 1.02 })
    .jpeg({ quality: 92 })
    .toBuffer();

  const paper = await paperPanel(rightWidth, args.height);

  const stampMaxWidth = Math.round(rightWidth * 0.78);
  const stampMaxHeight = Math.round(args.height * 0.36);
  const stamp = await sharp(args.stamp)
    .ensureAlpha()
    .resize(stampMaxWidth, stampMaxHeight, {
      fit: "inside",
      withoutEnlargement: false,
    })
    .png()
    .toBuffer();
  const stampMeta = await sharp(stamp).metadata();
  const stampW = stampMeta.width ?? stampMaxWidth;
  const stampH = stampMeta.height ?? stampMaxHeight;

  const stampLeft = Math.round((rightWidth - stampW) / 2);
  // Mid-lower placement with room for typewriter text under the stamp.
  const stampTop = Math.round(args.height * 0.34);

  const textWidth = Math.round(rightWidth * 0.78);
  const textHeight = Math.round(args.height * 0.22);
  const text = await textPanel(textWidth, textHeight, args);
  const textLeft = Math.round((rightWidth - textWidth) / 2);
  const textTop = stampTop + stampH + Math.round(args.height * 0.04);

  const right = await sharp(paper)
    .composite([
      { input: stamp, left: stampLeft, top: stampTop },
      { input: text, left: textLeft, top: textTop },
    ])
    .png()
    .toBuffer();

  await mkdir(dirname(args.output), { recursive: true });
  await sharp({
    create: {
      width: args.width,
      height: args.height,
      channels: 3,
      background: { r: 236, g: 228, b: 210 },
    },
  })
    .composite([
      { input: photo, left: 0, top: 0 },
      { input: right, left: leftWidth, top: 0 },
    ])
    .jpeg({ quality: 94, mozjpeg: true })
    .toFile(args.output);

  console.log(JSON.stringify({
    ok: true,
    output: args.output,
    width: args.width,
    height: args.height,
    leftWidth,
    rightWidth,
    place: args.place,
    number: args.number,
  }));
}

await main();
