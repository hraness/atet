# Visual communication rules

Use these rules to turn supplied content into a diagram without adding content.

## Start with the claim

A diagram should make one relationship, comparison, sequence, or hierarchy easy
to perceive. Write down that supplied claim privately before placing shapes.
Every primary mark must help the viewer perceive it. Remove marks that merely
repeat styling.

Keep the semantic inventory small:

- Three to seven primary objects is a useful default for a high-level overview.
- A viewer should be able to name the reading order after a quick glance.
- Labels should normally be one to three words. Use a second diagram when the
  only way to fit the content is paragraph-sized labels.

These are compression rules, not permission to omit facts the user explicitly
asked to show.

## Make visual grammar consistent

Similarity implies shared meaning. Proximity implies grouping. Alignment implies
relationship. Encode those implications deliberately:

- Equal roles use equal geometry and treatment.
- A size change must encode a supplied magnitude or hierarchy.
- A color change must encode a supplied category or state.
- A different shape must encode a different kind of object.
- Group with whitespace and position before adding a new enclosing border.
- Do not mix rounded and hard corners for peers.

When appearance varies without a reason, a viewer spends attention searching
for a distinction that does not exist.

## Route relationships clearly

Connectors need room to be seen as connectors.

- Keep at least 96px of visible connector between shape boundaries; prefer
  120–200px.
- Bind each semantic arrow to its source and target.
- Point arrowheads into open space at the target edge.
- Avoid crossings. If a crossing is unavoidable, change the layout before
  adding bridge decorations.
- Keep connector labels short and off the path.
- Do not use an arrow where proximity or containment already states the
  relationship.

Longer arrows are the default because a short arrow can collapse into the
neighboring strokes and make two objects look like one component.

## Use icons as recognition cues

- Use one icon family and one stroke language in a diagram.
- Keep peer icons the same optical size.
- Render an icon bare inside its existing card or shape.
- Do not add a second bordered icon container inside a bordered card.
- Pair an icon with a short label when the glyph is not universally understood.
- Never let an icon introduce a fact absent from the prompt.

## Build hierarchy without prose

Use position, whitespace, and restrained contrast before size or saturation.
Make the important path visually continuous. Keep supporting objects quieter.
Avoid shadows, gradients, textures, and ornamental strokes unless they encode
requested meaning.

For light and dark variants:

- Preserve the same geometry and semantic contrast.
- Test text and thin strokes against their immediate background.
- Do not encode meaning only by hue.
- Keep axis and connector strokes single and opaque enough to avoid a faint
  inner-line effect.

## Sources behind the rules

These defaults synthesize established work rather than copying a house style:

- Gestalt principles of proximity, similarity, continuity, and enclosure.
- Colin Ware, *Information Visualization: Perception for Design*, on
  preattentive features and visual queries.
- Stephen Kosslyn, *Graph Design for the Eye and Mind*, on perceptual grouping
  and correspondence between visual marks and meaning.
- Richard Mayer's coherence principle: exclude extraneous material that
  competes with the intended explanation.
- Barbara Tversky's work on spatial representations and diagrams as external
  structures for inference.

The practical test is semantic: if a visual difference makes a reasonable
viewer infer a difference that the prompt did not supply, remove it.
