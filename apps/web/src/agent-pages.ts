import { sourceInstall } from "./published-release"

export const homeMarkdown = `# Direct scenes and films with your coding agent

Slopcamera is a local visual studio for coding agents. Author scenes, combine generated and recorded media, and export images, diagrams, animation, and video from retained sources.

Free and open source under the MIT license. Source build. Requires Bun 1.3.14 or newer. Recording needs macOS.

## Your first local diagram

In a new working directory, use the included input to produce five local outputs with no model account:

\`\`\`sh
slopcamera diagram init first.diagram.json
slopcamera diagram check first.diagram.json --strict
slopcamera diagram render first.diagram.json
\`\`\`

The starter writes \`example-flow.tldr\`, \`example-flow.light.svg\`, \`example-flow.dark.svg\`, \`example-flow.light.png\`, and \`example-flow.dark.png\`. Rendering again replaces these derived files. Follow the [complete tutorial](https://github.com/hraness/slopcamera/blob/main/docs/tutorials/first-diagram.md) to inspect the result and change a label.

Slopcamera covers four output families: images, diagrams, animated loops, and video. Start with the Agent Skill and CLI; the TypeScript SDK supports integrations, and MCP exposes a fixed subset. Video delivery covers 16:9, 9:16, 1:1, and 4:5 with clean and captioned cuts from one edit.

- Author editable scenes, diagrams, and motion. Direct a camera through a world or build an educational film from native source.
- Compose rendered shots with generated media and real footage. Add world-space screens, narration, captions, graphics, and sound.
- Deliver the required formats and retain the sources and project decisions for the next revision.

## Install from source

No Slopcamera release archive has been published. You need Git and Bun 1.3.14 or newer. Start a new checkout:

\`\`\`sh
${sourceInstall.checkoutCommand}
${sourceInstall.enterCommand}
\`\`\`

Cloning is only the first step. Follow the [complete source-install guide](${sourceInstall.guideUrl}) to record the commit, install locked dependencies, build the SDK and CLI, and define the \`slopcamera\` command. Native engines install separately.

After building, install the guide from that same checkout:

\`\`\`sh
${sourceInstall.skillCommand}
# For Claude Code:
${sourceInstall.alternateSkillCommand}
\`\`\`

Use \`slopcamera skill install\` for Codex by default, or add \`--scope project\` inside the target repository. Start a new agent session after installation.

## Give your agent the whole creative job

### Direct a scene

Create a product reveal with a moving camera. Keep the model editable, mount the product diagram on a screen in the scene, and show contact frames before rendering.

Portable Three.js scenes support a defined GLB subset, calibrated cameras, an explicit hardware GPU profile, and saved splat worlds through Spark. Splats capture appearance, not collision geometry. [Direct a scene](https://github.com/hraness/slopcamera/blob/main/docs/spatial-scenes.md).

### Film a native world

Build a shaded street with an original presenter. Put an animated explanation on a screen in the world, then pull the camera back into the city.

Blender handles native scenes, character rigs, cloth and liquid caches; CadQuery handles solids and STEP. Native \`studio\` commands require the current source build and separately installed engines. [Make a native film](https://github.com/hraness/slopcamera/blob/main/docs/tutorials/first-native-film.md).

### Explain an idea visually

Turn the services in this repository into an editable diagram, then animate the explanation. Add a presenter, readable mathematics, and captions where they help.

Use diagrams, HTML/SVG motion, shader graphics, and optional vgpu raster passes. Manim educational films use the source-build studio. [Make an educational video](https://github.com/hraness/slopcamera/blob/main/docs/how-to/educational-video.md).

### Edit and finish a video

Record a product demo, remove pauses, zoom into important clicks, and add \`logo.svg\`. Generate a calm voiceover from \`script.txt\`, then preview clean and captioned versions in 16:9, 9:16, 1:1, and 4:5.

Edit screen recordings and imported footage, or generate images, video, and voice through your own Gateway access. Source-build shot recipes retain budgets, reviewed takes, and continuation references. [Edit video](https://github.com/hraness/slopcamera/blob/main/docs/how-to/edit-video.md) · [Generate media](https://github.com/hraness/slopcamera/blob/main/docs/how-to/generate-media.md) · [Direct takes](https://github.com/hraness/slopcamera/blob/main/docs/directing-video.md).

**Source availability:** Build from \`main\` for portable scenes, the qualified Three.js GPU profile, saved worlds, native \`studio\`, shot-recipe \`direct\`, and \`scene camera-track\`. Engines install separately. [Check capabilities and requirements](https://github.com/hraness/slopcamera/blob/main/docs/reference/capabilities.md).

After a job runs, your agent should show the result and report the source, preview, and final output files. Ask for changes in the same plain language.

## From source to a finished film

Keep native rigs and simulations, portable geometry and cameras, diagram objects and labels, and video edits in their respective sources.

1. Prepare the sources. Inspect available tools, then author scenes or diagrams, import assets, or record on macOS.
2. Direct the result. Set cameras, shots, timing, and outputs. Discover Gateway models for generated images, video, voice, or transcripts.
3. Compose the film. Combine selected shots, edit timing, and add captions, graphics, and motion. Reframe footage and apply color and audio treatment.
4. Review before final. Inspect contact frames, motion, sound, and continuity. Preview and final renders use the same timeline and composition.
5. Deliver and revise. Export finished videos. Retain sources, project decisions, and receipts for revisions.

Share supported geometry and calibrated cameras, or mount images and video in world space. Raster handoffs preserve pixels, without reconstructing geometry or rigs. [Understand scene interchange](https://github.com/hraness/slopcamera/blob/main/docs/studio.md#share-assets-across-renderers).

## Choose how your agent works

- Agent Skill: version-matched guidance for choosing creative operations.
- CLI: human-readable commands and stable JSON for the broad local workflow. Start with \`slopcamera workflows list --json\`.
- TypeScript SDK: declarative or imperative media work in Bun. For example, import \`vectorizeImage\` from \`@hraness/slopcamera\`.
- MCP: a fixed toolset for checking and rendering diagrams, vectorizing images, and generating images within one selected root. Run \`slopcamera mcp --root /absolute/path/to/workspace\`. It does not expose every CLI command.

## Retain the sources behind the result

Source media stays unchanged under normal edit operations. Slopcamera keeps authored sources, editing decisions, previews, and final outputs in storage you control. There is no Slopcamera account or hosted project database. Native scenes and portable assets keep their own capabilities; rendered derivatives connect them.

Local processes use your Vercel AI Gateway credential without storing or printing it. Media uploads require acknowledgement. This website never receives a Gateway credential. Important operations keep secret-free receipts that name their inputs and outputs.

Native Python execution requires separate authorization. Loading a custom Bun workflow evaluates its module, including during check and plan; review the source before invoking it. Both run as your current user, without an operating-system sandbox. Runtime hashes identify observed tools; they do not make arbitrary source hermetic. Read the [security policy](https://github.com/hraness/slopcamera/blob/main/SECURITY.md) and [privacy guide](https://github.com/hraness/slopcamera/blob/main/PRIVACY.md).

## Documentation

The [documentation index](https://github.com/hraness/slopcamera/blob/main/docs/README.md) connects learning, task guides, reference, and explanation:

- [Your first diagram](https://github.com/hraness/slopcamera/blob/main/docs/tutorials/first-diagram.md)
- [Run a workflow](https://github.com/hraness/slopcamera/blob/main/docs/how-to/run-workflows.md)
- [Capabilities and requirements](https://github.com/hraness/slopcamera/blob/main/docs/reference/capabilities.md)
- [Architecture](https://github.com/hraness/slopcamera/blob/main/docs/architecture.md)

## Before you install

### Does Slopcamera require an account or subscription?

No Slopcamera account or subscription exists. Slopcamera is free and open source under the MIT license. Model-backed generation uses caller-owned Vercel AI Gateway access.

### What does it cost?

Slopcamera costs nothing. Editing, previews, diagrams, vectorization, and exports run on your machine. Model usage is billed to your own Gateway account, not to Slopcamera.

### Where do my Gateway credentials live?

In the local CLI or SDK process environment. Slopcamera does not store or print the credential. With a linked Vercel project, \`vercel env run -- <command>\` injects it for one command without writing it into the project.

### Which platforms does Slopcamera run on?

The CLI needs Bun 1.3.14+ on macOS, Linux, or Windows; recording needs macOS permissions. GPU, browser, codec, and engine requirements vary; \`slopcamera doctor\` and the capability reference identify those requirements.

### Does Slopcamera overwrite original media?

Normal edit operations retain originals and record project decisions. Rendering the starter diagram again replaces its five derived outputs.

### When can local media leave the machine?

Editing and rendering stay local. Gateway generation and selected cloud analysis upload named media only after acknowledgement. Native Python and custom Bun workflows run with your current-user access, including potential network access.

### Does the website generate or edit media?

No. The website explains and installs the local system. Media work runs through local tools; MCP exposes only its documented subset.

## Built by Ben Guo

Slopcamera is built by Ben Guo, a musician and builder, formerly a founder and engineering leader at companies including Venmo and Stripe, now building from Puerto Rico.

[hraness.com](https://hraness.com) · [@hraness](https://x.com/hraness) · [GitHub](https://github.com/hraness/slopcamera)

## Sitemap

- [Slopcamera home](https://slop.camera/index.md)
- [Machine-readable site guide](https://slop.camera/llms.txt)
- [Markdown sitemap](https://slop.camera/sitemap.md)
- [XML sitemap](https://slop.camera/sitemap.xml)
`

