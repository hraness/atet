import { siteShellClassNames } from "./site-shell.stylex"
import { siteInstallClassNames } from "./site-install.stylex"
import { siteContentSlots, type SiteAssets, type SiteDocument } from "./site-content"
import { assertCompiledSiteClass, replaceSiteSlot } from "./site-template"

const commonSlots = [
  ["{{SITE_SKIP_CLASS}}", siteShellClassNames.skip, 1],
  ["{{SITE_HEADER_CLASS}}", siteShellClassNames.header, 1],
  ["{{SITE_WORDMARK_CLASS}}", siteShellClassNames.wordmark, 1],
  ["{{SITE_ACTIONS_CLASS}}", siteShellClassNames.actions, 1],
  ["{{SITE_NAVIGATION_CLASS}}", siteShellClassNames.navigation, 1],
] as const
const homeSlots = [
  ["{{SITE_HOME_NAVIGATION_LINK_CLASS}}", siteShellClassNames.homeNavigationLink, 4],
  ["{{SITE_NAVIGATION_ACTION_CLASS}}", siteShellClassNames.navigationAction, 1],
  ["{{INSTALL_NOTE_CLASS}}", siteInstallClassNames.note, 1],
  ["{{INSTALL_PANEL_NOTE_CLASS}}", siteInstallClassNames.panelNote, 2],
  ["{{INSTALL_PANEL_LINK_CLASS}}", siteInstallClassNames.panelLink, 2],
  ["{{INSTALL_LABEL_CLASS}}", siteInstallClassNames.label, 2],
  ["{{INSTALL_COPY_CLASS}}", siteInstallClassNames.command, 1],
  ["{{INSTALL_VALUE_CLASS}}", siteInstallClassNames.value, 1],
  ["{{INSTALL_IDLE_CLASS}}", siteInstallClassNames.idle, 2],
  ["{{INSTALL_COPIED_CLASS}}", siteInstallClassNames.copied, 1],
  ["{{INSTALL_FAILED_CLASS}}", siteInstallClassNames.failed, 1],
  ["{{INSTALL_COPY_NOTE_CLASS}}", siteInstallClassNames.copyNote, 1],
  ["{{INSTALL_NOTE_CODE_CLASS}}", siteInstallClassNames.noteCode, 1],
  ["{{INSTALL_STATUS_CLASS}}", siteInstallClassNames.status, 1],
  ["{{INSTALL_FALLBACK_CLASS}}", siteInstallClassNames.fallback, 1],
  ["{{INSTALL_CLI_CLASS}}", siteInstallClassNames.cli, 1],
  ["{{INSTALL_COMMANDS_CLASS}}", siteInstallClassNames.commands, 1],
  ["{{INSTALL_ITEM_CLASS}}", siteInstallClassNames.item, 1],
  ["{{INSTALL_SUBSEQUENT_ITEM_CLASS}}", siteInstallClassNames.subsequentItem, 1],
  ["{{INSTALL_NUMBER_CLASS}}", siteInstallClassNames.number, 2],
  ["{{INSTALL_CODE_CLASS}}", siteInstallClassNames.installCode, 2],
] as const
const recoverySlots = [
  ["{{SITE_NAVIGATION_LINK_CLASS}}", siteShellClassNames.navigationLink, 2],
  ["{{SITE_RECOVERY_CLASS}}", siteShellClassNames.recovery, 1],
  ["{{SITE_RECOVERY_LABEL_CLASS}}", siteShellClassNames.recoveryLabel, 1],
  ["{{SITE_RECOVERY_HEADING_CLASS}}", siteShellClassNames.recoveryHeading, 1],
  ["{{SITE_RECOVERY_PARAGRAPH_CLASS}}", siteShellClassNames.recoveryParagraph, 2],
  ["{{SITE_RECOVERY_LINK_CLASS}}", siteShellClassNames.recoveryLink, 4],
  ["{{SITE_RECOVERY_ACTION_CLASS}}", siteShellClassNames.recoveryAction, 1],
] as const

/** Produce the complete authored document once, before the public compiler
 * seals it. No class, stylesheet, script or content is rewritten afterward. */
export function renderSiteDocument(template: string, document: SiteDocument, assets: SiteAssets, stylesheetLinks: string): string {
  if (document !== "index.html" && document !== "404.html") throw new Error("Unexpected site document")
  let rendered = template
  // Copy content contains finite recipe slots. Fill it before the closed class
  // inventory; both substitutions are completed inside the sealed SSR graph.
  for (const [placeholder, value, count] of siteContentSlots(document, assets)) {
    rendered = replaceSiteSlot(rendered, placeholder, value, count)
  }
  for (const [placeholder, className, count] of [...commonSlots, ...(document === "index.html" ? homeSlots : recoverySlots)]) {
    assertCompiledSiteClass(className, placeholder)
    rendered = replaceSiteSlot(rendered, placeholder, className, count)
  }
  rendered = replaceSiteSlot(rendered, "{{SITE_STYLES}}", stylesheetLinks, 1)
  if (/\{\{[^{}]*\}\}/u.test(rendered)) throw new Error("Site document contains an unresolved placeholder")
  return rendered
}
