# Security Policy

## Supported Versions

| Version | Supported |
|---------|-----------|
| 1.0.x   | ✅ |
| < 1.0   | ❌ |

Only the latest `1.0.x` release is supported. Fixes are not backported.

## Reporting a Vulnerability

**Please do not open a public GitHub issue for security vulnerabilities.**

Report privately using [GitHub Security Advisories](https://github.com/JulesNsenda/drop/security/advisories/new)
for this repository ("Security" tab → "Report a vulnerability"). This opens a
private discussion with the maintainers and lets us coordinate a fix before
any public disclosure.

Include as much detail as you can:

- The affected version / commit
- Isolation mode (`none` or `docker`) if relevant — several classes of issue
  only apply to one mode
- Steps to reproduce, or a proof of concept
- The impact you believe it has

## Response Expectations

This is a small, self-hosted project maintained outside of working hours —
please give it a realistic amount of slack:

- **Acknowledgement**: within 5 business days.
- **Triage / initial assessment**: within 2 weeks of acknowledgement.
- **Fix or mitigation**: timeline depends on severity and complexity; we'll
  keep you updated via the advisory thread.

We'll credit reporters in the release notes unless you'd prefer to stay
anonymous — let us know your preference when you report.

## Scope

This policy covers the DROP platform itself (`src/`, `install.sh`,
`install.bat`, the GitHub Actions workflows that build and publish releases).
Vulnerabilities in apps you deploy *onto* DROP are outside this scope —
report those to the app's own maintainers.
