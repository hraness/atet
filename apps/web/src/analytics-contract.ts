import type { CaptureResult } from "posthog-js/dist/module.slim.no-external"

export const analyticsSchemaVersion = 1
export const canonicalAnalyticsOrigin = "https://atet.sh"
export const posthogCookielessDistinctId = "$posthog_cookieless"
export const siteId = "atet"

const rawUserAgentLimit = 2_048

export function isCanonicalAnalyticsPage(location: Readonly<Pick<Location, "origin" | "pathname">>): boolean {
  return location.origin === canonicalAnalyticsOrigin && location.pathname === "/"
}

export function sanitizePageview(event: CaptureResult | null, publicKey: string): CaptureResult | null {
  if (event?.event !== "$pageview") {
    return null
  }
  const rawUserAgent = event.properties.$raw_user_agent
  if (
    event.properties.token !== publicKey
    || event.properties.distinct_id !== posthogCookielessDistinctId
    || event.properties.$cookieless_mode !== true
    || typeof rawUserAgent !== "string"
    || rawUserAgent.trim().length === 0
  ) {
    return null
  }

  return {
    event: "$pageview",
    properties: {
      $process_person_profile: false,
      $cookieless_mode: true,
      $raw_user_agent: rawUserAgent.slice(0, rawUserAgentLimit),
      analytics_schema_version: analyticsSchemaVersion,
      distinct_id: posthogCookielessDistinctId,
      site_id: siteId,
      token: publicKey,
    },
    timestamp: event.timestamp,
    uuid: event.uuid,
  }
}
