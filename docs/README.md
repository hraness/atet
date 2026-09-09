# ATET documentation

ATET retains editable source, renders local or generated media, and assembles it into inspectable video projects. Choose a guide for the work you want to do.

These pages describe the current repository. The canonical published archive is **v3.2.3**. That release includes directed scenes, but the newer native studio, short-video directing, and calibrated camera export commands require a compatible source build. Check the [capability and version reference](reference/capabilities.md) before following a command from `main`.

## Learn by making something

- [Create and revise your first diagram](tutorials/first-diagram.md): make a two-node diagram, inspect its five exports, then change its source.
- [Render your first native film](tutorials/first-native-film.md): retain a Blender source, render a small shot, and export an ordinary ATET project.

## Complete a task

- [Run current-source commands](how-to/use-current-source.md): build an exact checkout when a feature is absent from the published archive.

- [Edit and deliver video](how-to/edit-video.md): import footage, align related tracks, place overlays, and check a delivery.
- [Generate images, video, or narration](how-to/generate-media.md): discover Gateway capabilities, acknowledge selected uploads, and retain the result.
- [Direct short generated clips](directing-video.md): budget, review takes, preserve endpoint continuity, and recover uncertain work.
- [Author a native film](studio.md): use Blender, CadQuery, or Manim; retain caches; share assets and calibrated cameras.
- [Render and edit spatial scenes](spatial-scenes.md): patch named entities, use hardware rendering, import a saved world, or prepare a V2 shot composition.
- [Make an educational video](how-to/educational-video.md): keep mathematical visuals, narration, and timing evidence revisable.
- [Run or recover a workflow](how-to/run-workflows.md): use a built-in recipe or trusted Bun module and inspect its durable run.
- [Configure Vercel](vercel.md) or [publish ATET](publishing.md): provider and maintainer procedures.

## Look up a contract

- [Capabilities, versions, and platforms](reference/capabilities.md): released versus current-main behavior, command discovery, and supported runtime boundaries.
- [SDK surfaces](reference/sdk.md): portable and local imports, operation projections, and execution contracts.
- [CLI help](reference/capabilities.md#discover-the-installed-contract): exact grammar and JSON schemas from the installed host.

## Understand the design

- [Source, representations, and projects](architecture.md): what stays editable, what a receipt proves, and how local and cloud work fit together.
- [Choose an HTML authoring surface](html-overlay-creative-toolkit.md): why DOM, vector, Three.js, and explicit GPU profiles serve different jobs. Its ecosystem research is dated separately from its supported locks.

## Work with an agent

The [ATET Agent Skill](../skills/atet/SKILL.md) routes an agent to the relevant task reference. Install the version-matched skill with your CLI; installing a skill alone does not install native tools or enable commands absent from that release. See the [installation instructions](../README.md#install-atet).
