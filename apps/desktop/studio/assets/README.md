# Retained Poly Haven assets

This adapter finds free Poly Haven assets and imports an explicitly selected file set into a local studio source directory. Search and import results identify Poly Haven, retain the artists' credits, and distinguish the CC0 asset license from the API service terms.

Poly Haven's current API terms permit personal and commercial use without a key or payment. API clients must identify their application and make the source of surfaced content clear. SLOPCAMERA sends `SLOPCAMERA/StudioAssets (+https://slop.camera)` and returns `Powered by Poly Haven`. The assets themselves remain CC0 without an attribution requirement. These terms were checked on September 9, 2026 against the [current API terms](https://raw.githubusercontent.com/Poly-Haven/Public-API/master/ToS.md), the [July 18 API announcement](https://polyhaven.com/our-api), and the [asset license](https://polyhaven.com/license).

## Service interface

`createPolyHavenAssetService({storageRoot, fetch?, signal?, beforePublication?})` exposes `search(input)`, `describe(assetId)`, `plan(selection)`, and `importAsset(plan)`. `storageRoot` must be an existing physical private directory, normally below `artifacts/slopcamera/generated/studio-assets`. The optional fetch and publication hooks are host-owned runtime dependencies; they never enter a retained plan.

Search input is `{provider:"poly-haven",query:"warm studio",type:"hdris",limit:8}`. Types are `all`, `hdris`, `textures`, and `models`; limits are one through 20. The adapter calls the documented `/search` endpoint and fetches metadata only for those bounded results. It preserves provider result order. Similarity scores do not independently explain the hybrid ranking or prove suitability. [Official API specification](https://raw.githubusercontent.com/Poly-Haven/Public-API/master/swagger.yml)

Selections require `provider`, `assetId`, `resolution`, `kind`, and `format`. `maximumTotalBytes` defaults to 50 MiB and cannot exceed 512 MiB. Supported resolutions are `1k`, `2k`, and `4k`.

| Kind | Formats | Selection |
| --- | --- | --- |
| `hdri` | `hdr`, `exr` | One exact environment file |
| `texture` | `png`, `jpg`, `exr` | An explicit `maps` array using catalog names such as `Diffuse`, `Rough`, and `nor_gl` |
| `model` | `gltf` | One glTF 2.0 file and its complete catalog `include` dependencies |

`describe` returns asset/author metadata and bounded provider snapshots, so an agent can inspect available variants before selecting one. Plans retain canonical snapshots, exact selected URLs, MD5 checksums, byte counts, relative paths, credits, and a SHA-256 plan identity. `parsePolyHavenAssetPlan` recomputes the entire plan from its snapshots and selection. It rejects changed counts, omitted dependencies, conflicting paths, unexpected fields, and altered provenance.

## Acquisition and replay

Downloads use only HTTPS `api.polyhaven.com` metadata endpoints and `dl.polyhaven.org/file/ph-assets/` asset paths. Credentials, URL fragments, query strings on asset downloads, alternate ports, redirects, and arbitrary remote URLs reject. Each file is at most 128 MiB, each complete selection is at most 64 files, and response capture checks actual streamed bytes. Requests have a bounded deadline and honor host cancellation. There are no automatic retries, uploads, credential reads, or provider charges.

Import verifies catalog size and MD5, checks supported file signatures, and computes local SHA-256 identities. The shared physical storage adapter publishes each exact source file with atomic no-replace semantics. Completion is published only after the entire source closure verifies. An interrupted import can reuse already verified files; a completed import rechecks all retained files and its receipt without network access. Conflicting bytes or undeclared files reject rather than being replaced.

Exact download stages remain retained as recovery evidence, so disk usage can exceed the network byte budget. Source files live in `imports/<planSha256>/source`; the canonical plan and receipt live beside that directory. The import result returns the private absolute `sourceRoot`, the relative `receiptPath`, and its receipt identity. Agents explicitly include the selected source files in the ordinary studio bundle before rendering. Acquisition does not execute a renderer or append objects to a scene.

The glTF subset accepts explicit local `.bin`, PNG, and JPEG dependencies. It verifies every buffer/image URI against the catalog closure and checks declared buffer byte lengths. Remote/data URIs, hidden resource references, unsupported extensions, omitted dependencies, and unreferenced catalog includes reject. Common material and texture-transform extensions are supported; compressed geometry and additional image formats require a separately qualified profile. Native `.blend`, scripts, archives, FBX, USD, and GLB are not acquired by this subset. Existing explicit native-source import paths retain such source as inert bytes until a separately authorized render.

Provider metadata and transport checksums are evidence of what was fetched. They do not establish cryptographically authenticated authorship, renderer compatibility, physical calibration, or absence of hostile native decoder inputs. API thumbnail metadata is not assigned the CC0 asset-file license, and the importer does not fetch preview images.

## Validation

`bun test apps/desktop/studio/assets/poly-haven.test.ts` runs network-free regressions for canonical plans, foreign accessors, source URLs, budgets, glTF dependencies, cancellation, publication custody, interrupted acquisition, and offline replay.

The opt-in `qualify-live.ts <fresh-absolute-ignored-directory>` imports `venice_sunset` at 1k HDR and `dirty_football` at 1k glTF. It enforces a combined 50 MiB free download ceiling and requires both complete imports to replay with networking disabled. The September 9 qualification retained six exact files totaling 3,435,401 bytes: 1,440,400 bytes of HDRI and 1,995,001 bytes of model/source dependencies. The qualification writes its evidence into the requested ignored directory. This verifies acquisition and local dependency closure, not a native render of the imported asset.
