# Security Policy

## Reporting a Vulnerability

Please report suspected vulnerabilities privately. Do not open a public issue with exploit details, credentials, tokens, or private infrastructure information.

Recommended report contents:

- A clear description of the issue
- Steps to reproduce
- Affected routes, APIs, or MongoDB documents
- Potential impact
- Suggested fix, if known

If a private security channel is not yet configured for this repository, contact the maintainer directly through the GitHub owner account and request a secure disclosure path.

## Response Process

1. The maintainer acknowledges the report.
2. The issue is triaged for severity and reproducibility.
3. A fix branch is prepared privately when needed.
4. A patched release or commit is published.
5. Public details are shared after users have a reasonable upgrade window.

## Sensitive Data Rules

Never commit:

- `.env` files with real values
- Passwords, tokens, API keys, JWT secrets, or certificates
- Private keys or SSH keys
- Customer, subscriber, IMSI, MSISDN, or billing data from real systems
- Private deployment configuration

Use `.env.example` for placeholder configuration only.

## Operational Notes

- `JWT_SECRET` must be unique per environment and at least 32 bytes.
- `INITIAL_ADMIN_PASSWORD` must satisfy the configured strong password policy.
- Production deployments should terminate TLS before the Next.js service.
- Review audit logs after any administrative or repair action.
