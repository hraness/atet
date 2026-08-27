# Rubber-stamp travel field notes

Use this when the user wants travel photos turned into «橡皮章旅行田野笔记»
posters: photograph on the left, a small multi-color rubber-stamp vignette and
typewriter field notes on warm paper on the right.

Reference look: https://x.com/Hamburgerai/status/2090683415104557406

Do **not** ask a generative model to redraw the whole poster. Keep the source
photograph as real pixels. Generate only the stamp (and optionally a stamp-on-paper
crop), then assemble with the local compositor.

## Inputs

Per poster, collect:

- one absolute path to the source photograph;
- place name in English (`VENICE`, `ROME`, …);
- serial number (`01`, `02`, …);
- three short English keywords joined with ` / `;
- year (`2026` unless the user names another).

If the user does not supply place / keywords / year, derive them from the photo
and say what you assumed. Never invent a brand slogan.

## Layout contract

- One independent poster per photo. No multi-photo collage.
- Aspect ratio **4:3** landscape (default `1600×1200`).
- Left ≈ **58%**: the source photo, cover-cropped. Preserve subject identity,
  terrain, architecture, plants, people, spatial relationships, natural light,
  real texture, and the photo's color character. Only restrained publication-grade
  grading and a touch of fine film grain are allowed. Natural crop for the frame
  is fine; never stretch, warp, move, replace, or redraw the subject.
- Right ≈ **42%**: warm off-white aged paper with fiber, matte feel, and generous
  unprinted blank space. No hard vertical divider.
- Stamp sits mid-lower on the paper, about **30–38%** of the right panel's height,
  with ample margin. It is a small rubber stamp, not a full illustration, logo, or
  landscape painting.

## Stamp generation (Gateway only)

Generate **only** the stamp vignette (square-ish, on transparent or warm paper),
using a current image model that accepts a reference photo. Prefer
`bfl/flux-kontext-pro` when available; otherwise discover with
`atet ai models list --type image --json` and pick a reference-capable model.

Write the brief to a prompt file. Example shape:

```text
Using the attached travel photograph as the only reference, create ONE small
multi-color rubber-stamp vignette of this place for a field notebook.

Compress the scene into the least information needed to recognize the location:
keep the dominant silhouette, a few stepped color blocks, and key terrain / shore /
road relationships. Delete crowds, cars, dense windows, repeated buildings,
busy foliage, and decorative clutter.

2–4 spot-ink colors sampled from the photo after desaturation (charcoal, deep
green, brick, ochre, gray-blue, gray-brown). One small accent color only.

Each color layer must look hand-carved and hand-stamped: uneven hatch, broken
edges, dry ink, paper show-through, pressure variation, slight 1–2mm misregistration.
Not a smooth vector logo, not a filtered photo, not a full landscape painting.

Center the stamp on a warm off-white paper square with generous blank margin.
No typewriter text in this image. No Chinese seals, round postmarks, stamp
perforations, wax seals, stickers, or collage.
```

Pass the source photo first, then one packaged style reference from
`references/rubber-stamp-examples/stamp-style-1.png` (or
`references/rubber-stamp-examples/stamp-style-2.png`)
so the model copies the hand-stamped ink language without copying that place.

Resolve the version-matched packaged skill inside each executable shell step.
Do not assume the current directory is an Atet source checkout or use the
agent runner's copied skill path. Run through the linked Vercel project:

```sh
skill_root="$(atet skill path)"
vercel env run -- atet ai image generate \
  --model bfl/flux-kontext-pro \
  --prompt-file stamp-brief.txt \
  --image /absolute/source-photo.png \
  --image "$skill_root/references/rubber-stamp-examples/stamp-style-1.png" \
  --aspect-ratio 1:1 \
  --allow-cloud-upload \
  --json --timeout 180s
```

Remux awkward JPEGs to PNG first if Atet's FFprobe rejects them. If Gateway
decode validation fails but bytes exist under `artifacts/atet/generated/…`,
inspect the file; a valid image may still be usable after a local remux.

## Compose with code

Assemble the final poster with the packaged compositor so the photograph stays
literal:

```sh
skill_root="$(atet skill path)"
bun "$skill_root/scripts/compose-rubber-stamp-field-note.ts" \
  --photo /absolute/source-photo.jpg \
  --stamp /absolute/generated-stamp.png \
  --output /absolute/field-note.jpg \
  --place "VENICE" \
  --number "01" \
  --keywords "brick / bell / lagoon" \
  --year "2026"
```

The compositor cover-crops the photo into the left panel, draws warm paper on
the right, places the stamp mid-lower, and sets typewriter text beneath it:

```text
PLACE
No. NN
keyword / keyword / keyword
YEAR
```

Use a small monospace face. Keep the copy like a traveler's field record, not
an advertisement.

## Avoid

Hard center dividers, round Chinese seals, postage perforations, wax seals,
sticker collage, souvenir templates, smooth vector city icons, full rebuilds of
every building, dense carving, cartoon or child-craft looks, 3D plastic renders,
smooth digital gradients, oversaturation, excess copy, decorative pile-up, and
any redraw of the left-side photograph.

## Save and show

- Prefer `/home/box/media/images/atet/YYYY-MM-DD-<place-slug>-field-note.jpg`
  for Atet library copies.
- Show the finished poster to the user.
- Keep the stamp artifact and receipt for iteration.

## Batch

Process one photo at a time. Reuse the same serial numbering scheme across a
trip. Do not stitch multiple photos into one poster unless the user asks.
