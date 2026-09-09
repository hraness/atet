import * as stylex from "@stylexjs/stylex"

const phone = "@media (max-width: 34rem)"
const forcedColors = "@media (forced-colors: active)"

// Only local install/copy presentation. The design-kit marketing section and
// its headings remain in the separately identified legacy foundation.
const install = stylex.create({
  note: { maxWidth: "62ch", color: "var(--muted)", fontSize: "0.92rem", lineHeight: 1.55 },
  panelNote: { marginTop: "1rem" },
  panelLink: { color: "var(--gold)" },
  label: { color: "var(--muted)", fontSize: "0.875rem", fontWeight: 500 },
  nightPanel: {
    borderWidth: "1px", borderStyle: "solid",
    borderColor: { default: "var(--night-line)", [forcedColors]: "CanvasText" },
    borderImageSource: "none", borderImageSlice: "100%", borderImageWidth: 1,
    borderImageOutset: 0, borderImageRepeat: "stretch", borderRadius: "0.625rem",
    backgroundColor: "var(--night)", backgroundImage: "none", backgroundPosition: "initial",
    backgroundSize: "auto auto", backgroundRepeat: "repeat", backgroundAttachment: "scroll",
    backgroundOrigin: "padding-box", backgroundClip: "border-box", color: "var(--night-ink)",
  },
  command: {
    position: "relative", display: "grid", minWidth: 0, marginTop: "0.6rem", overflow: "hidden",
    gridTemplateColumns: { default: "minmax(0, 1fr) auto", [phone]: "minmax(0, 1fr)" },
  },
  code: {
    backgroundColor: "transparent", backgroundImage: "none", backgroundPosition: "initial",
    backgroundSize: "auto auto", backgroundRepeat: "repeat", backgroundAttachment: "scroll",
    backgroundOrigin: "padding-box", backgroundClip: "border-box",
  },
  value: {
    minWidth: 0, paddingTop: "0.9rem", paddingRight: "1rem", paddingBottom: "0.9rem", paddingLeft: "1rem",
    overflowX: "auto", fontSize: "0.82rem", lineHeight: 1.5, whiteSpace: "nowrap",
  },
  button: {
    minWidth: "4.4rem", minHeight: "2.75rem", paddingTop: "0.6rem", paddingRight: "0.9rem",
    paddingBottom: "0.6rem", paddingLeft: "0.9rem",
    borderTopWidth: { default: 0, [phone]: "1px" }, borderTopStyle: { default: "none", [phone]: "solid" },
    borderTopColor: {
      default: "currentColor", [phone]: "var(--night-line)",
      [forcedColors]: { default: "CanvasText", [phone]: "CanvasText" },
    },
    borderRightWidth: 0, borderRightStyle: "none",
    borderRightColor: { default: "currentColor", [forcedColors]: "CanvasText" },
    borderBottomWidth: 0, borderBottomStyle: "none",
    borderBottomColor: { default: "currentColor", [forcedColors]: "CanvasText" },
    borderLeftWidth: { default: "1px", [phone]: 0 }, borderLeftStyle: { default: "solid", [phone]: "none" },
    borderLeftColor: {
      default: "var(--night-line)", [phone]: "currentColor",
      [forcedColors]: { default: "CanvasText", [phone]: "CanvasText" },
    },
    borderImageSource: "none", borderImageSlice: "100%", borderImageWidth: 1,
    borderImageOutset: 0, borderImageRepeat: "stretch",
    backgroundColor: { default: "transparent", ":hover": "color-mix(in srgb, var(--gold-bright) 14%, transparent)" },
    backgroundImage: "none", backgroundPosition: "initial", backgroundSize: "auto auto", backgroundRepeat: "repeat",
    backgroundAttachment: "scroll", backgroundOrigin: "padding-box", backgroundClip: "border-box",
    color: { default: "var(--night-muted)", ":hover": "var(--night-ink)" },
    cursor: "pointer", fontSize: "0.8rem", fontWeight: 500,
  },
  copied: {
    backgroundColor: { default: "color-mix(in srgb, var(--gold-bright) 14%, transparent)", ":hover": "color-mix(in srgb, var(--gold-bright) 14%, transparent)" },
    color: { default: "var(--night-ink)", ":hover": "var(--night-ink)" },
  },
  // Failed follows hover with equal specificity in the original cascade.
  failed: { color: { default: "var(--gold-bright)", ":hover": "var(--gold-bright)" } },
  copyNote: {
    paddingTop: "0.65rem", paddingRight: "1rem", paddingBottom: "0.65rem", paddingLeft: "1rem",
    borderTopWidth: "1px", borderTopStyle: "solid", borderTopColor: "var(--night-line)",
    color: "var(--night-muted)", fontSize: "0.8rem", gridColumn: "1 / -1",
  },
  noteCode: { color: "var(--night-ink)" },
  status: { position: "absolute", width: "1px", height: "1px", overflow: "hidden", clipPath: "inset(50%)", whiteSpace: "nowrap" },
  fallback: { position: "fixed", top: 0, right: "auto", bottom: "auto", left: "-9999px", opacity: 0 },
  cli: { marginTop: "1.5rem", paddingTop: "1.5rem", borderTopWidth: "1px", borderTopStyle: "solid", borderTopColor: "var(--line)" },
  commands: { marginTop: "0.6rem", padding: 0, listStyleType: "none", listStylePosition: "outside", listStyleImage: "none" },
  item: { display: "grid", minWidth: 0, paddingTop: "0.75rem", paddingRight: "1rem", paddingBottom: "0.75rem", paddingLeft: "1rem", gap: "0.85rem", gridTemplateColumns: "1.5rem minmax(0, 1fr)" },
  subsequentItem: { borderTopWidth: "1px", borderTopStyle: "solid", borderTopColor: "var(--night-line)" },
  number: { color: "var(--gold-bright)", font: "0.75rem/1.7 var(--font-mono)" },
  installCode: { overflowWrap: "anywhere", fontSize: "0.82rem", lineHeight: 1.7 },
})

export const siteInstallClassNames = {
  note: stylex.props(install.note).className,
  panelNote: stylex.props(install.note, install.panelNote).className,
  panelLink: stylex.props(install.panelLink).className,
  label: stylex.props(install.label).className,
  command: stylex.props(install.nightPanel, install.command).className,
  value: stylex.props(install.code, install.value).className,
  idle: stylex.props(install.button).className,
  copied: stylex.props(install.button, install.copied).className,
  failed: stylex.props(install.button, install.failed).className,
  copyNote: stylex.props(install.copyNote).className,
  noteCode: stylex.props(install.code, install.noteCode).className,
  status: stylex.props(install.status).className,
  fallback: stylex.props(install.fallback).className,
  cli: stylex.props(install.cli).className,
  commands: stylex.props(install.nightPanel, install.commands).className,
  item: stylex.props(install.item).className,
  subsequentItem: stylex.props(install.item, install.subsequentItem).className,
  number: stylex.props(install.number).className,
  installCode: stylex.props(install.code, install.installCode).className,
}
