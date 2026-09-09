const feedbackDurationMilliseconds = 2_500

function fallbackCopy(value: string, ownerDocument: Document, template: HTMLTextAreaElement): boolean {
  const input = template.cloneNode(true) as HTMLTextAreaElement
  input.value = value
  input.readOnly = true
  ownerDocument.body.append(input)

  try {
    input.select()
    input.setSelectionRange(0, value.length)
    return ownerDocument.execCommand("copy")
  } finally {
    input.remove()
  }
}

async function copyText(value: string, ownerDocument: Document, template: HTMLTextAreaElement): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(value)
    return true
  } catch {
    try {
      return fallbackCopy(value, ownerDocument, template)
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
    const template = component.querySelector<HTMLTemplateElement>("template[data-copy-command-fallback]")?.content.querySelector("textarea")
    const classes = [button?.dataset.copyIdleClass, button?.dataset.copyCopiedClass, button?.dataset.copyFailedClass]
    if (command === null || button === null || status === null || template == null
      || classes.some(value => typeof value !== "string" || !/^copy-command__button(?: [A-Za-z_][A-Za-z0-9_-]*)+$/u.test(value))) {
      continue
    }
    const [idleClass, copiedClass, failedClass] = classes as [string, string, string]

    button.hidden = false
    let resetTimer: number | undefined
    button.addEventListener("click", async () => {
      if (resetTimer !== undefined) {
        window.clearTimeout(resetTimer)
      }

      const copied = await copyText(command.textContent ?? "", ownerDocument, template)
      button.textContent = copied ? "Copied" : "Copy"
      button.dataset.copyState = copied ? "copied" : "failed"
      button.className = copied ? copiedClass : failedClass
      status.textContent = copied
        ? "Install command copied."
        : "Could not copy the command. Select it and copy it manually."
      button.focus()

      if (copied) {
        resetTimer = window.setTimeout(() => {
          button.textContent = "Copy"
          delete button.dataset.copyState
          button.className = idleClass
          status.textContent = ""
          resetTimer = undefined
        }, feedbackDurationMilliseconds)
      }
    })
  }
}
