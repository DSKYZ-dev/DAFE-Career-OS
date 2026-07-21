# Security Policy

## Reporting a Vulnerability

**Do NOT open a public issue for security vulnerabilities.**

Security vulnerabilities should be reported via GitHub Issues.

## Scope

Security issues in the following are in scope:

- **Scripts** (`*.mjs`) — command injection, path traversal, SSRF
- **Dashboard** (`dashboard/`) — any Go binary vulnerabilities
- **Templates** (`templates/`) — XSS in generated HTML/PDF
- **Configuration** — secrets exposure, unsafe defaults

## Out of Scope

- Issues in third-party dependencies (report upstream)
- Issues requiring physical access to the user's machine
- Social engineering attacks
- dafe-career-os is a local tool — there is no hosted service to attack

## Disclosure Policy

We follow coordinated disclosure. Once a fix is released, we will credit the reporter (unless they prefer anonymity) in the release notes.
