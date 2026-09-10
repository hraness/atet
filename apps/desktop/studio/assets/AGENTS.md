# Contents

- `contracts.ts` defines bounded Poly Haven search, selection, provenance, and canonical import plans.
- `network.ts` owns fixed-origin public GET requests and bounded response capture.
- `poly-haven.ts` resolves the provider catalog and retains explicitly selected asset closures through immutable storage.
- Tests and `README.md` document the supported asset subset and live qualification boundary.

# Guidelines

- Use only the fixed Poly Haven API and asset download origins. Identify SLOPCAMERA in the User-Agent, reject redirects, and retain a visible Poly Haven credit independently from the CC0 asset license.
- Never read credentials, upload source, execute downloads, extract archives, or discover dependencies by scanning neighboring files. Treat native scene files and scripts as inert bytes in other explicit import paths.
- Parse and detach foreign data before access. Recompute plan identity and the complete selected closure before downloading or replaying retained artifacts.
- Check catalog byte counts and MD5 transport checksums, then retain SHA-256 identities. Do not use MD5 as the artifact identity or claim provider-authenticated provenance.
- Preserve declared glTF image/buffer dependencies exactly; reject missing, extra, remote, or unsupported extension resources. Formats outside the qualified subset must fail explicitly.
- Use physical private directories and the shared immutable storage adapter. Publish completion only after complete verification; preserve failed partial artifacts and never overwrite conflicting retained bytes.
- Keep focused tests network-free. Qualify free live downloads only within the owning task's explicit byte budget, retaining media and receipts under ignored artifacts.
