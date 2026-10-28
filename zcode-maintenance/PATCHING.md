# ZCode patch — architecture & update runbook

`zcode-main` = `upstream/main` + three kinds of commits:

1. The original PR merge (`aintoniodev/feat/zcode-provider` + hardening), kept
   for provenance — most of its code was later superseded.
2. `feat(provider-zcode): add ZCode provider package on ProviderAdapterV2` —
   the actual provider implementation as a self-contained workspace package.
3. Future upstream-sync merge commits (via `sync-upstream.sh`).

## Where the ZCode code lives

Everything functional sits in `packages/provider-zcode/` — a standard provider
package per `docs/internals/adding-a-provider.md`:

| File                           | Role                                                                                         |
| ------------------------------ | -------------------------------------------------------------------------------------------- |
| `src/settings.ts`              | Instance settings schema (`makeProviderSettingsSchema`), off by default                      |
| `src/client.ts`                | `ProviderClientDefinition` (label + plain-data icon) for web/mobile                          |
| `src/server/executable.ts`     | CLI discovery: finds `zcode.cjs` inside the desktop app, skips Electron launchers            |
| `src/server/desktopAuth.ts`    | Reads `~/.zcode/v2/{config,credentials}.json` → coding-plan provider/model/env               |
| `src/server/rpc.ts`            | ZCode Protocol stdio connection (line-delimited JSON), session create/resume/subscribe       |
| `src/server/adapter.ts`        | `ProviderAdapterV2`: turns, streaming, tool items, approvals/questions, model+mode switching |
| `src/server/status.ts`         | Health probe (version + plan auth), snapshot builders, static GLM model catalog              |
| `src/server/textGeneration.ts` | Ephemeral plan-mode session for commit/PR/title helpers                                      |
| `src/server/driver.ts`         | `ProviderDriver` assembly (snapshot + adapter + text generation)                             |

## Seam map — the ONLY upstream files this patch touches

When upstream refactors, conflicts can only appear here. Each seam is one or
two additive lines; re-applying after an upstream refactor is mechanical.

| Upstream file                                     | The seam                                                                                                                                                                                                       | Anchor                                                                      |
| ------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| `apps/server/src/provider/builtInDrivers.ts`      | import `ZcodeDriver` + `ZcodeDriverEnv` union member + array entry (before `AcpRegistryDriver`)                                                                                                                | `import { PiDriver ... }` block and `BUILT_IN_DRIVERS` array                |
| `packages/client-runtime/src/providerClients.ts`  | import `zcodeClient` + registry entry (before `acpRegistryClient`)                                                                                                                                             | `import { piClient ... }` and the `makeProviderClientRegistry([...])` array |
| `packages/contracts/src/model.ts`                 | `const ZCODE_DRIVER_KIND = ProviderDriverKind.make("zcode")` + entries in `DEFAULT_MODEL_BY_PROVIDER`, `DEFAULT_TEXT_GENERATION_MODEL_BY_PROVIDER`, `MODEL_SLUG_ALIASES_BY_PROVIDER`, `PROVIDER_DISPLAY_NAMES` | next to the other `*_DRIVER_KIND` consts and maps                           |
| `packages/contracts/src/settings.ts`              | `"zcode"` in `DEFAULT_DISABLED_PROVIDER_DRIVERS`                                                                                                                                                               | the driver-name array (~line 1329)                                          |
| `apps/server/src/provider/providerStatusCache.ts` | `"zcode"` in `BUILT_IN_DRIVER_ORDER`                                                                                                                                                                           | the order array                                                             |
| `apps/server/src/provider/model-manifest.json`    | `{"driver": "zcode", ...}` compatibility entry + bump top-level `updatedAt`                                                                                                                                    | entries array                                                               |
| `apps/server/package.json`                        | `"@t3tools/provider-zcode": "workspace:*"`                                                                                                                                                                     | dependencies                                                                |
| `packages/client-runtime/package.json`            | `"@t3tools/provider-zcode": "workspace:*"`                                                                                                                                                                     | dependencies                                                                |
| root `package.json`                               | `--workspace packages/provider-zcode` in `knip:check`                                                                                                                                                          | the workspace list                                                          |
| `docs/user/install.md`                            | ZCode row in the providers table                                                                                                                                                                               | end of table                                                                |
| `docs/user/providers-zcode.md`                    | standalone file (ours, no conflict risk)                                                                                                                                                                       | —                                                                           |

If upstream renames one of these anchors, the fix is: find the new anchor
(grep the table's left column), re-add the one line, typecheck.

## Update runbook

```sh
cd ~/src/t3code
zcode-maintenance/sync-upstream.sh            # merge + typecheck + test + build + package
git push origin zcode-main                     # publish the sync commit
# then install the printed pacman command (sudo required once)
```

`git rerere` is enabled in this clone: conflicts you resolved once are
auto-resolved in later merges. On a NEW clone run:

```sh
git config rerere.enabled true && git config rerere.autoUpdate true
```

### Conflict triage

`sync-upstream.sh` prints each conflicted file grouped by what it means:

- **zcode package files** — upstream moved an interface; adapt
  `packages/provider-zcode` to it (the typecheck output names the breakage).
- **contracts/builtInDrivers/providerClients seams** — re-add the additive
  line per the seam map; keep both sides' entries.
- **anything else** — the patch shouldn't have opinions there; take upstream.

## Rollback to stock T3 Code

```sh
sudo pacman -Rdd t3code-bin && paru -S t3code-bin   # reinstall stock AUR build
```

The `epoch=1` on our package means pacman considers the fork newer than any
stock `0.x`; removing it first makes the AUR version installable again.

## Testing gap (known)

Unit tests cover discovery, protocol parsing, and approval mapping
(`packages/provider-zcode/src/server/*.test.ts`). The upstream bar for a
provider also includes orchestrator replay fixtures
(`apps/server/src/orchestration-v2/testkit/`) and a recorder script; that
tier is not implemented yet — live sessions against the real ZCode app are
the current verification path. If you want it, mirror
`packages/provider-pi` (adapter.test.ts) and the `record-pi-rpc-replay-fixture.ts`
script.
