# Security Policy

## Reporting a vulnerability

Please **do not** open a public issue for security problems.

Report vulnerabilities privately through GitHub's
[private vulnerability reporting](https://github.com/diagridio/dev-dashboard/security/advisories/new)
for this repository. Include steps to reproduce, the affected version
(`diagrid-dev-dashboard --version`), and the discovery mode you were running.

We aim to acknowledge reports within a few working days and will keep you
updated while a fix is prepared.

## Supported versions

Only the latest release receives security fixes. Upgrade with
`diagrid-dev-dashboard update` or by re-running the install script.

## Scope

The dashboard is a local development tool. By default it binds to
`127.0.0.1` and rejects non-loopback `Host` headers and cross-origin
mutating requests. Running it with a non-loopback bind or in container
(Aspire) posture exposes it to your network; treat that as you would any
unauthenticated development service.
