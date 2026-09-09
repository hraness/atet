import { renderHranessSiteFooter } from "@hraness/site-footer"
import { AskAiAboutThis } from "@hraness/ui"
import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { publishedArchiveUrl, publishedRelease } from "./published-release"

// Existing content producers run within the ordinary page's captured SSR
// graph. They introduce no client renderer and retain their public APIs.
export function renderAskAiAboutThis(canonicalUrl: string): string {
  return renderToStaticMarkup(createElement(AskAiAboutThis, {
    className: "atet-ask-ai",
    url: canonicalUrl,
  }))
}

function renderAppearanceMenu(): string {
  return `<div aria-busy="true" class="hraness-design-theme-toggle"
      data-display="icons" data-hraness-appearance-menu data-presentation="menu"
      data-ready="false" data-theme-value="system">
    <button aria-controls="appearance-menu" aria-expanded="false" aria-haspopup="menu"
      aria-label="Appearance: System" class="hraness-design-theme-toggle__trigger"
      disabled type="button">
      <span aria-hidden="true" data-current-appearance-icon="system"></span>
    </button>
    <div class="hraness-design-theme-toggle__popover" hidden>
      <div aria-label="Appearance" class="hraness-design-theme-toggle__menu"
        id="appearance-menu" role="menu">
        <div aria-checked="false" class="hraness-design-theme-toggle__item"
          data-theme-value="light" role="menuitemradio" tabindex="-1">
          <span aria-hidden="true" data-appearance-icon="light"></span><span>Light</span>
        </div>
        <div aria-checked="false" class="hraness-design-theme-toggle__item"
          data-theme-value="dark" role="menuitemradio" tabindex="-1">
          <span aria-hidden="true" data-appearance-icon="dark"></span><span>Dark</span>
        </div>
        <div aria-checked="true" class="hraness-design-theme-toggle__item"
          data-selected="true" data-theme-value="system" role="menuitemradio" tabindex="-1">
          <span aria-hidden="true" data-appearance-icon="system"></span><span>System</span>
        </div>
      </div>
    </div>
  </div>`
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/gu, character => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[character] ?? character)
}

type CopyCommandOptions = Readonly<{
  alternateCommand: string
  command: string
  id: string
}>

function renderCopyCommand(options: CopyCommandOptions): string {
  const alternateCommand = escapeHtml(options.alternateCommand)
  const command = escapeHtml(options.command)
  const id = escapeHtml(options.id)
  return `<div class="copy-command" data-copy-command>
    <code class="copy-command__value" data-copy-command-value>${command}</code>
    <button aria-describedby="${id}" aria-label="Copy install command" class="copy-command__button"
      data-copy-command-button hidden type="button">Copy</button>
    <p class="copy-command__note">Using Bun? <code>${alternateCommand}</code></p>
    <p aria-atomic="true" aria-live="polite" class="copy-command__status"
      data-copy-command-status id="${id}"></p>
  </div>`
}

export type SiteDocument = "index.html" | "404.html"
export type SiteAssets = Readonly<{ themePath: string; analyticsPath: string | null }>

export function siteContentSlots(document: SiteDocument, assets: SiteAssets): ReadonlyArray<readonly [string, string, number]> {
  if (!/^\/assets\/theme-[a-f0-9]{12}\.js$/u.test(assets.themePath)
    || (assets.analyticsPath !== null && !/^\/assets\/analytics-[a-f0-9]{12}\.js$/u.test(assets.analyticsPath))) {
    throw new Error("Site content requires exact local fingerprinted script paths")
  }
  const common: ReadonlyArray<readonly [string, string, number]> = [
    ["{{APPEARANCE_MENU}}", renderAppearanceMenu(), 1],
    ["{{HRANESS_SITE_FOOTER}}", renderHranessSiteFooter({ mailingList: { kind: "none" } }), 1],
    ["{{THEME_ASSET}}", assets.themePath, 1],
  ]
  if (document === "404.html") return common
  return [...common,
    ["{{ASK_AI_ABOUT_THIS}}", renderAskAiAboutThis("https://atet.sh/"), 1],
    ["{{PUBLISHED_VERSION}}", publishedRelease.version, 7],
    ["{{PUBLISHED_ARCHIVE_URL}}", publishedArchiveUrl, 1],
    ["{{PUBLISHED_RELEASE_URL}}", publishedRelease.releaseUrl, 1],
    ["{{ANALYTICS_SCRIPT}}", assets.analyticsPath === null ? "" : `<script src="${assets.analyticsPath}" type="module"></script>`, 1],
    ["{{SKILL_INSTALL_COMMAND}}", renderCopyCommand({
      alternateCommand: `bunx skills add https://github.com/hraness/atet/tree/v${publishedRelease.version} --skill atet`,
      command: `npx skills add https://github.com/hraness/atet/tree/v${publishedRelease.version} --skill atet`,
      id: "skill-install-copy-status",
    }), 1],
  ]
}
