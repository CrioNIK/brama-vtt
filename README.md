# BRAMA VTT

**A multilingual virtual tabletop by [CrioMant](https://github.com/CrioNIK).**

[English](README.md) · [Українська](docs/uk/README.md) · [Español](docs/es/README.md) · [Polski](docs/pl/README.md) · [Čeština](docs/cs/README.md)

I'm building BRAMA as a shared space for tabletop stories: a map, characters, dice, journals, and a clear distinction between the game master's view and each player's view. The application runs on your computer and keeps campaign state in a local database.

**Source available for noncommercial use. Commercial use requires my prior written permission.** See [LICENSE.md](LICENSE.md). This restriction means the project is not distributed under an OSI open-source licence. Third-party dependencies retain their own licences, listed in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

## What is available

- Scenes with square grids, levels, tokens, walls, doors, lights, measurement, and a limited vision model.
- Separate game master and player sessions, explicit ownership, and server-side filtering of private information.
- Character sheets, inventory, ability checks, saving throws, skills, resources, effects, and configurable progression.
- Action costs, dice results, and explicit damage or healing application as separate steps.
- A combat queue with initiative, tied-order controls, counters, and previous-turn restoration.
- Journals with formatted text, images, folders, document and page permissions, private game master notes, and targeted presentations.
- Campaign JSON export, validated interchange import, and durable confirmations for supported commands.

The interface supports **English, Spanish, Ukrainian, Polish, and Czech**. Ukrainian is the initial interface language; the language picker remembers your choice. Changing the interface language does not translate or replace campaign content written by players. English is the original documentation language; the other four editions cover the same material.

## Run locally

Install **Node.js 24.12 or later within the 24.x line**, then run:

```sh
git clone https://github.com/CrioNIK/brama-vtt.git
cd brama-vtt
npm ci
npm run build
npm start
```

Open **http://127.0.0.1:8015/**. Create a campaign, then use its invitation link in another tab to join as a player. The game master grants token and character access separately. Session credentials remain in that browser tab; keep the game master tab available.

The server deliberately binds to loopback. Invitation links work on this computer; Internet hosting and account recovery are not included. `PORT` changes the local port and `VTT_DB` changes the SQLite path. The default database is `server/data/vtt.sqlite`.

## Play and create

Use the map tools to select and move objects, measure distance, or add tokens, walls, doors, and lights. Choose a scene and level before editing. Token ownership controls who can manipulate a piece; sheet permissions control who can inspect its character data.

Create character actions and their resource costs explicitly. Review a cost before executing an action. A successful action can produce a roll; applying its damage or healing is another explicit operation. This avoids treating a displayed dice result as an automatic change to hit points.

In combat, add participants, set or roll initiative, then start the encounter. The queue supports defeated participants, tied initiative, counters, and reversing the previous transition. It does not enforce every game rule or prevent out-of-turn map movement.

Use journals for handouts and notes. Pages may inherit document access or have their own permissions. A targeted presentation sends a saved copy of selected pages without granting permanent access to the source. Later edits do not change that copy. Archiving a journal revokes its active presentations; restoring it does not resend them.

Export the campaign periodically. An export is a portable JSON document; it is not a replacement for the live database or a promise of one-click campaign restore. Stop the server before copying the database and its associated SQLite files for a consistent local backup. Do not commit campaign databases, exports, invitation codes, or session credentials to a public repository.

## Development and verification

```sh
npm test
npm run typecheck
npm run build
```

For separate frontend development, run `npm run dev` and `npm run client` in two terminals. Vite uses port 5173 and proxies the API and WebSocket connection to port 8015.

The project uses React, TypeScript, Vite, Node's SQLite support, WebSockets, Tiptap, and HTML sanitisation. `client/` contains the interface, `server/` authoritative commands and storage, `shared/` data contracts and rule helpers, and `tests/` regression cases and self-contained fixtures. Translations use English message keys with named parameters; player-authored text is not a translation key.

Changes should preserve command validation, permission filtering, atomic writes, and retry behaviour. A lost acknowledgement does not prove a command failed. Use the interface's result-recovery action rather than issuing a new operation while its outcome is unknown. See [Contributing](CONTRIBUTING.md) and [Security](SECURITY.md).

## Current boundaries

BRAMA is an early working application. It does not implement a complete ruleset, unrestricted scripting, collaborative text merging, native journal roundtrips, map pins, audio/video/PDF pages, or a public hosting service. Imported unsupported rules are reported or rejected rather than silently executed. The vision model and mobile editing have explicit limits. A passing test suite demonstrates its tested contracts, not universal compatibility or every possible game scenario.

## Author and permissions

Created and maintained by **CrioMant / [CrioNIK](https://github.com/CrioNIK)**. Request commercial permission through the repository's **Commercial permission** issue form. State the intended use, distribution model, and organisation. Opening an issue is not permission; wait for an explicit written agreement.

Copyright © 2026 CrioMant. BRAMA project code and original assets are governed by [LICENSE.md](LICENSE.md). Dependency notices and licences remain applicable to their respective components.
