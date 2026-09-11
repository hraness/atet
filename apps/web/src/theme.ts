import { installAppearanceMenus } from "@hraness/design-kit/browser"

import { installCopyCommands } from "./copy-command"

installAppearanceMenus({
  darkThemeColor: "#12100f",
  lightThemeColor: "#f8f7f4",
  storageKey: "slopcamera.appearance",
})

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", () => installCopyCommands(), { once: true })
} else {
  installCopyCommands()
}
