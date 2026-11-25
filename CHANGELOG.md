# Changelog

## 1.7.2

- 修复：局部压缩遇到「边界不是整步边界」时，原本会把引擎的英文异常原文透出（`compactRegion: end seq N is not a balanced boundary ...`）。现在翻成中文并给出可执行的建议（换成已结束步骤的首/末条消息序号）。
## 1.7.1

- 修复：操作台账（`/ctxmgr batches`）在个别时刻读成空台账。根因是把日志事件序号当成「已消费事件数」传给 `snapshotEvents(n)`，窗口可能落到日志末尾之外；台账现在每次全量扫描会话日志（只由用户命令触发，成本可忽略）。
- 修复：持久队列（删除/恢复的排队重放）使用同一错误游标，改为按「已消费事件数」推进——与 agent-loop 的 `storedCount` 写法一致，不再有跳过记录的窗口。
- 修复：`/ctxmgr undo-batch` 可能重复选中「已经撤销过」的批次（撤销是排队到下个请求才落地，连调工具时墓碑仍在表面上）。现在同时看台账信号：某批次已被一条 `op=undo` 记录点名即视为已撤销，再撤销会明确报「还没有可撤销的批次记录」。
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
- Recall pointers: every tombstone `source` is now `{ kind: 'context-manager', batchId, recall }`, where `recall` holds at most 8 `{ seq, role, preview }` entries (`RECALL_MAX_ENTRIES = 8`) with previews truncated to 80 characters (`RECALL_PREVIEW_LIMIT = 80`). It stores the original seq, the role and a one-line preview — never the full message text — and the tombstone `content` stays an empty array, because a tombstone must project as an empty message. Older tombstones without `batchId` / `recall` keep working unchanged. The dialog's deleted rows fall back to 可召回 #seq · 摘要 when the original text is no longer on the surface.
- Retrieving deleted originals: the recalled `seq` is the session seq of the original event, so the read-only tools of `@deepseek-ai/dsh-tool-session-query` (`session_search`, `session_event_search`, `session_trace`, `session_event_trace`, `session_event_read`) can locate it — search it by keyword with `session_event_search`, or read the complete unredacted event as JSON with `session_event_read`. Searches exclude the caller's own session and are authorized by the workspace `cwd`. Deleting is therefore redefined as unloading the range from the main context into a searchable archive: the main context no longer carries it, while the raw event stays in the append-only session log and can be fetched back by seq or keyword.
- Local compaction: new `/ctxmgr compact <start> <end>` command and `context_manager` action `compact` (parameters `start` / `end`). It calls the official `ctx.compaction.compactRegion(start, end, agentCtx, signal)`; `start` / `end` are surface position seqs (not numeric order) and both edges must be tool-pair balanced, otherwise the engine reports an unbalanced region. This is the only place the plugin leans on official compaction, and it is strictly limited to the user selection — no global threshold compaction (that is `dsh-compact-manager` / the compaction backend). A loaded compaction backend (e.g. `dsh-compaction-basic`) is required: without one the plugin shows a clear Chinese hint and records the failure in the ledger, and the plugin does not hard-depend on the service (it gets `compaction` optionally via `ctx.get('compaction')`). Success and failure both append one `op: 'compact'` ledger entry with the shadowed node count and tokens. Unlike delete / clean, which unload restorably with no summary, compact replaces the range with one official summary.
- Header dialog: a new filter dropdown (全部 / 用户 / 助手 / 工具 / 上下文) that only affects display — selection, token totals and the Host planner are untouched — with a 显示 X/Y counter; user message rows carry a 受保护 (protected) marker, matching that clean never selects user messages.
- Tests: three zero-dependency `node:test` files under `test/` with 49 cases in total (`core.test.mjs` 9, `batch.test.mjs` 14, `surface.test.mjs` 26), covering `planDeletion` tool-group linkage, `deletedFromSurface`, `foldSurface`, `turnsFromSurface`, `planClean` protection and ordering, `undo-batch` selection (including ambiguous-prefix rejection), and recall pointers with tombstone projection.
- Boundary fixes: a tombstone can no longer be deleted as if it were a message (the plugin answers 该序号是一条删除记录（墓碑）…请用 restore), and `foldSurface` ignores malformed surface objects that lack a `seq`.

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
