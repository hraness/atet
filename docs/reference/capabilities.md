# Capabilities, versions, and platforms

This reference describes the current Slopcamera CLI and its runtime requirements. A package's version number alone does not identify a source checkout; inspect its commit and actual command help.

## Current Slopcamera and historical Atet

Slopcamera v3.2.4 installs from its [canonical release archive](https://github.com/hraness/slopcamera/releases/download/v3.2.4/hraness-slopcamera-3.2.4.tgz) or from [source](../how-to/use-current-source.md). The historical **Atet v3.2.3** archive contains `@hraness/atet` and the `atet` command; it does not install Slopcamera.

| Surface | Historical Atet v3.2.3 | Slopcamera v3.2.4 |
| --- | --- | --- |
| Diagrams, vectorization, Gateway media, recording, ordinary project edits, local workflows | Available with the relevant local tools and credentials | Available |
| Editable spatial scenes, calibrated scene cameras, V2 shots, Three hardware and Spark profiles, saved-world import | Available | Available |
| Paid World Labs world commands | Present in the historical release | Removed; saved-world import and historical provenance replay remain |
| Retained short-video directing: `direct …` | Absent | Available |
| Blender, CadQuery, Manim and acquisition: `studio …` | Absent | Available |
| Native output admission: `studio asset` | Absent | Available |
| Calibrated camera samples: `scene camera-track` | Absent | Available |
| External vgpu 0.4.1 native example | Absent | Explicit example runtime; not a new registered studio engine |

Use the Slopcamera release installation or a source build for the commands below. Do not substitute the renamed package or executable into an old Atet archive URL, silently switch versions, or use historical paid-world commands as a substitute for the current saved-world workflow.

## Discover the installed contract

| Need | Discovery command |
| --- | --- |
| CLI version and top-level commands | `slopcamera --version`, `slopcamera --help` |
| Grammar for a command family | `slopcamera help project`, `slopcamera help studio`, `slopcamera help scene` |
| Local tools and readiness | `slopcamera doctor --json` |
| Closed local operation catalog and exact schemas | `slopcamera operations list --json`, `slopcamera operations show <kind>[@<version>] --json` |
| Built-in workflow input schema | `slopcamera workflows list --json`, `slopcamera workflows show <id> --json` |
| Live Gateway model capabilities | `slopcamera ai models list --type <type> --json`, `slopcamera ai models show <id> --json` |
| HTML profile locks | `slopcamera html catalog --json` |
| Version-matched packaged agent instructions | `slopcamera skill path` |

The portable `code search/execute` and MCP surface has four operations: diagram check, diagram render, image generation, and vectorization. The complete local host has a larger closed registry. Neither surface allows a caller to register arbitrary operations. See [SDK surfaces](sdk.md).

## Local execution profiles

| Work | Required runtime and boundary |
| --- | --- |
| Diagram JSON, SVG/PNG and tldraw export | Bun package and bundled rendering dependencies; no tldraw app required |
| Vectorization | Bounded macOS/Linux profile; checksum-pinned VTracer can be obtained on first use. Windows deliberately rejects this profile |
| Ordinary media and delivery | FFmpeg/FFprobe; additional analysis dependencies are reported by `doctor` |
| Screen/camera/microphone/system-audio recording | Native macOS capture support and the selected operating-system permissions |
| HTML or Three rendering | Admitted local Chrome runtime and declared assets; dependencies may need initial verified provisioning |
| `three-webgl2-hardware-v1` | Qualified macOS ANGLE Metal WebGL2 context; software or unknown fallback rejects |
| `three-spark-webgl2-hardware-v1` | Separate qualified Spark profile for bounded saved splats; its format, camera and output limits apply |
| Blender | Explicit executable selection; CPU or requested GPU. A GPU request never silently falls back to CPU |
| CadQuery / Manim | Explicit Python environment; Manim uses its qualified Cairo profile and owns silent visuals |
| External vgpu native example | Separately provisioned pinned Node/Dawn runtime; distinct from the browser overlay lock |

Native studio qualification used Blender 5.2.1 LTS, CadQuery 2.8.0 and Manim Community 0.21.0. These observations do not certify every plugin, solver, device or imported asset. [Native profile limits](../studio.md#qualified-profiles-and-extension-limits) and [spatial asset limits](../spatial-scenes.md#asset-and-rendering-profile) describe the admitted representations.

The copied macOS executable supports direct studio commands with embedded starters and drivers. Local Code Mode workflows still require the source-backed Bun distribution for their build-identity scan. A desktop UI, a copied binary, and the Bun package are not interchangeable installation prerequisites.

Ordinary media import requires an existing project. Creation currently starts from a stopped recording or a successful studio/directing assembly; arbitrary standalone files cannot directly bootstrap an empty project through the public CLI or SDK. [Video editing](../how-to/edit-video.md#inspect-the-source-and-project) explains this boundary.

## Commands that can cross the network boundary

Gateway model discovery and paid generation, selected cloud analysis, optional private Blob reference hosting, Poly Haven acquisition, and first-use runtime or tool provisioning have separate network roles. Rendering from a prepared local closure does not upload a project. Credentials and explicit upload/trusted-code acknowledgements remain invocation-scoped; a local source import does not authorize executing it or sending it to a model.

Directing budgets use catalog estimates, not provider-enforced spending caps. Native supervision and hash receipts provide process control and observed provenance, not an OS sandbox or complete hermetic dependency closure.
