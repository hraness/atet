const allowedThemes = new Set(["dark", "light", "system"])
const storageKey = "atet.appearance"
const root = document.documentElement
const choices = document.querySelectorAll("[data-theme-choice]")

function readStoredTheme() {
  try {
    const stored = localStorage.getItem(storageKey)
    return allowedThemes.has(stored) ? stored : "system"
  } catch {
    return "system"
  }
}

function applyTheme(theme, persist) {
  root.dataset.theme = theme
  for (const choice of choices) {
    choice.setAttribute(
      "aria-pressed",
      String(choice.dataset.themeChoice === theme),
    )
  }
  if (!persist) return
  try {
    localStorage.setItem(storageKey, theme)
  } catch {
    // Appearance persistence is optional in privacy-restricted browsers.
  }
}

for (const choice of choices) {
  choice.addEventListener("click", () => {
    const theme = choice.dataset.themeChoice
    if (theme && allowedThemes.has(theme)) applyTheme(theme, true)
  })
}

applyTheme(readStoredTheme(), false)
