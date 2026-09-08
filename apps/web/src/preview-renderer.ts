import { previewClassNames } from "./preview.stylex"

const classSlots = [
  ["{{PREVIEW_ROUTE_CLASS}}", previewClassNames.route, 1],
  ["{{PREVIEW_SHELL_CLASS}}", previewClassNames.shell, 1],
  ["{{PREVIEW_MARK_CLASS}}", previewClassNames.mark, 1],
  ["{{PREVIEW_SUN_CLASS}}", previewClassNames.sun, 1],
  ["{{PREVIEW_PATH_CLASS}}", previewClassNames.path, 1],
  ["{{PREVIEW_KICKER_CLASS}}", previewClassNames.kicker, 1],
  ["{{PREVIEW_TITLE_CLASS}}", previewClassNames.title, 1],
  ["{{PREVIEW_SUMMARY_CLASS}}", previewClassNames.summary, 1],
  ["{{PREVIEW_OUTPUTS_CLASS}}", previewClassNames.outputs, 1],
  ["{{PREVIEW_FIRST_OUTPUT_CLASS}}", previewClassNames.firstOutput, 1],
  ["{{PREVIEW_SECOND_OUTPUT_CLASS}}", previewClassNames.secondOutput, 1],
  ["{{PREVIEW_THIRD_OUTPUT_CLASS}}", previewClassNames.thirdOutput, 1],
  ["{{PREVIEW_FOURTH_OUTPUT_CLASS}}", previewClassNames.fourthOutput, 1],
  ["{{PREVIEW_NUMBER_CLASS}}", previewClassNames.number, 4],
  ["{{PREVIEW_NOTE_CLASS}}", previewClassNames.note, 1],
] as const

function replaceSlot(template: string, placeholder: string, value: string, count: number): string {
  if (template.split(placeholder).length - 1 !== count) {
    throw new Error(`Preview document must contain ${count} instance(s) of ${placeholder}`)
  }
  return template.replaceAll(placeholder, () => value)
}

export function renderPreviewDocument(template: string, stylesheetLinks: string): string {
  let rendered = template
  for (const [placeholder, className, count] of classSlots) {
    if (typeof className !== "string" || className.trim() === "") {
      throw new Error(`Preview recipe did not produce a compiled class for ${placeholder}`)
    }
    rendered = replaceSlot(rendered, placeholder, className, count)
  }
  rendered = replaceSlot(rendered, "{{PREVIEW_STYLES}}", stylesheetLinks, 1)
  if (/\{\{[^{}]*\}\}/u.test(rendered)) {
    throw new Error("Preview document contains an unresolved placeholder")
  }
  return rendered
}
