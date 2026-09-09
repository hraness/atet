import assert from "node:assert/strict"

/** The only representation changes admitted by the install migration. This
 * runs on the cloned, browser-serialized body, never on a live document. Every
 * byte outside the one install section remains an input to the old oracle. */
export function normalizeInstallTransport(body: string, current: boolean): string {
  const openings = [...body.matchAll(/<section\b[^>]*\bid="install"[^>]*>/gu)]
  if (openings.length === 0) {
    assert.ok(!body.includes("data-copy-command"), "Copy transport outside the install section")
    return body
  }
  assert.equal(openings.length, 1)
  const opening = openings[0]
  assert.ok(opening !== undefined && opening.index !== undefined)
  const start = opening.index, end = body.indexOf("</section>", start) + "</section>".length
  assert.ok(end > start && !body.slice(start + opening[0].length, end).includes("<section"))
  let section = body.slice(start, end)
  const outside = body.slice(0, start) + body.slice(end)
  assert.ok(!outside.includes("data-copy-command"), "Copy transport escaped install ownership")
  const replace = (pattern: RegExp, count: number, replacement: string | ((...args: string[]) => string)) => {
    assert.equal([...section.matchAll(pattern)].length, count, `Install transport count: ${pattern.source}`)
    section = typeof replacement === "string" ? section.replace(pattern, replacement) : section.replace(pattern, replacement)
  }
  // Only these original semantic hooks acquire compiled suffixes. Native
  // state/paint and exact generated ownership are checked separately.
  const hooks = [["install-note", 1], ["cli-install", 1], ["panel-label", 2], ["install-commands", 1],
    ["copy-command", 1], ["copy-command__value", 1], ["copy-command__button", 1], ["copy-command__note", 1],
    ["copy-command__status", 1], ["panel-note", 2]] as const
  const classes = "(?: [A-Za-z_][A-Za-z0-9_-]*)+"
  const buttonClass = current ? section.match(new RegExp(`<button[^>]* class="(copy-command__button${classes})"`, "u"))?.[1] : undefined
  for (const [hook, count] of hooks) {
    replace(new RegExp(`(?<![\\w-])class="${hook}${current ? classes : ""}"`, "gu"), count, `class="${hook}"`)
  }
  if (current) {
    const stateClasses: string[] = []
    for (const state of ["idle", "copied", "failed"]) {
      replace(new RegExp(` data-copy-${state}-class="(copy-command__button${classes})"`, "gu"), 1,
        (_whole, value) => { assert.ok(value !== undefined); stateClasses.push(value); return "" })
    }
    assert.equal(new Set(stateClasses).size, 3, "Distinct finite copy presentations required")
    assert.equal(buttonClass, stateClasses[0], "Live idle class differs from its sealed transport")
    replace(/\n    <template data-copy-command-fallback=""><textarea class="[A-Za-z_][A-Za-z0-9_-]*(?: [A-Za-z_][A-Za-z0-9_-]*)*" readonly=""><\/textarea><\/template>/gu, 1, "")
    // Originally classless descendants: exact counts/tags, and only inside the
    // install section. Unknown attributes, text and nested structure survive.
    for (const [tag, count] of [["li", 2], ["span", 2], ["code", 3], ["a", 2]] as const) {
      replace(new RegExp(`<${tag} class="(?!copy-command__)[A-Za-z_][A-Za-z0-9_-]*(?: [A-Za-z_][A-Za-z0-9_-]*)*"`, "gu"), count, `<${tag}`)
    }
    // Four intentionally de-indented block starts saved exactly 60 source
    // bytes. Restore those exact starts, not arbitrary whitespace or text.
    replace(/\n<p class="panel-label">/gu, 2, '\n              <p class="panel-label">')
    replace(/\n<li>/gu, 2, "\n                <li>")
  }
  assert.ok(!/data-copy-(?:idle|copied|failed)-class|data-copy-command-fallback/u.test(section), "Unknown copy transport")
  return body.slice(0, start) + section + body.slice(end)
}
