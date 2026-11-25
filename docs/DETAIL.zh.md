![在上下文管理弹窗中选中一整轮对话并从模型上下文中移除](preview.svg)

- 回退到某一轮的开始：`/ctxmgr turns` 查看轮号，`/ctxmgr deleteturn 5` 把该轮整体移出上下文，然后重新提问。
- 清除废物信息：`/ctxmgr list` 找到序号，`/ctxmgr delete 12,13,14` 按条清掉报错日志与试错指令。
- 让模型忘掉过时的中间结论：删掉被推翻的方案所在的轮次，避免它反复引用旧结论。
- 止损边界：只移出模型上下文，原始会话日志与聊天记录仍留在本地会话文件里，本插件不是擦除工具。

- token 估算：列表里的 `≈N tok` 与总占用来自 `core.js` 的 `estimateMessageTokens`，定价与 DSH 官方 `dsh-token-meter` 同源——4 字符 ≈ 1 token、每个内容块 +4、每条消息角色开销 +4。Host 有 token-meter 时优先用 `ctx.tokenMeter.measure()` 的节点定价，否则回退本地启发式。
- 这只是估算：中文与 JSON 明显被低估，实际省下的 token 通常多于显示值。
- 按预算清理：`/ctxmgr clean 60000`（工具等价 `context_manager` + `clean`）把 `tool` / `assistant` 候选按估算 token 降序删除，达到预算即停止。用户消息与上下文消息永不入选，默认保护最近 3 条，候选默认 ≥100 tokens；删除复用同一套墓碑与持久队列，仍可恢复。

- 批次审计：每次删除、整轮删除与按预算清理都会生成 `batchId`，写进墓碑消息的 `source`：`{ kind: 'context-manager', batchId: '<uuid>' }`。
- `kind` 仍是唯一标记，因此旧墓碑没有 `batchId` 也照常识别与恢复。
- 台账：每次操作在会话日志追加一条 `plugin:context-manager/batch` 记录——`batchId`、`op`（`delete` / `delete-turn` / `clean` / `undo`）、`seqs`、`tombstoneSeqs`、`estimatedFreedTokens`、结果（`applied` / `queued` / `skipped` / `failed`）与 `reason`。
- 台账只增不改，随会话日志持久化，重启后仍可查，不写外部文件。
- 撤销：`/ctxmgr batches` 查看台账；`/ctxmgr undo-batch [batchId]` 撤销最近一次或按 batchId 前几位撤销指定批次（工具 `action=batches` / `action=undo-batch`）。
- 撤销复用既有 restore 路径（持久队列 + ack 幂等），不是新的恢复机制，并会留下自己的 `op=undo` 台账记录。

- 召回指针：每条墓碑的 `source` 是 `{ kind: 'context-manager', batchId, recall }`，其中 `recall` 最多 8 条 `{ seq, role, preview }`（`RECALL_MAX_ENTRIES = 8`），`preview` 截断到 80 字符（`RECALL_PREVIEW_LIMIT = 80`）。只存 seq、角色与一行摘要，不写消息全文；墓碑的 content 仍为空数组——墓碑必须投影成空消息。老墓碑没有这两个字段也照常工作。
- 取回原文：`recall` 里的 `seq` 就是原始事件的会话序号，可用 `@deepseek-ai/dsh-tool-session-query` 的只读工具 `session_search` / `session_event_search` / `session_trace` / `session_event_trace` / `session_event_read` 按关键字检索或读取完整未删节事件（JSON）；搜索会排除调用方会话、按工作区 `cwd` 授权。所以「删除」是从主上下文卸载到可检索存档，不是擦除——与 `dsh-context-redline`（迁移走）和压缩插件（摘要掉）区分开。
- 局部压缩：`/ctxmgr compact <起序号> <止序号>`（工具 `context_manager` + `action=compact`，参数 `start` / `end`）调用官方 `ctx.compaction.compactRegion(start, end, agentCtx, signal)`。start / end 是表面位置序号，不是数值大小顺序，两端必须工具配对平衡，否则引擎报 unbalanced。
- 它只作用于用户选区，不做全局阈值压缩；需要环境加载压缩后端（如 `dsh-compaction-basic`），没加载时给明确中文提示并把失败写进台账。服务通过 `ctx.get('compaction')` 可选获取，插件不硬依赖；成功与失败都会在台账留一条 `op: 'compact'` 记录（含被遮蔽的节点数与 tokens）。与 delete / clean 的区别：delete / clean 是移出上下文、可恢复且无摘要，compact 是把一段换成一条官方摘要、不能按消息恢复，但原始会话日志仍只增不改。
- 旧墓碑没有 `batchId` / `recall` 也照常工作；弹窗「已删除」行在拿不到原文时，用召回指针显示「可召回 #seq · 摘要」。

- 表面替换与生效时机：删除是追加一条空 developer 消息，墓碑投影成空消息，会话日志只增不改、可重放。目标属于更早步骤且当前有步骤打开时，立即从模型上下文移除；会话空闲或目标含进行中步骤时，写入 `plugin:context-manager/pending` 记录，在下一个 `agent/request` 组装前应用——也就是「下次发消息时它就不在上下文里了」。恢复总是排队。
- 幂等与兼容：队列存在会话日志里，重启不丢；应用完追加 `plugin:context-manager/ack`，绝不重放两次；目标已消失则以 `skipped` 收尾。旧版 `dsh-message-manager` 写入的墓碑（`kind: message-manager`）与排队记录（`plugin:message-manager/pending` / `ack`）仍被识别，升级无需清理日志。整轮删除拆成逐个节点（或工具组）的独立墓碑，每条保有自己的恢复语义，已有墓碑不被覆盖。

- 台账字段（记录 `plugin:context-manager/batch`，只增不改、重启不丢、不写外部文件）：`batchId`（撤销记录同样带）、`op`（`delete` / `delete-turn` / `clean` / `compact` / `undo`）、`seqs`（消息序号或轮号）、`tombstoneSeqs`（实际写入）、`estimatedFreedTokens`（启发式估算）、`result`（`applied` / `queued` / `skipped` / `failed`）、`reason`。批次号也写进墓碑 `source`：`{ kind: 'context-manager', batchId: '<uuid>', recall: [...] }`；`kind` 仍是唯一标记，旧墓碑没有这些字段也照常工作。

- 恢复能力边界：用户消息与普通上下文消息恢复到原表面位置；助手纯文本消息追加到会话末尾（DSH 不允许 assistant 消息作为带 source 引用的表面替换）；助手工具调用组整组追加到末尾以保持合法工具生命周期；单独的工具结果、带工具变更的上下文消息、系统提示词不支持恢复。恢复助手消息会在聊天记录末尾新增内容副本，原删除记录仍留在日志里。

- 行为限制：被删消息仍出现在聊天记录里（聊天视图展示历史，弹窗与后续模型请求用当前表面）；系统提示词与尚未落盘的消息（如正在流式生成）不可删；墓碑本身不能再当消息删除，请改用 `restore`，`foldSurface` 会忽略缺 `seq` 的畸形表面对象；需要会话处于运行状态；关闭插件后标题栏入口、`/ctxmgr` 与工具消失，但已写入的删除记录保留；纯本地运行，不联网、不外发数据。
