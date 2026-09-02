import { editorialReadings } from "./editorial-images"

const readingMarkdownList = editorialReadings.map(reading => (
  `- [${reading.title}](https://atet.sh${reading.canonicalPath}): ${reading.description}`
)).join("\n")

export const homeMarkdown = `# Atet

Atet lets Codex, Claude, and other coding agents generate images, video, and voice; edit screen recordings and imported footage; add captions, graphics, and motion; and export finished videos from the files in your project.

Source media stays unchanged while explicit project revisions record the edit. Preview and final renders use the same timeline and composition.

## Working model

One local project moves through four inspectable steps:

1. Verify the host with \`atet doctor --json\`.
2. Inspect exact inputs, resources, and outputs with \`atet workflows show social-variants --json\`.
3. Resolve the run before execution with \`atet workflows plan social-variants --input job.json --json\`.
4. Stream progress and retain the exact run with \`atet workflows run social-variants --input job.json --jsonl\`.

Atet covers four output families—images, diagrams, animated loops, and video—through four peer interfaces: Agent Skill, CLI, TypeScript SDK, and MCP. Project authority stays local. Atet is free and MIT licensed.

## Install

Install the Atet Agent Skill, then install the local media tools. Atet requires Bun 1.3.14 or newer.

\`\`\`sh
npx skills add https://github.com/hraness/atet/tree/v3.2.0 --skill atet
# or
bunx skills add https://github.com/hraness/atet/tree/v3.2.0 --skill atet
\`\`\`

\`\`\`sh
bun add --global @hraness/atet@3.2.0
atet doctor
\`\`\`

Run \`atet doctor\` inside the project you want to work in. Then start a new agent session and describe the finished result, naming the source files and details that must remain unchanged.

The public skills command installs the immutable v3.2.0 guide. When that command is not being used, \`atet skill install\` installs the guide shipped with your CLI for Codex by default.

- Claude Code: \`atet skill install --target claude\`
- Other Agent Skill readers: \`atet skill install --target agents\`
- Only the current repository: run the install there and add \`--scope project\`

## Examples

A useful request names the source, the result, and the details that must remain unchanged. Your agent can plan the individual commands and show you a preview before it makes the final files.

### Edit a product demo

Use Atet to record my screen, camera, microphone, and system audio while I demo the app. When I stop, turn the recording into a polished two-minute walkthrough. Remove long pauses and filler words, zoom in when I click or type, keep me framed, add readable captions and \`logo.svg\`, and show me a preview before exporting the final video.

### Generate an opening sequence

Use Atet to create three opening-shot ideas from \`product.png\`. Show them to me side by side, then animate the one I choose into a six-second widescreen clip. Keep the product shape, colors, and lettering recognizable.

### Add voice and deliver every format

Use Atet to generate a calm voiceover from \`script.txt\`, place it over the approved edit, mix the music quietly underneath it, and export clean and captioned versions in 16:9, 9:16, 1:1, and 4:5.

### Explain a system visually

Use Atet to turn the services in this repository into an editable diagram, then build a short animated version that introduces each service in order.

After it runs, your agent should show you the result and report the source, preview, and final output files. You can ask for changes in the same plain language.

## Workflow

Atet brings generation, editing, motion, and export into one project that your agent can inspect and revise.

1. Bring in what you have. Record a screen, camera, microphone, and system audio on macOS, or import existing video, audio, images, and graphics.
2. Generate what is missing. Discover current Gateway models and create images, video shots, voiceovers, or transcripts from text and reference media.
3. Shape the edit. Remove pauses and filler words, align sound, reframe speakers, zoom into screen actions, add overlays, captions, color, and audio treatment.
4. Review before final. Render a lower-cost preview from the same timeline and composition that will produce the final video.
5. Deliver every version. Export clean and captioned cuts in landscape, vertical, square, and portrait formats without rebuilding the edit.

Graphics and motion use the same toolkit. Atet also creates editable diagrams, converts raster artwork to SVG locally, and builds deterministic animated layers with HTML, SVG, shaders, and Three.js. Those outputs can stand alone or join a video project.

## Interfaces

The same local system meets four kinds of caller:

- Agent Skill: version-matched guidance for turning a creative brief into checked operations. Install it with \`npx skills add https://github.com/hraness/atet/tree/v3.2.0 --skill atet\`.
- CLI: human-readable commands and stable JSON for local scripts. Start with \`atet workflows list --json\`.
- TypeScript SDK: declarative or imperative media work inside caller-owned Bun code. Import \`vectorizeImage\` from \`@hraness/atet\`.
- MCP: a fixed set of typed operations confined to one selected root. Run \`atet mcp --root /absolute/path/to/workspace\`.

## Design

Atet keeps source media, editing decisions, previews, and final outputs in storage you control. The agent chooses explicit operations, and the project records what those operations changed.

1. Source. Original recordings and imported media stay unchanged.
2. Project. Cuts, timing, framing, overlays, and effects become a revisable project state.
3. Operations. Your agent chooses from checked local tools and current Gateway models.
4. Outputs. Previews, alternatives, and deliveries remain tied to the project state that produced them.

- Local project. There is no Atet account or hosted project database. Source, project state, previews, and final files stay in storage you control.
- Caller-owned AI access. Model-backed work uses your Vercel AI Gateway credential and uploads local media only after explicit acknowledgement.
- Non-destructive revisions. Original media remains intact while alternatives and approved changes are recorded as distinct project states.
- Reviewable results. Preview and final use the same edit, while secret-free receipts identify the inputs and implementation behind important operations.

The installed Agent Skill and \`atet --help\` describe the exact tools available on the current machine. The repository documents the project model, workflow engine, security boundary, and implementation.

- [README and agent guide](https://github.com/hraness/atet#readme)
- [Architecture](https://github.com/hraness/atet/blob/main/docs/architecture.md)
- [Security policy](https://github.com/hraness/atet/blob/main/SECURITY.md)
- [Atet on npm](https://www.npmjs.com/package/@hraness/atet)
- [Source on GitHub](https://github.com/hraness/atet)

## Questions

### Does the Atet website generate or edit media?

No. The website explains and installs the local system. Media work runs in the caller's CLI, SDK, MCP server, or desktop host.

### Does Atet require an account or subscription?

No Atet account or subscription exists. Atet is free and open source. Model-backed generation uses caller-owned Vercel AI Gateway access.

### Does Atet overwrite original media?

No. Original recordings and imported media stay unchanged while edits, alternatives, previews, and deliveries remain attached to explicit project states.

### When can local media leave the machine?

Only model-backed work may upload named media, and only after explicit acknowledgement. Local editing, vectorization, deterministic rendering, previews, and outputs remain local.

## The name Atet

Agentic creative coding toolkit. At the beginning of time, when there was nothing but chaos, Atum existed alone in the watery mass of Nun. A pyramid mound called Benben emerged. When the lotus flower bloomed, Atum dawned and became Ra. Every night Ra sails in the underworld on the solar barque Atet.

## Reading

Browse every visual reading take in the [Atet reading index](https://atet.sh/reading).

- [Keep the painting as code you can edit](https://atet.sh/reading/paint-with-code.md): An Atet take on Narreddi’s p5.brush painter

## Sitemap

- [Atet home](https://atet.sh/index.md)
- [Atet reading index](https://atet.sh/reading/index.md)
- [Keep the painting as code you can edit](https://atet.sh/reading/paint-with-code.md)
- [Machine-readable site guide](https://atet.sh/llms.txt)
- [Markdown sitemap](https://atet.sh/sitemap.md)
- [XML sitemap](https://atet.sh/sitemap.xml)
`

