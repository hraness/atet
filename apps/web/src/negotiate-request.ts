import {
  homeMarkdown,
  notFoundMarkdown,
  readingIndexMarkdown,
  readingFacesMarkdown,
  readingFeynobgMarkdown,
  readingGaussiansMarkdown,
  readingGeminiOmniMarkdown,
} from "./agent-pages"
import {
  htmlMediaType,
  markdownMediaType,
  notAcceptableBody,
  preferredRepresentation,
  preferredRepresentationFrom,
} from "./negotiate"

const markdownContentType = "text/markdown; charset=utf-8"
const notAcceptableContentType = "text/plain; charset=utf-8"
const previewNotAcceptableBody = "Not Acceptable\n\nAvailable: text/html\n"
const varyAccept = "Accept"
const varyAcceptAndEncoding = "Accept, Accept-Encoding"

function negotiatedBody(request: Request, body: string): string | null {
  return request.method.toUpperCase() === "HEAD" ? null : body
}

export function isHomePath(pathname: string): boolean {
  return pathname === "/" || pathname === "/index.html"
}

export function isReadingFacesPath(pathname: string): boolean {
  return pathname === "/reading/draw-faces-with-javascript"
    || pathname === "/reading/draw-faces-with-javascript.html"
}

export function isReadingIndexPath(pathname: string): boolean {
  return pathname === "/reading"
    || pathname === "/reading/"
    || pathname === "/reading/index.html"
}

export function isReadingFeynobgPath(pathname: string): boolean {
  return pathname === "/reading/feynobg"
    || pathname === "/reading/feynobg.html"
}

export function isReadingGaussiansPath(pathname: string): boolean {
  return pathname === "/reading/painting-with-gaussians"
    || pathname === "/reading/painting-with-gaussians.html"
}

export function isReadingGeminiOmniPath(pathname: string): boolean {
  return pathname === "/reading/gemini-omni"
    || pathname === "/reading/gemini-omni.html"
}

export function isPreservedRedirectPath(pathname: string): boolean {
  return pathname === "/docs" || pathname.startsWith("/docs/")
}

export function isPreviewPath(pathname: string): boolean {
  return pathname === "/preview" || pathname === "/preview.html"
}

export function isNegotiableDocumentPath(pathname: string): boolean {
  if (isPreviewPath(pathname)) {
    return true
  }
  if (
    isHomePath(pathname)
    || isReadingIndexPath(pathname)
    || isReadingFacesPath(pathname)
    || isReadingFeynobgPath(pathname)
    || isReadingGaussiansPath(pathname)
    || isReadingGeminiOmniPath(pathname)
    || isPreservedRedirectPath(pathname)
  ) {
    return true
  }
  if (pathname.startsWith("/assets/")) {
    return false
  }
  return !pathname.includes(".")
}

function canonicalHomeUrl(request: Request): string {
  return new URL("/", request.url).href
}

function canonicalReadingFacesUrl(request: Request): string {
  return new URL("/reading/draw-faces-with-javascript", request.url).href
}

function canonicalReadingIndexUrl(request: Request): string {
  return new URL("/reading", request.url).href
}

function canonicalReadingFeynobgUrl(request: Request): string {
  return new URL("/reading/feynobg", request.url).href
}

function canonicalReadingGaussiansUrl(request: Request): string {
  return new URL("/reading/painting-with-gaussians", request.url).href
}

function canonicalReadingGeminiOmniUrl(request: Request): string {
  return new URL("/reading/gemini-omni", request.url).href
}

export function negotiateSiteRequest(request: Request): Response | undefined {
  const method = request.method.toUpperCase()
  if (method !== "GET" && method !== "HEAD") {
    return undefined
  }

  const pathname = new URL(request.url).pathname
  if (!isNegotiableDocumentPath(pathname) || isPreservedRedirectPath(pathname)) {
    return undefined
  }

  const accept = request.headers.get("accept")
  const preview = isPreviewPath(pathname)
  const chosen = preview
    ? preferredRepresentationFrom(accept, [htmlMediaType])
    : preferredRepresentation(accept)

  if (chosen === markdownMediaType) {
    if (isHomePath(pathname)) {
      return new Response(negotiatedBody(request, homeMarkdown), {
        headers: {
          "Content-Type": markdownContentType,
          "Link": `<${canonicalHomeUrl(request)}>; rel="canonical", </index.md>; rel="alternate"; type="text/markdown"`,
          "Vary": varyAcceptAndEncoding,
        },
        status: 200,
      })
    }

    if (isReadingFacesPath(pathname)) {
      return new Response(negotiatedBody(request, readingFacesMarkdown), {
        headers: {
          "Content-Type": markdownContentType,
          "Link": `<${canonicalReadingFacesUrl(request)}>; rel="canonical", </reading/draw-faces-with-javascript.md>; rel="alternate"; type="text/markdown"`,
          "Vary": varyAcceptAndEncoding,
        },
        status: 200,
      })
    }

    if (isReadingIndexPath(pathname)) {
      return new Response(negotiatedBody(request, readingIndexMarkdown), {
        headers: {
          "Content-Type": markdownContentType,
          "Link": `<${canonicalReadingIndexUrl(request)}>; rel="canonical", </reading/index.md>; rel="alternate"; type="text/markdown"`,
          "Vary": varyAcceptAndEncoding,
        },
        status: 200,
      })
    }

    if (isReadingFeynobgPath(pathname)) {
      return new Response(negotiatedBody(request, readingFeynobgMarkdown), {
        headers: {
          "Content-Type": markdownContentType,
          "Link": `<${canonicalReadingFeynobgUrl(request)}>; rel="canonical", </reading/feynobg.md>; rel="alternate"; type="text/markdown"`,
          "Vary": varyAcceptAndEncoding,
        },
        status: 200,
      })
    }

    if (isReadingGaussiansPath(pathname)) {
      return new Response(negotiatedBody(request, readingGaussiansMarkdown), {
        headers: {
          "Content-Type": markdownContentType,
          "Link": `<${canonicalReadingGaussiansUrl(request)}>; rel="canonical", </reading/painting-with-gaussians.md>; rel="alternate"; type="text/markdown"`,
          "Vary": varyAcceptAndEncoding,
        },
        status: 200,
      })
    }

    if (isReadingGeminiOmniPath(pathname)) {
      return new Response(negotiatedBody(request, readingGeminiOmniMarkdown), {
        headers: {
          "Content-Type": markdownContentType,
          "Link": `<${canonicalReadingGeminiOmniUrl(request)}>; rel="canonical", </reading/gemini-omni.md>; rel="alternate"; type="text/markdown"`,
          "Vary": varyAcceptAndEncoding,
        },
        status: 200,
      })
    }

    return new Response(negotiatedBody(request, notFoundMarkdown), {
      headers: {
        "Cache-Control": "no-store",
        "Content-Type": markdownContentType,
        "Vary": varyAcceptAndEncoding,
        "X-Robots-Tag": "noindex",
      },
      status: 404,
    })
  }

  if (chosen === htmlMediaType) {
    // The static handler owns HTML headers and emits a bodyless response for HEAD.
    return undefined
  }

  if (chosen === null && accept !== null && accept.trim() !== "") {
    return new Response(negotiatedBody(
      request,
      preview ? previewNotAcceptableBody : notAcceptableBody,
    ), {
      headers: {
        "Content-Type": notAcceptableContentType,
        "Vary": varyAccept,
      },
      status: 406,
    })
  }

  return undefined
}
