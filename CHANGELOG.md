# Changelog

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
