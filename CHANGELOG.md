# Changelog

## 1.7.0

- Token metering: `core.js` gains `estimateMessageTokens`, a heuristic priced like DSH's own `dsh-token-meter` (4 characters ≈ 1 token, +4 per content block, +4 role overhead per message). The message list shows `≈N tok` per message and the current total context occupation; delete, whole-turn delete and clean results report the estimated tokens released. These are estimates only — Chinese text and JSON are markedly underestimated.
- Budget clean-up: new `/ctxmgr clean <target tokens>` command and `context_manager` action `clean` (optional `targetTokens`, `minCandidateTokens`, `protectRecent`). Candidates are only `tool` / `assistant` messages, sorted by estimated tokens descending; user and context messages are never eligible, the most recent 3 messages are protected by default, candidates below 100 tokens are skipped by default, and the clean stops once the budget is met. Deletion reuses the existing delete pipeline (`planDeletion` + tombstones + durable queue), not a second deletion path.
- The header dialog gains a budget row at the top: a target-token field plus a clean button.
- The Host prefers node pricing from `ctx.tokenMeter.measure()` and falls back to the local heuristic when no token meter is injected.
- Batch ids: every delete, whole-turn delete and budget clean now mints a `batchId`, recorded in the tombstone `source` as `{ kind: 'context-manager', batchId: '<uuid>' }`. `kind` stays the only marker, so tombstones written before batch ids keep working unchanged.
- Audit ledger: every operation appends one `plugin:context-manager/batch` record to the session log — `batchId`, `op` (`delete` / `delete-turn` / `clean` / `undo`), target `seqs`, written `tombstoneSeqs`, `estimatedFreedTokens`, outcome (`applied` / `queued` / `skipped` / `failed`) and `reason`. The ledger is append-only, persists with the session log, survives restarts and writes no external files.
- `/ctxmgr batches` (aliases `ledger` / `audit`) lists the ledger, and the `context_manager` tool gains `action=batches`.
- `/ctxmgr undo-batch` undoes the latest batch, `/ctxmgr undo-batch <batchId prefix>` a specific one (alias `undo-last`); the tool exposes `action=undo-batch` with an optional `batchId`. Undo reuses the existing restore path (durable queue + idempotent ack) instead of a second restore mechanism, and leaves its own `op=undo` ledger entry.
- Header dialog: each deleted-record row shows the first 8 characters of its batch id, and a "undo last operation" button at the bottom undoes the most recent batch.
- README: added a 与同类插件的边界 (boundaries against similar plugins) section covering `dsh-context`, `dsh-compact-manager` / `dsh-compression-improved`, `dsh-context-redline`, the same-named `@sulytwelve/dsh-context-manager` and memory plugins, plus the audit ledger section and the new commands and tool actions.

## 1.6.0

- Renamed the package and bundle from `dsh-message-manager` to `dsh-context-manager` (1.5.0 → 1.6.0): a new npm package plus a renamed GitHub repository. The old package is deprecated on npm in favour of the new one, and the old repository URL redirects to the new one.
- Renamed the command `/msgmgr` to `/ctxmgr` (same subcommands: `list` / `turns` / `delete` / `deleteturn` / `restore`) and the model tool `message_manager` to `context_manager` (same actions: `list` / `list-turns` / `delete` / `delete-turns` / `restore`). The bundle patch id is now `context-manager`.
- Renamed the header entry and dialog from 消息管理 to 上下文管理 (Context manager in English); the plugin title in the Plugin Manager follows the same name.
- README: added a 使用场景 section with concrete workflows — rolling back to the start of a turn and asking again, dropping error logs and trial instructions entry by entry, forgetting superseded conclusions, converging over-long sessions, and the honest limits of removing leaked content — and updated every install source to 1.6.0 with migration steps from the old package.
- Backward compatible with session logs written by 1.5.0: tombstones whose source kind is `message-manager` and queued records `plugin:message-manager/pending` / `plugin:message-manager/ack` are still recognized, restored and applied, so no manual log cleanup is needed.
- Plugin market submission moved to `data/plugins/xian-yu-zhao__dsh-context-manager.yml` (category `session`).

