# Positive face fixture provenance

`face-positive-fixture.jpg` is a 640 × 360, 24 KB test-only image containing
three fictional adults. It exists solely to prove that the signed offline Apple
Vision helper returns every clearly separated face, rather than only proving a
no-face result.

- Generated: 2026-07-24 with OpenAI's built-in image-generation tool.
- Original generated PNG SHA-256:
  `2d2761f3cb87a956ab74f25cd5ed1e5fb4a93a9fbc898c310a597be273d7ca0f`.
- Checked JPEG SHA-256:
  `45820150baeabab6b6841aa825404f9e22985cbc6f999d50a9d696d6b810bb6a`.
- Derivation: FFmpeg scale-and-pad to 640 × 360, white padding, JPEG quality 4.
- Subjects: generated and fictional; no user recording, name, identity label,
  embedding, crop corpus, or biometric reference is present.

The generation prompt was:

> Create a realistic, high-resolution horizontal 16:9 group portrait
> containing exactly three fictional adults, all clearly visible from the
> shoulders up and looking toward the camera, against a plain neutral transmute
> backdrop. Use natural photorealistic photography, soft even frontal transmute
> lighting, high facial detail, neutral expressions, separated faces, and
> generous framing. Use diverse appearances. Include no occlusion, sunglasses,
> hats, hands, objects, logos, text, watermark, duplicated features, cropped
> heads, profile-only faces, blur, or stylization.
