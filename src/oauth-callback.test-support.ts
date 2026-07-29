import { homedir } from "node:os"
import { join } from "node:path"
import { acquireTransmuteCredentialMutationLease } from "./credential-lease.ts"

const oauthCallbackTestLease = {
  directory: join(
    homedir(),
    ".cache",
    "hraness-transmute-tests",
    "oauth-callback-49671-lease-v4",
  ),
  waitTimeoutMilliseconds: 45_000,
  staleAfterMilliseconds: 30_000,
  pollIntervalMilliseconds: 10,
} as const

export const oauthCallbackTestTimeoutMilliseconds = 60_000

/**
 * The production redirect URI intentionally owns one machine-wide port.
 * Serialize only tests that bind it so concurrent worktrees and extracted
 * standalone-package checks cannot make each other fail nondeterministically.
 */
export async function withOAuthCallbackTestLease<T>(
  run: () => T | Promise<T>,
): Promise<T> {
  const lease = await acquireTransmuteCredentialMutationLease(
    { credentialLease: oauthCallbackTestLease },
    "login",
  )
  try {
    return await run()
  } finally {
    await lease.release()
  }
}
