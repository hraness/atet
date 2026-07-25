import type { DiagramConfig } from "@cclrte/graphics"

export default {
  icons: {
    "custom-mark": {
      viewBox: "0 0 24 24",
      body:
        '<circle cx="12" cy="12" r="8" fill="none" stroke="currentColor" stroke-width="1.5"/>' +
        '<path d="m8.5 12 2.25 2.25L15.5 9.5" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>',
    },
  },
} satisfies DiagramConfig