export const readingIndexMarkdown = `# Atet reading

Short, sourced essays about keeping generated media inspectable, revisable, and attached to the source that produced it.

${readingMarkdownList}

Return to the [Atet home](https://atet.sh/).
`

export const notFoundMarkdown = `# Page not found

The requested Atet resource does not exist. Use one of these public indexes to recover:

- [Home and installation guide](https://atet.sh/)
- [Machine-readable site guide](https://atet.sh/llms.txt)
- [Markdown sitemap](https://atet.sh/sitemap.md)
- [XML sitemap](https://atet.sh/sitemap.xml)
`

export const llmsTxt = `# Atet

> Atet gives coding agents tools to generate images, video, and voice, edit real footage, add motion graphics and captions, and export finished videos. The toolkit runs on the local machine. There is no Atet account or hosted project database.

The CLI performs the work. The Agent Skill explains the creative tools and the decisions an agent should make before it uses them. Generation credentials stay in the local SDK or CLI. This site does not accept, store, or render an AI Gateway credential.

## When to use Atet

Use Atet when a coding agent needs to make or edit visual media inside a local project. Reach for it to record a screen, camera, microphone, or system audio; generate images, video, speech, or transcripts through the caller's Vercel AI Gateway; clean and caption footage; add graphics and motion; or export landscape, vertical, square, and portrait versions from one project.

Install the Agent Skill, then describe the finished result. Do not use Atet as a hosted generation website, account system, or remote media store.

## Install

- [Atet home](https://atet.sh/index.md): Skill install, Bun CLI, example requests, workflow, and design
- [Repository README](https://github.com/hraness/atet#readme): Agent guide shipped with the source

## Optional

- [Atet reading index](https://atet.sh/reading/index.md): Every visual reading take
- [Keep the painting as code you can edit](https://atet.sh/reading/paint-with-code.md): An Atet reading take on Narreddi’s p5.brush painter
- [Markdown sitemap](https://atet.sh/sitemap.md): Public Atet pages in markdown
- [XML sitemap](https://atet.sh/sitemap.xml): Search-engine sitemap
- [Architecture](https://github.com/hraness/atet/blob/main/docs/architecture.md): Project model and local host
- [Security policy](https://github.com/hraness/atet/blob/main/SECURITY.md): Trust boundary and reporting
- [Source on GitHub](https://github.com/hraness/atet): Current repository
`

