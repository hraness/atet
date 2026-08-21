const feedbackDurationMilliseconds = 2_500

function fallbackCopy(value: string, ownerDocument: Document): boolean {
  const input = ownerDocument.createElement("textarea")
  input.value = value
  input.readOnly = true
  input.style.position = "fixed"
  input.style.inset = "0 auto auto -9999px"
  input.style.opacity = "0"
  ownerDocument.body.append(input)
  input.select()
  input.setSelectionRange(0, value.length)

  try {
    return ownerDocument.execCommand("copy")
  } finally {
    input.remove()
  }
}

async function copyText(value: string, ownerDocument: Document): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(value)
    return true
  } catch {
    try {
      return fallbackCopy(value, ownerDocument)
    } catch {
      return false
    }
  }
}

export function installCopyCommands(ownerDocument: Document = document): void {
  for (const component of ownerDocument.querySelectorAll<HTMLElement>("[data-copy-command]")) {
    const command = component.querySelector<HTMLElement>("[data-copy-command-value]")
    const button = component.querySelector<HTMLButtonElement>("[data-copy-command-button]")
    const status = component.querySelector<HTMLElement>("[data-copy-command-status]")
    if (command === null || button === null || status === null) {
      continue
    }

    button.hidden = false
    let resetTimer: number | undefined
    button.addEventListener("click", async () => {
      if (resetTimer !== undefined) {
        window.clearTimeout(resetTimer)
      }

      const copied = await copyText(command.textContent ?? "", ownerDocument)
      button.textContent = copied ? "Copied" : "Copy"
      button.dataset.copyState = copied ? "copied" : "failed"
      status.textContent = copied
        ? "Install command copied."
        : "Could not copy the command. Select it and copy it manually."
      button.focus()

      if (copied) {
        resetTimer = window.setTimeout(() => {
          button.textContent = "Copy"
          delete button.dataset.copyState
          status.textContent = ""
          resetTimer = undefined
        }, feedbackDurationMilliseconds)
      }
    })
  }
}
