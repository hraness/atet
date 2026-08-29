import { editorialReadings } from "./editorial-images"

const readingMarkdownList = editorialReadings.map(reading => (
  `- [${reading.title}](https://atet.sh${reading.canonicalPath}): ${reading.description}`
)).join("\n")

export const homeMarkdown = `# Atet

Atet lets Codex, Claude, and other coding agents generate images, video, and voice; edit screen recordings and imported footage; add captions, graphics, and motion; and export finished videos from the files in your project.

## Install

Install the Atet Agent Skill, then install the local media tools. Atet requires Bun 1.3.14 or newer.

\`\`\`sh
npx skills add https://github.com/hraness/atet/tree/v3.1.2 --skill atet
# or
bunx skills add https://github.com/hraness/atet/tree/v3.1.2 --skill atet
\`\`\`

\`\`\`sh
bun add --global @hraness/atet@3.1.2
atet doctor
\`\`\`

Run \`atet doctor\` inside the project you want to work in. Then start a new agent session and describe the finished result.

The public skills command installs the immutable v3.1.2 guide. When that command is not being used, \`atet skill install\` installs the guide shipped with your CLI for Codex by default.

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

## The name Atet

Agentic creative coding toolkit. At the beginning of time, when there was nothing but chaos, Atum existed alone in the watery mass of Nun. A pyramid mound called Benben emerged. When the lotus flower bloomed, Atum dawned and became Ra. Every night Ra sails in the underworld on the solar barque Atet.

## Reading

Browse every visual reading take in the [Atet reading index](https://atet.sh/reading).

- [Keep the source small enough to vary](https://atet.sh/reading/draw-faces-with-javascript.md): An Atet take on Mannay’s JavaScript faces
- [Keep the cutout from replacing the source](https://atet.sh/reading/feynobg.md): An Atet take on FeyNoBg
- [Keep the stroke decision in the renderer](https://atet.sh/reading/painting-with-gaussians.md): An Atet take on Sotnikov’s painterly Gaussian renderer
- [Control in the renderer still beats a bigger Omni prompt](https://atet.sh/reading/gemini-omni.md): An Atet take on Gemini Omni 1.1 Flash

## Sitemap

- [Atet home](https://atet.sh/index.md)
- [Atet reading index](https://atet.sh/reading/index.md)
- [Keep the source small enough to vary](https://atet.sh/reading/draw-faces-with-javascript.md)
- [Keep the cutout from replacing the source](https://atet.sh/reading/feynobg.md)
- [Keep the stroke decision in the renderer](https://atet.sh/reading/painting-with-gaussians.md)
- [Control in the renderer still beats a bigger Omni prompt](https://atet.sh/reading/gemini-omni.md)
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
- [Keep the source small enough to vary](https://atet.sh/reading/draw-faces-with-javascript.md): An Atet reading take on Mannay’s JavaScript faces
- [Keep the cutout from replacing the source](https://atet.sh/reading/feynobg.md): An Atet reading take on FeyNoBg
- [Keep the stroke decision in the renderer](https://atet.sh/reading/painting-with-gaussians.md): An Atet reading take on Sotnikov’s painterly Gaussian renderer
- [Control in the renderer still beats a bigger Omni prompt](https://atet.sh/reading/gemini-omni.md): An Atet reading take on Gemini Omni 1.1 Flash
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
- [Keep the source small enough to vary](https://atet.sh/reading/draw-faces-with-javascript.md): An Atet reading take on Mannay’s JavaScript faces
- [Keep the cutout from replacing the source](https://atet.sh/reading/feynobg.md): An Atet reading take on FeyNoBg
- [Keep the stroke decision in the renderer](https://atet.sh/reading/painting-with-gaussians.md): An Atet reading take on Sotnikov’s painterly Gaussian renderer
- [Control in the renderer still beats a bigger Omni prompt](https://atet.sh/reading/gemini-omni.md): An Atet reading take on Gemini Omni 1.1 Flash
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

export const readingFacesMarkdown = `# Keep the source small enough to vary

