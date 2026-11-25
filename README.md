# dsh-context-manager

A DSH (DeepSeek Harness) plugin that adds a **Context manager** entry to the session title bar: remove model-context messages one by one or whole conversation turns — and restore them later. The original session log, chat history, and audit ledger are always preserved.

*中文定位：在会话标题栏增加「上下文管理」入口，按条或按整轮移除模型上下文，之后还能恢复；原始会话日志、聊天记录与审计数据始终保留。*

- Package: `dsh-context-manager` · Version: `1.7.3` · License: MIT
- Type: Cordis bundle (Host half + Web Client half), plain JavaScript, **no build step, no third-party dependencies**
- Compatible with DSH `0.2.1-rc.2` and above (`0.2.2-rc.5` verified)

> ⭐ **Star 一下，让我假装自己是个有影响力的开源作者。**

## Why

Long sessions accumulate error logs, pasted code, failed instructions, verbose tool output, and superseded conclusions — all of which keep consuming context budget and get quoted back by the model. New sessions lose history; global compactors compress everything at once. What is missing is a **scalpel**: remove the exact messages or turns the user selects, keep the original log intact, and be able to undo it.

**中文说明：** 长会话里堆着报错日志、试错指令与推翻的结论，持续占用上下文还容易被模型反复引用。缺的是一把**手术刀**：精确删掉选中的消息或轮次，原日志不动，还能反悔。

## Install

