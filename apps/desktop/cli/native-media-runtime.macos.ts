// Direct import is required for Bun to embed Sharp's dynamically selected
// N-API addon in the compiled Apple Silicon executable.
import sharpAddon from "@img/sharp-darwin-arm64/sharp.node";

(globalThis as Record<symbol, unknown>)[
  Symbol.for("transmute.sharp-darwin-arm64-addon/v1")
] = sharpAddon;
