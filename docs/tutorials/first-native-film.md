# Render your first native film

Create a one-second product shot in Blender, inspect its retained frames, and export it through an ordinary Slopcamera video project. You will keep the native source and the encoded clip as separate artifacts.

This lesson uses Slopcamera's native studio commands. Complete [source installation](../how-to/use-current-source.md), which defines `slopcamera` for the built checkout, and verify `slopcamera help studio` lists `init`, `run`, `encode` and `assemble`. The following setup uses macOS, Blender 5.2.1 LTS, Bun, FFmpeg and FFprobe. Set `SLOPCAMERA_BLENDER_BIN` to your installed Blender executable; the usual application path is shown below. The small preview deliberately uses CPU rendering; no cloud service or GPU is required.

## Create and retain the source

In the new production working directory created during source setup, select Blender:

```sh
export SLOPCAMERA_BLENDER_BIN="/Applications/Blender.app/Contents/MacOS/Blender"
test -x "$SLOPCAMERA_BLENDER_BIN"
```

If that check fails, use the actual executable path of your existing Blender installation before continuing. Then retain a starter:

```sh
slopcamera studio init product --template blender-product --json
slopcamera studio bundle product/source.json --json > product-bundle.json
```

Open `product/scene.py` and `product/source.json`. The manifest lists the Python scene and its helper explicitly. The bundle result contains the digest of the retained copies; neither command executes the scene.

## Make a small preview job

Create `prepare-preview.ts` in the working directory:

```ts
const job = await Bun.file("product/job.json").json()
const bundle = await Bun.file("product-bundle.json").json()
job.jobId = `studio_tutorial_${crypto.randomUUID()}`
job.bundleSha256 = bundle.bundleSha256
job.engine.device = "cpu"
job.engine.samples = 8
job.render.width = 320
job.render.height = 180
job.render.startFrame = 0
job.render.endFrameExclusive = 24
job.limits.timeoutSeconds = 180
job.limits.maximumOutputBytes = 134217728
job.limits.maximumOutputFiles = 128
await Bun.write("product/preview.job.json", JSON.stringify(job, null, 2))
```

Run it once, then inspect the plan and selected runtime:

```sh
bun prepare-preview.ts
slopcamera studio plan product/preview.job.json --json
slopcamera studio probe product/preview.job.json --blender-bin "$SLOPCAMERA_BLENDER_BIN" --json
```

The plan should contain 24 frames at 24 fps and a CPU request. Planning is inert; probing loads the fixed engine driver without executing your scene. Keep the job ID reported by the plan for the remaining steps.

## Render and inspect the shot

```sh
slopcamera studio run product/preview.job.json --blender-bin "$SLOPCAMERA_BLENDER_BIN" --allow-trusted-code --json
```

This flag authorizes the reviewed local Python source to run as your current user. It is not an OS sandbox. If the job fails, inspect that same job before choosing another attempt; do not repeatedly rerun it.

Use the returned `jobId` in place of `<studio-id>`:

```sh
slopcamera studio inspect <studio-id> --json
slopcamera studio encode <studio-id> --output-id beauty --json
```

A successful inspection lists the native `.blend` and 24 PNG frames with their hashes. Open the first and last PNGs from those returned paths. Encoding produces a separately retained RGB video and verifies every frame against the PNGs. The original frames and native scene remain available.

## Export an ordinary project

```sh
slopcamera studio assemble <studio-id> --output-id beauty --name "First product shot" --json
```

Copy the returned `projectId` into these commands:

```sh
slopcamera project inspect <project-id> --json
slopcamera project render plan <project-id> --width 320 --height 180 --fps 24 --output renders/first-shot.mp4 --json
slopcamera project render run <project-id> --width 320 --height 180 --fps 24 --output renders/first-shot.mp4 --json
```

The output and its receipt are relative to the project directory, not your shell’s working directory. For the default workspace, open `artifacts/slopcamera/projects/<project-id>/renders/first-shot.mp4`; the render result’s FFmpeg invocation also names the full output path. It should contain the complete one-second shot at 320×180. Keep the source bundle, job, native receipt and encoded derivative with the project. To direct another version, edit the source, retain a new bundle and choose a new job ID; the [native authoring guide](../studio.md) covers larger shots, caches and shared assets.
