# How Slopcamera connects sources, scenes and films

Slopcamera keeps authored source available while turning it into inspectable visual artifacts. A diagram, a native Blender scene, an AI-generated clip and a recorded screen can all contribute to a film, but they retain different editing capabilities and provenance. A finished image or video is a useful common boundary between renderers; it does not preserve every property of the source that produced it.

## One local host, several authoring representations

The portable SDK owns diagram, graph, spatial-scene and native-job contracts. The local host adds durable jobs, media import, rendering, project storage and resource admission. The CLI and desktop shell use that host; the shell adds native capture, operating-system permissions and UI. The [SDK reference](reference/sdk.md) distinguishes the portable four-operation projection from the complete local registry.

Structured spatial scenes give agents named entities, calibrated cameras and typed patches. Three renders the supported mesh and media-surface profile; Spark adds bounded saved splat environments. These sources expose a deliberately bounded editing contract.

Native studio bundles retain explicit Blender, Manim or CadQuery source and its declared files. They preserve detailed engine features such as rigs, bakes, mathematical animation or solid geometry without reimplementing those tools as a large JSON scene language. Executing them is explicitly trusted current-user code. The host observes tools and output identities; it does not promise an OS sandbox or complete dependency closure.

Native jobs are production assets, not a third timeline system. Their verified frames or videos enter the ordinary project compositor. A compatible static GLB can enter a spatial scene, while the original rig remains native. A rendered diagram or shader can become a world-space surface, with its original authored source retained for later edits. Shared camera samples transfer calibrated poses and intrinsics; they do not make different lighting engines pixel-identical.

## Source identity and editorial state

Source bundles, completed receipts and addressed artifacts retain exact identities. Ordinary projects keep the current edit plan alongside original media, analysis and derived outputs. A frozen basis lets creative candidates and delivery variants refer to the same inputs; subsequent edits produce a different basis. This is more specific than treating every project as a universally reproducible immutable commit.

The V2 spatial project aggregate adds explicit scene revisions, shot bindings and candidate lineage. Migration snapshots the ordinary media basis and then rejects ordinary editing commands on that V2 head. Finish timeline and audio edits before migration. Its current compositor does not automatically substitute selected generated candidate footage; the [spatial guide](spatial-scenes.md) describes the supported path.

Short-clip directing retains recipes, takes, accepted selections and reference lineage, then assembles current selections into an ordinary project. First/last-frame conditioning can support continuity, but it is not a neural checkpoint or a recovered editable world. Changing an upstream accepted take invalidates dependent selections while preserving older attempts.

## Time, color and renderer boundaries

Every offline frame has an explicit clock. Spatial scenes use microsecond selections and rational frame rates; native jobs use half-open frame intervals. The renderer evaluates requested time rather than relying on a second live animation loop. Media assembly uses verified video spans so container audio padding does not introduce a black frame at a cut.

A derivative states its color and alpha interpretation. Native linear or data passes remain distinct from display-ready sRGB imagery. Studio encoding retains original PNG masters and records any 16-to-8-bit conversion. Rendered scene video and native RGB masters become ordinary delivery video through the project compositor. GPU receipts identify observed hardware; cross-driver regeneration need not be pixel-identical.

A preview exercises the complete authored timeline at lower cost. It helps assess pacing, cuts, overlays and framing, but final dimensions, frame count, color, sound and first/last frames still need inspection. A successful process or schema check alone is not creative acceptance.

## Durable work and recovery

Plans bind declared inputs before effects. Completed work is reused only when its input, tool and receipt identities still match. The local scheduler bounds ready work through physical resource admission and retains custody until processes settle. Revisions and explicit selections prevent unrelated editorial changes from being silently merged.

A failed or interrupted attempt can leave useful outputs and uncertain effects. Recovery inspects that exact attempt rather than assuming a timeout means nothing happened. Native reconciliation does not rerun source, and directing resume does not resubmit a provider call. Paid reservations remain when dispatch cannot be disproved. [Workflow recovery](how-to/run-workflows.md) and [directing recovery](directing-video.md) explain those operational choices.

## Local and network responsibilities

Project state lives locally; Slopcamera has no product account or hosted project database. Local rendering consumes admitted assets, while explicit acquisition and provider operations cross separate boundaries. Gateway sends authorized prompts and references to models; private Blob hosting grants temporary reference access; Poly Haven imports selected assets. Initial browser libraries or VTracer provisioning may download verified tool dependencies before local execution.

Credentials belong to the invocation environment and are not project data. A model request's local estimate is not a provider-enforced spending cap. Downloading a public asset, uploading private references and rendering retained bytes are distinct operations with distinct receipts. The [capability reference](reference/capabilities.md) records current platform and trust limits; [generation](how-to/generate-media.md) and [native production](studio.md) explain the corresponding tasks.
