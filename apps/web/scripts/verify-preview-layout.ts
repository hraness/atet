#!/usr/bin/env bun

import { constants } from "node:fs"
import { access, mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join, resolve, sep } from "node:path"
import { fileURLToPath } from "node:url"

const appDirectory = dirname(dirname(fileURLToPath(import.meta.url)))
const outputDirectory = join(appDirectory, "dist")
const viewport = Object.freeze({ height: 180, width: 320 })
const chromeTimeoutMs = 30_000

interface PreviewLayoutEvidence {
  readonly bodyScrollWidth: number
  readonly devicePixelRatio: number
  readonly documentClientHeight: number
  readonly documentClientWidth: number
  readonly documentScrollHeight: number
  readonly documentScrollWidth: number
  readonly finalNoteBottom: number
  readonly finalNoteTop: number
  readonly horizontalFailures: readonly string[]
  readonly maxScrollY: number
  readonly reachedScrollY: number
  readonly verticalFailures: readonly string[]
  readonly viewportHeight: number
  readonly viewportWidth: number
}

const measurementScript = String.raw`<script>
(() => {
  const evidenceTarget = window.parent === window
    ? document.body
    : window.parent.document.body;
  const recordError = (error) => {
    evidenceTarget.dataset.previewLayoutError = encodeURIComponent(String(error?.stack || error));
  };
  const measure = () => {
    if (document.fonts.status !== "loaded") {
      throw new Error("Preview fonts did not finish loading");
    }
    const root = document.documentElement;
    const body = document.body;
    root.style.scrollBehavior = "auto";
    body.style.scrollBehavior = "auto";

    const horizontalTargets = [
      ...document.querySelectorAll(".preview-shell, .preview-shell *"),
    ];
    const verticalTargets = horizontalTargets.filter((element) =>
      !element.classList.contains("preview-shell")
      && element.closest('[aria-hidden="true"]') === null);
    const label = (element, index) =>
      element.id || [...element.classList].join(".") || element.tagName.toLowerCase() + "-" + index;
    const horizontalFailures = [];
    const viewportWidth = root.clientWidth;

    if (root.scrollWidth > viewportWidth + 1) {
      horizontalFailures.push("document scroll width exceeds its client width");
    }
    if (body.scrollWidth > viewportWidth + 1) {
      horizontalFailures.push("body scroll width exceeds the document client width");
    }
    horizontalTargets.forEach((element, index) => {
      const rect = element.getBoundingClientRect();
      const name = label(element, index);
      if (rect.width <= 0 || rect.height <= 0) {
        horizontalFailures.push(name + " is not rendered");
      }
      if (rect.left < -0.5 || rect.right > viewportWidth + 0.5) {
        horizontalFailures.push(name + " leaves the horizontal viewport");
      }
      const overflowX = getComputedStyle(element).overflowX;
      if (
        element.scrollWidth > element.clientWidth + 1
        && (overflowX !== "visible" || rect.left + element.scrollWidth > viewportWidth + 0.5)
      ) {
        horizontalFailures.push(name + " clips its own horizontal content");
      }
    });

    const maxScrollY = Math.max(0, root.scrollHeight - root.clientHeight);
    const verticalFailures = [];
    for (const [index, element] of verticalTargets.entries()) {
      const initialRect = element.getBoundingClientRect();
      const absoluteTop = initialRect.top + window.scrollY;
      const targetScrollY = Math.min(
        maxScrollY,
        Math.max(0, absoluteTop - (root.clientHeight - initialRect.height) / 2),
      );
      window.scrollTo(0, targetScrollY);
      const rect = element.getBoundingClientRect();
      if (rect.top < -0.5 || rect.bottom > root.clientHeight + 0.5) {
        verticalFailures.push(label(element, index) + " cannot be fully reached by vertical scrolling");
      }
    }

    window.scrollTo(0, maxScrollY);
    const finalNote = document.querySelector(".preview-note").getBoundingClientRect();
    const result = {
      bodyScrollWidth: body.scrollWidth,
      devicePixelRatio: window.devicePixelRatio,
      documentClientHeight: root.clientHeight,
      documentClientWidth: root.clientWidth,
      documentScrollHeight: root.scrollHeight,
      documentScrollWidth: root.scrollWidth,
      finalNoteBottom: finalNote.bottom,
      finalNoteTop: finalNote.top,
      horizontalFailures,
      maxScrollY,
      reachedScrollY: window.scrollY,
      verticalFailures,
      viewportHeight: window.innerHeight,
      viewportWidth: window.innerWidth,
    };
    evidenceTarget.dataset.previewLayout = encodeURIComponent(JSON.stringify(result));
  };

  document.fonts.ready.then(measure).catch(recordError);
})();
</script>`

async function findChrome(): Promise<string> {
  const candidates = [
    process.env.ATET_CHROME_PATH,
    process.env.CHROME_PATH,
    "/usr/bin/google-chrome",
    "/usr/bin/google-chrome-stable",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  ].filter((candidate): candidate is string => candidate !== undefined && candidate !== "")

  for (const candidate of candidates) {
    try {
      await access(candidate, constants.X_OK)
      return candidate
    } catch {
      // Continue to the next explicit executable candidate.
    }
  }
  throw new Error("Chrome is required for the preview layout check; set ATET_CHROME_PATH")
}