export const notFoundMarkdown = `# Page not found

The requested Slopcamera resource does not exist. Use one of these public indexes to recover:

- [Home and installation guide](https://slop.camera/)
- [Machine-readable site guide](https://slop.camera/llms.txt)
- [Markdown sitemap](https://slop.camera/sitemap.md)
- [XML sitemap](https://slop.camera/sitemap.xml)
`

export const llmsTxt = `# Slopcamera

> Slopcamera is a local visual studio for coding agents. Author scenes, combine generated and recorded media, and export images, diagrams, animation, and video from retained sources.

Use the Agent Skill and CLI for the broad local workflow. The TypeScript SDK supports integrations; MCP exposes a fixed diagram and image subset. There is no Slopcamera account or hosted project database.

## When to use Slopcamera

Use Slopcamera to author portable scenes and direct cameras; film saved worlds; create diagrams and motion graphics; edit footage and deliver multiple formats; or generate images, video, speech, and transcripts through your own Vercel AI Gateway access. Native Blender, CadQuery, and Manim workflows add detailed worlds and educational films in the current source build.

Slopcamera currently requires a source build from main. It includes portable scenes, the qualified Three.js GPU profile, saved Spark worlds, native studio, shot-recipe directing, and camera-track export. No Slopcamera release archive has been published. Follow the source-install guide and check runtime requirements.

Editing and rendering stay local. Gateway generation and selected cloud analysis upload named media only after acknowledgement. Native Python requires separate authorization. Custom Bun workflow modules execute when loaded, including during check and plan; review their source first. Both run as the current user without an operating-system sandbox. This website accepts no credentials and performs no generation.

## Start

- [Slopcamera home](https://slop.camera/index.md): Product overview, source installation, first task, and limits
- [Documentation index](https://github.com/hraness/slopcamera/blob/main/docs/README.md): Learning, task guides, reference, and explanation
- [First diagram](https://github.com/hraness/slopcamera/blob/main/docs/tutorials/first-diagram.md): Complete local input-to-output task using the source-built CLI
- [Repository README](https://github.com/hraness/slopcamera#readme): Product contract and install

## Choose a task

- [Directed scenes](https://github.com/hraness/slopcamera/blob/main/docs/spatial-scenes.md): Portable geometry, cameras, media surfaces, GPU, and saved worlds
- [Native studio](https://github.com/hraness/slopcamera/blob/main/docs/studio.md): Blender, CadQuery, Manim, explicit native trust, and interchange
- [Edit video](https://github.com/hraness/slopcamera/blob/main/docs/how-to/edit-video.md): Import, edit, preview, and delivery
- [Generate media](https://github.com/hraness/slopcamera/blob/main/docs/how-to/generate-media.md): Model discovery and caller-owned Gateway access
- [Direct generated clips](https://github.com/hraness/slopcamera/blob/main/docs/directing-video.md): Source-build shot recipes, budgets, takes, and review
- [Educational video](https://github.com/hraness/slopcamera/blob/main/docs/how-to/educational-video.md): Diagrams, mathematics, presenters, and motion
- [Run workflows](https://github.com/hraness/slopcamera/blob/main/docs/how-to/run-workflows.md): Recipes, declarative graphs, and recovery

## Reference and explanation

- [Capabilities](https://github.com/hraness/slopcamera/blob/main/docs/reference/capabilities.md): Release availability, supported profiles, runtime requirements, and limits
- [SDK entrypoints](https://github.com/hraness/slopcamera/blob/main/docs/reference/sdk.md): Import surfaces and execution effects
- [Architecture](https://github.com/hraness/slopcamera/blob/main/docs/architecture.md): Sources, projects, operations, and local host
- [Security policy](https://github.com/hraness/slopcamera/blob/main/SECURITY.md): Trust boundary and reporting
- [Markdown sitemap](https://slop.camera/sitemap.md): Public page indexes
- [XML sitemap](https://slop.camera/sitemap.xml): Search-engine sitemap
`

export const sitemapMarkdown = `# Sitemap

## Slopcamera

- [Slopcamera home](https://slop.camera/index.md): Visual studio overview, installation, examples, workflow, and trust
- [Documentation](https://github.com/hraness/slopcamera/blob/main/docs/README.md): Tutorials, task guides, reference, and explanation
- [Machine-readable site guide](https://slop.camera/llms.txt): When to use Slopcamera and the public indexes
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

Sitemap: https://slop.camera/sitemap.xml
`

export const homeCanonicalUrl = "https://slop.camera/"
export const homeMarkdownUrl = "https://slop.camera/index.md"
export const llmsTxtUrl = "https://slop.camera/llms.txt"
export const sitemapMarkdownUrl = "https://slop.camera/sitemap.md"
export const sitemapXmlUrl = "https://slop.camera/sitemap.xml"
