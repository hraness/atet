import { installAppearanceMenus } from "@hraness/design-kit/browser"

import { installCopyCommands } from "./copy-command"

installAppearanceMenus({
  darkThemeColor: "#0b0b0e",
  lightThemeColor: "#faf8f3",
  storageKey: "atet.appearance",
})

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", () => installCopyCommands(), { once: true })
} else {
  installCopyCommands()
}
