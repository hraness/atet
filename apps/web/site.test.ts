import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test"
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

import {
  HRANESS_HOME_URL,
  hranessSocialLinks,
} from "@hraness/site-footer"

import {
  isCanonicalAnalyticsPage,
  posthogCookielessDistinctId,
  sanitizePageview,
} from "./src/analytics-contract"
import {
  homeMarkdown,
  llmsTxt,
  notFoundMarkdown,
  robotsTxt,
  sitemapMarkdown,
} from "./src/agent-pages"
import {
  notAcceptableBody,
  preferredRepresentation,
  preferredRepresentationFrom,
} from "./src/negotiate"
import {
  isHomePath,
  isNegotiableDocumentPath,
  isPreservedRedirectPath,
  isPreviewPath,
  negotiateSiteRequest,
} from "./src/negotiate-request"
import middleware, { config as middlewareConfig } from "./middleware"
import { buildWebsite, renderAskAiAboutThis, renderSitemapXml } from "./scripts/build"
import { renderAtetSocialImage } from "./scripts/generate-og"
import { parsePublishedRelease, publishedArchiveUrl, publishedRelease } from "./src/published-release"
import { replaceSiteSlot } from "./src/site-template"
const appDirectory = dirname(fileURLToPath(import.meta.url))
const repositoryDirectory = join(appDirectory, "..", "..")
const brandDescription = "Agentic creative coding toolkit. At the beginning of time, when there was nothing but chaos, Atum existed alone in the watery mass of Nun. A pyramid mound called Benben emerged. When the lotus flower bloomed, Atum dawned and became Ra. Every night Ra sails in the underworld on the solar barque Atet."
const searchDescription = "Atet gives coding agents tools to generate images, video, and voice, edit real footage, add motion graphics and captions, and export finished videos."
let builtAssets: Awaited<ReturnType<typeof buildWebsite>>

// Each build compiles the independent ordinary-site and preview graphs. These
// are compilation-fixture budgets, not deadlines for production operations or
// the ordinary content assertions below.
const compilationTimeoutMs = 60_000
const repeatedCompilationTimeoutMs = 2 * compilationTimeoutMs
type CompilationFixture = Readonly<{
  build: typeof buildWebsite
  temporaryDirectory: (prefix: string) => Promise<string>
}>
type CompilationOwner = Readonly<{ collect: () => Promise<void> }>
let compilationOwner: CompilationOwner | undefined

function ownedCompilation<T>(
  body: (fixture: CompilationFixture) => Promise<T>,
  compile: typeof buildWebsite = buildWebsite,
): Promise<T> {
  if (compilationOwner !== undefined) throw new Error("Previous compilation fixture has not settled")
  const controller = new AbortController()
  const directories = new Set<string>()
  let collection: Promise<void> | undefined
  // Register ownership before dispatch. Bun timing out a test does not cancel
  // its promise; collection revokes the next build and joins the whole callback
  // before removing any output directory or admitting another fixture.
  const task = Promise.resolve().then(() => {
    controller.signal.throwIfAborted()
    return body({
      build: async options => {
        controller.signal.throwIfAborted()
        const result = await compile(options)
        controller.signal.throwIfAborted()
        return result
      },
      temporaryDirectory: async prefix => {
        controller.signal.throwIfAborted()
        const directory = await mkdtemp(join(tmpdir(), prefix))
        directories.add(directory)
        controller.signal.throwIfAborted()
        return directory
      },
    })
  })
  // Observe rejection immediately, including the timeout-to-afterEach window.
  const settled = Promise.allSettled([task])
  const owner: CompilationOwner = {
    collect: () => {
      if (collection !== undefined) return collection
      controller.abort(new Error("Compilation fixture admission has ended"))
      collection = (async () => {
        await settled
        const cleanup = await Promise.allSettled([...directories].map(directory =>
          rm(directory, { force: true, recursive: true })))
        const failures = cleanup.filter(result => result.status === "rejected")
        if (failures.length !== 0) {
          throw new AggregateError(failures.map(result => result.reason), "Compilation fixture cleanup failed")
        }
        if (compilationOwner === owner) compilationOwner = undefined
      })()
      return collection
    },
  }
  compilationOwner = owner
  return task
}

async function collectCompilation(): Promise<void> {
  await compilationOwner?.collect()
}

beforeEach(() => {
  // A timed-out collection never releases ownership, even if Bun proceeds to
  // another case. Do not admit a new writer over its surviving continuation.
  if (compilationOwner !== undefined) throw new Error("Previous compilation fixture has not settled")
})
afterEach(collectCompilation, repeatedCompilationTimeoutMs)
afterAll(collectCompilation, repeatedCompilationTimeoutMs)

async function readSource(path: string): Promise<string> {
  return await readFile(join(appDirectory, "src", path), "utf8")
}

async function readBuilt(path: string): Promise<string> {
  return await readFile(join(appDirectory, "dist", path), "utf8")
}

function assertAuthoredShellBudget(template: string): number {
  let authored = replaceSiteSlot(template, "{{PUBLISHED_VERSION}}", publishedRelease.version, 6)
  authored = replaceSiteSlot(authored, "{{PUBLISHED_ARCHIVE_URL}}", publishedArchiveUrl, 1)
  authored = replaceSiteSlot(authored, "{{PUBLISHED_RELEASE_URL}}", publishedRelease.releaseUrl, 1)
  // Discount only the finite compiler-slot spelling, never authored classes or HTML.
  for (const [slot, count] of [
    ["{{SITE_SKIP_CLASS}}", 1], ["{{SITE_HEADER_CLASS}}", 1],
    ["{{SITE_WORDMARK_CLASS}}", 1], ["{{SITE_ACTIONS_CLASS}}", 1],
    ["{{SITE_NAVIGATION_CLASS}}", 1], ["{{SITE_HOME_NAVIGATION_LINK_CLASS}}", 4],
    ["{{SITE_NAVIGATION_ACTION_CLASS}}", 1],
  ] as const) authored = replaceSiteSlot(authored, slot, "", count)
  if (/\{\{SITE_[^{}]*_CLASS\}\}/u.test(authored)) throw new Error("Unexpected site class slot")
  const bytes = new TextEncoder().encode(authored).byteLength
  if (bytes >= 32_000) throw new Error(`Authored site shell exceeds its 32,000-byte budget: ${bytes}`)
  return bytes
}

test("authored shell budget rejects content growth and unapproved slot discounts without compilation", async () => {
  const template = await readSource("index.html")
  expect(assertAuthoredShellBudget(template)).toBeLessThan(32_000)
  expect(() => assertAuthoredShellBudget(template.replace("</main>", `${"x".repeat(32_000)}</main>`)))
    .toThrow("Authored site shell exceeds its 32,000-byte budget")
  expect(() => assertAuthoredShellBudget(`${template}{{SITE_UNKNOWN_CLASS}}`))
    .toThrow("Unexpected site class slot")
  expect(() => assertAuthoredShellBudget(`${template}{{SITE_SKIP_CLASS}}`))
    .toThrow("Site document must contain 1 instance(s) of {{SITE_SKIP_CLASS}}")
  for (const slot of ["PUBLISHED_ARCHIVE_URL", "PUBLISHED_RELEASE_URL"]) {
    expect(() => assertAuthoredShellBudget(`${template}{{${slot}}}`))
      .toThrow(`Site document must contain 1 instance(s) of {{${slot}}}`)
  }
})

describe("compilation fixture ownership (controlled promises, no compiler)", () => {
  test("collection before dispatch prevents any work from starting", async () => {
    let dispatched = false
    const task = ownedCompilation(async () => { dispatched = true })
    const collection = collectCompilation()
    await expect(task).rejects.toThrow("Compilation fixture admission has ended")
    await collection
    expect(dispatched).toBe(false)
    expect(compilationOwner).toBeUndefined()
  })

  test("late build completion is joined before cleanup and cannot start another build", async () => {
    let enter!: () => void
    let release!: () => void
    const entered = new Promise<void>(resolve => { enter = resolve })
    const released = new Promise<void>(resolve => { release = resolve })
    let directory = ""
    let builds = 0
    let reachedSecondBuild = false
    const task = ownedCompilation(async fixture => {
      directory = await fixture.temporaryDirectory("atet-web-owned-settlement-")
      await fixture.build({ outputDirectory: directory })
      reachedSecondBuild = true
      await fixture.build({ outputDirectory: directory })
    }, async () => {
      builds += 1
      enter()
      await released
      await writeFile(join(directory, "late-output.txt"), "settled before cleanup")
      return builtAssets
    })
    await entered
    let collected = false
    const collection = collectCompilation().then(() => { collected = true })
    try {
      expect(compilationOwner).toBeDefined()
      expect(() => ownedCompilation(async () => {})).toThrow("Previous compilation fixture has not settled")
      expect(await readdir(directory)).toEqual([])
      expect(collected).toBe(false)
    } finally {
      release()
      await expect(task).rejects.toThrow("Compilation fixture admission has ended")
      await collection
    }
    expect(builds).toBe(1)
    expect(reachedSecondBuild).toBe(false)
    expect(collected).toBe(true)
    expect(compilationOwner).toBeUndefined()
    await expect(readdir(directory)).rejects.toMatchObject({ code: "ENOENT" })
  })

  test("a rejected build retains its exact failure and outputs until collection", async () => {
    const failure = new Error("controlled compiler rejection")
    let directory = ""
    const task = ownedCompilation(async fixture => {
      directory = await fixture.temporaryDirectory("atet-web-owned-rejection-")
      await fixture.build({ outputDirectory: directory })
    }, async () => { throw failure })
    await expect(task).rejects.toBe(failure)
    expect(compilationOwner).toBeDefined()
    expect(await readdir(directory)).toEqual([])
    await collectCompilation()
    expect(compilationOwner).toBeUndefined()
    await expect(readdir(directory)).rejects.toMatchObject({ code: "ENOENT" })
    await ownedCompilation(async () => {})
    await collectCompilation()
  })
})

test("analytics preserves an optional timestamp without manufacturing an undefined field", () => {
  for (const timestamp of [undefined, new Date("2026-09-08T00:00:00.000Z")]) {
    const sanitized = sanitizePageview({
      event: "$pageview",
      properties: { token: "phc_testtoken", distinct_id: posthogCookielessDistinctId,
        $cookieless_mode: true, $raw_user_agent: "native test user agent" },
      uuid: "0198c6a7-7c00-7000-8000-000000000000",
      ...(timestamp === undefined ? {} : { timestamp }),
    }, "phc_testtoken")
    expect(sanitized).not.toBeNull()
    expect(Object.hasOwn(sanitized!, "timestamp")).toBe(timestamp !== undefined)
    expect(sanitized?.timestamp).toBe(timestamp)
  }
})

