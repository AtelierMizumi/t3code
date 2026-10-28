# ZCode

ZCode is Z.ai's coding agent. T3 Code drives the CLI that ships inside the ZCode desktop app, using the same Z.AI coding-plan login as the app itself.

## Install

Install the [ZCode desktop app](https://zcode.z.ai) and sign in there, or run `zcode login` on the machine that hosts T3 Code.

Turn the provider on in **Settings** → **ZCode**. T3 Code looks for the bundled CLI (`zcode.cjs`) next to the app; set **Binary path** only if yours lives somewhere unusual.

Do not point Binary path at the Electron wrapper named `zcode` on Linux package installs. That launches the GUI. The CLI entry is the `zcode.cjs` file inside the app bundle.

## Quota

ZCode's coding-plan quota is tied to the official app identity. T3 Code starts that CLI with the desktop surface and your existing ZCode login, so usage is counted like the ZCode app — not like a third-party client that only has an API key.

If Settings shows ZCode as installed but unauthenticated, sign in with the ZCode app (or `zcode login`) and refresh the provider.
