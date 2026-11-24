# Changelog

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
