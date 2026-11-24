# 会话消息管理 · dsh-message-manager

一个 DSH（DeepSeek Harness）插件：在会话标题栏增加「消息管理」入口，把不需要的消息**从模型上下文中移除**——单条删、整轮删、批量删，之后还能恢复。原始会话日志、聊天记录与审计数据始终保留。

- 包名：`dsh-message-manager`
- 版本：`1.5.0`
- 类型：Cordis bundle（Host 半 + Web Client 半），纯 JavaScript，**无构建、无第三方依赖**
- 适用：DSH `0.2.1-rc.2` 及以上（`0.2.2-rc.5` 实测）

---

## 安装

插件管理页里选择任一来源即可，也可以直接用 `plugin_manager` 工具的 `install_bundle`：

| 来源 | target 写法 | 说明 |
|---|---|---|
| npm | `dsh-message-manager@1.5.0` | 已发布到 [npm](https://www.npmjs.com/package/dsh-message-manager) |
| GitHub | `github:xian-yu-zhao/dsh-message-manager` | 免 npm，直接从仓库取 |
| 本地 tgz | `file:C:\path\to\dsh-message-manager-1.5.0.tgz` | Release 资产或 `npm pack` 产物 |
| 本地目录 | `link:C:\path\to\dsh-message-manager` | 开发调试用，改源码即生效 |

安装后刷新 Web 页面（F5）或重启应用，会话标题栏右侧会出现列表图标。

> 无 npm CLI 也能装：GitHub / tgz / 本地目录三种来源都不经过 npm 发布。
>
> 若 npm 上暂时只能看到 `0.0.0-stage` 占位版本，说明 npm 的暂存审核尚未通过，此时请先用 GitHub 源安装。

---

## 插件市场收录

DSH 的插件市场（**Plugins → Discover**）**没有官方索引**：它只读用户自己添加的索引 URL，索引是一份 format 1 的 JSON。社区事实标准索引是 [awesome-dsh-plugin](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin)，站点索引地址 `https://awesome-dsh-plugin.com/index.json`。

使用市场：

1. 侧栏 **Plugins** → **Experimental plugins** 打开 **Custom plugin indexes**，页面出现 **Installed / Discover** 两个标签。
2. **Discover** → **Add index source**，填入索引地址（已配置过就跳过）。
3. 搜索 `message manager`，安装按钮把索引里的 `name@version` 交给同一套 `installBundle`。

投稿收录：向 awesome-dsh-plugin 仓库提一个 PR，**只新增一个文件** `data/plugins/xian-yu-zhao__dsh-message-manager.yml`，内容即本仓库的 [`market/awesome-dsh-plugin.yml`](market/awesome-dsh-plugin.yml)：

```yaml
url: https://github.com/xian-yu-zhao/dsh-message-manager
name: xian-yu-zhao/dsh-message-manager
category: session
description:
  en: 'Removes single messages or whole conversation turns from the model context of a DSH session, and can restore them later.'
  zh: '从 DSH 会话的模型上下文中移除单条消息或整轮对话，之后可以恢复。'
```

合并后站点重建索引，即可被搜到并一键安装（安装来源为 npm 上的 `dsh-message-manager`）。门槛核对：`dsh.bundle` 已声明 ✅、有真实可用代码 ✅、仓库建满 1 天 ✅、`dsh-plugin` topic 已添加 ✅。

### 自己托管一份索引

任何静态 https 地址都可托管一份 format 1 索引（**不能有重定向**），让别人「Add index source」即可：

```json
{
  "format": 1,
  "title": { "en": "xian-yu-zhao plugins", "zh": "xian-yu-zhao 插件" },
  "plugins": [
    {
      "name": "dsh-message-manager",
      "title": { "en": "Session message manager", "zh": "会话消息管理" },
      "versions": [
        { "version": "1.5.0", "publishTimestamp": 1795534865, "source": { "type": "npm" } }
      ]
    }
  ]
}
```

`versions[].source` 只有两种形态：`{"type":"npm"}`（可带 `registry`）或 `{"type":"git","url":"https://github.com/owner/repo","commit":"<40 位小写 commit>","path?":"子目录"}`。字段细节、图标限制（`data:` ≤32 KiB）与校验规则见 DSH 内置包 `@deepseek-ai/dsh-plugin-market-index`。

---

## 使用

### 弹窗

1. 打开任意会话，点标题栏右侧的列表图标，打开「消息管理」。
2. **对话轮（整轮删除）**：一行一轮，显示轮号、预览与消息条数；勾选后点「删除选中」，或点行尾「删除本轮」。这一轮里的用户提问、助手的工作与回答、该轮注入的上下文会一起移出，不必逐条删工具调用。
3. **当前消息**（默认折叠，点标题或 ▸ 展开）：按条勾选，点「删除选中」；也可点行尾垃圾桶单独删。折叠状态下全选与批量删除按钮仍可用。
4. **已删除**：保留本插件产生的删除记录（`删除记录 #seq`），可勾选后「恢复选中」，或逐条「恢复」。
5. 删除只影响**后续模型请求**；恢复后重新进入后续请求。

确认条会提示连带移除的总条数（`共移除 N 条消息`），因为删助手消息会带走它发起的工具结果，删工具结果会带走所属助手消息与同组结果。

### 命令

```text
/msgmgr list                                  # 当前消息 + 已删除记录 + 排队中的操作
/msgmgr turns                                 # 对话轮列表（轮号、预览、条数、进行中标记）
/msgmgr delete <序号,...>                     # 按条删除
/msgmgr deleteturn <轮号,...>                 # 按轮删除
/msgmgr restore <删除记录序号,...>            # 恢复
```

### 工具

模型可调用 `message_manager`，参数 `action` ∈ `list` / `list-turns` / `delete` / `delete-turns` / `restore`，`seqs` 按 action 解释为消息序号、轮号或删除记录序号。工具描述里明确要求「仅在用户明确要求时使用」。

---

## 删除与恢复何时生效

DSH 的会话格式要求 `developer/message` 必须位于一个已打开的 turn/step 中，且 Session 不能在 `session/event` 派发过程中重入追加。插件据此选路：

- **目标属于更早的步骤，且当前有步骤打开**：立即从模型上下文移除。
- **会话空闲，或目标包含当前正在进行的步骤**：进入**持久化队列**——一条 `plugin:message-manager/pending` 记录直接写进会话日志（plugin 记录不要求打开的 turn/step），在下一个 `agent/request` 时、模型请求组装之前同步应用。也就是「你下次发消息时它就不在上下文里了」。
- **恢复**：总是进队列，在下一个 `agent/request` 时应用。
- 队列存在会话日志里，重启不丢；应用完的操作追加 `plugin:message-manager/ack` 记录，**绝不重放两次**；重放时目标已消失则以 skipped 收尾，不反复报错。
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
- 需要会话处于运行状态。
- 纯本地运行：不联网、不外发任何数据。
- 关闭插件后标题栏入口、`/msgmgr` 命令与 `message_manager` 工具都会消失；已写入日志的删除记录仍然保留。

---

## 结构

| 文件 | 作用 |
|---|---|
| `index.js` | Host 半：`/msgmgr` 命令、`message_manager` 工具、删除/恢复计划、持久化队列与 `agent/request` 应用器 |
| `core.js` | 纯函数：表面折叠、删除计划、墓碑消息、列表与对话轮格式化 |
| `client.js` | Client 半：标题栏按钮、「消息管理」弹窗（对话轮 / 当前消息 / 已删除） |
| `cordis.patch.yml` | 向 profile patch 插入一行插件 |
| `locale/*.json` | 插件管理页与详情页的标题、描述、详情文档路径 |
| `docs/DETAIL*.md`、`docs/preview.svg` | 插件详情页的单图说明 |
| `CHANGELOG.md` | 版本记录 |

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
plugin_manager remove_bundle   target=dsh-message-manager
plugin_manager install_bundle  target=link:<插件目录>
```

## 发布（维护者）

`publishConfig` 已锁定 `registry.npmjs.org` 与 `access: public`，`files` 已覆盖运行文件、locale、图标与 `docs/`：

```bash
npm publish          # 发布 dsh-message-manager@<version>
git push origin main
```

发版顺序：改 `package.json` 版本 → 补 `CHANGELOG.md` → 语法检查 → `npm publish` → 打 tag / 上传 tgz 到 Release → 推 GitHub。

## 许可

MIT