Mannay’s published note on [Hraness](https://hraness.com) treats JavaScript as a drawing partner. The sheets of loose, colorful faces change when a few drawable rules change. Atet applies that idea to the files already in a project.

The [Draw faces with JavaScript](https://hraness.com/reading/draw-faces-with-javascript) note collects four grids. Eyes, mouths, outlines, and fills shift a little, and the sheet shifts a lot. You can still name the rules after you look. The source stays a compact visual system.

Atet’s public site describes the same demand for a media project. Original recordings and imported images stay unchanged. Your agent chooses explicit operations. Cuts, timing, framing, overlays, and effects become a revisable project state. Previews and deliveries stay tied to the state that produced them.

## Start from a file you can still point at

The [Atet home](https://atet.sh/) asks you to name the source, the result, and the details that must remain unchanged. One request starts from \`product.png\` and asks for three opening-shot ideas, then a six-second clip that keeps the product shape, colors, and lettering recognizable. Another starts from a screen, camera, microphone, and system-audio recording and asks for a two-minute walkthrough with captions and \`logo.svg\`. A third turns the services in a repository into an editable diagram, then a short animated introduction.

Graphics and motion stay in that toolkit. Atet creates editable diagrams, converts raster artwork to SVG locally, and builds deterministic animated layers with HTML, SVG, shaders, and Three.js. Those outputs can stand alone or join a video project. Atet does not ship a face generator. The transfer from Mannay’s doodles is the inspectable source, not a new drawing command.

## Compare the variations before you keep one

A sheet of faces is useful because you can see the results together. Atet’s design does that for a finished job. Preview and final use the same edit. Model-backed work uses your Vercel AI Gateway credential and uploads local media only after explicit acknowledgement. There is no Atet account or hosted project database.

Read the source note on [Hraness](https://hraness.com/reading/draw-faces-with-javascript). Then start at the [Atet home](https://atet.sh/) and describe the finished result from the files you already have.

## Related pages

- [Atet home](https://atet.sh/)
- [Keep the cutout from replacing the source](https://atet.sh/reading/feynobg)
- [Keep the stroke decision in the renderer](https://atet.sh/reading/painting-with-gaussians)
- [Control in the renderer still beats a bigger Omni prompt](https://atet.sh/reading/gemini-omni)
- [Hraness](https://hraness.com)
- [Draw faces with JavaScript](https://hraness.com/reading/draw-faces-with-javascript)
`

export const readingFeynobgMarkdown = `# Keep the cutout from replacing the source

Feyn published FeyNoBg as a field note. [Hraness](https://hraness.com) collected it. The transferable claim for a media project is that foreground recognition and boundary precision are two skills in one opacity map. Atet applies that to the files already in a project. The original stays. The cutout stays an operation you can inspect and revise.

The [FeyNoBg](https://usefeyn.com/blog/feynobg/) note by Hafedh Hichri and Shreyash Nigam says, “Producing this opacity map requires two skills.” The model has to find the subject, then trace a boundary. “Hair, fur, thin wires, and motion blur can blend foreground and background elements together.” Feyn reports, “Across eight benchmarks, it posts the best published S-measure on four and comes within 2% of the leader on the rest.” That sentence is their published comparison. This page does not assign a rank. The [Hraness reading](https://hraness.com/reading/feynobg-a-sota-model-for-background-removal) is the collected source note.

A pipeline fails when the cutout becomes the only inspectable image. You can no longer see whether the model missed the subject or chewed the edge. You also cannot vary the operation and keep the original file the [Atet home](https://atet.sh/) asks you to name.

## Keep both failures on the timeline

Feyn writes, “A poor training mix can produce unbalanced models where improvements in one skill come at the expense of the other.” “Outputs either miss parts of the subject or lack clean edges.” A later choice removes the soft edge a composite often needs: “The matting datasets therefore contributed precisely outlined subjects, not soft-opacity supervision.”

Atet’s public site keeps those failures visible by refusing to replace the source. Original recordings and imported images stay unchanged. Cuts, timing, framing, overlays, and effects become a revisable project state. Previews, alternatives, and deliveries stay tied to the state that produced them. After a removal step, that split is what lets you still point at \`product.png\` or the screen, camera, microphone, and system-audio recording and see what the model changed.

## Vary the operation, then deliver

One public take, [Keep the source small enough to vary](https://atet.sh/reading/draw-faces-with-javascript), is about compact drawable rules. [Keep the stroke decision in the renderer](https://atet.sh/reading/painting-with-gaussians) keeps brushwork in a tunable renderer after an agent proposes marks. This take is about a later temptation: a model output that looks finished enough to replace the file you started from. If the transparent PNG becomes the project’s only image, the walkthrough that must keep you framed and the opening shot that must keep product shape, colors, and lettering recognizable both lose the file they were asked to protect.

Atet does not ship FeyNoBg or a background-removal command. The transfer is the inspectable original and the named operation. Preview and final use the same edit. Model-backed work uses your Vercel AI Gateway credential and uploads local media only after explicit acknowledgement. There is no Atet account or hosted project database.

Read the field note on [Feyn](https://usefeyn.com/blog/feynobg/) and the collected page on [Hraness](https://hraness.com/reading/feynobg-a-sota-model-for-background-removal). Then start at the [Atet home](https://atet.sh/) and keep the source file in the project after the model runs.

## Related pages

- [Atet home](https://atet.sh/)
- [Keep the source small enough to vary](https://atet.sh/reading/draw-faces-with-javascript)
- [Keep the stroke decision in the renderer](https://atet.sh/reading/painting-with-gaussians)
- [Control in the renderer still beats a bigger Omni prompt](https://atet.sh/reading/gemini-omni)
- [Hraness](https://hraness.com)
- [FeyNoBg on Hraness](https://hraness.com/reading/feynobg-a-sota-model-for-background-removal)
- [FeyNoBg on Feyn](https://usefeyn.com/blog/feynobg/)
`

export const homeCanonicalUrl = "https://atet.sh/"
export const homeMarkdownUrl = "https://atet.sh/index.md"
export const readingGaussiansMarkdown = `# Keep the stroke decision in the renderer

Dmitri Sotnikov published [Painting with Gaussians](https://yogthos.net/posts/2026-08-03-splat-painter.html) on 3 August 2026. [Hraness](https://hraness.com) collected the note. Atet is an agentic creative-coding toolkit. The transfer is the place where a mark is decided. An agent can propose marks. The stroke decision stays in a renderer you can still inspect.

The essay builds a painterly image from 2D Gaussian splats. A color-aware structure tensor points each splat along a contour. A wavelet detail map spends small strokes on texture and keeps broad marks in smooth areas. Opaque underpainting covers the canvas, then translucent layers restore form. The work is classical image analysis. Sotnikov rejects randomly seeded splats optimized against a target because the process is slow, difficult to inspect, and tends to reproduce the input instead of creating convincing brushwork. The [Hraness reading](https://hraness.com/reading/painting-with-gaussians) is the collected source note.

That diagnosis matters once a coding agent can sample a picture. A generated opening shot can look finished while hiding every stroke decision. You can no longer ask which edge rule kept the lettering, or which layer restored the product silhouette. The [Atet home](https://atet.sh/) asks you to name the source, the result, and the details that must remain unchanged. Those names need a renderer that still answers.

## Spend marks from the photograph

Sotnikov concludes that contour and texture measurements provide much of the information needed to place painted marks. The controls stay attached to those measurements. Atet’s public site keeps a similar split. Original recordings and imported images stay unchanged. Your agent chooses explicit operations. Cuts, timing, framing, overlays, and effects become a revisable project state. Previews, alternatives, and deliveries stay tied to the state that produced them. After a generation step you can still point at \`product.png\` and see what the renderer or the model changed.

Graphics and motion stay in that toolkit. Atet creates editable diagrams, converts raster artwork to SVG locally, and builds deterministic animated layers with HTML, SVG, shaders, and Three.js. Those outputs can stand alone or join a video project. Atet does not ship a Gaussian painter or a splat-painter command. The transfer is the inspectable source and the controllable renderer.

## Leave the sampled picture on the timeline

[Keep the source small enough to vary](https://atet.sh/reading/draw-faces-with-javascript) treats JavaScript faces as compact drawable rules. [Keep the cutout from replacing the source](https://atet.sh/reading/feynobg) keeps a background-removal output from becoming the only file. This page is about a later habit: accepting a generated picture as the painting. If the opening-shot sample replaces \`product.png\`, the six-second clip that must keep product shape, colors, and lettering recognizable has no renderer left to retune.

Preview and final use the same edit. Model-backed work uses your Vercel AI Gateway credential and uploads local media only after explicit acknowledgement. There is no Atet account or hosted project database.

Read the essay on [yogthos.net](https://yogthos.net/posts/2026-08-03-splat-painter.html) and the collected page on [Hraness](https://hraness.com/reading/painting-with-gaussians). Then start at the [Atet home](https://atet.sh/) and keep the stroke decision in a renderer you can still tune. A later take, [Control in the renderer still beats a bigger Omni prompt](https://atet.sh/reading/gemini-omni), applies the same habit to Gemini Omni 1.1 Flash.

## Related pages

- [Atet home](https://atet.sh/)
- [Keep the source small enough to vary](https://atet.sh/reading/draw-faces-with-javascript)
- [Keep the cutout from replacing the source](https://atet.sh/reading/feynobg)
- [Control in the renderer still beats a bigger Omni prompt](https://atet.sh/reading/gemini-omni)
- [Hraness](https://hraness.com)
- [Painting with Gaussians on Hraness](https://hraness.com/reading/painting-with-gaussians)
- [Painting with Gaussians on yogthos.net](https://yogthos.net/posts/2026-08-03-splat-painter.html)
`

export const readingFacesCanonicalUrl = "https://atet.sh/reading/draw-faces-with-javascript"
export const readingFacesMarkdownUrl = "https://atet.sh/reading/draw-faces-with-javascript.md"
export const readingFeynobgCanonicalUrl = "https://atet.sh/reading/feynobg"
export const readingFeynobgMarkdownUrl = "https://atet.sh/reading/feynobg.md"
export const readingGeminiOmniMarkdown = `# Control in the renderer still beats a bigger Omni prompt

Anish Nangia and Alisa Fortin published [Gemini Omni 1.1 Flash lets you build with more control](https://blog.google/innovation-and-ai/technology/developers-tools/build-with-gemini-omni-1-1-flash/) on the Google blog on 27 August 2026. [Hraness](https://hraness.com) collected the note on 28 August 2026. This page is an Atet reading take. It is not the Hraness Reading digest. Atet is an agentic creative-coding toolkit. The transfer is where generation knobs live after a model returns a clip.

The Google post presents Omni 1.1 as a production-ready generative video update on the Gemini API. Scene extension now reads 10 seconds of prior context and continues a clip in 10-second steps up to 40 seconds. First and last frames interpolate a shot. Drafts can run at 360p, then the same job can upscale to 1080p or 4K. A prompt can also attach up to three seconds of reference video. The [Hraness reading](https://hraness.com/reading/gemini-omni-1-1-flash) is the collected source note.

Those controls stay inside a general Omni model. A longer, more specific prompt can name a dolly, an orbit, or a loop. That request still ends when the file lands. You cannot ask which timeline cut kept the lettering, or which overlay restored the product silhouette. The [Atet home](https://atet.sh/) asks you to name the source, the result, and the details that must remain unchanged. Those names need knobs that still answer after generation.

## Keep the clip attached to a project state

Atet’s public site keeps source media, editing decisions, previews, and final outputs in storage you control. Original recordings and imported images stay unchanged. Your agent chooses explicit operations. Cuts, timing, framing, overlays, and effects become a revisable project state. After a Gateway video shot you can still point at \`product.png\` and see what the model changed. Preview and final use the same edit.

Graphics and motion stay in that toolkit. Atet creates editable diagrams, converts raster artwork to SVG locally, and builds deterministic animated layers with HTML, SVG, shaders, and Three.js. Those outputs can stand alone or join a video project. Atet does not ship Gemini Omni, a scene-extension command, or a first-and-last-frame interpolator. The transfer is the inspectable source and the controllable renderer.

## Leave Omni’s extra prompt on the model

Thursday’s take, [Keep the stroke decision in the renderer](https://atet.sh/reading/painting-with-gaussians), argued from Sotnikov’s Gaussian painter that an agent can propose marks while the stroke decision stays in a renderer you can inspect. This page starts from a different source: Google’s Omni control and API story. Extra prompt control on a general Omni model is not a replacement for that toolkit.

Model-backed work uses your Vercel AI Gateway credential and uploads local media only after explicit acknowledgement. There is no Atet account or hosted project database.

Read [Gemini Omni 1.1 Flash lets you build with more control](https://blog.google/innovation-and-ai/technology/developers-tools/build-with-gemini-omni-1-1-flash/) on the Google blog and the collected page on [Hraness](https://hraness.com/reading/gemini-omni-1-1-flash). Then start at the [Atet home](https://atet.sh/) and keep generation knobs in a renderer you can still tune.

## Related pages

- [Atet home](https://atet.sh/)
- [Keep the stroke decision in the renderer](https://atet.sh/reading/painting-with-gaussians)
- [Keep the source small enough to vary](https://atet.sh/reading/draw-faces-with-javascript)
- [Keep the cutout from replacing the source](https://atet.sh/reading/feynobg)
- [Hraness](https://hraness.com)
- [Gemini Omni 1.1 Flash on Hraness](https://hraness.com/reading/gemini-omni-1-1-flash)
- [Gemini Omni 1.1 Flash on the Google blog](https://blog.google/innovation-and-ai/technology/developers-tools/build-with-gemini-omni-1-1-flash/)
`

export const readingGaussiansCanonicalUrl = "https://atet.sh/reading/painting-with-gaussians"
export const readingGaussiansMarkdownUrl = "https://atet.sh/reading/painting-with-gaussians.md"
export const readingGeminiOmniCanonicalUrl = "https://atet.sh/reading/gemini-omni"
export const readingGeminiOmniMarkdownUrl = "https://atet.sh/reading/gemini-omni.md"
export const llmsTxtUrl = "https://atet.sh/llms.txt"
export const sitemapMarkdownUrl = "https://atet.sh/sitemap.md"
export const sitemapXmlUrl = "https://atet.sh/sitemap.xml"
