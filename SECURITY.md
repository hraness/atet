# Security

Report suspected vulnerabilities privately through [GitHub’s security advisory form](https://github.com/hraness/transmute/security/advisories/new). Do not open a public issue for credential exposure, path escape, unsafe SVG output, archive extraction, subprocess containment, unbounded resource use, Gateway authority substitution, or MCP boundary failures.

Include the affected version, platform, command or API, minimal reproduction, expected boundary, observed result, and whether any secret or caller-owned media left the machine. Remove tokens, account identifiers, private paths, and proprietary media from the report.

Transmute’s local MCP server confines paths to one caller-selected root but is not an operating-system sandbox against concurrent same-user mutation. Vectorization is network-silent. Generation sends its prompt and explicitly supplied media directly to Vercel AI Gateway. Transmute reads `AI_GATEWAY_API_KEY` or `VERCEL_OIDC_TOKEN` from the process environment and never persists either value.

An explicitly imported workflow module is trusted Bun code with the authority of the current user. Review workflow modules before running them. Declarative graph compilation restricts operation nodes to the closed capability projection supplied by the host and rejects unsupported capabilities before executor or resource admission, but it does not sandbox the JavaScript that constructs the graph.
