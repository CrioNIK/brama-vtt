# Contributing to BRAMA VTT

[English](CONTRIBUTING.md) · [Українська](docs/uk/CONTRIBUTING.md) · [Español](docs/es/CONTRIBUTING.md) · [Polski](docs/pl/CONTRIBUTING.md) · [Čeština](docs/cs/CONTRIBUTING.md)

I welcome bug reports, accessibility improvements, translations, and focused changes. For a large change, open an issue describing the problem and the intended behaviour before implementing it.

1. Read [LICENSE.md](LICENSE.md). Submit only material you have the right to contribute. Contributions use the project licence; submitting them does not transfer copyright or grant an automatic commercial exception.
2. Use Node.js 24.12+ within 24.x and run `npm ci`.
3. Keep data contracts, permission checks, and command behaviour explicit. Do not translate stored user content or change technical protocol keys to localised words.
4. Add or update English message keys and all five language values. Preserve named placeholders. Document behaviour in the original English documentation and update its Ukrainian, Spanish, Polish, and Czech editions.
5. Run `npm test`, `npm run typecheck`, and `npm run build`. Check affected interfaces at desktop and narrow widths, including keyboard interaction and errors.
6. In the pull request, describe the problem, resulting behaviour, verification, and remaining limits. Do not include credentials, personal campaign data, databases, copied commercial content, or generated dependency folders.

I review contributions under **CrioMant / CrioNIK**. Inclusion in the project is a technical review decision and does not grant commercial permission.
