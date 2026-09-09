export function replaceSiteSlot(template: string, placeholder: string, value: string, count: number): string {
  if (!/^\{\{[A-Z_]+\}\}$/u.test(placeholder) || !Number.isSafeInteger(count) || count < 1
    || template.split(placeholder).length - 1 !== count) {
    throw new Error(`Site document must contain ${count} instance(s) of ${placeholder}`)
  }
  return template.replaceAll(placeholder, () => value)
}

export function assertCompiledSiteClass(value: unknown, placeholder: string): asserts value is string {
  if (typeof value !== "string" || !/^[A-Za-z_][A-Za-z0-9_-]*(?: [A-Za-z_][A-Za-z0-9_-]*)*$/u.test(value)) {
    throw new Error(`Site recipe did not produce a compiled class for ${placeholder}`)
  }
}
