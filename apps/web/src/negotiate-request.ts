import {
  homeMarkdown,
  notFoundMarkdown,
  readingFacesMarkdown,
  readingFeynobgMarkdown,
  readingGaussiansMarkdown,
} from "./agent-pages"
import {
  markdownMediaType,
  notAcceptableBody,
  preferredRepresentation,
} from "./negotiate"

const markdownContentType = "text/markdown; charset=utf-8"
const notAcceptableContentType = "text/plain; charset=utf-8"
const varyAccept = "Accept"
const varyAcceptAndEncoding = "Accept, Accept-Encoding"

export function isHomePath(pathname: string): boolean {
  return pathname === "/" || pathname === "/index.html"
}

export function isReadingFacesPath(pathname: string): boolean {
  return pathname === "/reading/draw-faces-with-javascript"
    || pathname === "/reading/draw-faces-with-javascript.html"
}

export function isReadingFeynobgPath(pathname: string): boolean {
  return pathname === "/reading/feynobg"
    || pathname === "/reading/feynobg.html"
}

export function isReadingGaussiansPath(pathname: string): boolean {
  return pathname === "/reading/painting-with-gaussians"
    || pathname === "/reading/painting-with-gaussians.html"
}

export function isPreservedRedirectPath(pathname: string): boolean {
  return pathname === "/docs" || pathname.startsWith("/docs/")
}

export function isNegotiableDocumentPath(pathname: string): boolean {
  if (
    isHomePath(pathname)
    || isReadingFacesPath(pathname)
    || isReadingFeynobgPath(pathname)
    || isReadingGaussiansPath(pathname)
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

function canonicalReadingFeynobgUrl(request: Request): string {
  return new URL("/reading/feynobg", request.url).href
}

function canonicalReadingGaussiansUrl(request: Request): string {
  return new URL("/reading/painting-with-gaussians", request.url).href
}

export function negotiateSiteRequest(request: Request): Response | undefined {
  const pathname = new URL(request.url).pathname
  if (!isNegotiableDocumentPath(pathname) || isPreservedRedirectPath(pathname)) {
    return undefined
  }

  const accept = request.headers.get("accept")
  const chosen = preferredRepresentation(accept)

  if (chosen === markdownMediaType) {
    if (isHomePath(pathname)) {
      return new Response(homeMarkdown, {
        headers: {
          "Content-Type": markdownContentType,
          "Link": `<${canonicalHomeUrl(request)}>; rel="canonical", </index.md>; rel="alternate"; type="text/markdown"`,
          "Vary": varyAcceptAndEncoding,
        },
        status: 200,
      })
    }

    if (isReadingFacesPath(pathname)) {
      return new Response(readingFacesMarkdown, {
        headers: {
          "Content-Type": markdownContentType,
          "Link": `<${canonicalReadingFacesUrl(request)}>; rel="canonical", </reading/draw-faces-with-javascript.md>; rel="alternate"; type="text/markdown"`,
          "Vary": varyAcceptAndEncoding,
        },
        status: 200,
      })
    }

    if (isReadingFeynobgPath(pathname)) {
      return new Response(readingFeynobgMarkdown, {
        headers: {
          "Content-Type": markdownContentType,
          "Link": `<${canonicalReadingFeynobgUrl(request)}>; rel="canonical", </reading/feynobg.md>; rel="alternate"; type="text/markdown"`,
          "Vary": varyAcceptAndEncoding,
        },
        status: 200,
      })
    }

    if (isReadingGaussiansPath(pathname)) {
      return new Response(readingGaussiansMarkdown, {
        headers: {
          "Content-Type": markdownContentType,
          "Link": `<${canonicalReadingGaussiansUrl(request)}>; rel="canonical", </reading/painting-with-gaussians.md>; rel="alternate"; type="text/markdown"`,
          "Vary": varyAcceptAndEncoding,
        },
        status: 200,
      })
    }

    return new Response(notFoundMarkdown, {
      headers: {
        "Cache-Control": "no-store",
        "Content-Type": markdownContentType,
        "Vary": varyAcceptAndEncoding,
        "X-Robots-Tag": "noindex",
      },
      status: 404,
    })
  }

  if (chosen === null && accept !== null && accept.trim() !== "") {
    return new Response(notAcceptableBody, {
      headers: {
        "Content-Type": notAcceptableContentType,
        "Vary": varyAccept,
      },
      status: 406,
    })
  }

  return undefined
}
