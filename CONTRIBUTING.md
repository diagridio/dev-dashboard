# Contributing to Diagrid Dev Dashboard

Thank you for your interest in contributing! This project is owned and maintained by
[Diagrid](https://diagrid.io) and welcomes external contributions — bug reports, fixes,
docs improvements, and features.

## Reporting issues

Open a [GitHub issue](https://github.com/diagridio/dev-dashboard/issues) with:

- What you did, what you expected, and what happened instead.
- Your OS, dashboard version (`diagrid-dev-dashboard --version`), and Dapr version (`dapr --version`).
- If relevant, diagnostic output from `diagrid-dev-dashboard --verbose` (logs go to stderr).

For feature requests, describe the use case rather than a specific implementation —
it helps us evaluate the best way to fit it into the dashboard.

## Developer Certificate of Origin (DCO)

All commits must be signed off, certifying that you have the right to submit the work
under this project's [Apache 2.0 license](LICENSE) per the
[Developer Certificate of Origin](https://developercertificate.org/):

```sh
git commit -s -m "fix: describe your change"
```

This appends a `Signed-off-by: Your Name <your@email>` trailer to the commit message.
Pull requests with unsigned commits cannot be merged.

## Development setup

**Prerequisites:** Go ≥ 1.26 and Node.js 20 (with `npm`).

```sh
git clone https://github.com/diagridio/dev-dashboard.git
cd dev-dashboard
make build            # builds web/dist, then the Go binary at bin/diagrid-dev-dashboard
./bin/diagrid-dev-dashboard
```

See [Building from source](README.md#building-from-source) in the README for manual steps
and Windows instructions, and [ARCHITECTURE.md](ARCHITECTURE.md) for how the codebase is
organized and how to extend each part.

## Testing

Run the self-contained suites before opening a PR:

```sh
make test              # Go unit tests (-race) + web (Vitest) tests
make test-integration  # Go integration tests (in-process Redis + temp SQLite)
```

There is also an opt-in e2e suite (`make test-e2e`) that requires a local Dapr install
and skips automatically without one. See [Testing](README.md#testing) in the README for
details, including the build-tag gating of the Go tests.

New code should come with tests: Go changes with unit tests (build tag `unit`), frontend
changes with Vitest tests, and state-store/HTTP-path changes with integration coverage
where it applies.

## Pull requests

1. Fork the repo and create a branch from `main`.
2. Keep PRs focused — one logical change per PR.
3. Make sure `make test` (and `make test-integration` if relevant) passes.
4. Run `make tidy` if you touched Go dependencies.
5. Sign off all commits (`git commit -s`).
6. Use clear commit messages; this repo follows the
   [Conventional Commits](https://www.conventionalcommits.org/) style
   (`feat(web): ...`, `fix: ...`, `test(web): ...`).

A maintainer will review your PR. We may ask for changes — see the review comments as a
conversation, not a gate.

## Code style

- **Go:** standard `gofmt` formatting; each domain lives in its own `pkg/*` package with
  no dependency on `cmd/`.
- **Frontend:** React + TypeScript; UI conventions (design tokens, page anatomy,
  component classes) are documented in [`web/STYLEGUIDE.md`](web/STYLEGUIDE.md).

## License

By contributing, you agree that your contributions are licensed under the
[Apache License 2.0](LICENSE), per section 5 of the license.