describe("static Atet site", () => {
  beforeAll(async () => {
    try {
      builtAssets = await ownedCompilation(fixture => fixture.build({ environment: {} }))
    } finally {
      await collectCompilation()
    }
  }, compilationTimeoutMs)

  test("published release separates public availability from the source candidate", async () => {
    expect(publishedRelease).toEqual({
      version: "3.2.3",
      releaseUrl: "https://github.com/hraness/atet/releases/tag/v3.2.3",
    })
    expect(Object.isFrozen(publishedRelease)).toBe(true)
    const template = await readSource("index.html")
    const html = await readBuilt("index.html")
    expect(template.match(/\{\{PUBLISHED_VERSION\}\}/gu)).toHaveLength(6)
    expect(template).not.toContain(publishedRelease.version)
    expect(html).not.toContain("{{PUBLISHED_VERSION}}")
    expect(html).not.toContain("{{PUBLISHED_ARCHIVE_URL}}")
    expect(html).not.toContain("{{PUBLISHED_RELEASE_URL}}")
    expect(publishedArchiveUrl).toBe("https://github.com/hraness/atet/releases/download/v3.2.3/hraness-atet-3.2.3.tgz")
    expect(html).toContain(`"softwareVersion": "${publishedRelease.version}"`)
    expect(html).toContain(`"version": "${publishedRelease.version}"`)
    expect(html).toContain(`Free and open source under the MIT license · v${publishedRelease.version}`)
    expect(html).toContain(`<small>Atet v${publishedRelease.version}</small>`)
    expect(html).toContain(`bun add --global ${publishedArchiveUrl}`)
    expect(homeMarkdown).toContain(`Version ${publishedRelease.version}.`)
    expect(homeMarkdown).toContain(`bun add --global ${publishedArchiveUrl}`)
    expect(await readBuilt("index.md")).toBe(homeMarkdown)
    for (const publicText of [html, homeMarkdown, llmsTxt]) {
      expect(publicText).not.toContain("3.2.2")
    }
  })

  test("published release validates exact fields and safe stable versions before rendering", () => {
    for (const version of ["0.0.0", "3.2.1", "9007199254740991.0.0"]) {
      const value = { version, releaseUrl: `https://github.com/hraness/atet/releases/tag/v${version}` }
      expect(parsePublishedRelease(value)).toEqual(value)
    }
    for (const value of [null, [], "3.2.0", {}, { version: "3.2.0" },
      { ...publishedRelease, verificationRun: "invented" },
      { ...publishedRelease, [Symbol("extra")]: true },
    ]) expect(() => parsePublishedRelease(value)).toThrow()
    for (const version of ["03.2.0", "3.2", "v3.2.0", "3.2.0-beta.1", "3.2.0+build", "3.2.0\n",
      "3.2.0 ", " 3.2.0", "3.2.-1", "3.2.0<script>", "9007199254740992.0.0", "1".repeat(51),
    ]) {
      expect(() => parsePublishedRelease({
        version, releaseUrl: `https://github.com/hraness/atet/releases/tag/v${version}`,
      })).toThrow("canonical stable SemVer")
    }
    for (const releaseUrl of [
      "https://github.com/hraness/atet/releases/tag/v3.2.1",
      `${publishedRelease.releaseUrl}?source=main`, `${publishedRelease.releaseUrl}#proof`,
      `${publishedRelease.releaseUrl}/`, "http://github.com/hraness/atet/releases/tag/v3.2.0",
      "https://github.com.evil.test/hraness/atet/releases/tag/v3.2.0",
      "https://github.com/another/atet/releases/tag/v3.2.0", 42, null,
    ]) expect(() => parsePublishedRelease({ version: "3.2.0", releaseUrl })).toThrow("exact immutable Atet tag")
  })

  test("keeps product Ask AI links off utility pages", async () => {
    const subjectUrl = "https://atet.sh/"
    const prompt = `Tell me about ${subjectUrl}`
    const row = renderAskAiAboutThis(subjectUrl)
    const providers = [
      ["chatgpt", "https://chatgpt.com/", "q"],
      ["claude", "https://claude.ai/new", "q"],
      ["perplexity", "https://perplexity.ai/", "q"],
      ["grok", "https://x.com/i/grok", "text"],
    ] as const

    expect(row.match(/<nav\b/gu)).toHaveLength(1)
    expect(row).toContain('aria-label="Ask AI about this"')
    expect(row.match(/data-slot="ask-ai-about-this-link"/gu)).toHaveLength(4)
    expect(row.match(/target="_blank"/gu)).toHaveLength(4)
    expect(row.match(/rel="noopener noreferrer nofollow"/gu)).toHaveLength(4)
    for (const [provider, baseUrl, parameter] of providers) {
      const destination = new URL(baseUrl)
      destination.searchParams.set(parameter, prompt)
      const escapedDestination = destination.href.replaceAll("&", "&amp;")
      expect(row).toContain(`data-ask-ai-provider="${provider}"`)
      expect(row).toContain(`href="${escapedDestination}"`)
    }

    const home = await readBuilt("index.html")
    const builtRow = /<nav\b[^>]*data-slot="ask-ai-about-this"[\s\S]*?<\/nav>/u.exec(home)?.[0]
    expect(builtRow).toBeDefined()
    expect(home.match(/data-slot="ask-ai-about-this"/gu)).toHaveLength(1)
    expect(builtRow?.match(/data-slot="ask-ai-about-this-link"/gu)).toHaveLength(4)
    expect(builtRow?.match(/target="_blank"/gu)).toHaveLength(4)
    expect(builtRow?.match(/rel="noopener noreferrer nofollow"/gu)).toHaveLength(4)
    for (const [provider, baseUrl, parameter] of providers) {
      const destination = new URL(baseUrl)
      destination.searchParams.set(parameter, prompt)
      expect(builtRow).toContain(`data-ask-ai-provider="${provider}"`)
      expect(builtRow).toContain(`href="${destination.href.replaceAll("&", "&amp;")}"`)
    }
    expect(await readBuilt("preview.html")).not.toContain('data-slot="ask-ai-about-this"')
    expect(await readBuilt("404.html")).not.toContain('data-slot="ask-ai-about-this"')
  })

  test("makes the README a detailed agent guide with natural GitHub discovery terms", async () => {
    const readme = await readFile(join(repositoryDirectory, "README.md"), "utf8")
    const searchableReadme = readme
      .replaceAll("**", "")
      .replace(/^>\s?/gmu, "")
      .replace(/\s+/gu, " ")
      .toLowerCase()

    for (const heading of [
      "## Why Atet",
      "## Install Atet",
      "## Start with a finished job",
      "### Instructions for coding agents",
      "## What Atet does",
      "## Important limitations",
      "## How Atet works",
      "## Design and trust",
      "## Verification",
      "## Contributing",
    ]) {
      expect(readme).toContain(heading)
    }

    const readerPath = [
      "## Why Atet",
      "## Install Atet",
      "## Start with a finished job",
      "## What Atet does",
      "## Important limitations",
      "## How Atet works",
      "## Design and trust",
      "## Verification",
      "## Contributing",
    ].map(heading => readme.indexOf(heading))
    expect(readerPath.every(position => position >= 0)).toBe(true)
    expect(readerPath).toEqual([...readerPath].sort((left, right) => left - right))

    for (const term of [
      "agentic creative coding toolkit",
      "TypeScript SDK",
      "Bun CLI",
      "Agent Skill",
      "MCP server",
      "Vercel AI Gateway",
      "AI media generation and video editing for coding agents",
      "screen recordings and imported footage",
      "image, video, speech, and transcription models",
      "clean and captioned versions",
    ]) {
      expect(searchableReadme).toContain(term.toLowerCase())
    }

    expect(searchableReadme).toContain(brandDescription.toLowerCase())

    expect(readme).toContain(`npx skills add https://github.com/hraness/atet/tree/v${publishedRelease.version} --skill atet`)
    expect(readme).toContain(`bun add --global ${publishedArchiveUrl}`)
    expect(readme).toContain(`bun add ${publishedArchiveUrl}`)
    expect(readme).toContain("atet skill install --target claude")
    expect(readme).toContain("atet operations list --json")
    expect(readme).toContain("atet ai video generate")
    expect(readme).toContain("atet workflows show social-variants --json")
    expect(readme).toContain("[`CONTRIBUTING.md`](CONTRIBUTING.md)")
    expect(readme).not.toMatch(/checked step|checked path|bounded capability|delivery variant/i)
    expect(readme).not.toContain("https://atet.sh/docs")
  })

  test("ships agent instructions for video editing and Gateway media generation", async () => {
    const [skill, video, gateway] = await Promise.all([
      readFile(join(repositoryDirectory, "skills/atet/SKILL.md"), "utf8"),
      readFile(join(repositoryDirectory, "skills/atet/references/video-projects.md"), "utf8"),
      readFile(join(repositoryDirectory, "skills/atet/references/gateway-media.md"), "utf8"),
    ])

    expect(skill).toContain("# Make and edit visual media with Atet")
    expect(skill).toContain("[video-projects.md](references/video-projects.md)")
    expect(skill).toContain("[gateway-media.md](references/gateway-media.md)")
    expect(skill).toContain("social video variants")

    for (const capability of [
      "talking-head-cleanup",
      "polished-screen-demo",
      "social-variants",
      "creative-iteration",
      "Preview and final use the same timeline and composition",
    ]) {
      expect(video).toContain(capability)
    }

    for (const command of [
      "atet ai models list --type image",
      "atet ai video generate",
      "atet ai speech generate",
      "atet ai transcribe",
      "--allow-cloud-upload",
      "--allow-cloud-audio-upload",
    ]) {
      expect(gateway).toContain(command)
    }
  })

  test("publishes one canonical Atet identity across discovery metadata", async () => {
    const html = await readSource("index.html")

    expect(html).toContain("<title>Atet: AI media generation and video editing for coding agents</title>")
    expect(html).toContain(`<meta name="description" content="${searchDescription}">`)
    expect(html).toContain(`<meta property="og:description" content="${searchDescription}">`)
    expect(html).toContain(`<meta name="twitter:description" content="${searchDescription}">`)
    expect(html).toContain('<meta name="robots" content="index, follow, max-image-preview:large, max-snippet:-1, max-video-preview:-1">')
    expect(html).not.toContain('<meta name="keywords"')
    expect(html).toContain('<link rel="canonical" href="https://atet.sh/">')
    expect(html).toContain('<link rel="alternate" type="text/markdown" href="/index.md">')
    expect(html).toContain('<link rel="describedby" href="/llms.txt">')
    expect(html).toContain('<meta property="og:url" content="https://atet.sh/">')
    expect(html).toContain('<meta property="og:image" content="https://atet.sh/og.png">')
    expect(html).toContain('<meta property="og:image:width" content="1200">')
    expect(html).toContain('<meta property="og:image:height" content="630">')
    expect(html).toContain('<meta name="twitter:card" content="summary_large_image">')
    expect(html).toContain('<meta name="twitter:image" content="https://atet.sh/og.png">')
    expect(html).toContain('<meta name="twitter:image:alt" content="Atet, AI media generation and video editing for coding agents, beside an abstract solar disk and barque path">')
    expect(html).toContain('<link rel="icon" href="/icon.svg" type="image/svg+xml">')
    expect(html).toContain('<link rel="apple-touch-icon" href="/apple-touch-icon.png">')
    expect(html).toContain('<a href="{{PUBLISHED_RELEASE_URL}}">immutable Atet release</a>')
    expect(html).toContain('<a href="https://skills.sh/hraness/atet">Atet Agent Skill</a>')
  })

  test("builds an inert noindex Atet preview with the homepage as canonical", async () => {
    const [source, built, productCss, recipes, css] = await Promise.all([
      readSource("preview.html"),
      readBuilt("preview.html"),
      readSource("styles.css"),
      readSource("preview.stylex.ts"),
      readBuilt(builtAssets.previewStylesPath.slice(1)),
    ])
    const semanticHooks = [
      "preview-route", "preview-shell", "preview-mark", "preview-mark__sun",
      "preview-mark__path", "preview-kicker", "preview-summary", "preview-outputs", "preview-note",
    ]

    for (const html of [source, built]) {
      expect(html.match(/<h1\b/gu)).toHaveLength(1)
      expect(html).toMatch(/<h1 id="preview-title" class="[^"]+">Atet<\/h1>/u)
      expect(html).toMatch(/<main aria-labelledby="preview-title" class="preview-shell [^"]+">/u)
      expect(html).toContain("Make and edit visual media with your coding agent.")
      expect(html).toContain('<meta name="robots" content="noindex, nofollow, noarchive, nosnippet">')
      expect(html).toContain('<link rel="canonical" href="https://atet.sh/">')
      expect(html).not.toMatch(/<script\b|<style\b|\sstyle\s*=|<a\b|<button\b|<form\b|<input\b|<select\b|<textarea\b|contenteditable/iu)
      expect(html).not.toMatch(/analytics|posthog|account|authentication|authorization|sign[ -]?in|user data/iu)
      expect(html).not.toContain('rel="alternate"')
      expect(html).not.toContain('rel="sitemap"')
      expect(html).not.toContain('rel="describedby"')
      expect(html).not.toContain("data-hraness-appearance-menu")
      expect(html).not.toContain('data-slot="hraness-site-footer"')
      expect([...html.matchAll(/\sclass="([^"]+)"/gu)]
        .flatMap(match => match[1]!.split(/\s+/u))
        .filter(token => token.startsWith("preview-"))).toEqual(semanticHooks)
    }

    expect(source.trimEnd().split("\n")).toHaveLength(33)
    expect(source).toContain("    {{PREVIEW_STYLES}}\n")
    expect(source.match(/\{\{PREVIEW_[A-Z_]+_CLASS\}\}/gu)).toHaveLength(18)
    expect(source.match(/\{\{PREVIEW_NUMBER_CLASS\}\}/gu)).toHaveLength(4)
    const stylesheetLinks = `<link rel="stylesheet" href="${builtAssets.previewFoundationPath}">\n    <link rel="stylesheet" href="${builtAssets.previewStylesPath}">`
    expect(built).toContain(stylesheetLinks)
    expect(built.match(/<link rel="stylesheet"(?=\s|>)/gu)).toHaveLength(2)
    expect(built).not.toContain(builtAssets.stylesPath)
    expect(built).not.toContain("{{")
    const withoutRecipeClasses = (html: string): string => html.replace(/\sclass="([^"]+)"/gu, (_attribute, value: string) => {
      const hooks = value.split(/\s+/u).filter(token => semanticHooks.includes(token))
      return hooks.length === 0 ? "" : ` class="${hooks.join(" ")}"`
    })
    expect(withoutRecipeClasses(built.replace(stylesheetLinks, "{{PREVIEW_STYLES}}")))
      .toBe(withoutRecipeClasses(source))
    const outputs = [...built.matchAll(/<li class="([^"]+)"><span class="([^"]+)">(0[1-4])<\/span>([^<]+)<\/li>/gu)]
    expect(outputs.map(match => [match[3], match[4]])).toEqual([
      ["01", "images"], ["02", "diagrams"], ["03", "animated loops"], ["04", "video"],
    ])
    const classAttributes = [...built.matchAll(/\sclass="([^"]+)"/gu)].map(match => match[1]!)
    expect(classAttributes).toHaveLength(18)
    for (const attribute of classAttributes) {
      expect(attribute).toMatch(/^[A-Za-z0-9_-]+(?: [A-Za-z0-9_-]+)*$/u)
      const compiled = attribute.split(" ").filter(token => !semanticHooks.includes(token))
      expect(compiled.length).toBeGreaterThan(0)
      for (const token of compiled) expect(css).toContain(`.${token}`)
    }

    const declarations = (classes: string): string => {
      const selectors = classes.split(" ").map(token => new RegExp(`\\.${token}(?=[^A-Za-z0-9_-]|$)`, "u"))
      return [...css.matchAll(/([^{}]+)\{([^{}]*)\}/gu)]
        .filter(match => selectors.some(selector => selector.test(match[1]!)))
        .map(match => match[2]).join(";").replace(/\s+/gu, "")
    }
    const routeCss = declarations(classAttributes[0]!)
    const shellCss = declarations(classAttributes[1]!)
    expect(routeCss).toContain("align-items:safecenter")
    expect(routeCss).toContain("justify-items:safecenter")
    expect(routeCss).toContain("overflow-x:hidden")
    expect(routeCss).toContain("overflow-y:auto")
    expect(routeCss).toContain("min-height:100svh")
    expect(shellCss).toMatch(/min-height:min\(38rem,(?:calc\()?100svh-2rem\)\)?/u)
    expect(shellCss).toContain("min-height:calc(100svh-1rem)")
    expect(`${routeCss};${shellCss}`).not.toMatch(/(?:^|;)overflow:hidden(?:;|$)/u)
    // The compiler normalizes max-width to its equivalent inclusive range.
    expect(css).toMatch(/@media\s*\((?:max-width:\s*|width\s*<=\s*)48rem\)/u)
    expect(css).toMatch(/@media\s*\(forced-colors:\s*active\)/u)
    expect(shellCss).toMatch(/border(?:-(?:top|right|bottom|left))?-color:CanvasText/iu)
    const outputGridCss = declarations(classAttributes[8]!)
    expect(outputGridCss).toContain("grid-template-columns:repeat(4,minmax(0,1fr))")
    expect(outputGridCss).toContain("grid-template-columns:repeat(2,minmax(0,1fr))")
    expect(declarations(outputs[2]![1]!)).toMatch(/border-left-width:0(?:px)?(?:;|$)/u)
    for (const output of outputs.slice(2)) {
      expect(declarations(output[1]!)).toContain("border-top-width:1px")
      expect(declarations(output[1]!)).toContain("border-top-style:solid")
    }
    expect(productCss).not.toMatch(/\.preview-(?:route|shell|mark|kicker|summary|outputs|note)\b/u)
    expect(recipes).toContain('import * as stylex from "@stylexjs/stylex"')
    expect(recipes).toContain('default: "min(38rem, calc(100svh - 2rem))"')
    expect(recipes).toContain('[compactViewport]: "calc(100svh - 1rem)"')
  })

  test("publishes exactly the preview HTML, two stylesheets, and thirteen approved font assets", async () => {
    expect(builtAssets.previewStylesPath).toMatch(/^\/assets\/preview-[a-f0-9]{64}\.css$/u)
    expect(builtAssets.previewFoundationPath).toMatch(/^\/graphs\/preview-foundation\/assets\/[A-Za-z0-9_.-]+\.css$/u)
    const artifacts = builtAssets.previewArtifacts
    const paths = artifacts.map(artifact => artifact.path)
    expect(artifacts).toHaveLength(16)
    expect(paths).toEqual([...paths].sort())
    expect(new Set(paths).size).toBe(16)
    expect(paths.filter(path => path.endsWith(".html"))).toEqual(["preview.html"])
    expect(paths.filter(path => path.endsWith(".css")).sort()).toEqual([
      builtAssets.previewStylesPath.slice(1), builtAssets.previewFoundationPath.slice(1),
    ].sort())
    const fonts = paths.filter(path => path.endsWith(".woff2"))
    expect(fonts).toHaveLength(13)
    for (const font of fonts) expect(font).toMatch(/^graphs\/preview-foundation\/assets\/[A-Za-z0-9_.-]+\.woff2$/u)
    for (const artifact of artifacts) {
      expect(Object.keys(artifact).sort()).toEqual(["bytes", "path", "sha256"])
      expect(artifact.sha256).toMatch(/^[a-f0-9]{64}$/u)
      const bytes = await readFile(join(appDirectory, "dist", artifact.path))
      expect(artifact.bytes).toBe(bytes.byteLength)
      expect(artifact.bytes).toBeGreaterThan(0)
      expect(artifact.sha256).toBe(new Bun.CryptoHasher("sha256").update(bytes).digest("hex"))
    }
    expect((await readdir(join(appDirectory, "dist/graphs"))).sort()).toEqual(["preview-foundation", "site-foundation"])
    expect(await readdir(join(appDirectory, "dist/graphs/preview-foundation"))).toEqual(["assets"])
    expect((await readdir(join(appDirectory, "dist/graphs/preview-foundation/assets"))).sort())
      .toEqual(paths.filter(path => path.startsWith("graphs/preview-foundation/assets/"))
        .map(path => path.split("/").at(-1)!).sort())
    const foundation = await readBuilt(builtAssets.previewFoundationPath.slice(1))
    expect(foundation.match(/@font-face\b/gu)).toHaveLength(13)
    expect([...foundation.matchAll(/url\(["']?([^"')]+)["']?\)/gu)].map(match => {
      const url = new URL(match[1]!, `https://atet.sh${builtAssets.previewFoundationPath}`)
      expect(url.origin).toBe("https://atet.sh")
      return url.pathname.slice(1)
    }).sort()).toEqual([...fonts].sort())
    expect(foundation).not.toMatch(/sourceMappingURL|@import\b/u)
  })

  test("publishes two sealed ordinary documents with one complete union and bound local fonts", async () => {
    const artifacts = builtAssets.siteArtifacts
    const paths = artifacts.map(item => item.path)
    expect(artifacts).toHaveLength(17)
    expect(paths).toEqual([...paths].sort())
    expect(new Set(paths).size).toBe(17)
    expect(paths.filter(path => path.endsWith(".html"))).toEqual(["404.html", "index.html"])
    expect(paths.filter(path => path.endsWith(".css")).sort()).toEqual([
      builtAssets.stylesPath.slice(1), builtAssets.siteFoundationPath.slice(1),
    ].sort())
    expect(builtAssets.stylesPath).toMatch(/^\/assets\/site-[a-f0-9]{64}\.css$/u)
    expect(builtAssets.siteFoundationPath).toMatch(/^\/graphs\/site-foundation\/assets\/[A-Za-z0-9_.-]+\.css$/u)
    for (const artifact of artifacts) {
      expect(Object.keys(artifact).sort()).toEqual(["bytes", "path", "sha256"])
      const bytes = await readFile(join(appDirectory, "dist", artifact.path))
      expect(artifact.bytes).toBe(bytes.byteLength)
      expect(artifact.bytes).toBeGreaterThan(0)
      expect(artifact.sha256).toBe(new Bun.CryptoHasher("sha256").update(bytes).digest("hex"))
    }
    const fonts = paths.filter(path => path.endsWith(".woff2"))
    expect(fonts).toHaveLength(13)
    const foundation = await readBuilt(builtAssets.siteFoundationPath.slice(1))
    const union = await readBuilt(builtAssets.stylesPath.slice(1))
    expect(foundation.match(/@font-face\b/gu)).toHaveLength(13)
    expect([...foundation.matchAll(/url\(["']?([^"')]+)["']?\)/gu)].map(match => {
      const url = new URL(match[1]!, "https://atet.sh" + builtAssets.siteFoundationPath)
      expect(url.origin).toBe("https://atet.sh")
      return url.pathname.slice(1)
    }).sort()).toEqual([...fonts].sort())
    expect(foundation).not.toMatch(/sourceMappingURL|@import\b/u)
    expect(union).not.toMatch(/url\(|@font-face|sourceMappingURL/u)
    expect(foundation).toContain("components.atet-legacy")
    expect(union).toContain("components.hraness-stylex")
    expect(await readdir(join(appDirectory, "dist/graphs/site-foundation"))).toEqual(["assets"])
    expect((await readdir(join(appDirectory, "dist/graphs/site-foundation/assets"))).sort())
      .toEqual(paths.filter(path => path.startsWith("graphs/site-foundation/assets/"))
        .map(path => path.split("/").at(-1)!).sort())
    const stylesheets = '<link rel="stylesheet" href="' + builtAssets.siteFoundationPath
      + '">\n    <link rel="stylesheet" href="' + builtAssets.stylesPath + '">'
    for (const path of ["index.html", "404.html"]) {
      const html = await readBuilt(path)
      expect(html).toContain(stylesheets)
      expect(html.match(/<link rel="stylesheet"(?=\s|>)/gu)).toHaveLength(2)
      expect(html).not.toMatch(/\{\{|<style\b|\sstyle\s*=|graphs\/site-renderer/u)
      for (const marker of ["skip-link", "topbar", "wordmark", "topbar-actions"]) {
        const classes = new RegExp('class="' + marker + ' ([^"]+)"', "u").exec(html)?.[1]?.split(" ")
        expect(classes).toBeDefined()
        expect(classes!.length).toBeGreaterThan(0)
        for (const name of classes!) {
          expect(name).toMatch(/^x[A-Za-z0-9_-]+$/u)
          expect(union).toContain("." + name)
        }
      }
    }
  })

  test("links the website, product, and source in structured data", async () => {
    const html = await readBuilt("index.html")
    const match = /<script type="application\/ld\+json">([\s\S]+?)<\/script>/u.exec(html)
    expect(match?.[1]).toBeDefined()
    const value = JSON.parse(match?.[1] ?? "null") as { "@graph"?: unknown[] }

    expect(value["@graph"]).toEqual(expect.arrayContaining([
      expect.objectContaining({
        "@id": "https://hraness.com/#organization",
        "@type": "Organization",
        name: "Hraness",
        sameAs: ["https://github.com/hraness"],
      }),
      expect.objectContaining({
        "@id": "https://atet.sh/#website",
        "@type": "WebSite",
        description: searchDescription,
        inLanguage: "en",
        publisher: { "@id": "https://hraness.com/#organization" },
      }),
      expect.objectContaining({
        "@id": "https://atet.sh/#webpage",
        "@type": "WebPage",
        isPartOf: { "@id": "https://atet.sh/#website" },
        mainEntity: { "@id": "https://atet.sh/#software" },
        publisher: { "@id": "https://hraness.com/#organization" },
      }),
      expect.objectContaining({
        "@id": "https://atet.sh/#software",
        "@type": "SoftwareApplication",
        description: searchDescription,
        author: { "@id": "https://hraness.com/#organization" },
        installUrl: "https://atet.sh/#install",
        publisher: { "@id": "https://hraness.com/#organization" },
        sameAs: [
          "https://github.com/hraness/atet",
          "https://www.npmjs.com/package/@hraness/atet",
          "https://skills.sh/hraness/atet",
        ],
        softwareVersion: publishedRelease.version,
      }),
      expect.objectContaining({
        "@id": "https://atet.sh/#source",
        "@type": "SoftwareSourceCode",
        author: { "@id": "https://hraness.com/#organization" },
        codeRepository: "https://github.com/hraness/atet",
        targetProduct: { "@id": "https://atet.sh/#software" },
        version: publishedRelease.version,
      }),
      expect.objectContaining({
        "@id": "https://atet.sh/#questions",
        "@type": "FAQPage",
        mainEntity: expect.arrayContaining([
          expect.objectContaining({
            "@type": "Question",
            name: "Does Atet require an account or subscription?",
          }),
          expect.objectContaining({
            "@type": "Question",
            name: "When can local media leave the machine?",
          }),
        ]),
      }),
    ]))
  })

  test("puts the complete agent install in the first product section", async () => {
    const html = await readBuilt("index.html")
    const searchableHtml = html.replace(/\s+/gu, " ")
    const commands = [
      `bun add --global ${publishedArchiveUrl}`,
      "atet doctor",
      `npx skills add https://github.com/hraness/atet/tree/v${publishedRelease.version} --skill atet`,
    ]
    const installMarker = html.indexOf('data-hraness-marketing="install"')
    const installStart = html.lastIndexOf("<section", installMarker)
    const installEnd = html.indexOf("</section>", installMarker) + "</section>".length
    const installHtml = html.slice(installStart, installEnd)
    const positions = commands.map(command => installHtml.indexOf(command))

    expect(positions.every(position => position >= 0)).toBe(true)
    expect(positions).toEqual([...positions].sort((left, right) => left - right))
    expect(installStart).toBeGreaterThan(0)
    expect(installEnd).toBeGreaterThan(installStart)
    expect(html).toContain("Make and edit visual media with your coding agent.")
    expect(searchableHtml).toContain("generate images, video, and voice")
    expect(searchableHtml).toContain("edit screen recordings and imported footage")
    expect(searchableHtml).toContain("add captions, graphics, and motion")
    expect(searchableHtml).toContain("export finished videos")
    expect(searchableHtml).toContain("Source media stays unchanged")
    expect(searchableHtml).toContain("Preview and final renders use the same timeline and composition")
    expect(html).toContain("Install the Atet Agent Skill")
    expect(html).toContain("Install the local media tools · Requires Bun 1.3.14+")
    expect(html).toContain(`Using Bun? <code>bunx skills add https://github.com/hraness/atet/tree/v${publishedRelease.version} --skill atet</code>`)
    expect(html).toContain("inside the project you want to work")
    expect(html).toContain("start a new agent session")
    expect(installHtml).not.toContain("atet skill install")
    expect(html).toContain("When that command is not being used")
    expect(html).toContain("atet skill install --target claude")
    expect(html).toContain("atet skill install --target agents")
    expect(html).toContain("--scope project")
    expect(html).toContain(publishedArchiveUrl)
    expect(html).toContain('data-hraness-marketing="hero"')
    expect(html).toContain('data-hraness-marketing="flow"')
    expect(html).toContain('data-hraness-marketing="facts"')
    expect(html).toContain('data-hraness-marketing="install"')
  })

  test("renders a progressively enhanced reusable copy command in the hero", async () => {
    const [html, build, client] = await Promise.all([
      readBuilt("index.html"),
      readSource("site-content.ts"),
      readSource("copy-command.ts"),
    ])

    expect(build).toContain("function renderCopyCommand(options: CopyCommandOptions)")
    expect(html.match(/data-copy-command(?:>|\s)/gu)).toHaveLength(1)
    expect(html).toContain(`<code class="copy-command__value" data-copy-command-value>npx skills add https://github.com/hraness/atet/tree/v${publishedRelease.version} --skill atet</code>`)
    expect(html).toContain(`<code>bunx skills add https://github.com/hraness/atet/tree/v${publishedRelease.version} --skill atet</code>`)
    expect(html).toContain('aria-label="Copy install command"')
    expect(html).toContain("data-copy-command-button hidden type=\"button\">Copy</button>")
    expect(html).toContain('aria-live="polite"')
    expect(html).toContain('aria-describedby="skill-install-copy-status"')
    expect(client).toContain("button.hidden = false")
    expect(client).toContain("navigator.clipboard.writeText(value)")
    expect(client).toContain('ownerDocument.execCommand("copy")')
    expect(client).toContain('button.addEventListener("click"')
    expect(client).not.toMatch(/fetch\(|XMLHttpRequest|WebSocket|EventSource|sendBeacon/)
  })

  test("uses one install, examples, workflow, interfaces, and design information architecture", async () => {
    const html = await readSource("index.html")
    const sections = [
      'id="install"',
      'id="examples"',
      'id="workflow"',
      'id="interfaces"',
      'id="design"',
      'id="questions"',
      'id="maker"',
    ]
    const positions = sections.map(section => html.indexOf(section))
    const navigation = /<nav aria-label="Primary" class="\{\{SITE_NAVIGATION_CLASS\}\}">([\s\S]*?)<\/nav>/u.exec(html)?.[1] ?? ""

    expect(positions.every(position => position >= 0)).toBe(true)
    expect(positions).toEqual([...positions].sort((left, right) => left - right))
    expect([...navigation.matchAll(/href="([^"]+)"/gu)].map(match => match[1])).toEqual([
      "#examples",
      "#workflow",
      "#interfaces",
      "https://github.com/hraness/atet",
      "#install",
    ])
    expect(navigation).toContain('class="site-action {{SITE_NAVIGATION_ACTION_CLASS}}" data-emphasis="primary" href="#install"')
    expect(html).not.toContain('class="docs-index"')
    for (const role of [
      "pillars",
      "install",
      "primitives",
      "section",
      "interfaces",
      "trust",
      "questions",
      "maker",
      "cta",
    ]) {
      expect(html).toContain(`data-hraness-marketing="${role}"`)
    }
    expect(html).not.toContain("Diátaxis")
  })

  test("shows exact equivalent interfaces without inventing a hosted surface", async () => {
    const html = await readBuilt("index.html")

    for (const example of [
      `npx skills add https://github.com/hraness/atet/tree/v${publishedRelease.version} --skill atet`,
      "atet workflows list --json",
      'import { vectorizeImage } from "@hraness/atet"',
      "atet mcp --root /absolute/path/to/workspace",
    ]) {
      expect(html).toContain(example)
    }
    expect(html).toContain("The same local system meets four kinds of caller.")
    expect(html).not.toMatch(/hosted (?:project|generation|media) (?:service|surface)/iu)
  })

  test("teaches people through requests instead of a command catalog", async () => {
    const html = await readSource("index.html")

    for (const claim of [
      "record my screen, camera, microphone, and system audio",
      "three opening-shot ideas from <code>product.png</code>",
      "generate a calm voiceover from <code>script.txt</code>",
      "clean and captioned versions in 16:9, 9:16, 1:1, and 4:5",
      "services in this repository into an editable diagram",
    ]) {
      expect(html.toLowerCase()).toContain(claim.toLowerCase())
    }

    expect(html).not.toMatch(/checked step|checked path|bounded capability|delivery variant/i)
    expect(html).not.toMatch(/<table\b|class="table-wrap"/)
    expect(html).not.toMatch(/atet\.diagram\.|atet\.image\.|@hraness\/atet\/code/)
    expect(html).not.toMatch(/AI_GATEWAY_API_KEY|VERCEL_OIDC_TOKEN|ATET_CACHE_DIR/)
  })

  test("presents one complete creative workflow in order", async () => {
    const html = await readSource("index.html")
    const stages = [
      ">Bring in what you have<",
      ">Generate what is missing<",
      ">Shape the edit<",
      ">Review before final<",
      ">Deliver every version<",
    ]
    const positions = stages.map(stage => html.indexOf(stage))

    expect(positions.every(position => position >= 0)).toBe(true)
    expect(positions).toEqual([...positions].sort((left, right) => left - right))
  })

  test("explains the architecture and trust boundary in plain language", async () => {
    const html = await readSource("index.html")
    const searchableHtml = html.replace(/\s+/gu, " ")

    for (const claim of ["Source", "Project", "Operations", "Outputs"]) {
      expect(html).toContain(claim)
    }
    expect(html).toContain("A local project your agent can understand.")
    expect(searchableHtml).toContain("your Vercel AI Gateway credential")
    expect(searchableHtml).toContain("There is no Atet account or hosted project database")
    expect(searchableHtml).toContain("uploads local media only after explicit acknowledgement")
    expect(searchableHtml.toLowerCase()).not.toContain("operating-system sandbox")
    expect(html).not.toMatch(/<form|type="password"|\/api\//)
  })

  test("keeps the approved creation story as quiet identity context", async () => {
    const html = await readSource("index.html")
    const searchableHtml = html.replace(/\s+/gu, " ")

    expect(searchableHtml).toContain(brandDescription)
    expect(html).toContain("Atum dawned and became Ra")
    expect(html).toContain("underworld on the solar barque Atet")
    expect(html).toContain('<h3>The name Atet</h3>')
    expect(html).not.toMatch(/hieroglyph|pharaoh|ankh/i)
  })

  test("keeps the page semantic, linkable, keyboard-operable, and responsive", async () => {
    const [html, notFound, css] = await Promise.all([
      readSource("index.html"),
      readSource("404.html"),
      readSource("styles.css"),
    ])
    const fragmentLinks = [...html.matchAll(/href="#([^"]+)"/gu)].map(match => match[1])
    const ids = new Set([...html.matchAll(/\sid="([^"]+)"/gu)].map(match => match[1]))

    expect(html.match(/<h1\b/gu)).toHaveLength(1)
    expect(html).toContain('<a class="skip-link {{SITE_SKIP_CLASS}}" href="#main">')
    expect(html).toContain('<nav aria-label="Primary" class="{{SITE_NAVIGATION_CLASS}}">')
    expect(html).toContain('<div class="topbar-actions {{SITE_ACTIONS_CLASS}}">')
    expect(html).toContain('<main id="main" tabindex="-1">')
    expect(html).not.toMatch(/<section(?![^>]*aria-labelledby)/)
    expect(fragmentLinks.every(fragment => ids.has(fragment))).toBe(true)
    expect(notFound.match(/<h1\b/gu)).toHaveLength(1)
    expect(notFound).toContain('<a class="skip-link {{SITE_SKIP_CLASS}}" href="#main">')
    expect(notFound).toContain('<main class="route-state {{SITE_RECOVERY_CLASS}}" id="main" tabindex="-1">')
    expect(notFound).toContain('<meta name="robots" content="noindex, nofollow">')
    expect(notFound).toContain('<meta name="theme-color" content="#faf8f3" media="(prefers-color-scheme: light)">')
    expect(notFound).toContain('<meta name="theme-color" content="#0b0b0e" media="(prefers-color-scheme: dark)">')
    expect(notFound).toContain('href="/llms.txt"')
    expect(notFound).toContain('href="/sitemap.md"')
    expect(notFound).toContain('href="/sitemap.xml"')
    expect(notFound).toContain("machine-readable site guide")
    expect(css).toContain(":where(a, button, [tabindex]):focus-visible")
    expect(css).not.toContain(".topbar")
    expect(css).not.toContain(".route-state")
    expect(css).not.toMatch(/\.reading-(?:article|card|index|module)/u)
    expect(css).toContain("@media (max-width: 64rem)")
    expect(css).toContain("@media (max-width: 48rem)")
    expect(css).toContain("@media (max-width: 34rem)")
    expect(css).toContain("@media (prefers-reduced-motion: reduce)")
    expect(css).toContain("@media (forced-colors: active)")
  })

  test("owns one shared appearance menu as the final action in every retained header", async () => {
    const documents = await Promise.all([
      readBuilt("index.html"),
      readBuilt("404.html"),
    ])
    for (const document of documents) {
      expect(document.match(/data-hraness-appearance-menu/gu)).toHaveLength(1)
      expect(document).toMatch(
        /<header class="topbar [^"]+">[\s\S]*?<div class="topbar-actions [^"]+">[\s\S]*?<nav aria-label="Primary" class="[^"]+">[\s\S]*?<\/nav>\s*<div[^>]*data-hraness-appearance-menu[^>]*>[\s\S]*?<\/div>\s*<\/div>\s*<\/header>/u,
      )
      const footerStart = document.indexOf('data-slot="hraness-site-footer"')
      expect(footerStart).toBeGreaterThan(0)
      expect(document.slice(footerStart)).not.toContain("data-hraness-appearance-menu")
      expect(document).not.toContain('class="appearance"')
      expect(document).not.toContain("data-theme-choice")
      expect(document).toContain('aria-label="Appearance: System"')
      expect(document).toContain('aria-haspopup="menu"')
      expect(document).toContain('aria-label="Appearance"')
      expect(document.match(/role="menuitemradio"/gu)).toHaveLength(3)
      expect([...document.matchAll(/data-theme-value="(light|dark|system)" role="menuitemradio"/gu)]
        .map(match => match[1])).toEqual(["light", "dark", "system"])
    }
  })

  test("uses the shared premium marketing system", async () => {
    const [css, html] = await Promise.all([readSource("styles.css"), readSource("index.html")])

    expect(css).toContain('--font-body: "Nebula Sans", ui-sans-serif, system-ui')
    expect(css).toContain("--font-sans: var(--font-body)")
    expect(css).toContain("--hraness-site-accent: var(--gold)")
    expect(css).toContain("--hraness-marketing-radius: 0.625rem")
    expect(css).toMatch(/^:root \{[^}]*color-scheme: light;/u)
    expect(css).toContain('html[data-theme="dark"]')
    expect(css).not.toMatch(/--font-display|ui-serif|Baskerville|text-transform:\s*uppercase|letter-spacing:\s*0\.\d+em/u)
    expect(css).not.toMatch(/transition|animation|@keyframes/u)
    expect(css).not.toContain(".topbar")
    expect(css).toContain(".transcript")
    expect(css).toContain(".origin-note")
    expect(css).not.toMatch(/@font-face|url\([^)]*\.woff/)
    expect(html).toContain('<h1 class="hraness-marketing-hero__heading" id="page-title">Make and edit video with your coding agent</h1>')
    expect(html).toContain('data-hraness-marketing="proof-frame"')
    expect(html).toContain("Built by Ben Guo")
    expect(html).not.toContain('class="hraness-marketing-hero__eyebrow"')
    expect(html).toContain('class="hraness-marketing-hero atet-product-hero" data-align="start"')
    expect(css).toContain("grid-template-columns: minmax(0, 0.9fr) minmax(0, 1.1fr)")
    expect(css).toContain("overflow-wrap: anywhere")
    expect(html).not.toMatch(/<h1[^>]*>[^<]*(?:bounded|exact|authority|custody|immutable|inspectable|canonical|projection|receipt)/iu)
    const builtCss = await readBuilt(builtAssets.siteFoundationPath.slice(1))
    expect(builtCss).toMatch(/font-family:\s*"?Nebula Sans"?/u)
    expect(builtCss).toContain(".hraness-marketing-hero")
    expect(builtCss).toContain(".hraness-marketing-interface-grid")
    const book = builtAssets.siteArtifacts.find(item => /\/NebulaSans-Book-[A-Za-z0-9_-]+\.woff2$/u.test(item.path))
    expect(book).toBeDefined()
    expect(book!.bytes).toBeGreaterThan(60_000)
    expect((await readFile(join(appDirectory, "dist", book!.path))).byteLength).toBe(book!.bytes)
    expect(builtAssets.siteArtifacts.filter(item => item.path.endsWith(".woff2"))).toHaveLength(13)
    expect(builtAssets.siteArtifacts.some(item => /PROVENANCE|\.(?:otf|json|map|ts|js)$/u.test(item.path))).toBe(false)
  })

  test("ships reproducible correctly sized social and icon assets", async () => {
    const social = new Uint8Array(await Bun.file(join(appDirectory, "src/og.png")).arrayBuffer())
    const generatedSocial = await renderAtetSocialImage()
    const serifHero = new Uint8Array(await Bun.file(
      join(appDirectory, "src/og-serif-hero.png"),
    ).arrayBuffer())
    const apple = new Uint8Array(await Bun.file(join(appDirectory, "src/apple-touch-icon.png")).arrayBuffer())
    const socialSource = await readSource("og-source.svg")
    const socialGenerator = await readFile(join(appDirectory, "scripts/generate-og.ts"), "utf8")
    const icon = await readSource("icon.svg")
    const socialView = new DataView(social.buffer, social.byteOffset, social.byteLength)
    const serifHeroView = new DataView(
      serifHero.buffer,
      serifHero.byteOffset,
      serifHero.byteLength,
    )
    const appleView = new DataView(apple.buffer, apple.byteOffset, apple.byteLength)

    expect(generatedSocial).toEqual(social)
    expect(new Bun.CryptoHasher("sha256").update(social).digest("hex")).toBe(
      "d040e1483849836e42ef4209a12cff0e84a9933af947f18bd143381a496d8da5",
    )
    expect(Array.from(social.slice(1, 4))).toEqual([80, 78, 71])
    expect(socialView.getUint32(16)).toBe(1200)
    expect(socialView.getUint32(20)).toBe(630)
    expect(socialSource).toContain("Make and edit")
    expect(socialSource).toContain("visual media")
    expect(socialSource).toContain("with your agent.")
    expect(socialSource).toContain('href="og-serif-hero.png"')
    expect(socialSource.match(/font-family="Nebula Sans"/gu)).toHaveLength(4)
    expect(socialSource).not.toMatch(/system-ui|-apple-system|sans-serif/u)
    expect(socialSource).toContain('fill="#e8aa48"')
    expect(serifHeroView.getUint32(16)).toBe(1200)
    expect(serifHeroView.getUint32(20)).toBe(630)
    expect(new Bun.CryptoHasher("sha256").update(serifHero).digest("hex")).toBe(
      "4a4a132a6f8fd781df0c5804797799dc4179e56ab819de79f33fbeecc99b2f52",
    )
    expect(socialGenerator).toContain('loadSystemFonts: false')
    expect(socialGenerator).toContain("NebulaSans-Book.otf")
    expect(socialGenerator).toContain("NebulaSans-Bold.otf")
    expect(socialGenerator).toContain("4cc650f856591af1affc4add4f50e260c8239a2542bafe77909b78006023f091")
    expect(socialGenerator).toContain("91617d3e2281e8213f64f6bf359f387022d3149b35000b38365c32130a25bfa8")
    expect(Array.from(apple.slice(1, 4))).toEqual([80, 78, 71])
    expect(appleView.getUint32(16)).toBe(180)
    expect(appleView.getUint32(20)).toBe(180)
    expect(icon).toContain('viewBox="0 0 64 64"')
    expect(icon).toContain('fill="#090a12"')
    expect(icon).toContain('stop-color="#f6b94a"')
  })

  test("keeps the static shell fingerprinted and analytics explicit", async () => {
    const html = await readSource("index.html")
    const css = await readSource("styles.css")
    const theme = await readSource("theme.ts")
    const copyCommand = await readSource("copy-command.ts")
    const analytics = await readSource("analytics.ts")
    const build = await readFile(join(appDirectory, "scripts/build.ts"), "utf8")
    const manifest = JSON.parse(
      await readFile(join(appDirectory, "package.json"), "utf8"),
    ) as {
      dependencies?: Record<string, string>
      devDependencies?: Record<string, string>
    }
    const rootManifest = JSON.parse(
      await readFile(join(repositoryDirectory, "package.json"), "utf8"),
    ) as { workspaces?: { catalog?: Record<string, string> } }
    const localLockfile = await readFile(join(appDirectory, "bun.lock"), "utf8")

    expect(manifest.dependencies).toEqual({
      "@hraness/design-kit": "github:hraness/design-kit#v0.5.2",
      "@hraness/site-footer": "github:hraness/site-footer#v0.6.1",
      "@hraness/ui": "github:hraness/ui#v0.5.7",
      "@resvg/resvg-js": "2.6.2",
      "posthog-js": "1.413.2",
      "react": "19.2.3",
      "react-dom": "19.2.3",
    })
    expect(manifest.devDependencies).toEqual({
      "@babel/core": "7.29.7",
      "@hraness/direct": "github:hraness/direct#f19d0fdac747e4359d6e2f915537cc826269b2d7",
      "@stylexjs/babel-plugin": "0.19.0",
      "@stylexjs/stylex": "0.19.0",
      "@types/babel__core": "7.20.5",
      "@types/bun": "1.3.14",
      "@types/node": "24.13.3",
      "@types/react": "19.2.14",
      "@types/react-dom": "19.2.3",
      "lightningcss": "1.33.0",
      "playwright-core": "1.62.0",
      "typescript": "5.9.3",
      "vite": "8.2.1",
    })
    expect(rootManifest.workspaces?.catalog?.["posthog-js"]).toBeUndefined()
    expect(rootManifest.workspaces?.catalog?.["@hraness/design-kit"]).toBeUndefined()
    expect(localLockfile).toContain('"@hraness/design-kit": "github:hraness/design-kit#v0.5.2"')
    expect(localLockfile).toContain(
      '"@hraness/site-footer": "github:hraness/site-footer#v0.6.1"',
    )
    expect(localLockfile).toContain('"@hraness/ui": "github:hraness/ui#v0.5.7"')
    expect(localLockfile).toContain('"@resvg/resvg-js": "2.6.2"')
    expect(localLockfile).toContain('"posthog-js": "1.413.2"')
    for (const [name, version] of Object.entries(manifest.devDependencies ?? {})) {
      expect(localLockfile).toContain(`"${name}": "${version}"`)
    }
    expect(localLockfile).not.toContain("catalog:")
    expect(assertAuthoredShellBudget(html)).toBeLessThan(32_000)
    // Bound the full sealed document separately, including compiled classes and content producers.
    const emittedBytes = new TextEncoder().encode(await readBuilt("index.html")).byteLength
    expect(builtAssets.siteArtifacts.find(artifact => artifact.path === "index.html")?.bytes).toBe(emittedBytes)
    expect(emittedBytes).toBeLessThan(56_000)
    expect(new TextEncoder().encode(css).byteLength).toBeLessThan(36_000)
    expect(new TextEncoder().encode(theme).byteLength).toBeLessThan(3_000)
    expect(new TextEncoder().encode(copyCommand).byteLength).toBeLessThan(4_000)
    expect(html).not.toMatch(/https:\/\/[^"']+\.(?:css|js)/)
    expect(html).toContain("{{SITE_STYLES}}")
    expect(html).toContain('<script src="{{THEME_ASSET}}"></script>')
    expect(html.indexOf('<script src="{{THEME_ASSET}}"></script>'))
      .toBeLessThan(html.indexOf("{{SITE_STYLES}}"))
    expect(html).toContain("{{APPEARANCE_MENU}}")
    expect(html).toContain("{{ANALYTICS_SCRIPT}}")
    expect(html.match(/<script\b/gu)).toHaveLength(2)
    expect(theme).toContain('from "@hraness/design-kit/browser"')
    expect(theme).toContain('storageKey: "atet.appearance"')
    expect(theme).toContain('import { installCopyCommands } from "./copy-command"')
    expect(theme).not.toMatch(/fetch\(|XMLHttpRequest|WebSocket|EventSource|sendBeacon/)
    expect(copyCommand).not.toMatch(/fetch\(|XMLHttpRequest|WebSocket|EventSource|sendBeacon/)
    expect(analytics).toContain('cookieless_mode: "always"')
    expect(analytics).toContain('person_profiles: "never"')
    expect(analytics).toContain("disable_external_dependency_loading: true")
    expect(analytics).toContain("disable_persistence: true")
    expect(analytics).toContain("disable_surveys: true")
    expect(analytics).toContain("disableDeviceModel: true")
    expect(analytics).toContain("advanced_disable_flags: true")
    expect(analytics).toContain('posthog.capture("$pageview"')
    expect(analytics).not.toMatch(/identify\(|autocapture:\s*true|capture_pageleave:\s*true/)
    expect(build).toContain('createHash("sha256")')
    expect(build).toContain("Bun.build")
    expect(build).toContain('format: "iife"')
    expect(await readSource("site-foundation.css"))
      .toContain('@import "@hraness/design-kit/compiler-foundation.css"')
    expect(await readFile(join(appDirectory, "scripts/build-site.ts"), "utf8"))
      .toContain('import.meta.resolve("@hraness/design-kit/fonts.css")')
    expect(await readSource("site-content.ts")).toContain("renderAppearanceMenu()")
    expect(await readSource("site-content.ts")).toContain("renderCopyCommand({")
    expect(build).toContain('environment.VERCEL_ENV !== "production"')
    expect(build).not.toContain("docsTemplate")
    expect(build).not.toContain('outputDirectory, "docs"')
  })

  test("allows only a canonical cookieless Atet pageview", () => {
    expect(isCanonicalAnalyticsPage({ origin: "https://atet.sh", pathname: "/" })).toBe(true)
    expect(isCanonicalAnalyticsPage({ origin: "https://preview.atet.sh", pathname: "/" })).toBe(false)
    expect(isCanonicalAnalyticsPage({ origin: "https://atet.sh", pathname: "/404" })).toBe(false)
    expect(isCanonicalAnalyticsPage({
      origin: "https://atet.sh",
      pathname: "/reading/draw-faces-with-javascript",
    })).toBe(false)
    expect(isCanonicalAnalyticsPage({
      origin: "https://atet.sh",
      pathname: "/reading/feynobg",
    })).toBe(false)
    expect(isCanonicalAnalyticsPage({
      origin: "https://atet.sh",
      pathname: "/reading/painting-with-gaussians",
    })).toBe(false)
    expect(isCanonicalAnalyticsPage({
      origin: "https://atet.sh",
      pathname: "/reading/gemini-omni",
    })).toBe(false)
    expect(isCanonicalAnalyticsPage({
      origin: "https://atet.sh",
      pathname: "/reading/paint-with-code",
    })).toBe(false)
    expect(isCanonicalAnalyticsPage({
      origin: "https://atet.sh",
      pathname: "/reading/how-i-design-with-ai",
    })).toBe(false)

    const timestamp = new Date("2026-08-19T12:00:00.000Z")
    const sanitized = sanitizePageview({
      event: "$pageview",
      properties: {
        $cookieless_mode: true,
        $current_url: "https://atet.sh/?private=value#fragment",
        $device_id: "device",
        $pathname: "/",
        $raw_user_agent: "Atet test browser",
        $referrer: "https://example.com/private",
        analytics_schema_version: 99,
        distinct_id: posthogCookielessDistinctId,
        site_id: "wrong",
        token: "phc_testtoken",
      },
      timestamp,
      uuid: "0198c6a7-7c00-7000-8000-000000000000",
    }, "phc_testtoken")

    expect(sanitized).toEqual({
      event: "$pageview",
      properties: {
        $cookieless_mode: true,
        $process_person_profile: false,
        $raw_user_agent: "Atet test browser",
        analytics_schema_version: 1,
        distinct_id: posthogCookielessDistinctId,
        site_id: "atet",
        token: "phc_testtoken",
      },
      timestamp,
      uuid: "0198c6a7-7c00-7000-8000-000000000000",
    })
    expect(sanitizePageview({
      event: "$autocapture",
      properties: { distinct_id: posthogCookielessDistinctId, token: "phc_testtoken" },
      uuid: "0198c6a7-7c00-7000-8000-000000000001",
    }, "phc_testtoken")).toBeNull()
    expect(sanitizePageview({
      event: "$pageview",
      properties: { distinct_id: "persisted-id", token: "phc_testtoken" },
      uuid: "0198c6a7-7c00-7000-8000-000000000002",
    }, "phc_testtoken")).toBeNull()
    expect(sanitizePageview({
      event: "$pageview",
      properties: {
        distinct_id: posthogCookielessDistinctId,
        token: "phc_testtoken",
      },
      uuid: "0198c6a7-7c00-7000-8000-000000000003",
    }, "phc_testtoken")).toBeNull()
    expect(sanitizePageview({
      event: "$pageview",
      properties: {
        $cookieless_mode: false,
        $raw_user_agent: "Atet test browser",
        distinct_id: posthogCookielessDistinctId,
        token: "phc_testtoken",
      },
      uuid: "0198c6a7-7c00-7000-8000-000000000004",
    }, "phc_testtoken")).toBeNull()
    expect(sanitizePageview({
      event: "$pageview",
      properties: {
        $cookieless_mode: true,
        distinct_id: posthogCookielessDistinctId,
        token: "phc_testtoken",
      },
      uuid: "0198c6a7-7c00-7000-8000-000000000005",
    }, "phc_testtoken")).toBeNull()
  })

  test("emits analytics only for a configured Production build", async () => {
    await ownedCompilation(async fixture => {
      const productionDirectory = await fixture.temporaryDirectory("atet-web-production-")
      const secondDirectory = await fixture.temporaryDirectory("atet-web-production-repeat-")
      const environment = {
        NEXT_PUBLIC_POSTHOG_HOST: "https://us.i.posthog.com",
        NEXT_PUBLIC_POSTHOG_KEY: "phc_test-token_value",
        VERCEL_ENV: "production",
      } as const
      const first = await fixture.build({ environment, outputDirectory: productionDirectory })
      const second = await fixture.build({ environment, outputDirectory: secondDirectory })
      expect(first.analyticsPath).toMatch(/^\/assets\/analytics-[a-f0-9]{12}\.js$/u)
      expect(second.analyticsPath).toBe(first.analyticsPath)
      expect(second.previewStylesPath).toBe(first.previewStylesPath)
      expect(second.previewFoundationPath).toBe(first.previewFoundationPath)
      expect(second.previewArtifacts).toEqual(first.previewArtifacts)
      expect(first.previewArtifacts).toEqual(builtAssets.previewArtifacts)
      expect(second.siteArtifacts).toEqual(first.siteArtifacts)
      expect(second.siteFoundationPath).toBe(first.siteFoundationPath)
      expect(second.stylesPath).toBe(first.stylesPath)
      expect(first.stylesPath).not.toBe(builtAssets.stylesPath)

      const [html, notFound, preview, asset] = await Promise.all([
        readFile(join(productionDirectory, "index.html"), "utf8"),
        readFile(join(productionDirectory, "404.html"), "utf8"),
        readFile(join(productionDirectory, "preview.html"), "utf8"),
        readFile(join(productionDirectory, first.analyticsPath?.slice(1) ?? "missing"), "utf8"),
      ])
      expect(html).toContain(`<script src="${first.analyticsPath}" type="module"></script>`)
      expect(notFound).not.toMatch(/analytics-|posthog|phc_test-token_value/i)
      expect(preview).not.toMatch(/<script\b|analytics-|posthog|phc_test-token_value/iu)
      expect(asset).toContain("phc_test-token_value")
      expect(asset).toContain("https://us.i.posthog.com")
      expect(asset).toStartWith("/*! posthog-js 1.413.2")
      expect(asset).toContain("Apache License\n                           Version 2.0")
      expect(new TextEncoder().encode(asset).byteLength).toBeLessThan(180_000)
    })
  }, repeatedCompilationTimeoutMs)

  test("keeps missing, Preview, and unsupported-host analytics builds inert", async () => {
    await ownedCompilation(async fixture => {
      const outputDirectory = await fixture.temporaryDirectory("atet-web-inert-")
      const preview = await fixture.build({
        environment: {
          NEXT_PUBLIC_POSTHOG_KEY: "phc_testtoken",
          VERCEL_ENV: "preview",
        },
        outputDirectory,
      })
      expect(preview.analyticsPath).toBeNull()
      expect(await readFile(join(outputDirectory, "index.html"), "utf8"))
        .not.toMatch(/analytics-|phc_testtoken/)

      await expect(fixture.build({
        environment: {
          NEXT_PUBLIC_POSTHOG_HOST: "https://example.com",
          NEXT_PUBLIC_POSTHOG_KEY: "phc_testtoken",
          VERCEL_ENV: "production",
        },
        outputDirectory,
      })).rejects.toThrow("NEXT_PUBLIC_POSTHOG_HOST must equal https://us.i.posthog.com")
    })
  }, compilationTimeoutMs)

  test("renders one closed static page with resolved content-hashed assets", async () => {
    const [html, notFound, rootFiles, assetFiles] = await Promise.all([
      readFile(join(appDirectory, "dist/index.html"), "utf8"),
      readFile(join(appDirectory, "dist/404.html"), "utf8"),
      readdir(join(appDirectory, "dist")),
      readdir(join(appDirectory, "dist/assets")),
    ])

    expect(html).toContain(`<link rel="stylesheet" href="${builtAssets.stylesPath}">`)
    expect(html).toContain(`<script src="${builtAssets.themePath}"></script>`)
    expect(builtAssets.analyticsPath).toBeNull()
    expect(html).not.toMatch(/analytics-/)
    expect(notFound).toContain(`<link rel="stylesheet" href="${builtAssets.stylesPath}">`)
    expect(notFound).toContain(`<script src="${builtAssets.themePath}"></script>`)
    expect(`${html}\n${notFound}`).not.toContain("{{")
    expect(rootFiles.sort()).toEqual([
      "404.html",
      "apple-touch-icon.png",
      "assets",
      "graphs",
      "icon.svg",
      "index.html",
      "index.md",
      "llms.txt",
      "og.png",
      "preview.html",
      "robots.txt",
      "sitemap.md",
      "sitemap.xml",
    ])
    expect(assetFiles.sort()).toEqual([
      builtAssets.previewStylesPath.split("/").at(-1)!,
      builtAssets.stylesPath.split("/").at(-1)!,
      builtAssets.themePath.split("/").at(-1)!,
    ].sort())

    const [stylesAsset, foundationAsset, themeAsset] = await Promise.all([
      readFile(join(appDirectory, "dist", builtAssets.stylesPath.slice(1)), "utf8"),
      readFile(join(appDirectory, "dist", builtAssets.siteFoundationPath.slice(1)), "utf8"),
      readFile(join(appDirectory, "dist", builtAssets.themePath.slice(1)), "utf8"),
    ])
    expect(foundationAsset).toContain(".hraness-design-theme-toggle__trigger")
    expect(stylesAsset).toContain("--hraness-site-footer-social-target")
    expect(stylesAsset).not.toContain("@import \"./dist/stylex.css\"")
    expect(stylesAsset).toMatch(/@media\s*\(pointer:\s*coarse\)/u)
    // The ordinary graph now includes the complete three-package union and
    // captured compatibility foundation, never duplicated standalone sheets.
    expect(new TextEncoder().encode(stylesAsset + foundationAsset).byteLength).toBeLessThan(256_000)
    expect(new TextEncoder().encode(themeAsset).byteLength).toBeLessThan(24_000)
    expect(themeAsset).not.toMatch(/react|next-themes|react-aria/i)
    expect(themeAsset).not.toMatch(/fetch\(|XMLHttpRequest|WebSocket|EventSource|sendBeacon/)
  })

  test("publishes crawler discovery only for retained product pages", async () => {
    const [sitemap, notFound] = await Promise.all([
      readBuilt("sitemap.xml"),
      readSource("404.html"),
    ])
    const locations = [...sitemap.matchAll(/<loc>([^<]+)<\/loc>/g)].map(match => match[1])
    expect(locations).toEqual([
      "https://atet.sh/",
      "https://atet.sh/index.md",
    ])
    expect(await readBuilt("index.md")).toBe(homeMarkdown)
    expect(await readBuilt("llms.txt")).toBe(llmsTxt)
    expect(await readBuilt("sitemap.md")).toBe(sitemapMarkdown)
    expect(await readBuilt("robots.txt")).toBe(robotsTxt)
    for (const document of [sitemap, sitemapMarkdown, homeMarkdown, llmsTxt]) {
      expect(document).not.toMatch(/\/reading|paint-with-code|draw-faces-with-javascript|feynobg|painting-with-gaussians|gemini-omni|how-i-design-with-ai/u)
      expect(document).not.toContain("/preview")
    }
    for (const crawler of [
      "OAI-SearchBot",
      "ChatGPT-User",
      "GPTBot",
      "Claude-SearchBot",
      "Claude-User",
      "ClaudeBot",
      "PerplexityBot",
      "Perplexity-User",
      "Google-Extended",
      "CCBot",
    ]) {
      expect(robotsTxt).toContain(`User-agent: ${crawler}`)
    }
    expect(robotsTxt).toContain("User-agent: *\nAllow: /")
    expect(robotsTxt).not.toMatch(/^\s*Disallow:/mu)
    expect(robotsTxt).toContain("Sitemap: https://atet.sh/sitemap.xml")
    expect(sitemap).not.toContain("xmlns:image")
    expect(sitemap).toBe(renderSitemapXml())
    expect(llmsTxt).toMatch(/^# Atet\n/u)
    expect(llmsTxt).toContain("> Atet gives coding agents tools")
    expect(llmsTxt).toContain("## When to use Atet")
    expect(llmsTxt).toContain("https://atet.sh/index.md")
    expect(sitemapMarkdown).toMatch(/^# Sitemap\n/u)
    expect(sitemapMarkdown).toContain("https://atet.sh/index.md")
    expect(sitemapMarkdown).toContain("https://atet.sh/llms.txt")
    expect(homeMarkdown).toContain("## Sitemap")
    expect(homeMarkdown).toContain("https://atet.sh/sitemap.md")
    expect(notFound).toContain('<meta name="robots" content="noindex, nofollow">')
    expect(notFoundMarkdown).toContain("https://atet.sh/llms.txt")
    expect(notFoundMarkdown).toContain("https://atet.sh/sitemap.xml")
  })

  test("redirects the retired docs route and each reviewed predecessor host", async () => {
    const vercel = JSON.parse(
      await readFile(join(appDirectory, "vercel.json"), "utf8"),
    ) as {
      redirects?: Array<{
        source?: string
        has?: Array<{ type?: string; value?: string }>
        destination?: string
        permanent?: boolean
      }>
    }
    const redirects = vercel.redirects ?? []
    const hostRedirects = redirects
      .filter(redirect => redirect.has !== undefined)
      .map(redirect => ({
        source: redirect.source,
        host: redirect.has?.[0],
        destination: redirect.destination,
        permanent: redirect.permanent,
      }))
    const routeRedirects = redirects
      .filter(redirect => redirect.has === undefined)
      .map(redirect => ({
        source: redirect.source,
        destination: redirect.destination,
        permanent: redirect.permanent,
      }))

    expect(routeRedirects).toEqual([
      { source: "/docs", destination: "/", permanent: true },
      { source: "/docs/:path*", destination: "/", permanent: true },
    ])
    expect(hostRedirects).toEqual([
      { source: "/", host: { type: "host", value: "transmute.rocks" }, destination: "https://atet.sh/", permanent: true },
      { source: "/:path*", host: { type: "host", value: "transmute.rocks" }, destination: "https://atet.sh/:path*", permanent: true },
      { source: "/", host: { type: "host", value: "www.transmute.rocks" }, destination: "https://atet.sh/", permanent: true },
      { source: "/:path*", host: { type: "host", value: "www.transmute.rocks" }, destination: "https://atet.sh/:path*", permanent: true },
      { source: "/", host: { type: "host", value: "hraness.graphics" }, destination: "https://atet.sh/", permanent: true },
      { source: "/:path*", host: { type: "host", value: "hraness.graphics" }, destination: "https://atet.sh/:path*", permanent: true },
      { source: "/", host: { type: "host", value: "hraness.studio" }, destination: "https://atet.sh/", permanent: true },
      { source: "/:path*", host: { type: "host", value: "hraness.studio" }, destination: "https://atet.sh/:path*", permanent: true },
    ])

    for (const redirect of hostRedirects) {
      const sourceHost = redirect.host?.value
      expect(sourceHost).not.toBe("atet.sh")
      expect(new URL(redirect.destination?.replace(":path*", "") ?? "https://invalid").host)
        .not.toBe(sourceHost)
    }

    expect(new Set(hostRedirects.map(redirect => redirect.host?.value))).toEqual(new Set([
      "transmute.rocks",
      "www.transmute.rocks",
      "hraness.graphics",
      "hraness.studio",
    ]))
  })

  test("serves strict security headers and only the retained markdown rewrite", async () => {
    const vercel = JSON.parse(
      await readFile(join(appDirectory, "vercel.json"), "utf8"),
    ) as {
      cleanUrls?: boolean
      headers?: Array<{ source?: string; headers?: Array<{ key?: string; value?: string }> }>
      rewrites?: Array<{
        source?: string
        destination?: string
        has?: Array<{ type?: string; key?: string; value?: string }>
      }>
      trailingSlash?: boolean
    }
    const ordinary = vercel.headers
      ?.find(entry => entry.source === "/((?!preview$).*)")?.headers ?? []
    const preview = vercel.headers?.find(entry => entry.source === "/preview")?.headers ?? []
    const assets = vercel.headers?.find(entry => entry.source === "/assets/(.*)")?.headers ?? []
    const byKey = new Map(ordinary.map(header => [header.key, header.value]))
    const previewByKey = new Map(preview.map(header => [header.key, header.value]))
    const csp = byKey.get("Content-Security-Policy") ?? ""

    expect(vercel.headers?.find(entry => entry.source === "/(.*)")).toBeUndefined()
    expect(csp).toContain("connect-src https://us.i.posthog.com")
    expect(csp).toContain("font-src 'self'")
    expect(csp).toContain("form-action 'none'")
    expect(csp).toContain("frame-ancestors 'none'")
    expect(csp).toContain("object-src 'none'")
    expect(csp).not.toMatch(/font-src[^;]*(?:https?:|data:)/u)
    expect(byKey.get("X-Frame-Options")).toBe("DENY")
    expect(byKey.get("Referrer-Policy")).toBe("no-referrer")
    expect(byKey.get("Strict-Transport-Security")).toContain("includeSubDomains")
    expect(byKey.get("Vary")).toBe("Accept, Accept-Encoding")
    expect(previewByKey.get("Content-Security-Policy")).toBe(
      "default-src 'none'; base-uri 'none'; connect-src 'none'; font-src 'self'; "
      + "form-action 'none'; frame-ancestors https://hraness.com https://www.hraness.com; "
      + "img-src 'none'; object-src 'none'; script-src 'none'; style-src 'self'; "
      + "upgrade-insecure-requests",
    )
    expect(previewByKey.get("X-Frame-Options")).toBeUndefined()
    expect(previewByKey.get("X-Robots-Tag")).toBe(
      "noindex, nofollow, noarchive, nosnippet",
    )
    expect(previewByKey.get("Link")).toBe('<https://atet.sh/>; rel="canonical"')
    for (const key of [
      "Permissions-Policy",
      "Referrer-Policy",
      "X-Content-Type-Options",
      "Cross-Origin-Opener-Policy",
      "Strict-Transport-Security",
      "Vary",
    ]) {
      expect(previewByKey.get(key)).toBe(byKey.get(key))
    }
    expect(vercel.headers
      ?.filter(entry => entry.headers?.some(header => (
        header.key === "Content-Security-Policy"
      )))
      .map(entry => entry.source)).toEqual(["/((?!preview$).*)", "/preview"])
    const ordinaryPathPattern = /^\/((?!preview$).*)$/u
    expect(ordinaryPathPattern.test("/preview")).toBe(false)
    for (const pathname of [
      "/",
      "/Preview",
      "/preview.html",
      "/preview/",
      "/preview/child",
      "/reading/paint-with-code",
      "/assets/example.css",
      "/missing",
    ]) {
      expect(ordinaryPathPattern.test(pathname)).toBe(true)
    }
    expect(assets).toContainEqual({
      key: "Cache-Control",
      value: "public, max-age=31536000, immutable",
    })
    expect(vercel.cleanUrls).toBe(true)
    expect(vercel.trailingSlash).toBe(false)

    const home = vercel.headers?.find(entry => entry.source === "/")?.headers ?? []
    const markdown = vercel.headers?.find(entry => entry.source === "/index.md")?.headers ?? []
    const sitemap = vercel.headers?.find(entry => entry.source === "/sitemap.md")?.headers ?? []
    const llms = vercel.headers?.find(entry => entry.source === "/llms.txt")?.headers ?? []
    expect(home).toContainEqual({
      key: "Link",
      value: '</index.md>; rel="alternate"; type="text/markdown", </llms.txt>; rel="describedby"',
    })
    expect(markdown).toContainEqual({
      key: "Content-Type",
      value: "text/markdown; charset=utf-8",
    })
    expect(sitemap).toContainEqual({
      key: "Content-Type",
      value: "text/markdown; charset=utf-8",
    })
    expect(llms).toContainEqual({
      key: "Content-Type",
      value: "text/plain; charset=utf-8",
    })
    expect(vercel.rewrites).toEqual([
      {
        source: "/",
        has: [{ type: "header", key: "accept", value: "^text/markdown" }],
        destination: "/index.md",
      },
    ])
    expect(JSON.stringify(vercel)).not.toMatch(/\/reading|paint-with-code|draw-faces-with-javascript|feynobg|painting-with-gaussians|gemini-omni|how-i-design-with-ai/u)
  })

  test("renders the canonical Hraness network footer on every retained ordinary page", async () => {
    const documents = await Promise.all([
      readBuilt("index.html"),
      readBuilt("404.html"),
    ])
    expect(hranessSocialLinks[0]).toMatchObject({
      href: "https://substack.com/@hraness",
      platform: "substack",
    })
    const expectedHrefs = [
      HRANESS_HOME_URL,
      ...hranessSocialLinks.map(({ href }) => href),
    ]

    for (const document of documents) {
      expect(document.match(/<footer\b/gu)).toHaveLength(1)
      const footer = /<footer\b[\s\S]*?<\/footer>/u.exec(document)?.[0]
      expect(footer).toContain('data-slot="hraness-site-footer"')
      expect(footer?.match(/data-slot="hraness-mark"/gu)).toHaveLength(1)
      expect(footer?.match(/data-slot="social-icon"/gu)).toHaveLength(5)
      expect(footer).not.toContain("hraness-site-footer__wordmark")
      expect(
        [...(footer?.matchAll(/<a\b[^>]*\shref="([^"]+)"/gu) ?? [])]
          .map(match => match[1]),
      ).toEqual(expectedHrefs)
    }
  })

  test("selects markdown, HTML, and 406 from Accept quality values", () => {
    expect(preferredRepresentation(null)).toBe("text/html")
    expect(preferredRepresentation("")).toBe("text/html")
    expect(preferredRepresentation("*/*")).toBe("text/html")
    expect(preferredRepresentation("text/html")).toBe("text/html")
    expect(preferredRepresentation("text/markdown")).toBe("text/markdown")
    expect(preferredRepresentation("text/markdown, text/html, */*")).toBe("text/markdown")
    expect(preferredRepresentation("text/html, text/markdown;q=0.9")).toBe("text/html")
    expect(preferredRepresentation("text/html;q=0, */*;q=1")).toBe("text/markdown")
    expect(preferredRepresentation("text/markdown;q=0, text/html;q=0")).toBeNull()
    expect(preferredRepresentation("application/xml")).toBeNull()
    expect(preferredRepresentation("application/json, image/png")).toBeNull()
    expect(preferredRepresentationFrom(null, ["text/html"])).toBe("text/html")
    expect(preferredRepresentationFrom("text/html", ["text/html"])).toBe("text/html")
    expect(preferredRepresentationFrom("*/*", ["text/html"])).toBe("text/html")
    expect(preferredRepresentationFrom("text/markdown", ["text/html"])).toBeNull()
    expect(preferredRepresentationFrom("text/html;q=0, */*;q=1", ["text/html"])).toBeNull()
    expect(preferredRepresentation("text/html; q = 0.5")).toBe("text/html")
    expect(preferredRepresentation("text/html;level=1, text/markdown;q=0.4")).toBe("text/markdown")

    for (const malformed of [
      ",",
      "text/html;",
      "text/html;q",
      "text/html;q=",
      "text/html;q=wat",
      "text/html;q=.5",
      "text/html;q=00.5",
      "text/html;q=-0.1",
      "text/html;q=1.001",
      "text/html;q=2",
      "text/html;q=0.0000",
      "text/html;q=0.5;q=0.4",
      "text/html;level=1",
      "text/html;charset=utf-8",
      "text/html;q=0.5;extension=unsupported",
    ]) {
      expect(preferredRepresentation(malformed)).toBeNull()
      expect(preferredRepresentationFrom(malformed, ["text/html"])).toBeNull()
    }
  })

  test("negotiates homepage markdown, generic failures, and retired reading 404s", async () => {
    expect(isHomePath("/")).toBe(true)
    expect(isHomePath("/index.html")).toBe(true)
    expect(isPreservedRedirectPath("/docs")).toBe(true)
    expect(isPreservedRedirectPath("/docs/install")).toBe(true)
    expect(isPreviewPath("/preview")).toBe(true)
    expect(isPreviewPath("/preview.html")).toBe(true)
    expect(isPreviewPath("/preview/child")).toBe(false)
    expect(isNegotiableDocumentPath("/missing-route")).toBe(true)
    expect(isNegotiableDocumentPath("/reading/paint-with-code")).toBe(true)
    expect(isNegotiableDocumentPath("/llms.txt")).toBe(false)
    expect(isNegotiableDocumentPath("/index.md")).toBe(false)
    expect(isNegotiableDocumentPath("/assets/styles.css")).toBe(false)

    const markdownHome = negotiateSiteRequest(new Request("https://atet.sh/", {
      headers: { Accept: "text/markdown" },
    }))
    expect(markdownHome?.status).toBe(200)
    expect(markdownHome?.headers.get("content-type")).toBe("text/markdown; charset=utf-8")
    expect(markdownHome?.headers.get("vary")).toBe("Accept, Accept-Encoding")
    expect(markdownHome?.headers.get("link")).toContain('rel="canonical"')
    expect(await markdownHome?.text()).toBe(homeMarkdown)

    expect(negotiateSiteRequest(new Request("https://atet.sh/", {
      headers: { Accept: "text/html" },
    }))).toBeUndefined()
    expect(negotiateSiteRequest(new Request("https://atet.sh/docs", {
      headers: { Accept: "text/markdown" },
    }))).toBeUndefined()

    const markdownNotFound = negotiateSiteRequest(new Request("https://atet.sh/this-path-does-not-exist", {
      headers: { Accept: "text/markdown" },
    }))
    expect(markdownNotFound?.status).toBe(404)
    expect(markdownNotFound?.headers.get("cache-control")).toBe("no-store")
    expect(markdownNotFound?.headers.get("content-type")).toBe("text/markdown; charset=utf-8")
    expect(markdownNotFound?.headers.get("vary")).toBe("Accept, Accept-Encoding")
    expect(markdownNotFound?.headers.get("x-robots-tag")).toBe("noindex")
    expect(await markdownNotFound?.text()).toBe(notFoundMarkdown)

    const notAcceptable = negotiateSiteRequest(new Request("https://atet.sh/", {
      headers: { Accept: "application/xml" },
    }))
    expect(notAcceptable?.status).toBe(406)
    expect(notAcceptable?.headers.get("content-type")).toBe("text/plain; charset=utf-8")
    expect(notAcceptable?.headers.get("vary")).toBe("Accept")
    expect(await notAcceptable?.text()).toBe(notAcceptableBody)

    expect(negotiateSiteRequest(new Request("https://atet.sh/llms.txt", {
      headers: { Accept: "application/xml" },
    }))).toBeUndefined()

    for (const accept of ["text/markdown", "application/xml", "text/html;q=0, */*;q=1"]) {
      const preview = new Request("https://atet.sh/preview", {
        headers: { Accept: accept },
      })
      const negotiated = negotiateSiteRequest(preview)
      expect(negotiated?.status).toBe(406)
      expect(negotiated?.headers.get("content-type")).toBe("text/plain; charset=utf-8")
      expect(negotiated?.headers.get("vary")).toBe("Accept")
      expect(await negotiated?.text()).toBe("Not Acceptable\n\nAvailable: text/html\n")

      const middlewareResponse = middleware(preview)
      expect(middlewareResponse?.status).toBe(406)
      expect(await middlewareResponse?.text()).toBe("Not Acceptable\n\nAvailable: text/html\n")
    }

    for (const accept of ["text/html", "*/*"]) {
      const preview = new Request("https://atet.sh/preview", {
        headers: { Accept: accept },
      })
      expect(negotiateSiteRequest(preview)).toBeUndefined()
      expect(middleware(preview)).toBeUndefined()
    }

    const headMarkdown = negotiateSiteRequest(new Request("https://atet.sh/", {
      headers: { Accept: "text/markdown" },
      method: "HEAD",
    }))
    expect(headMarkdown?.status).toBe(200)
    expect(headMarkdown?.headers.get("content-type")).toBe("text/markdown; charset=utf-8")
    expect(await headMarkdown?.text()).toBe("")

    const headNotFound = negotiateSiteRequest(new Request("https://atet.sh/missing-route", {
      headers: { Accept: "text/markdown" },
      method: "HEAD",
    }))
    expect(headNotFound?.status).toBe(404)
    expect(await headNotFound?.text()).toBe("")

    for (const path of ["/", "/preview"]) {
      const headNotAcceptable = negotiateSiteRequest(new Request(`https://atet.sh${path}`, {
        headers: { Accept: "application/xml" },
        method: "HEAD",
      }))
      expect(headNotAcceptable?.status).toBe(406)
      expect(headNotAcceptable?.headers.get("vary")).toBe("Accept")
      expect(await headNotAcceptable?.text()).toBe("")

      const headHtml = new Request(`https://atet.sh${path}`, {
        headers: { Accept: "text/html" },
        method: "HEAD",
      })
      expect(negotiateSiteRequest(headHtml)).toBeUndefined()
      expect(middleware(headHtml)).toBeUndefined()
    }

    for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
      for (const path of ["/", "/missing-route", "/preview"]) {
        for (const accept of ["text/markdown", "application/xml", "text/html"]) {
          const url = `https://atet.sh${path}`
          expect(negotiateSiteRequest(new Request(url, {
            headers: { Accept: accept },
            method,
          }))).toBeUndefined()
          expect(middleware(new Request(url, {
            headers: { Accept: accept },
            method,
          }))).toBeUndefined()
        }
      }
    }

    expect(middlewareConfig.matcher).toContain("/")
    const middlewareMarkdown = middleware(new Request("https://atet.sh/", {
      headers: { Accept: "text/markdown" },
    }))
    expect(middlewareMarkdown?.status).toBe(200)
    expect(await middlewareMarkdown?.text()).toBe(homeMarkdown)

    for (const slug of [
      "",
      "draw-faces-with-javascript",
      "feynobg",
      "painting-with-gaussians",
      "gemini-omni",
      "paint-with-code",
      "how-i-design-with-ai",
    ]) {
      const removed = negotiateSiteRequest(new Request(`https://atet.sh/reading${slug === "" ? "" : `/${slug}`}`, {
        headers: { Accept: "text/markdown" },
      }))
      expect(removed?.status).toBe(404)
      expect(removed?.headers.get("cache-control")).toBe("no-store")
      expect(removed?.headers.get("content-type")).toBe("text/markdown; charset=utf-8")
      expect(removed?.headers.get("vary")).toBe("Accept, Accept-Encoding")
      expect(removed?.headers.get("x-robots-tag")).toBe("noindex")
      expect(await removed?.text()).toBe(notFoundMarkdown)

      expect(negotiateSiteRequest(new Request(`https://atet.sh/reading${slug === "" ? "" : `/${slug}`}`, {
        headers: { Accept: "text/html" },
      }))).toBeUndefined()
    }
  })









})
