import { homeMarkdown, notFoundMarkdown } from "./agent-pages"
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

export function isPreservedRedirectPath(pathname: string): boolean {
  return pathname === "/docs" || pathname.startsWith("/docs/")
}

export function isNegotiableDocumentPath(pathname: string): boolean {
  if (isHomePath(pathname) || isPreservedRedirectPath(pathname)) {
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
