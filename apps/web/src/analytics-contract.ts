import type { CaptureResult } from "posthog-js/dist/module.slim.no-external"

export const analyticsSchemaVersion = 1
export const canonicalAnalyticsOrigin = "https://atet.sh"
export const posthogCookielessDistinctId = "$posthog_cookieless"
export const siteId = "atet"

export function isCanonicalAnalyticsPage(location: Readonly<Pick<Location, "origin" | "pathname">>): boolean {
  return location.origin === canonicalAnalyticsOrigin && location.pathname === "/"
}

export function sanitizePageview(event: CaptureResult | null, publicKey: string): CaptureResult | null {
  if (event?.event !== "$pageview") {
    return null
  }
  if (
    event.properties.token !== publicKey
    || event.properties.distinct_id !== posthogCookielessDistinctId
    || event.properties.$cookieless_mode !== true
  ) {
    return null
  }

  return {
    event: "$pageview",
    properties: {
      $process_person_profile: false,
      $cookieless_mode: true,
      analytics_schema_version: analyticsSchemaVersion,
      distinct_id: posthogCookielessDistinctId,
      site_id: siteId,
      token: publicKey,
    },
    timestamp: event.timestamp,
    uuid: event.uuid,
  }
}
