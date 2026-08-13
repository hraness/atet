# Reference-led Three.js and metallic treatments

Use this guide only when Transmute's complete local Code Mode host is available.
It ships in this repository alongside the thin desktop capture shell. The
portable `@hraness/transmute/code` and `@hraness/transmute/workflow`
entrypoints intentionally expose no HTML renderer, Three.js operation, or
arbitrary source execution. Those capabilities belong to the local host.

## Separate reference generation from source execution

An image model may supply a visual reference. It must not supply executable
authority.

1. Generate or select one reference image and preserve its exact artifact
   record.
2. Inspect the subject, silhouette, palette, proportions, negative space, and
   intended polygon character.
3. Run `transmute html scaffold three --output <scene.html>`. The command does
   not overwrite an existing source.
4. Edit only the scaffold's `createSubject()` region unless the requested
   camera, lights, or timing require a reviewed change elsewhere.
5. Run Code Mode checks and render a full-length 1x preview.
6. Inspect the first, middle, and last frame plus at least two useful angles.
7. Change the checked scene source, not a rendered frame. Render a final target
   only after selection.

Do not collapse those stages into an operation that accepts JavaScript text.
Local Code Mode is trusted local code with the current user's authority. It
is not a sandbox. The reviewed physical source and its imports enter the graph
identity before an effect can execute.

## Bind the reference to the reviewed scene

In a local Code Mode module, use the typed helper with the image artifact
and its projected media type:

```ts
const generated = workflow.gateway.image("reference", imageOptions);
const reference = generated.select("outputs").at(0);
const binding = createThreeReferenceScaffoldInput(
  reference,
  reference.select("mediaType"),
);
const scene = workflow.media.htmlOverlay("scene", {
  ...binding,
  document: { path: "overlays/reviewed-scene.html" },
  canvas: { deviceScaleFactor: 1, height: 1080, width: 1920 },
  parameters: { explode: 0.35, orbitTurns: 1, zoom: 1 },
  project,
  range: { startUs: 0, endUs: 3_000_000 },
  timing: { durationUs: 3_000_000, fps: 30 },
});
```

The resource binding verifies path, bytes, SHA-256, and media type. A mismatch
fails before the browser render. The reference remains execution provenance
even when the final scene does not display it.

If the scene uses the reference as a color texture, load only its declared
private URL and settle decoding before frame zero:

```js
const texture = new THREE.TextureLoader()
  .loadAsync(TransmuteOverlay.asset("reference-image"))
  .then((loaded) => {
    loaded.colorSpace = THREE.SRGBColorSpace;
    return loaded;
  });
TransmuteOverlay.ready(texture);
```

Never load a remote URL, data URL, object URL, undeclared font, environment map,
or model file from scene code.

## Preserve deterministic motion

- Derive every visible state from `progress`, `timeMs`, parameters, or
  `TransmuteOverlay.randomFor(key)`.
- Do not use `requestAnimationFrame`, `setAnimationLoop`, wall-clock time,
  mutable random sequences, pointer input, or cumulative per-frame state.
- Create geometry, materials, textures, vectors, matrices, and arrays before
  `onFrame`. Avoid allocation and asset loading inside the frame callback.
- Keep the first and last frame loop-compatible when the result is a loop.
- Use one `renderer.render(scene, camera)` call per frame unless a reviewed
  multipass effect justifies the extra cost.

## Keep generated Three.js inexpensive

The starter defaults to 64 draw calls and 200,000 triangles per frame. Keep
those ceilings unless the user chooses a measured exception.

- Reuse geometry and materials. Use `THREE.InstancedMesh` for repeated forms.
- Prefer flat-shaded primitives, indexed `BufferGeometry`, and a few deliberate
  lights for low-poly subjects.
- Leave shadows, postprocessing, physics, environment maps, logarithmic depth,
  and high-detail subdivisions off by default.
- Fit the camera from `Box3` or a bounding sphere rather than hand-tuning it for
  one output ratio.
- Keep opaque objects opaque. Preserve alpha in the renderer and background,
  rather than making every material transparent.
- Track every geometry, material, texture, and render target. Dispose them and
  the renderer when the page closes.
- Set color textures to `THREE.SRGBColorSpace`. Leave normal, roughness, metal,
  and other data textures in their default no-color space.
- Use a 1x canvas for the full-duration preview. A selected final may raise
  device scale or destination dimensions. Do not shorten the preview to hide a
  late-frame failure.

Compare output at each destination aspect ratio. Camera fit, negative space,
caption-safe areas, and transparent edges can fail even when the source scene
is valid.

## Create a metallic logo candidate

Use the supplied logo image as the sole shape authority. The treatment has
three literal creative variables: brand name, background color, and object
color. Model selection is separate because image-reference support changes by
provider.

```ts
const candidate = workflow.gateway.image("metallic-logo",
  createMetallicLogoImageRequest({
    backgroundColor: "warm gray",
    brandName: "Hraness",
    model: input.imageModel,
    objectColor: "brushed cobalt",
    reference: input.logo,
  }));
```

For direct local CLI use, choose a live image model that accepts reference
images, then pass the exact logo with `--image` and the required
`--allow-cloud-upload`. Inspect model capabilities before dispatch. Do not
silently upload a local brand asset.

Treat every output as a candidate. Reject it when the silhouette, negative
space, proportions, orientation, or existing lettering changes. Reject added
text, duplicated marks, invented symbols, cropped edges, implausible bevels,
dirty reflections, or a background that contaminates the mark. Preserve the
reference and prompt receipt beside an accepted derivative.
