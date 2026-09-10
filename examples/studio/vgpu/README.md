# Render an energy-flow panel with vgpu

This example renders an animated diagram on a Metal GPU, then saves an opaque sRGB PNG sequence for an existing scene renderer to use as a screen surface. The energy split is authored illustrative data. The pulses and colored glazing explain the graphic; they are not a thermal simulation or measured performance.

The example runs as an explicit trusted Node command. Importing its module does not load vgpu, execute a shader or acquire a GPU. It does not add a new SLOPCAMERA scene engine, a provider client or an editor. SLOPCAMERA's existing Three.js renderer can retain scene and camera ownership when consuming the resulting media.

## Provision a separate runtime

Use Node 24 on macOS for the qualified profile. Upstream vgpu documents Node 22+; other runtimes and GPU backends require separate qualification. Keep these dependencies in a dedicated directory outside tracked source:

```json
{
  "name": "slopcamera-vgpu-example-runtime",
  "private": true,
  "type": "module",
  "dependencies": {
    "vgpu": "0.4.1",
    "pngjs": "7.0.0"
  }
}
```

In that directory, generate a lockfile and install with lifecycle execution disabled:

```sh
npm install --package-lock-only --ignore-scripts
npm ci --ignore-scripts
```

The pinned vgpu adapter uses `webgpu@0.4.0`, which includes native Dawn binaries. Its macOS install hook normally modifies quarantine metadata, while vgpu's adapter hook may download a fallback binary. This example does not execute those hooks or modify platform security settings. Provision and review the native runtime separately if loading it fails.

## Render

Create the parent of the output directory first. The output directory itself must be new. Paths must be absolute and physical; the command preserves prior runs.

```sh
node /absolute/slopcamera/examples/studio/vgpu/heat-field.mjs \
  --runtime /absolute/vgpu-runtime \
  --output /absolute/retained-media/new-energy-panel
```

On Hraness hosts, wrap this native command with the installed `oompa-host-run` in the `mac-native` lane. The default output is 96 frames at 24 fps, 768×432. Optional `--frames`, `--start-frame`, `--width` and `--height` values remain within a 16:9, 1024 px, 240-frame profile. A frame's shader time is its absolute frame number divided by 24; a selected nonzero interval retains that time while filenames begin at zero.

Unset ambient `VGPU_*`, `NODE_OPTIONS` and `NODE_PATH` settings before invocation. The example rejects these overrides, explicitly requests Metal hardware, checks the observed hardware adapter and loaded native module, and records their identities. It permits no automatic CPU fallback as successful evidence.

Each frame contains GPU-rendered pixels and original bitmap labels added after readback. Numerical energy quantities are separate from display colors. The shader performs the piecewise sRGB transfer; each PNG carries an explicit sRGB chunk. Calibration checks top-left row order, RGB channel order and an sRGB middle-gray value. Every retained PNG is decoded and compared with its source bytes.

`manifest.json` records absolute times, runtime and native-binary hashes, shader/source/lock hashes, actual adapter identity, interpretation and frame digests. It appears after all frames verify and the GPU wrapper disposes. An incomplete directory has no completion manifest and remains available for diagnosis. This optional trusted runtime is not an OS sandbox or a hermetic dependency closure.

The PNG files are ordinary media. Import them through a supported SLOPCAMERA media path with their manifest's frame cadence and sRGB interpretation; no vgpu object needs to cross into Three.js. Encoding them or admitting them to a native Studio job is a separate explicit action. The current native Studio adapters do not execute WGSL.

## Check without a GPU

Run these tests from a source checkout; the published package includes the example and this guide, but omits test files.

```sh
node --test examples/studio/vgpu/heat-field.test.mjs
```

These tests cover bounds, nonzero frame clocks, energy conservation, override rejection, authored layout and PNG tagging. They do not claim native shader execution. Actual hardware qualification must also inspect the retained frames.

The September 9, 2026 qualification rendered 96 distinct frames on an Apple M4 Max with Metal 3 and Node 24.18.1. All PNG pixel comparisons and color/orientation calibration passed. Absolute frame 24 was identical when rendered in a fresh process alone, in a three-frame interval starting at 23, and in the full sequence starting at zero. That observation applies to this pinned runtime and device; it is not a cross-device bitwise guarantee.

For future Three WebGPU work, vgpu provides a [WGSL-to-TSL bridge](https://github.com/vercel-labs/vgpu/blob/ca6cf99fbeb109a3294d043a10de16819e1b9dad/docs/topics/threejs.docs.md). That bridge leaves Three in charge of scenes and resources. It does not establish compatibility with SLOPCAMERA's current WebGL2/Spark profile. [Node runtime requirements](https://github.com/vercel-labs/vgpu/blob/ca6cf99fbeb109a3294d043a10de16819e1b9dad/packages/adapter-node/README.md).