function instrumentPreview(html: string): string {
  if (!html.includes("</body>")) {
    throw new Error("Built preview is missing its closing body tag")
  }
  return html.replace("</body>", `${measurementScript}</body>`)
}

function decodeEvidence(document: string): PreviewLayoutEvidence {
  const error = /data-preview-layout-error="([^"]+)"/u.exec(document)?.[1]
  if (error !== undefined) {
    throw new Error(`Preview layout measurement failed: ${decodeURIComponent(error)}`)
  }
  const encoded = /data-preview-layout="([^"]+)"/u.exec(document)?.[1]
  if (encoded === undefined) {
    throw new Error("Chrome exited without preview layout evidence")
  }
  return JSON.parse(decodeURIComponent(encoded)) as PreviewLayoutEvidence
}

function assertEvidence(evidence: PreviewLayoutEvidence): void {
  const failures = [
    ...evidence.horizontalFailures,
    ...evidence.verticalFailures,
  ]
  if (evidence.viewportWidth !== viewport.width || evidence.viewportHeight !== viewport.height) {
    failures.push(
      `expected a ${viewport.width}x${viewport.height} CSS viewport, received ${evidence.viewportWidth}x${evidence.viewportHeight}`,
    )
  }
  if (Math.abs(evidence.devicePixelRatio - 2) > 0.01) {
    failures.push(`expected a 2x device scale, received ${evidence.devicePixelRatio}`)
  }
  if (evidence.maxScrollY <= 0) {
    failures.push("short viewport did not require vertical scrolling")
  }
  if (evidence.reachedScrollY < evidence.maxScrollY - 1) {
    failures.push(`vertical scroll stopped at ${evidence.reachedScrollY} of ${evidence.maxScrollY}`)
  }
  if (
    evidence.finalNoteTop < -0.5
    || evidence.finalNoteBottom > evidence.documentClientHeight + 0.5
  ) {
    failures.push("final preview content is not fully visible at the bottom scroll boundary")
  }
  if (failures.length > 0) {
    throw new Error(`Preview layout check failed:\n- ${failures.join("\n- ")}`)
  }
}

const profileDirectory = await mkdtemp(join(tmpdir(), "atet-preview-layout-"))
const preview = instrumentPreview(await readFile(join(outputDirectory, "preview.html"), "utf8"))
const harness = `<!doctype html>
<html lang="en">
  <head><meta charset="utf-8"><title>Atet preview layout harness</title></head>
  <body style="margin:0">
    <iframe src="/preview" title="Atet preview" style="width:${viewport.width}px;height:${viewport.height}px;border:0"></iframe>
  </body>
</html>`
const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  async fetch(request) {
    const url = new URL(request.url)
    if (url.pathname === "/harness") {
      return new Response(harness, {
        headers: { "Content-Type": "text/html; charset=utf-8" },
      })
    }
    if (url.pathname === "/preview" || url.pathname === "/preview.html") {
      return new Response(preview, {
        headers: { "Content-Type": "text/html; charset=utf-8" },
      })
    }

    const candidate = resolve(outputDirectory, `.${decodeURIComponent(url.pathname)}`)
    if (
      candidate === outputDirectory
      || !candidate.startsWith(`${outputDirectory}${sep}`)
    ) {
      return new Response("Not Found", { status: 404 })
    }
    const file = Bun.file(candidate)
    if (!await file.exists()) {
      return new Response("Not Found", { status: 404 })
    }
    return new Response(file)
  },
})

try {
  const chrome = await findChrome()
  const browser = Bun.spawn([
    chrome,
    "--headless=new",
    "--no-sandbox",
    "--disable-background-networking",
    "--disable-component-update",
    "--disable-default-apps",
    "--disable-extensions",
    "--disable-gpu",
    "--disable-sync",
    "--force-color-profile=srgb",
    "--force-device-scale-factor=2",
    "--metrics-recording-only",
    "--mute-audio",
    "--no-first-run",
    "--run-all-compositor-stages-before-draw",
    `--user-data-dir=${profileDirectory}`,
    "--virtual-time-budget=5000",
    "--window-size=800,600",
    "--dump-dom",
    new URL("/harness", server.url).href,
  ], {
    stderr: "pipe",
    stdout: "pipe",
  })
  const stdoutPromise = new Response(browser.stdout).text()
  const stderrPromise = new Response(browser.stderr).text()
  const timeout = setTimeout(() => browser.kill(), chromeTimeoutMs)
  const exitCode = await browser.exited
  clearTimeout(timeout)
  const [document, diagnostic] = await Promise.all([stdoutPromise, stderrPromise])
  if (exitCode !== 0) {
    throw new Error(`Chrome exited ${exitCode}: ${diagnostic.trim()}`)
  }
  const evidence = decodeEvidence(document)
  assertEvidence(evidence)
  console.log(JSON.stringify(evidence))
} finally {
  await server.stop(true)
  await rm(profileDirectory, { force: true, recursive: true })
}
