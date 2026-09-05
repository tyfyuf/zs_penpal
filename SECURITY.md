# Security policy

## Reporting a vulnerability

If you find a vulnerability that could expose API keys, allow arbitrary file access, enable path traversal or remote code execution, or damage user data, please do not open a public issue immediately.

Use GitHub Security Advisories when enabled, or contact the maintainers through a private channel. Include:

- the affected version or commit;
- reproducible steps or a minimal example;
- impact and prerequisites;
- a suggested fix, if available.

Remove API keys, Authorization headers, personal paths, and real writing from all logs and examples.

## Security boundary

Penpal is a local desktop application, but it can send the current conversation and explicitly selected context to the AI provider configured by the user. Review that provider's data policy before using sensitive material.