export const sitemapMarkdown = `# Sitemap

## Atet

- [Atet home](https://atet.sh/index.md): Installation, examples, workflow, and design for the local media toolkit
- [Atet reading index](https://atet.sh/reading/index.md): Every visual reading take
- [Keep the painting as code you can edit](https://atet.sh/reading/paint-with-code.md): An Atet reading take on Narreddi’s p5.brush painter
- [Machine-readable site guide](https://atet.sh/llms.txt): When to use Atet and the public indexes
`

export const robotsTxt = `User-agent: OAI-SearchBot
User-agent: ChatGPT-User
User-agent: GPTBot
Allow: /

User-agent: Claude-SearchBot
User-agent: Claude-User
User-agent: ClaudeBot
Allow: /

User-agent: PerplexityBot
User-agent: Perplexity-User
Allow: /

User-agent: Google-Extended
Allow: /

User-agent: CCBot
Allow: /

User-agent: *
Allow: /

Sitemap: https://atet.sh/sitemap.xml
`

export const homeCanonicalUrl = "https://atet.sh/"
export const homeMarkdownUrl = "https://atet.sh/index.md"
export const readingPaintWithCodeMarkdown = `# Keep the painting as code you can edit

An AI painting is easier to revise when the model returns the program that made it. In March 2026, Surya Narreddi published [Training AI to Paint with Code](https://surya.website/rling-qwen-to-paint-with-code), an experiment made with Cameron Franz and Alex Wang. For Atet, the useful implication is simple: keep generated code as a project artefact, not just rendered pixels.

Narreddi writes, “When you make an image with an AI model, the only way to participate is the prompt.” He and his collaborators trained a language model with reinforcement learning to answer a watercolour prompt by writing a complete p5.brush JavaScript sketch. A sandboxed Puppeteer renderer turns that sketch into a PNG so a judge can score it. “The code is the artefact, and the code is editable.”

That split matters once a coding agent can return a finished picture. A sealed raster and a longer prompt both leave you in the same place: you have to go back to the model to change a petal. You cannot ask which brush call kept the lettering, or which overlay restored the product silhouette. The [Atet home](https://atet.sh/) asks you to name the source, the result, and the details that must remain unchanged. Those names need an artefact that still answers.

## Keep the sketch in the project

Atet’s public site keeps source media, editing decisions, previews, and final outputs in storage you control. Original recordings and imported images stay unchanged. Your agent chooses explicit operations. Cuts, timing, framing, overlays, and effects become a revisable project state. After a generation step you can still point at \`product.png\` and see what the model changed.

Graphics and motion stay in that toolkit. Atet creates editable diagrams, converts raster artwork to SVG locally, and builds deterministic animated layers with HTML, SVG, shaders, and Three.js. Those outputs can stand alone or join a video project. Atet does not ship p5.brush, a paint-with-code command, or Narreddi’s training loop. The transfer is the inspectable source: code, a diagram, or a named operation you can revise.

## What the experiment found

Narreddi reports that a 400-line p5.brush API reference produced confident, well-formatted code that invented methods. A short allowlist of eight brush methods produced visible hibiscus forms. Absolute multi-judge scores correlated and locked the model on flat clip-art flowers. Pairwise comparison against a hand-rated reference pool learned faster and compressed winning sketches under 2,000 tokens. Those results stay his. The transferable claim is smaller: if the model returns only pixels, you cannot make the same revision.

Preview and final use the same edit. Model-backed work uses your Vercel AI Gateway credential and uploads local media only after explicit acknowledgement. There is no Atet account or hosted project database.


## Sources

- [Training AI to Paint with Code on Hraness](https://hraness.com/reading/rling-qwen-to-paint-with-code)
- [Training AI to Paint with Code on surya.website](https://surya.website/rling-qwen-to-paint-with-code)

`

export const readingPaintWithCodeCanonicalUrl = "https://atet.sh/reading/paint-with-code"
export const readingPaintWithCodeMarkdownUrl = "https://atet.sh/reading/paint-with-code.md"
export const llmsTxtUrl = "https://atet.sh/llms.txt"
export const sitemapMarkdownUrl = "https://atet.sh/sitemap.md"
export const sitemapXmlUrl = "https://atet.sh/sitemap.xml"
