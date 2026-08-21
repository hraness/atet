import { negotiateSiteRequest } from "./src/negotiate-request"

export default function middleware(request: Request): Response | undefined {
  return negotiateSiteRequest(request)
}

export const config = {
  matcher: [
    "/",
    "/((?!assets/).*)",
  ],
}
