![A whole conversation turn selected in the Context manager dialog and removed from the model context](preview.svg)

- Roll back to the start of a turn: `/ctxmgr turns` to read the turn numbers, `/ctxmgr deleteturn 5` to remove that whole turn from the context, then ask again.
- Drop noise: `/ctxmgr list` to find the indexes, `/ctxmgr delete 12,13,14` to clear error logs and trial-and-error instructions entry by entry.
- Forget superseded conclusions: delete the turns that hold plans which were later overturned, so the model stops citing them.
- Honest limit: this only removes content from the model context; the raw session log and chat transcript stay in the local session file, and this plugin is not an eraser.

- Token estimates: the `≈N tok` values and the total occupation come from `estimateMessageTokens` in `core.js`, a heuristic priced like DSH's `dsh-token-meter` (4 characters ≈ 1 token, +4 per content block, +4 role overhead per message). The Host prefers `ctx.tokenMeter.measure()` node pricing and falls back to the local heuristic when no token meter is injected.
- These are estimates, not exact usage: Chinese text and JSON are markedly underestimated, so the real saving is usually larger than the reported figure.
- Budget clean-up: `/ctxmgr clean 60000` (tool: `context_manager` action `clean`) sorts `tool` / `assistant` candidates by estimated tokens descending and deletes until the budget is met. User and context messages are never eligible, the most recent 3 messages are protected by default, candidates below 100 tokens are skipped, and deletion reuses the same tombstone + durable queue pipeline, so it stays restorable.

- Batch audit: every delete, whole-turn delete and clean mints a `batchId`, stored in the tombstone `source` as `{ kind: 'context-manager', batchId: '<uuid>' }`.
- `kind` stays the only marker, so tombstones written before batch ids are still recognized and restored.
- Ledger: each operation appends one `plugin:context-manager/batch` record to the session log — `batchId`, `op` (`delete` / `delete-turn` / `clean` / `undo`), `seqs`, `tombstoneSeqs`, `estimatedFreedTokens`, outcome (`applied` / `queued` / `skipped` / `failed`) and `reason`.
- The ledger is append-only, persists with the session log, survives restarts and writes no external files.
- Undo: `/ctxmgr batches` lists the ledger; `/ctxmgr undo-batch [batchId]` undoes the latest batch or a specific one by id prefix (tool: `action=batches` / `action=undo-batch`).
- Undo reuses the existing restore path (durable queue + idempotent ack) rather than a second mechanism, and leaves its own `op=undo` ledger entry.
