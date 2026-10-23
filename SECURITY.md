# Security

[English](SECURITY.md) · [Українська](docs/uk/SECURITY.md) · [Español](docs/es/SECURITY.md) · [Polski](docs/pl/SECURITY.md) · [Čeština](docs/cs/SECURITY.md)

BRAMA currently targets local use. It binds to loopback, stores session credentials in a browser tab, and persists campaign state in SQLite. The application is not an Internet account service. Do not expose the development server directly to the public Internet.

The server validates commands and filters private data for each member. Token ownership, character-sheet access, journal access, and presentation recipients are distinct permissions. A client interface is not a security boundary. HTML is sanitised; imported archives are inert data, not executable extensions.

For a suspected vulnerability, use GitHub's private vulnerability reporting if it is available on this repository. Otherwise, open an issue asking for a private contact without publishing exploit details or private data. Include affected versions, a minimal reproduction using synthetic data, expected and actual behaviour, and impact. Never include session tokens, invitation codes, live databases, or another person's campaign material.

No guaranteed response time or long-term support window is offered for this early release. Back up local data and review changes before upgrading.
