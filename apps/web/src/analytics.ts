import posthog from "posthog-js/dist/module.slim.no-external"

import { isCanonicalAnalyticsPage, sanitizePageview } from "./analytics-contract"

declare const __ATET_POSTHOG_HOST__: string
declare const __ATET_POSTHOG_KEY__: string

if (isCanonicalAnalyticsPage(window.location)) {
  posthog.init(__ATET_POSTHOG_KEY__, {
    advanced_disable_flags: true,
    advanced_disable_toolbar_metrics: true,
    autocapture: false,
    before_send: event => (
      isCanonicalAnalyticsPage(window.location)
        ? sanitizePageview(event, __ATET_POSTHOG_KEY__)
        : null
    ),
    capture_dead_clicks: false,
    capture_exceptions: false,
    capture_heatmaps: false,
    capture_pageleave: false,
    capture_pageview: false,
    capture_performance: false,
    cookieless_mode: "always",
    disableDeviceModel: true,
    disable_conversations: true,
    disable_external_dependency_loading: true,
    disable_persistence: true,
    disable_product_tours: true,
    disable_scroll_properties: true,
    disable_session_recording: true,
    disable_surveys: true,
    disable_web_experiments: true,
    enable_recording_console_log: false,
    mask_all_element_attributes: true,
    mask_all_text: true,
    persistence: "memory",
    person_profiles: "never",
    request_batching: false,
    save_campaign_params: false,
    save_referrer: false,
    api_host: __ATET_POSTHOG_HOST__,
  })
  posthog.capture("$pageview", {
    analytics_schema_version: 1,
    site_id: "atet",
  }, {
    send_instantly: true,
    transport: "fetch",
  })
}
