import { previewFailureSummary } from "./verify-preview-layout"
import { verifySiteShell } from "./verify-site-shell"

if (import.meta.main) {
  try { await verifySiteShell(process.argv.slice(2), "install-copy") } catch (error) {
    process.exitCode = 1
    console.error(previewFailureSummary(error).replace("slopcamera-preview:", "slopcamera-site-copy:"))
  }
}