## 1.5.0

- Publishable package: renamed from `@local/dsh-message-manager` to `dsh-message-manager`, dropped `private`, added keywords, `author`, `publishConfig` (public, `registry.npmjs.org`), `homepage`/`bugs`, and a `files` whitelist that covers runtime files, locales, icon and `docs/`.
- The bundle patch row now names `dsh-message-manager`, so the installed bundle resolves from the npm package, a GitHub spec, a tarball or a linked directory alike.
- Plugin detail page: `docs/DETAIL.md` / `docs/DETAIL.zh.md` with a single text-free `preview.svg`, declared through `meta.detail`; `meta.description` now carries the full capability, entry points and limitations for the Plugin Manager and market listing.
- README rewritten: install sources (npm / GitHub / tgz / local directory), the header dialog walkthrough, command and tool reference, queued-apply rules, restore boundaries, limitations, and a maintainer publish procedure.
- Published to npm as `dsh-message-manager@1.5.0`, and verified end to end by installing that spec through `plugin_manager` (pnpm resolved the registry tarball, the bundle activated, `message_manager` answered).
- Plugin market: added the community index submission at `market/awesome-dsh-plugin.yml` (category `session`) and documented how the market indexes work, since DSH ships no official index. Repository gained the `dsh-plugin` topic.

## 1.4.1

- The message list section starts collapsed in the header dialog, keeping the turns view in focus; click its header (chevron) to expand. The section keeps its select-all and batch-delete actions usable while collapsed.

## 1.4.0

- Delete a whole conversation turn in one action: the user prompt, the assistant work and reply, and that turn's injected context. `core.turnsFromSurface` groups the surface by turn (a node's own `data.turn`; tombstones stay invisible, so a fully deleted turn disappears).
- `deleteTurnNow` reuses the single-message planner per remaining node, so every tombstone keeps its own restore semantics: user messages restore in place, assistant groups and text restore at the tail. Tombstones already on the surface are left untouched.
- `/msgmgr turns` / `list-turns` lists turns with numbers and previews (`T3 · … · 12 条`), marking the turn that is still in progress.
- `/msgmgr deleteturn <轮号,...>` and the `message_manager` tool actions `list-turns` / `delete-turns` delete turns now when safe or queue them durably (`delete-turn` pending records) — including turns that are still in progress, which apply at the next request.
- The header dialog gains a turns section above the message list: per-turn row with selection, preview, message count, in-progress note, and a delete button, plus batch select-all and a turns-specific confirm bar.

## 1.3.0

- Durable queue: idle deletions and restores are recorded as `plugin:message-manager/pending` records in the session log itself, so queued operations survive Host restarts instead of living only in memory. Applied records are acknowledged (`plugin:message-manager/ack`) and never replay twice; replayed operations whose target vanished are acknowledged as skipped.
- `/msgmgr list` and the `message_manager` tool now also list deleted records (with the tombstone seqs `restore` needs) and queued operations, giving the model the same view as the header dialog.
- The confirm bar in the header dialog now shows the total removal count and the tool-group hint when a selection expands (deleting an assistant tool-call message or a tool result takes its whole group along).
- `openStepOf` scans the log backward, so finding the open step no longer walks the whole history.

## 1.2.0

- Batch selection: delete multiple messages in one action.
- Deleted records list with per-item and batch restore.
- Restore user/context messages at their original surface position.
- Restore assistant text and assistant tool-call groups by appending them at the tail with a valid tool lifecycle.
- Queue delete/restore operations until the next `agent/request`, so no event is appended outside an open turn/step.

## 1.1.0

- Fix false "operation failed" after a successful command by unwrapping `RemoteResult`.
- Queue idle deletions and apply them inside the next request instead of appending outside an open step.
- Prevent corrupt session logs caused by `developer/message` tombstones outside an open turn/step.

## 1.0.0

- Initial release: header message manager, per-message deletion, `/msgmgr` command, and `message_manager` tool.