| Source | `target` value | Notes |
|--------|----------------|-------|
| npm | `dsh-context-manager@1.7.3` | [npm](https://www.npmjs.com/package/dsh-context-manager) |
| GitHub | `github:xian-yu-zhao/dsh-context-manager` | No npm CLI needed |
| Local tgz | `file:C:\path\to\dsh-context-manager-1.7.3.tgz` | Release asset / `npm pack` |
| Local dir | `link:C:\path\to\dsh-context-manager` | Dev install; reinstall to pick up Host edits |

Refresh the Web page (F5) or restart after installing — a list icon appears on the right of the session title bar.

Migrating from the deprecated `dsh-message-manager` (1.5.0):

```text
plugin_manager remove_bundle target=dsh-message-manager
plugin_manager install_bundle target=dsh-context-manager@1.7.3
```

The new version still recognizes old tombstones (`kind: message-manager`) and queued records (`plugin:message-manager/pending` / `ack`) — no log cleanup needed. If npm only shows `0.0.0-stage`, staging review is pending; install from GitHub instead.

**中文说明：** 任选来源安装；旧包 `dsh-message-manager` 已弃用，remove 旧包 + install 新包即可，旧日志照常识别。npm 只显示 `0.0.0-stage` 时改从 GitHub 装。

## Requirements

- DSH `0.2.1-rc.2`+ (`0.2.2-rc.5` verified); a running session is required.
- Local compaction needs a loaded backend (e.g. `dsh-compaction-basic`); everything else works without it.
- Purely local: no network calls, no data exfiltration.

## Advantages

| Advantage | What it buys you |
|-----------|------------------|
| **Reversible（可逆）** | Every delete / turn-delete / clean / undo is a tombstone in the append-only log; `restore` / `undo-batch` brings it back. |
| **Surgical（就地裁剪）** | Remove exact messages or whole turns (prompt + work + reply + injected context together). |
| **Budget clean（按预算清理）** | `/ctxmgr clean 60000` drops the largest tool/assistant messages until the target is met; user messages are never eligible. |
| **Audit ledger（审计台账）** | Each operation appends one `plugin:context-manager/batch` record; restart-safe, no external files. |
| **Recall by seq（按 seq 召回）** | Tombstones carry a short `{ seq, role, preview }` pointer; raw events stay in the log, readable via session-query tools. |
| **Local compaction（局部压缩）** | `/ctxmgr compact <start> <end>` sends only the user selection to the official engine. |
| **No-message-rewrite（不改原文）** | Only empty developer messages are appended as surface replacements; the original log is never rewritten. |

**中文说明：** 核心是**可逆性 + 原日志只增不改 + 按 seq 审计**——不重写消息，只追加空 developer 消息做表面替换，每次操作留台账可追溯撤回。

## Use cases

- **Roll back to a turn** — model broke files or drifted: `/ctxmgr turns` → `/ctxmgr deleteturn 5` → re-ask.
- **Drop junk** — error logs, pasted code, failed instructions: `/ctxmgr list` → `/ctxmgr delete 12,13,14`.
- **Forget superseded conclusions** — delete the turns holding overturned plans: `/ctxmgr turns` → `/ctxmgr deleteturn 3,4`.
- **Converge a long session** — remove early exploration turns, keep decision turns: `/ctxmgr deleteturn 2,3,4`.
- **Trim by budget** — `/ctxmgr clean 60000` (largest tool/assistant first; protects user messages + recent 3).
- **Leak stop, with honest limits** — `/ctxmgr delete 9` removes it from the **model context**; the raw session log and chat transcript still contain it. **Not an erasure tool.**

Tool equivalents: `context_manager` with `action` = `delete-turns` / `delete` / `clean` etc.

## Tools & Commands

The model may call `context_manager`; `action` ∈ `list` / `list-turns` / `delete` / `delete-turns` / `restore` / `clean` / `compact` / `batches` / `undo-batch`. The tool description states **use only when the user explicitly asks**.

| Command | Meaning |
|---------|---------|
| `/ctxmgr list` | Current messages + deletion records + queued operations |
| `/ctxmgr turns` | Turn list (number, preview, count, in-progress marker) |
| `/ctxmgr delete <seq,...>` | Delete messages by seq |
| `/ctxmgr deleteturn <turn,...>` | Delete whole turns |
| `/ctxmgr restore <record-seq,...>` | Restore deletion records |
| `/ctxmgr clean <target-tokens>` | Budget clean (tool / assistant only; user messages protected) |
| `/ctxmgr compact <start> <end>` | Local compaction via official `ctx.compaction.compactRegion` |
| `/ctxmgr batches` | Audit ledger (aliases `ledger` / `audit`) |
| `/ctxmgr undo-batch [batchId]` | Undo latest / a specific batch (alias `undo-last`) |

Tool parameters: `seqs` (message / turn / record seq per action), `start` / `end` (`compact`, surface positions), `targetTokens`, `minCandidateTokens` (default `100`), `protectRecent` (default `3`), `batchId` (prefix match for `undo-batch`).

**Dialog**: title-bar list icon → **Context manager**. Sections: budget + token clean (top), turns (per-turn delete), current messages (collapsed by default; filter by role affects display only, user rows are **protected**), deleted (restore per record, batch id shown, falls back to recall pointer). The confirm bar reports total messages removed and estimated tokens freed. Deletion affects **later model requests** only.

## Boundaries & limitations

| Plugin / category | What it does | Our boundary |
|-------------------|--------------|--------------|
| `dsh-context` (official recommendation) | Dashboard, cost charts, occupation visualization | No dashboard or cost charts; in-place trimming only |
| `dsh-compact-manager` / `dsh-compression-improved` | Global threshold / tool-result compression | No global engine; only the user selection |
| `dsh-context-redline` | Migrate to a zero-history session + handoff | No migration; unload into a searchable archive (recall by seq) |
| `@sulytwelve/dsh-context-manager` and `dsh-memory` | Cross-session memory | No cross-session memory |

Same-name plugins are not us — the package is `dsh-context-manager` ([xian-yu-zhao/dsh-context-manager](https://github.com/xian-yu-zhao/dsh-context-manager)). **A scalpel, not a compressor and not a memory store.**

Two limits worth knowing up front: deleted messages **still appear in chat history** (the dialog and later model requests use the current surface), and restoring an assistant message appends a copy at the end rather than back in place. Full list below.

## Deep mechanics

Deletion is an append-only surface replacement; targets in earlier steps apply immediately, others queue to the next `agent/request`. All operations are idempotent (ack, never replayed twice) and survive restarts. Recall pointers, audit-ledger fields, the local-compaction contract, token-estimate heuristics, the restore capability boundary, and behavior limits are documented in [docs/DETAIL.md](docs/DETAIL.md) / [中文版](docs/DETAIL.zh.md).

**中文说明：** 删除是只追加的表面替换；更早步骤立即生效，其余排队到下一个 `agent/request`，ack 保证不重放。召回指针、台账字段、压缩契约、token 估算、恢复能力边界与行为限制详见 DETAIL 文档。

## Changelog

- `1.7.3` — Docs only: README rewritten in the English-led house style (Why / Advantages / Use cases / Boundaries / Deep mechanics), maintainer notes moved to `CONTRIBUTING.md`, DETAIL docs expanded. No code changes.
- `1.7.2` — `compact` unbalanced errors translated into Chinese with actionable hints; ledger full-scans the session log.
- `1.7.1` — Fixed empty `/ctxmgr batches` and queue cursor bugs; `undo-batch` no longer reselects undone batches.
- `1.7.0` — Token metering, budget `clean`, batch ids, ledger, recall pointers, local `compact`, filter dropdown, 49 tests.
- `1.6.0` — Renamed from `dsh-message-manager` to `dsh-context-manager`; backward compatible with old logs.
- `1.5.0` — Publishable package, detail page, market submission, npm release.
- `1.4.0` — Whole-turn delete (`/ctxmgr turns` / `deleteturn`) and dialog turns section.
- `1.3.0` — Earlier releases (see `CHANGELOG.md`).

## License

MIT
