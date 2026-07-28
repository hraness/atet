# Security

Report suspected vulnerabilities privately through [GitHub’s security advisory form](https://github.com/hraness/transmute/security/advisories/new). Do not open a public issue for credential exposure, path escape, unsafe SVG output, archive extraction, subprocess containment, unbounded resource use, discovery substitution, OAuth, or MCP boundary failures.

Include the affected version, platform, command or API, minimal reproduction, expected boundary, observed result, and whether any secret or caller-owned media left the machine. Remove tokens, account identifiers, private paths, and proprietary media from the report.

Transmute’s local MCP server confines paths to one caller-selected root but is not an operating-system sandbox against concurrent same-user mutation. Canonical vectorization is network-silent; hosted generation is the only image operation that sends a prompt to `transmute.rocks`.
