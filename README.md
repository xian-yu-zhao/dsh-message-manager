# 会话上下文管理 · dsh-context-manager

一个 DSH（DeepSeek Harness）插件：在会话标题栏增加「上下文管理」入口，管理会话的**模型上下文**——按条删、按整轮删，之后还能恢复。原始会话日志、聊天记录与审计数据始终保留。

- 包名：`dsh-context-manager`
- 版本：`1.7.0`
- 类型：Cordis bundle（Host 半 + Web Client 半），纯 JavaScript，**无构建、无第三方依赖**
- 适用：DSH `0.2.1-rc.2` 及以上（`0.2.2-rc.5` 实测）

---

## 安装

插件管理页里选择任一来源即可，也可以直接用 `plugin_manager` 工具的 `install_bundle`：

| 来源 | target 写法 | 说明 |
|---|---|---|
| npm | `dsh-context-manager@1.7.0` | 已发布到 [npm](https://www.npmjs.com/package/dsh-context-manager) |
| GitHub | `github:xian-yu-zhao/dsh-context-manager` | 免 npm，直接从仓库取 |
| 本地 tgz | `file:C:\path\to\dsh-context-manager-1.7.0.tgz` | Release 资产或 `npm pack` 产物 |
| 本地目录 | `link:C:\path\to\dsh-context-manager` | 开发调试用，改源码即生效 |

安装后刷新 Web 页面（F5）或重启应用，会话标题栏右侧会出现列表图标。

> **旧包已弃用**：`dsh-message-manager`（1.5.0）已在 npm 上标记 deprecated 并指向本包，GitHub 旧仓库 `xian-yu-zhao/dsh-message-manager` 自动重定向到 [`xian-yu-zhao/dsh-context-manager`](https://github.com/xian-yu-zhao/dsh-context-manager)。迁移只需两步：`plugin_manager remove_bundle target=dsh-message-manager`，再 `plugin_manager install_bundle target=dsh-context-manager@1.7.0`——新版本仍能识别旧版写入会话日志的删除记录与排队记录。

> 无 npm CLI 也能装：GitHub / tgz / 本地目录三种来源都不经过 npm 发布。
>
> 若 npm 上暂时只能看到 `0.0.0-stage` 占位版本，说明 npm 的暂存审核尚未通过，此时请先用 GitHub 源安装。

---

## 使用场景

### 回退到某一轮的开始，重新提问

模型在某一轮改坏了文件，或者方向跑偏了。先用 `/ctxmgr turns` 看清轮号与预览，再用 `/ctxmgr deleteturn 5` 把第 5 轮（你的提问 + 它的全部工作与回答）整体移出上下文——上下文就回到第 5 轮开始前的状态，然后重新描述需求。想回到第 5 轮之前但保留第 5 轮之前的成果，就删掉它之后的所有轮次。

`/ctxmgr turns` → `/ctxmgr deleteturn 5`

### 清除废物信息，省下上下文

几屏报错日志、一大段粘贴的代码、试错过程中的无效指令、啰嗦的工具输出，都会持续占用上下文预算。用 `/ctxmgr list` 找到序号，再按条清掉，后续请求不再携带这些内容。

`/ctxmgr list` → `/ctxmgr delete 12,13,14`

### 让模型忘掉过时的中间结论

探索阶段达成的方案与结论，后来被推翻或替换了，留在上下文里容易被模型反复引用。删掉对应的轮次，只保留最终结论所在的轮。

`/ctxmgr turns` → `/ctxmgr deleteturn 3,4`（工具等价：`context_manager` + `delete-turns`）

### 收敛超长会话

上下文快满，但又不想新开一个会话丢掉历史。把早期纯探索的轮次整轮删掉，保留关键决策轮次，后续请求就能继续在同一个会话里推进。

`/ctxmgr turns` → `/ctxmgr deleteturn 2,3,4`

### 按预算快速瘦身

不想逐条挑，就直接给一个 token 预算：`/ctxmgr clean 60000` 会按估算占用从大到小清掉工具输出与助手消息，直到降到目标附近。用户消息与上下文消息永不入选，默认保护最近 3 条，小于 100 tokens 的候选默认跳过；删除复用按条删除的同一套墓碑与持久队列，因此仍可恢复。

`/ctxmgr clean 60000`（工具等价：`context_manager` + `clean`，可带 `targetTokens` / `minCandidateTokens` / `protectRecent`）

### 误发内容的止损（如实说明边界）

把密钥、隐私片段或发错的内容从**模型上下文**里移除，后续请求不再看到它们。但必须清楚：**原始会话日志与聊天记录仍在本地会话文件里**，这个插件不是擦除工具，真要抹掉请自行处理会话文件。

`/ctxmgr delete 9`（工具等价：`context_manager` + `delete`）

---

## 与同类插件的边界

上下文赛道很挤，同名或近名的插件尤其多。先划清边界，避免装错东西，也避免预期错位：

| 插件 / 类别 | 它做什么 | 我们的关系 |
|---|---|---|
| `dsh-context`（周下载很高、官方推荐） | 仪表板、成本图表、上下文占用可视化 | 不做仪表板与成本图表；我们只做就地裁剪 |
| `dsh-compact-manager` / `dsh-compression-improved` | 全局阈值压缩、工具结果压缩引擎 | 不做全局压缩引擎；我们只在用户选区上删除或局部压缩 |
| `dsh-context-redline` | 迁移到零历史的新会话 + 交接摘要 | 不做交接与迁移；我们不改消息内容，只把选中的内容从主上下文卸载到可检索存档（按 seq 可取回）或恢复 |
| `@sulytwelve/dsh-context-manager`（同名）与各类 `dsh-memory` | 跨会话记忆 | 不做跨会话记忆 |

与它们最本质的区别是**可逆性 + 原日志只增不改 + 按 seq 审计**：我们不重写任何消息内容，只追加空 developer 消息做表面替换；每一次删除、整轮删除与撤销都留在会话日志的台账里，可按批次追溯与撤回。

同名插件不是我们，认包名 `dsh-context-manager`（GitHub [`xian-yu-zhao/dsh-context-manager`](https://github.com/xian-yu-zhao/dsh-context-manager)）。

> **手术刀，不是压缩机，也不是记忆库。**

---

## 插件市场收录

DSH 的插件市场（**Plugins → Discover**）**没有官方索引**：它只读用户自己添加的索引 URL，索引是一份 format 1 的 JSON。社区事实标准索引是 [awesome-dsh-plugin](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin)，站点索引地址 `https://awesome-dsh-plugin.com/index.json`。

使用市场：

1. 侧栏 **Plugins** → **Experimental plugins** 打开 **Custom plugin indexes**，页面出现 **Installed / Discover** 两个标签。
2. **Discover** → **Add index source**，填入索引地址（已配置过就跳过）。
3. 搜索 `context manager`，安装按钮把索引里的 `name@version` 交给同一套 `installBundle`。

投稿收录：向 awesome-dsh-plugin 仓库提一个 PR，**只新增一个文件** `data/plugins/xian-yu-zhao__dsh-context-manager.yml`，内容即本仓库的 [`market/awesome-dsh-plugin.yml`](market/awesome-dsh-plugin.yml)：

```yaml
url: https://github.com/xian-yu-zhao/dsh-context-manager
name: xian-yu-zhao/dsh-context-manager
category: session
description:
  en: 'Manages the model context of a DSH session: removes single messages or whole conversation turns (roll back to the start of a turn) and can restore them later.'
  zh: '管理 DSH 会话的模型上下文：按条或按整轮移除消息（可回退到某一轮的开始），之后还能恢复。'
```

合并后站点重建索引，即可被搜到并一键安装（安装来源为 npm 上的 `dsh-context-manager`）。门槛核对：`dsh.bundle` 已声明 ✅、有真实可用代码 ✅、仓库建满 1 天 ✅、`dsh-plugin` topic 已添加 ✅。

### 自己托管一份索引

任何静态 https 地址都可托管一份 format 1 索引（**不能有重定向**），让别人「Add index source」即可：

```json
{
  "format": 1,
  "title": { "en": "xian-yu-zhao plugins", "zh": "xian-yu-zhao 插件" },
  "plugins": [
    {
      "id": "context-manager",
      "name": "dsh-context-manager",
      "title": { "en": "Context manager", "zh": "会话上下文管理" },
      "versions": [
        { "version": "1.6.0", "publishTimestamp": 1795534865, "source": { "type": "npm" } }
      ]
    }
  ]
}
```

`versions[].source` 只有两种形态：`{"type":"npm"}`（可带 `registry`）或 `{"type":"git","url":"https://github.com/owner/repo","commit":"<40 位小写 commit>","path?":"子目录"}`。字段细节、图标限制（`data:` ≤32 KiB）与校验规则见 DSH 内置包 `@deepseek-ai/dsh-plugin-market-index`。

---

## 使用

### 弹窗

1. 打开任意会话，点标题栏右侧的列表图标，打开「上下文管理」。
2. **预算 + 按 token 清理**（弹窗顶部一行）：填入目标 tokens 点清理，不用手挑也会优先清掉最占地方的工具与助手消息；规则见下。当前消息每行显示 `≈N tok`，列表标题显示当前上下文总占用——都是启发式估算，不是精确用量。
3. **对话轮（整轮删除）**：一行一轮，显示轮号、预览与消息条数；勾选后点「删除选中」，或点行尾「删除本轮」。这一轮里的用户提问、助手的工作与回答、该轮注入的上下文会一起移出，不必逐条删工具调用。
4. **当前消息**（默认折叠，点标题或 ▸ 展开）：按条勾选，点「删除选中」；也可点行尾垃圾桶单独删。折叠状态下全选与批量删除按钮仍可用。**过滤**下拉可切到 全部 / 用户 / 助手 / 工具 / 上下文：只影响显示，选择、token 总计与 Host 计划器都不受影响，过滤时显示「显示 X/Y」。用户消息行带「受保护」标记——`clean` 永不选择用户消息。
5. **已删除**：保留本插件产生的删除记录（`删除记录 #seq`），每行还显示所属批次号前 8 位；可勾选后「恢复选中」，或逐条「恢复」。原文已不在当前表面时，行内改用召回指针显示「可召回 #seq · 摘要」，可凭该 seq 用 `session_event_read` 取回完整原始事件。弹窗底部另有「撤销上次操作」按钮，一次撤销最近一个批次。
6. 删除只影响**后续模型请求**；恢复后重新进入后续请求。

确认条会提示连带移除的总条数（`共移除 N 条消息`）与估算释放的 tokens（`估算释放约 X tokens`），因为删助手消息会带走它发起的工具结果，删工具结果会带走所属助手消息与同组结果。

### 命令

```text
/ctxmgr list                                  # 当前消息 + 已删除记录 + 排队中的操作
/ctxmgr turns                                 # 对话轮列表（轮号、预览、条数、进行中标记）
/ctxmgr delete <序号,...>                     # 按条删除
/ctxmgr deleteturn <轮号,...>                 # 按轮删除
/ctxmgr restore <删除记录序号,...>            # 恢复
/ctxmgr clean <目标tokens>                    # 按预算清理：只看 tool / assistant，默认保护最近 3 条、候选 ≥100 tokens
/ctxmgr compact <起序号> <止序号>             # 局部压缩：把用户选区交给官方 ctx.compaction.compactRegion
/ctxmgr batches                               # 操作台账（审计）：列出批次号、操作、目标序号与结果
/ctxmgr undo-batch [batchId]                  # 撤销最近一次操作；带 batchId 前几位时撤销指定批次（别名 undo-last）
```

### 工具

模型可调用 `context_manager`，参数 `action` ∈ `list` / `list-turns` / `delete` / `delete-turns` / `restore` / `clean` / `compact` / `batches` / `undo-batch`，`seqs` 按 action 解释为消息序号、轮号或删除记录序号（`clean` 与 `compact` 不用 `seqs`；`compact` 改用 `start` / `end`，二者都是表面位置序号）。工具描述里明确要求「仅在用户明确要求时使用」。

`clean` 按 token 预算清理，可选参数：

| 参数 | 默认值 | 含义 |
|---|---|---|
| `targetTokens` | — | 目标估算 tokens，按此预算判断何时停止 |
| `minCandidateTokens` | `100` | 只考虑估算 ≥ 该值的候选 |
| `protectRecent` | `3` | 最近 N 条消息不参与清理 |

候选只取 `tool` / `assistant` 消息，按估算 token 降序排列；用户消息与上下文消息永不入选；达到预算即停止。删除完全复用既有 `delete` 管线（`planDeletion` + 墓碑 + 持久队列），不是另一套删除逻辑，所以恢复语义与按条删除完全一致。

`action=batches` 列出操作台账；`action=undo-batch` 撤销最近一次操作，可选参数 `batchId`（前缀匹配）撤销指定批次。撤销复用既有 restore 路径（持久队列 + ack 幂等），并在台账里追加一条 `op=undo` 记录。

`action=compact` 需要 `start` 与 `end` 两个参数：它们是**表面位置序号**，两端必须落在工具配对平衡的边界上；插件把这一段交给官方 `ctx.compaction.compactRegion` 换成一条摘要。调用契约、前提与和 delete / clean 的区别见下文「局部压缩」。

### 审计台账

每次删除、整轮删除、按预算清理、局部压缩与撤销都会在会话日志里追加一条 `plugin:context-manager/batch` 审计记录，只增不改，随会话日志持久化——重启后仍可查，不写任何外部文件。

| 字段 | 含义 |
|---|---|
| `batchId` | 批次号；每次操作生成一个，撤销记录同样带 `batchId` |
| `op` | 操作类型：`delete` / `delete-turn` / `clean` / `compact` / `undo` |
| `seqs` | 本次操作的目标序号（消息序号或轮号） |
| `tombstoneSeqs` | 实际写入的墓碑序号 |
| `estimatedFreedTokens` | 估算释放的 tokens（启发式，非精确值） |
| `result` | `applied` 成功 / `queued` 排队中 / `skipped` 跳过 / `failed` 失败 |
| `reason` | 结果的原因说明 |

批次号同时写进墓碑消息的 `source`：`source = { kind: 'context-manager', batchId: '<uuid>', recall: [...] }`。`kind` 仍是唯一标记，`batchId` 与 `recall` 只是附加信息——旧墓碑没有这两个字段也照常工作（`recall` 见下节「召回」）。

查看与撤销：

- `/ctxmgr batches`（别名 `ledger` / `audit`；工具 `context_manager` + `action=batches`）：列出台账。
- `/ctxmgr undo-batch`：撤销最近一次操作（别名 `undo-last`）。
- `/ctxmgr undo-batch <batchId 前几位>`：撤销指定批次；工具等价 `action=undo-batch` + 可选 `batchId`。

撤销**复用既有的 restore 路径**（持久队列 + ack 幂等），不是另起一套恢复机制；撤销本身也会在台账里留一条 `op=undo` 记录。

### 局部压缩（与官方 compaction 分工）

`/ctxmgr compact <起序号> <止序号>`（工具等价：`context_manager` + `action=compact`，参数 `start` / `end`）把用户选中的一段交给官方压缩引擎，换回一条官方摘要。

**调用契约**：插件内部调用 `ctx.compaction.compactRegion(start, end, agentCtx, signal)`——这是本插件唯一借力官方压缩的地方，摘要逻辑本身不自己实现。

- `start` / `end` 是**表面位置序号**，不是数值大小顺序；两端必须落在工具配对平衡的边界上（不能切在「助手工具调用」与「工具结果」之间），否则引擎报 unbalanced，操作失败并写进台账。
- **需要压缩后端**：环境里必须加载了压缩后端（如 `dsh-compaction-basic`）。没加载时插件给明确的中文提示，并把失败记进台账；插件自身不硬依赖该服务，用 `ctx.get('compaction')` 可选获取。
- **只作用于用户选区**：不做全局阈值压缩——那是 `dsh-compact-manager` 与压缩后端的事。你指哪一段，它压哪一段。
- 成功与失败都会在台账留一条 `op: 'compact'` 记录（含被遮蔽的节点数与 tokens）。

与 delete / clean 的区别：

| 操作 | 结果 | 能否按消息恢复 |
|---|---|---|
| `delete` / `delete-turn` / `clean` | 目标从主上下文移出（墓碑投影成空消息） | 能，走 `restore` / `undo-batch` |
| `compact` | 选区换成一条官方摘要 | 不能按消息恢复；原始事件仍留在只增不改的会话日志里 |

一句话：delete / clean 是「卸载」，compact 是「摘要掉」，两者都不删除原始日志。

### 召回：删掉的还能取回

每条墓碑的 `source` 里现在带一个极短的**召回指针**：

```js
source = {
  kind: 'context-manager',
  batchId: '<uuid>',
  recall: [{ seq: 42, role: 'assistant', preview: '……一行摘要……' }],
}
```

- 最多 `RECALL_MAX_ENTRIES = 8` 条，`preview` 截断到 `RECALL_PREVIEW_LIMIT = 80` 字符。
- 只存原始 `seq`、角色与一行摘要，**不写消息全文**；墓碑的 `content` 仍是空数组——墓碑必须投影成空消息，这是硬约束。
- 与 `batchId` 并存；老墓碑没有这两个字段也照常工作。
- 弹窗「已删除」行在拿不到原文时，用召回指针显示「可召回 #seq · 摘要」。

**怎么取回原文**：`recall` 里的 `seq` 就是原始事件的会话序号。启用 `@deepseek-ai/dsh-tool-session-query` 那套只读工具后：

| 工具 | 用途 |
|---|---|
| `session_event_search` | 在该会话内按关键字检索事件，定位被删的那一段 |
| `session_event_read` | 按事件定位读取完整未删节事件（JSON） |
| `session_search` / `session_event_trace` / `session_trace` | 找到会话、看事件轨迹与调用链 |

搜索会排除调用方自己的会话、按工作区 `cwd` 授权。于是「删除」的准确定位是：**从主上下文卸载到可检索存档**——主上下文不再携带它（不再花 token，模型也看不见），但原始事件仍在 append-only 会话日志里，可按 seq / 关键字取回。

与隔壁的区分：`dsh-context-redline` 把内容「迁移走」到新会话，压缩插件把内容「摘要掉」，我们只是把选中的内容「卸载」出主上下文，原会话与原文都还在原地。

### token 估算（启发式）

消息列表里的 `≈N tok`、标题处的上下文总占用，以及删除 / 整轮删除 / 清理结果里的「估算释放约 X tokens」，都来自 `core.js` 的 `estimateMessageTokens`：与 DSH 官方 `dsh-token-meter` 同源的启发式定价——**4 字符 ≈ 1 token，每个内容块 +4，每条消息角色开销 +4**。Host 会优先用 `ctx.tokenMeter.measure()` 的节点定价；插件没注入 token-meter 时回退本地启发式。

**这只是估算，不是精确用量**：中文与 JSON 明显被低估。按预算清理也用同一套估算做排序与停止判断，所以实际省下的 token 通常多于显示值。

---

## 删除与恢复何时生效

DSH 的会话格式要求 `developer/message` 必须位于一个已打开的 turn/step 中，且 Session 不能在 `session/event` 派发过程中重入追加。插件据此选路：

- **目标属于更早的步骤，且当前有步骤打开**：立即从模型上下文移除。
- **会话空闲，或目标包含当前正在进行的步骤**：进入**持久化队列**——一条 `plugin:context-manager/pending` 记录直接写进会话日志（plugin 记录不要求打开的 turn/step），在下一个 `agent/request` 时、模型请求组装之前同步应用。也就是「你下次发消息时它就不在上下文里了」。
- **恢复**：总是进队列，在下一个 `agent/request` 时应用。
- 队列存在会话日志里，重启不丢；应用完的操作追加 `plugin:context-manager/ack` 记录，**绝不重放两次**；重放时目标已消失则以 skipped 收尾，不反复报错。
- **兼容旧数据**：旧版 `dsh-message-manager` 写入会话日志的删除记录（tombstone 来源 kind `message-manager`）与排队记录（旧名 `plugin:message-manager/pending` / `plugin:message-manager/ack`）仍会被识别、恢复与应用，升级无需手工清理日志。
- 整轮删除拆成逐个节点（或工具调用组）的独立删除记录，每条仍保有自己的恢复语义；表面上已有的删除记录不会被覆盖。

---

## 恢复的能力边界

| 目标 | 恢复行为 |
|---|---|
| 用户消息、普通上下文消息 | 恢复到原来的表面位置 |
| 助手纯文本消息 | 追加到会话末尾（DSH 不允许 assistant 消息作为带 source 引用的表面替换） |
| 助手工具调用组（助手消息 + 工具调用 + 工具结果） | 整组追加到末尾，保持合法工具生命周期 |
| 单独的工具结果、带工具变更的上下文消息、系统提示词 | 不支持恢复 |

恢复助手消息会在聊天记录末尾新增一份内容副本；原删除记录仍留在日志里。

---

## 行为与限制

- 删除的实现是追加一条「空 developer 消息」做表面替换，符合会话日志只追加、可重放的约定。
- 聊天视图展示历史记录，因此被删的消息**仍会出现在聊天记录里**；弹窗与后续模型请求使用当前表面。
- 系统提示词、尚未落盘的消息（例如正在流式生成的消息）不在可删除范围内。
- 删除记录（墓碑）本身不能再被当作消息删除：会提示该序号是一条删除记录、请改用 `restore`；`foldSurface` 会忽略缺 `seq` 的畸形表面对象。
- 需要会话处于运行状态。
- 纯本地运行：不联网、不外发任何数据。
- 关闭插件后标题栏入口、`/ctxmgr` 命令与 `context_manager` 工具都会消失；已写入日志的删除记录仍然保留。

---

## 结构

| 文件 | 作用 |
|---|---|
| `index.js` | Host 半：`/ctxmgr` 命令、`context_manager` 工具、删除/恢复计划、持久化队列与 `agent/request` 应用器 |
| `core.js` | 纯函数：表面折叠、删除计划、墓碑消息、列表与对话轮格式化 |
| `client.js` | Client 半：标题栏按钮、「上下文管理」弹窗（对话轮 / 当前消息 / 已删除） |
| `cordis.patch.yml` | 向 profile patch 插入一行插件 |
| `locale/*.json` | 插件管理页与详情页的标题、描述、详情文档路径 |
| `docs/DETAIL*.md`、`docs/preview.svg` | 插件详情页的单图说明 |
| `CHANGELOG.md` | 版本记录 |
| `test/*.test.mjs` | 零依赖 `node:test` 用例，共 49 个（`node --test "test/*.test.mjs"`） |

### 关于 `@deepseek-ai/*` 引用

Host 半需要 `@deepseek-ai/dsh-session` 的内部工具函数。以 `link:` 方式安装时，真实路径在 profile 之外，裸导入会报 `ERR_MODULE_NOT_FOUND`；插件因此先试裸导入，失败则用 `process.argv[2]`（Host 运行目录）拼出 asar 内的绝对 URL 再导入——同一 URL 得到同一模块实例，Session 的私有 brand 校验才能通过。

---

## 开发

```bash
# 语法检查（无构建步骤）
node --check index.js
node --check client.js
node --check core.js
```

改 Client 半后需要刷新页面（F5）或重启应用；改 Host 半需重新安装 bundle：

```text
plugin_manager remove_bundle   target=dsh-context-manager
plugin_manager install_bundle  target=link:<插件目录>
```

### 测试

`test/` 下三个零依赖 `node:test` 文件，共 49 个用例，只用内置模块，不需要安装任何依赖：

| 文件 | 用例数 |
|---|---|
| `test/core.test.mjs` | 9 |
| `test/batch.test.mjs` | 14 |
| `test/surface.test.mjs` | 26 |

覆盖 `planDeletion` 的工具组联动、`deletedFromSurface`、`foldSurface`（含缺 `seq` 的畸形对象）、`turnsFromSurface`、`planClean` 的保护与排序、`undo-batch` 的批次选择（含歧义前缀拒绝），以及召回指针与墓碑投影。

```bash
node --test "test/*.test.mjs"
```

## 发布（维护者）

`publishConfig` 已锁定 `registry.npmjs.org` 与 `access: public`，`files` 已覆盖运行文件、locale、图标与 `docs/`：

```bash
npm publish          # 发布 dsh-context-manager@<version>
git push origin main
```

发版顺序：改 `package.json` 版本 → 补 `CHANGELOG.md` → 语法检查 → `npm publish` → 打 tag / 上传 tgz 到 Release → 推 GitHub。

## 许可

MIT
