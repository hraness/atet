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
    alt: "Colored stroke tokens remaining visible as they assemble into an abstract hibiscus",
    canonicalPath: "/reading/paint-with-code",
    caption: "The sketch stays inspectable after the painted form appears.",
    credit,
    datePublished: "2026-08-31",
    description: "Why generated painting should remain editable code, using Narreddi’s p5.brush experiment and Atet’s local project model.",
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
