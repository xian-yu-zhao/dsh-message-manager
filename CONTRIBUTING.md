# Contributing & maintaining dsh-context-manager

Maintainer-facing notes. Users only need the [README](README.md); deep mechanics are in [docs/DETAIL.md](docs/DETAIL.md) / [DETAIL.zh.md](docs/DETAIL.zh.md).

## Structure

| File | Role |
|------|------|
| `index.js` | Host half: `/ctxmgr` commands, `context_manager` tool, delete/restore planning, durable queue, `agent/request` applier |
| `core.js` | Pure functions: surface folding, deletion plans, tombstones, list/turn formatting |
| `client.js` | Client half: title-bar button + dialog (turns / messages / deleted) |
| `cordis.patch.yml` | Inserts one plugin row into the profile patch |
| `locale/*.json` | Plugin-manager / detail-page titles, descriptions, doc paths |
| `docs/DETAIL*.md`, `docs/preview.svg` | Detail-page docs (single text-free preview) |
| `test/*.test.mjs` | 69 zero-dependency `node:test` cases |

**About `@deepseek-ai/*` imports:** the Host needs internal helpers of `@deepseek-ai/dsh-session`. With `link:` installs the real path is outside the profile, so a bare import fails with `ERR_MODULE_NOT_FOUND`; the plugin first tries a bare import, then builds an absolute asar URL from `process.argv[2]` (Host cwd) — the same URL resolves to the same module instance, which the Session private brand check requires.

## Development

```bash
# Syntax check (no build step)
node --check index.js
node --check client.js
node --check core.js

# Tests: 69 zero-dependency cases, built-in modules only
node --test "test/*.test.mjs"
```

| Test file | Cases |
|-----------|-------|
| `test/core.test.mjs` | 24 |
| `test/batch.test.mjs` | 19 |
| `test/surface.test.mjs` | 26 |

Coverage: `planDeletion` tool-group linkage, `deletedFromSurface`, `foldSurface` (including malformed surfaces missing `seq`), `turnsFromSurface`, `planClean` protection/ordering, `formatCleanPlan` dry-run preview (gap and preview limits), CJK-aware token pricing (`isCjkCodePoint` / `estimateTextTokens`), `formatBatches` one-row-per-batch grouping, `undo-batch` selection (including ambiguous-prefix rejection), recall pointers and tombstone projection.

Client edits need a page refresh (F5) or app restart; Host edits need a bundle reinstall:

```text
plugin_manager remove_bundle   target=dsh-context-manager
plugin_manager install_bundle  target=link:<插件目录>
```

## Publishing (maintainers)

`publishConfig` pins `registry.npmjs.org` + `access: public`; `files` covers runtime files, locales, icon and `docs/`.

```bash
npm publish          # publish dsh-context-manager@<version>
git push origin main
```

Order: bump `package.json` → update `CHANGELOG.md` → syntax check → normalize README per the `dsh-plugin-readme` skill → `npm publish` → tag / upload tgz to Release → push GitHub. The `npm-publish-sop` skill covers the interactive 2FA/OTP flow.

## Plugin market listing

DSH's market (**Plugins → Discover**) has **no official index** — it only reads user-added index URLs, each a format-1 JSON. The community de facto index is [awesome-dsh-plugin](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin): `https://awesome-dsh-plugin.com/index.json`.

1. Sidebar **Plugins** → **Experimental plugins** → **Custom plugin indexes** → **Discover** → **Add index source**, paste the URL.
2. Search `context manager`; Install passes the index's `name@version` to the same `installBundle`.

To be listed, open a PR adding only `data/plugins/xian-yu-zhao__dsh-context-manager.yml` from [`market/awesome-dsh-plugin.yml`](market/awesome-dsh-plugin.yml):

```yaml
url: https://github.com/xian-yu-zhao/dsh-context-manager
name: xian-yu-zhao/dsh-context-manager
category: session
description:
  en: 'Manages the model context of a DSH session: removes single messages or whole conversation turns (roll back to the start of a turn) and can restore them later.'
  zh: '管理 DSH 会话的模型上下文：按条或按整轮移除消息（可回退到某一轮的开始），之后还能恢复。'
```

Gates already met: `dsh.bundle` declared ✅, real working code ✅, repo older than one day ✅, `dsh-plugin` topic added ✅. Any static https URL can host a format-1 index (**no redirects**); `versions[].source` is either `{"type":"npm"}` (optional `registry`) or `{"type":"git","url":"...","commit":"<40 lowercase hex>","path?":"subdir"}`. Field details, icon limits (`data:` ≤ 32 KiB) and validation live in `@deepseek-ai/dsh-plugin-market-index`.
