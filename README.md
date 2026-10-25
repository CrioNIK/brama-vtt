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

Wall properties provide separate **None**, **Normal**, **Limited**, **Proximity**, and **Reverse proximity** modes for sight, light, and sound. Movement remains a checkbox. None does not block; Normal blocks at the first crossing; Limited allows one distinct crossing and blocks at the second along the same line. Coincident segments or segments meeting at the same endpoint count as one crossing: this is BRAMA's defined rule. Open doors do not block. Sound restrictions are stored and supported by geometric queries; spatial audio playback is not available.

Proximity permits passage for nearby sources; Reverse proximity permits it for distant sources. The test uses distance to the finite wall segment, including its ends, and accounts for source size where the perception profile supplies it. Exactly at the adjusted cutoff, the distance exception does not apply. Enter each channel's positive threshold in scene units; it is stored in pixels, up to 100,000. Blank (`null`) or missing values mean no distance exception and retain normal blocking, subject to the other wall settings. Changing modes keeps entered distances in the draft; saving a non-threshold mode clears that channel's distance. The shared **Threshold attenuation** setting is retained when its control is hidden and defaults to off. It changes the effective perception region beyond a wall, not its opacity; a raw collision query alone does not describe the resulting reach.

**Blocking side** offers **Both sides**, **Block from the left**, and **Block from the right**. Left and right are relative to the ordered arrow from endpoint A to endpoint B, not the sides of the screen. The live preview marks A and B and highlights the configured source side; the selected directional wall shows the same orientation on the map. Direction filters enabled sight, light, sound and movement restrictions from the source side before collision testing or Limited-crossing counting. Reversing A and B alone reverses the physical blocking side; reversing the endpoints and swapping Left/Right preserves it. Open doors retain this setting but do not block.

Older boolean wall settings remain compatible; explicit per-channel modes take precedence. Stored walls without a direction default to Both sides. Scene import supports Neutral Scene 0.1–0.11 and accepts explicit directional labels with their ordered endpoints across those versions; unknown direction values are rejected. Limited restrictions require version 0.9 or later. Threshold settings, an explicit vision-range origin, and explicit light-perception settings require version 0.11. The import preview counts each wall with a limited mode once, even when several channels use it.

BRAMA preserves fractional scene coordinates in geometric queries without rounding them to whole pixels. Movement determines the source side from the token center at the start of the move, then checks the swept axis-aligned rectangle defined by the token’s width and height. This footprint can collide even when a center-point path is clear; movement and point visibility are different contracts.

The game master can measure a token's vision range from its **Center** or **Token edge**. Center is the legacy default. Token edge adds half the smaller occupied dimension to a positive configured range; queries still originate at the token center. A finite unlit range of 0 grants no vision in darkness, even with Token edge. **Unlimited vision without light** is a separate option.

**Perceives illuminated areas** controls additional vision of areas that are actually lit. Its range is separately finite or unlimited; disabling it or setting its finite range to 0 disables this additional path. Positive finite ranges use the same range-origin setting. Unlimited removes the distance cap, while wall and perception-region restrictions still apply. Older tokens without this profile retain enabled, unlimited light perception; unrelated edits do not create an explicit profile.

Scene import accepts a redundant `basicSight` detection entry only when both it and sight are enabled, its range matches the sight metadata, and it contains no extra fields. Version 0.11 also accepts explicit `lightPerception` settings consistent with their source metadata; an explicit detection record requires corresponding normalized settings. Other detection modes, unknown fields, and mismatches remain unsupported.

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

Point queries ignore a wall when their source lies exactly on its supporting line—the straight line extended beyond either endpoint—even for Both sides. Directional movement also ignores that wall when the starting token center lies exactly on this line. Both-sides movement keeps the rectangular footprint collision check in this case. Nearby fractional coordinates are not rounded onto the line.

Token visibility checks the center and samples inside the rendered circular body, so a partly exposed token can be visible while its center is behind a wall. Sampling adapts to token size and is capped at 257 points; a narrow opening between samples can still be missed. Selection-box corners, labels, and outlines do not grant visibility. Hidden-token and ownership permissions remain separate. Fog conceals the map visually; scene geometry and background assets are still sent to players and are not confidential.

BRAMA is an early working application. It does not implement a complete ruleset, unrestricted scripting, collaborative text merging, native journal roundtrips, map pins, audio/video/PDF pages, or a public hosting service. Imported unsupported rules are reported or rejected rather than silently executed. The vision model and mobile editing have explicit limits. A passing test suite demonstrates its tested contracts, not universal compatibility or every possible game scenario.

Intersecting limited walls have a conservative rendering boundary: point visibility counts a coincident crossing once, while the mask clips the exact zero-width intersection ray so it cannot open a wider visible wedge. Intersection work is capped at 32,768 wall-pair comparisons and 2,048 intersections. Exceeding either budget makes limited walls act as normal walls for that rendered mask only. This can conceal otherwise visible areas; blockers are never discarded, and point visibility keeps its limited-crossing rule.

## Author and permissions

Created and maintained by **CrioMant / [CrioNIK](https://github.com/CrioNIK)**. Request commercial permission through the repository's **Commercial permission** issue form. State the intended use, distribution model, and organisation. Opening an issue is not permission; wait for an explicit written agreement.

Copyright © 2026 CrioMant. BRAMA project code and original assets are governed by [LICENSE.md](LICENSE.md). Dependency notices and licences remain applicable to their respective components.
