export type EditorialReading = Readonly<{
  alt: string
  canonicalPath: `/reading/${string}`
  caption: string
  credit: string
  datePublished: `${number}-${number}-${number}`
  description: string
  height: 864
  imageSha256: string
  provenance: Readonly<{
    job: string
    prompt: string
    receipt: string
  }>
  slug: string
  src: `/images/editorial/${string}.webp`
  title: string
  width: 1536
}>

const credit = "Editorial illustration generated for atet.sh with Atet."

export const editorialReadings = [
  {
    alt: "Simple geometric parts branching into six different abstract faces",
    canonicalPath: "/reading/draw-faces-with-javascript",
    caption: "A compact set of drawable parts can produce many inspectable variations.",
    credit,
    datePublished: "2026-08-26",
    description: "An Atet reading take on Mannay’s JavaScript faces: start from an inspectable source, then vary the operations in a local media project.",
    height: 864,
    imageSha256: "0d586de0f0b83acbfb9559e4c70137f8099ec77cecdf79084240cc36a25fc806",
    provenance: {
      job: "editorial-provenance/draw-faces-with-javascript/job.json",
      prompt: "editorial-provenance/draw-faces-with-javascript/prompt.txt",
      receipt: "editorial-provenance/draw-faces-with-javascript/receipt.json",
    },
    slug: "draw-faces-with-javascript",
    src: "/images/editorial/draw-faces-with-javascript.webp",
    title: "Keep the source small enough to vary",
    width: 1536,
  },
  {
    alt: "A cobalt desk lamp moving from a background through a precise cutout to a transparent canvas",
    canonicalPath: "/reading/feynobg",
    caption: "Source, edge decision, and reusable cutout remain visible as separate states.",
    credit,
    datePublished: "2026-08-26",
    description: "An Atet reading take on FeyNoBg: keep a background-removal output inspectable without replacing the original source.",
    height: 864,
    imageSha256: "1ec883cefb82656546757ddcc87e96b751b1a504762a6560c3c55856da630e94",
    provenance: {
      job: "editorial-provenance/feynobg/job.json",
      prompt: "editorial-provenance/feynobg/prompt.txt",
      receipt: "editorial-provenance/feynobg/receipt.json",
    },
    slug: "feynobg",
    src: "/images/editorial/feynobg.webp",
    title: "Keep the cutout from replacing the source",
    width: 1536,
  },
  {
    alt: "Translucent elliptical marks accumulating into an abstract flower",
    canonicalPath: "/reading/painting-with-gaussians",
    caption: "Individual marks remain visible as their layers accumulate into a finished form.",
    credit,
    datePublished: "2026-08-27",
    description: "An Atet reading take on Sotnikov’s painterly Gaussian renderer: keep stroke decisions in a controllable renderer after an agent proposes marks.",
    height: 864,
    imageSha256: "85c08d0d73146d33c86e7cb80f444a44480ed3bfa9ea67259ebad687f129d467",
    provenance: {
      job: "editorial-provenance/painting-with-gaussians/job.json",
      prompt: "editorial-provenance/painting-with-gaussians/prompt.txt",
      receipt: "editorial-provenance/painting-with-gaussians/receipt.json",
    },
    slug: "painting-with-gaussians",
    src: "/images/editorial/painting-with-gaussians.webp",
    title: "Keep the stroke decision in the renderer",
    width: 1536,
  },
  {
    alt: "Film frames becoming editable fragments, a rendered frame, and a local timeline",
    canonicalPath: "/reading/gemini-omni",
    caption: "Generated frames become source material inside a timeline that can still be inspected.",
    credit,
    datePublished: "2026-08-28",
    description: "An Atet reading take on Gemini Omni 1.1 Flash: extra prompt control on a general video model is not a replacement for generation knobs in a local renderer.",
    height: 864,
    imageSha256: "02317e2355f75430c2649c17b93a7cd38e79db634ff7e101b3a3dc4dc36724ca",
    provenance: {
      job: "editorial-provenance/gemini-omni/job.json",
      prompt: "editorial-provenance/gemini-omni/prompt.txt",
      receipt: "editorial-provenance/gemini-omni/receipt.json",
    },
    slug: "gemini-omni",
    src: "/images/editorial/gemini-omni.webp",
    title: "Control in the renderer still beats a bigger Omni prompt",
    width: 1536,
  },
  {
    alt: "Colored stroke tokens remaining visible as they assemble into an abstract hibiscus",
    canonicalPath: "/reading/paint-with-code",
    caption: "The sketch stays inspectable after the painted form appears.",
    credit,
    datePublished: "2026-08-31",
    description: "An Atet reading take on Narreddi’s p5.brush painter: keep the generated artefact as editable code rather than a finished raster or a longer prompt.",
    height: 864,
    imageSha256: "6697d98fe403c84f3b35e217bebdde49b620192e0856afcc21878b520a313c1a",
    provenance: {
      job: "editorial-provenance/paint-with-code/job.json",
      prompt: "editorial-provenance/paint-with-code/prompt.txt",
      receipt: "editorial-provenance/paint-with-code/receipt.json",
    },
    slug: "paint-with-code",
    src: "/images/editorial/paint-with-code.webp",
    title: "Keep the painting as code you can edit",
    width: 1536,
  },
  {
    alt: "A sealed prompt ribbon breaking into inspectable tiles and variant frames on a local workspace",
    canonicalPath: "/reading/how-i-design-with-ai",
    caption: "Design decisions stay visible as separate pieces after they leave the prompt.",
    credit,
    datePublished: "2026-09-01",
    description: "An Atet reading take on Dailey’s design-with-AI note: keep editable design decisions in the media tool and workflow rather than a bigger prompt dump.",
    height: 864,
    imageSha256: "73e13d179fd386a67b9d06503514c530d48c62bde55180dd024f310356c41280",
    provenance: {
      job: "editorial-provenance/how-i-design-with-ai/job.json",
      prompt: "editorial-provenance/how-i-design-with-ai/prompt.txt",
      receipt: "editorial-provenance/how-i-design-with-ai/receipt.json",
    },
    slug: "how-i-design-with-ai",
    src: "/images/editorial/how-i-design-with-ai.webp",
    title: "Keep the design decision in the media tool",
    width: 1536,
  },
] as const satisfies readonly EditorialReading[]

export type EditorialReadingPath = (typeof editorialReadings)[number]["canonicalPath"]

export function editorialReading(path: EditorialReadingPath): EditorialReading {
  const reading = editorialReadings.find(candidate => candidate.canonicalPath === path)
  if (reading === undefined) {
    throw new Error(`Unknown editorial reading path: ${path}`)
  }
  return reading
}

export function editorialImageUrl(reading: EditorialReading): string {
  return `https://atet.sh${reading.src}`
}

export function editorialImageSrcSet(reading: EditorialReading): string {
  const stem = reading.src.slice(0, -".webp".length)
  return `${stem}-384.webp 384w, ${stem}-768.webp 768w, ${reading.src} ${reading.width}w`
}
