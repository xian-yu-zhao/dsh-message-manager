/**
 * Client half of the Session Message Manager.
 *
 * The header utility opens a frame-wide dialog listing the messages currently
 * loaded into the view. It folds surface replacements locally so a deleted row
 * disappears immediately, and it performs the deletion through the Host command
 * that owns the authoritative surface rewrite.
 */
window.__ModuleLoader__.load({
  id: '@local/dsh-message-manager',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } = React

    const NS = 'message-manager'
    const SURFACE_TYPES = new Set([
      'system/message',
      'developer/message',
      'user/message',
      'assistant/message',
      'tool/result',
    ])
    const EMPTY_WINDOW = Object.freeze({
      entries: [],
      hasMore: false,
      revision: 0,
      change: Object.freeze({ kind: 'replace', entries: [] }),
    })

    const zh = {
      open: '消息管理',
      title: '消息管理',
      subtitle: '管理当前会话的模型上下文，可删除其中的单条消息。',
      close: '关闭',
      empty: '当前上下文没有可管理的消息。',
      notReady: '会话尚未就绪，请稍后再试。',
      count: '共 {count} 条消息',
      hint: '删除只影响后续模型请求，原始日志和聊天记录会保留。',
      delete: '删除这条消息',
      cancel: '取消',
      confirmDelete: '确认删除',
      confirmQuestion: '从模型上下文中移除？',
      groupHint: '相关的工具结果会一并移除。',
      user: '用户',
      assistant: '助手',
      tool: '工具',
      context: '上下文',
      system: '系统',
      emptyMessage: '（空消息）',
      failed: '操作失败',
      deleted: '已删除 {count} 条消息。',
      restoreQueued: '已加入恢复队列：{count} 条将在下一回合恢复。',
      busy: '正在处理…',
      usage: '删除：/msgmgr delete <序号,...>',
      currentSection: '当前消息',
      deletedSection: '已删除',
      selectAll: '全选',
      clearSelection: '清空',
      deleteSelected: '删除选中 ({count})',
      restoreSelected: '恢复选中 ({count})',
      restore: '恢复',
      confirmBatch: '确认删除选中的 {count} 条消息？',
      deletedGroup: '删除组',
      contentNotLoaded: '内容未加载',
      restoreAppended: '恢复到末尾',
      unrestorableTool: '工具结果不可单独恢复',
      unrestorableGroup: '该删除组不可恢复',
      deletedRecord: '删除记录 #{seq}',
      selected: '已选 {count}',
      unavailable: '不可恢复',
    }

    const en = {
      open: 'Message manager',
      title: 'Message manager',
      subtitle: 'Manage the model context of this session and remove individual messages.',
      close: 'Close',
      empty: 'There are no manageable messages in the current context.',
      notReady: 'The session is not ready yet.',
      count: '{count} messages',
      hint: 'Deletion only affects later model requests; the raw log and chat transcript are retained.',
      delete: 'Delete this message',
      cancel: 'Cancel',
      confirmDelete: 'Delete',
      confirmQuestion: 'Remove from the model context?',
      groupHint: 'Related tool results are removed together.',
      user: 'User',
      assistant: 'Assistant',
      tool: 'Tool',
      context: 'Context',
      system: 'System',
      emptyMessage: '(empty)',
      failed: 'Operation failed',
      deleted: 'Deleted {count} messages.',
      restoreQueued: 'Queued {count} message(s) for restore on the next turn.',
      busy: 'Working…',
      usage: 'Delete: /msgmgr delete <seq,...>',
      currentSection: 'Current messages',
      deletedSection: 'Deleted',
      selectAll: 'Select all',
      clearSelection: 'Clear',
      deleteSelected: 'Delete selected ({count})',
      restoreSelected: 'Restore selected ({count})',
      restore: 'Restore',
      confirmBatch: 'Delete the {count} selected messages?',
      deletedGroup: 'Deleted group',
      contentNotLoaded: 'content not loaded',
      restoreAppended: 'restored at the tail',
      unrestorableTool: 'A tool result cannot be restored alone',
      unrestorableGroup: 'This deleted group cannot be restored',
      deletedRecord: 'Deleted record #{seq}',
      selected: '{count} selected',
      unavailable: 'Not restorable',
    }

    const CSS = `
.dshmm-btn{display:inline-flex;align-items:center;justify-content:center;width:28px;height:28px;padding:0;border:0;border-radius:7px;background:transparent;color:var(--dsw-alias-label-secondary);cursor:pointer;font:inherit;flex:none}
.dshmm-btn:hover{background:color-mix(in srgb, var(--dsw-alias-label-primary) 8%, transparent);color:var(--dsw-alias-label-primary)}
.dshmm-btn[data-open="true"]{background:color-mix(in srgb, var(--dsw-alias-brand-primary) 14%, transparent);color:var(--dsw-alias-brand-primary)}
.dshmm-btn:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px}
.dshmm-backdrop{position:fixed;inset:0;z-index:1200;display:flex;align-items:center;justify-content:center;padding:24px;background:color-mix(in srgb, var(--dsw-alias-bg-base) 58%, transparent);backdrop-filter:blur(2px);pointer-events:auto}
.dshmm-panel{box-sizing:border-box;width:min(720px,100%);max-height:min(82vh,780px);display:flex;flex-direction:column;overflow:hidden;background:var(--dsw-alias-bg-overlay);color:var(--dsw-alias-label-primary);border:0.5px solid var(--dsw-alias-border-l2);border-radius:16px;box-shadow:var(--dsw-elevation-prominent,0 24px 64px rgba(0,0,0,.28));font-family:inherit;outline:none}
.dshmm-head{padding:16px 20px 12px;border-bottom:1px solid var(--dsw-alias-border-l1);flex:none}
.dshmm-titleRow{display:flex;align-items:center;justify-content:space-between;gap:12px}
.dshmm-title{margin:0;font-size:15px;line-height:22px;font-weight:600;color:var(--dsw-alias-label-primary)}
.dshmm-subtitle{margin:4px 0 0;font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary)}
.dshmm-close{display:inline-flex;align-items:center;justify-content:center;width:28px;height:28px;padding:0;border:0;border-radius:7px;background:transparent;color:var(--dsw-alias-label-secondary);cursor:pointer;flex:none}
.dshmm-close:hover{background:color-mix(in srgb, var(--dsw-alias-label-primary) 8%, transparent);color:var(--dsw-alias-label-primary)}
.dshmm-close:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px}
.dshmm-banner{margin:10px 20px 0;padding:8px 10px;border-radius:8px;font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary);background:color-mix(in srgb, var(--dsw-alias-label-primary) 7%, transparent);flex:none;overflow-wrap:anywhere}
.dshmm-banner[data-kind="success"]{color:var(--dsw-alias-state-success-primary);background:color-mix(in srgb, var(--dsw-alias-state-success-primary) 12%, transparent)}
.dshmm-banner[data-kind="error"]{color:var(--dsw-alias-state-error-primary);background:color-mix(in srgb, var(--dsw-alias-state-error-primary) 12%, transparent)}
.dshmm-list{flex:auto;min-height:120px;overflow-y:auto;padding:4px 0;background:var(--dsw-alias-bg-overlay)}
.dshmm-row{display:flex;align-items:flex-start;gap:12px;padding:10px 20px;border-bottom:1px solid var(--dsw-alias-border-l1);min-width:0}
.dshmm-row:hover{background:color-mix(in srgb, var(--dsw-alias-label-primary) 5%, transparent)}
.dshmm-role{flex:none;min-width:52px;text-align:center;font-size:11px;line-height:18px;padding:1px 8px;margin-top:1px;border-radius:6px;color:var(--dsw-alias-label-secondary);background:color-mix(in srgb, var(--dsw-alias-label-secondary) 10%, transparent);white-space:nowrap}
.dshmm-row[data-role="user"] .dshmm-role{color:var(--dsw-alias-brand-primary);background:color-mix(in srgb, var(--dsw-alias-brand-primary) 13%, transparent)}
.dshmm-row[data-role="assistant"] .dshmm-role{color:var(--dsw-alias-state-success-primary);background:color-mix(in srgb, var(--dsw-alias-state-success-primary) 12%, transparent)}
.dshmm-main{flex:auto;min-width:0}
.dshmm-preview{font-size:13px;line-height:20px;color:var(--dsw-alias-label-primary);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.dshmm-meta{margin-top:2px;font-size:11px;line-height:16px;color:var(--dsw-alias-label-secondary);font-variant-numeric:tabular-nums;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.dshmm-actions{flex:none;display:flex;align-items:center;justify-content:flex-end;min-width:28px}
.dshmm-iconbtn{display:inline-flex;align-items:center;justify-content:center;width:28px;height:28px;padding:0;border:0;border-radius:7px;background:transparent;color:var(--dsw-alias-label-secondary);cursor:pointer;flex:none}
.dshmm-iconbtn:hover{background:color-mix(in srgb, var(--dsw-alias-state-error-primary) 12%, transparent);color:var(--dsw-alias-state-error-primary)}
.dshmm-iconbtn:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px}
.dshmm-confirm{display:flex;flex-direction:column;align-items:flex-end;gap:6px;max-width:260px}
.dshmm-confirmText{font-size:11px;line-height:16px;color:var(--dsw-alias-label-secondary);text-align:right}
.dshmm-confirmActions{display:flex;align-items:center;gap:6px}
.dshmm-small{appearance:none;border:0;border-radius:6px;padding:4px 9px;font:inherit;font-size:11px;line-height:16px;cursor:pointer;background:color-mix(in srgb, var(--dsw-alias-label-primary) 8%, transparent);color:var(--dsw-alias-label-primary)}
.dshmm-small:hover{background:color-mix(in srgb, var(--dsw-alias-label-primary) 13%, transparent)}
.dshmm-small:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px}
.dshmm-small[data-danger="true"]{background:var(--dsw-alias-state-error-primary);color:var(--dsw-alias-bg-base)}
.dshmm-small[data-danger="true"]:hover{background:color-mix(in srgb, var(--dsw-alias-state-error-primary) 84%, var(--dsw-alias-label-primary))}
.dshmm-small:disabled{opacity:.55;cursor:default}
.dshmm-empty{padding:40px 20px;text-align:center;font-size:13px;line-height:20px;color:var(--dsw-alias-label-secondary)}
.dshmm-foot{padding:10px 20px;border-top:1px solid var(--dsw-alias-border-l1);display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap;flex:none}
.dshmm-footCount{font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary);font-variant-numeric:tabular-nums}
.dshmm-footHint{font-size:11px;line-height:16px;color:var(--dsw-alias-label-secondary);text-align:right;flex:auto;min-width:0}
.dshmm-code{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:11px}
.dshmm-section{position:sticky;top:0;z-index:2;display:flex;align-items:center;gap:10px;padding:8px 20px;background:var(--dsw-alias-bg-overlay);border-bottom:1px solid var(--dsw-alias-border-l1);box-shadow:0 1px 0 var(--dsw-alias-border-l1)}
.dshmm-sectionTitle{font-size:12px;line-height:18px;font-weight:600;color:var(--dsw-alias-label-primary);white-space:nowrap}
.dshmm-sectionCount{font-size:11px;line-height:16px;color:var(--dsw-alias-label-secondary);font-variant-numeric:tabular-nums}
.dshmm-sectionActions{display:flex;align-items:center;gap:6px;margin-left:auto;min-width:0}
.dshmm-selectAll{display:inline-flex;align-items:center;gap:6px;font-size:11px;line-height:16px;color:var(--dsw-alias-label-secondary);cursor:pointer;white-space:nowrap}
.dshmm-check{width:14px;height:14px;margin:0;accent-color:var(--dsw-alias-brand-primary);cursor:pointer;flex:none}
.dshmm-check:disabled{cursor:default;opacity:.45}
.dshmm-checkWrap{display:flex;align-items:center;padding-top:2px;flex:none}
.dshmm-deletedRow .dshmm-preview{color:var(--dsw-alias-label-secondary);text-decoration:line-through;text-decoration-color:color-mix(in srgb, var(--dsw-alias-label-secondary) 60%, transparent)}
.dshmm-deletedChip{flex:none;min-width:52px;text-align:center;font-size:11px;line-height:18px;padding:1px 8px;margin-top:1px;border-radius:6px;color:var(--dsw-alias-state-warn-primary);background:color-mix(in srgb, var(--dsw-alias-state-warn-primary) 12%, transparent);white-space:nowrap}
.dshmm-reason{font-size:11px;line-height:16px;color:var(--dsw-alias-label-secondary);text-align:right;max-width:160px}
.dshmm-restore{appearance:none;border:0;border-radius:6px;padding:4px 10px;font:inherit;font-size:11px;line-height:16px;cursor:pointer;background:color-mix(in srgb, var(--dsw-alias-state-success-primary) 14%, transparent);color:var(--dsw-alias-state-success-primary);white-space:nowrap}
.dshmm-restore:hover{background:color-mix(in srgb, var(--dsw-alias-state-success-primary) 22%, transparent)}
.dshmm-restore:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px}
.dshmm-confirmBar{display:flex;align-items:center;gap:10px;margin:10px 20px 0;padding:8px 10px;border-radius:8px;background:color-mix(in srgb, var(--dsw-alias-state-error-primary) 10%, transparent);color:var(--dsw-alias-label-primary);font-size:12px;line-height:18px;flex:none}
.dshmm-confirmBar .dshmm-confirmActions{margin-left:auto}
.dshmm-subtle{font-size:11px;color:var(--dsw-alias-label-secondary)}
@media (max-width:520px){.dshmm-backdrop{padding:10px}.dshmm-panel{max-height:90vh}.dshmm-footHint{display:none}.dshmm-reason{display:none}}
`

    function icon(paths, size) {
      return h(
        'svg',
        {
          viewBox: '0 0 24 24',
          width: size || 16,
          height: size || 16,
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 1.7,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
          'aria-hidden': true,
        },
        paths.map((path, index) => h('path', { key: index, d: path })),
      )
    }

    const IconList = () => icon(['M4 6h11', 'M4 12h9', 'M4 18h7', 'M17 15.5l4 4', 'M21 15.5l-4 4'])
    const IconClose = () => icon(['M6 6l12 12', 'M18 6L6 18'])
    const IconTrash = () => icon(['M4 7h16', 'M9 7V5h6v2', 'M6 7l1 13h10l1-13', 'M10 11v5', 'M14 11v5'])

    function createManager(sessions, remote) {
      let snapshot = { open: false, sessionId: undefined }
      const listeners = new Set()
      const publish = () => {
        for (const listener of [...listeners]) {
          try {
            listener()
          } catch (_error) {
            /* one failing listener must not block the others */
          }
        }
      }
      return {
        sessions,
        subscribe(listener) {
          listeners.add(listener)
          return () => { listeners.delete(listener) }
        },
        getSnapshot() {
          return snapshot
        },
        open(sessionId) {
          snapshot = { open: true, sessionId }
          publish()
        },
        close() {
          if (!snapshot.open) return
          snapshot = { open: false, sessionId: undefined }
          publish()
        },
        async executeCommand(sessionId, line) {
          const commands = remote?.commands
          if (commands === undefined || typeof commands.execute !== 'function') {
            throw new Error('commands Remote is unavailable.')
          }
          const controller = new AbortController()
          const response = await commands.execute(sessionId, line, [], controller.signal)
          if (response !== null && typeof response === 'object' && response.ok === false) {
            const message = response.error !== null && typeof response.error === 'object' && typeof response.error.message === 'string'
              ? response.error.message
              : 'Remote command failed.'
            throw new Error(message)
          }
          const execution = response !== null && typeof response === 'object' && response.ok === true
            ? response.value
            : response
          if (execution === undefined || execution === null) throw new Error('Command was not recognized.')
          return execution
        },
      }
    }

    function useManagerState(manager) {
      return useSyncExternalStore(manager.subscribe, manager.getSnapshot, manager.getSnapshot)
    }

    function useSessionWindow(sessions, sessionId) {
      const subscribe = useCallback((notify) => {
        const binding = sessions.binding(sessionId)
        if (binding === undefined) return () => {}
        return binding.eventSource.subscribe(notify)
      }, [sessions, sessionId])
      const read = useCallback(() => {
        const binding = sessions.binding(sessionId)
        return binding === undefined ? EMPTY_WINDOW : binding.eventSource.getSnapshot()
      }, [sessions, sessionId])
      return useSyncExternalStore(subscribe, read, read)
    }

    function roleOf(event) {
      if (event.type === 'user/message') return event.data?.source?.kind === 'user' ? 'user' : 'context'
      if (event.type === 'assistant/message') return 'assistant'
      if (event.type === 'tool/result') return 'tool'
      if (event.type === 'developer/message') return 'context'
      return 'system'
    }

    function previewOf(message, limit) {
      const content = Array.isArray(message?.content) ? message.content : []
      const parts = []
      for (const block of content) {
        if (block === null || typeof block !== 'object') continue
        if (block.type === 'text' && typeof block.text === 'string') parts.push(block.text)
        else if (block.type === 'tool-call') parts.push(`tool:${typeof block.name === 'string' ? block.name : '?'}`)
        else if (block.type === 'image') parts.push('[image]')
        else if (block.type === 'file') parts.push(`[file${block.attachment?.name ? `: ${block.attachment.name}` : ''}]`)
        else if (block.type === 'tool-addition') parts.push(`+${String(block.toolName)}`)
        else if (block.type === 'tool-removal') parts.push(`-${String(block.toolName)}`)
      }
      const text = parts.join(' ').replace(/\s+/g, ' ').trim()
      if (text.length === 0) return ''
      const max = limit === undefined ? 120 : limit
      return text.length > max ? `${text.slice(0, max - 1)}…` : text
    }

    function toolCallIdsOf(event) {
      if (event === undefined || event.type !== 'assistant/message') return []
      const content = Array.isArray(event.data?.message?.content) ? event.data.message.content : []
      return content
        .filter((block) => block !== null && typeof block === 'object' && block.type === 'tool-call' && typeof block.id === 'string')
        .map((block) => block.id)
    }

    function hasToolChange(event) {
      const content = event?.data?.message?.content
      return Array.isArray(content)
        && content.some((block) => block?.type === 'tool-addition' || block?.type === 'tool-removal')
    }

    function isTombstoneEvent(event) {
      return event !== undefined
        && event !== null
        && event.type === 'developer/message'
        && Array.isArray(event.data?.message?.content)
        && event.data.message.content.length === 0
        && event.data?.message?.source?.kind === 'message-manager'
        && event.surfaceOp !== null
        && typeof event.surfaceOp === 'object'
        && event.surfaceOp.op === 'replace'
    }

    function parseRestoredTombstoneId(id) {
      if (typeof id !== 'string' || !id.startsWith('restored-assistant-')) return undefined
      const rest = id.slice('restored-assistant-'.length)
      const dash = rest.indexOf('-')
      if (dash <= 0) return undefined
      const seq = Number(rest.slice(0, dash))
      return Number.isSafeInteger(seq) ? seq : undefined
    }

    function foldEntries(entries) {
      const seqs = []
      const bySeq = new Map()
      const groups = []
      for (const entry of entries) {
        if (entry === null || typeof entry !== 'object' || entry.type === 'transient') continue
        const event = entry.event
        if (event === null || typeof event !== 'object' || typeof event.seq !== 'number') continue
        bySeq.set(event.seq, event)
        if (!SURFACE_TYPES.has(event.type)) continue
        const op = event.surfaceOp
        if (op === undefined) continue
        if (op === 'append') {
          seqs.push(event.seq)
          continue
        }
        if (op !== null && typeof op === 'object' && op.op === 'replace') {
          const start = seqs.indexOf(op.startSeq)
          const end = seqs.indexOf(op.endSeq)
          if (start < 0 || end < start) continue
          const removed = seqs.slice(start, end + 1)
          if (isTombstoneEvent(event)) groups.push({ tombstoneSeq: event.seq, targetSeqs: removed })
          seqs.splice(start, end - start + 1, event.seq)
        }
      }

      const items = []
      let turn = 0
      let step = 0
      for (let index = 0; index < seqs.length; index += 1) {
        const seq = seqs[index]
        const event = bySeq.get(seq)
        if (event === undefined) continue
        if (Number.isSafeInteger(event.data?.turn)) turn = event.data.turn
        if (Number.isSafeInteger(event.data?.step)) step = event.data.step
        if (event.type === 'system/message') continue
        const message = event.type === 'user/message' ? event.data : event.data?.message
        if (message === null || typeof message !== 'object') continue
        const content = Array.isArray(message.content) ? message.content : []
        if ((event.type === 'developer/message' || event.type === 'assistant/message') && content.length === 0) continue
        let itemTurn = Number.isSafeInteger(event.data?.turn) ? event.data.turn : undefined
        let itemStep = Number.isSafeInteger(event.data?.step) ? event.data.step : undefined
        if (itemTurn === undefined || itemStep === undefined) {
          for (let next = index + 1; next < seqs.length; next += 1) {
            const data = bySeq.get(seqs[next])?.data
            if (Number.isSafeInteger(data?.turn) && Number.isSafeInteger(data?.step)) {
              itemTurn = data.turn
              itemStep = data.step
              break
            }
          }
        }
        items.push({
          seq: event.seq,
          time: event.time,
          type: event.type,
          role: roleOf(event),
          turn: itemTurn ?? turn,
          step: itemStep ?? step,
          messageId: typeof message.id === 'string' ? message.id : undefined,
          preview: previewOf(message),
          blocks: content.length,
        })
      }

      const restored = new Set()
      for (const item of items) {
        const tombstoneSeq = parseRestoredTombstoneId(item.messageId)
        if (tombstoneSeq !== undefined) restored.add(tombstoneSeq)
      }

      const deleted = []
      for (const group of groups) {
        if (restored.has(group.tombstoneSeq)) continue
        const originalEvents = group.targetSeqs.map((seq) => bySeq.get(seq))
        const known = originalEvents.filter((event) => event !== undefined)
        const missing = group.targetSeqs.length - known.length
        const assistant = known.find((event) => event.type === 'assistant/message')
        const calls = assistant === undefined ? [] : toolCallIdsOf(assistant)
        const results = known.filter((event) => event.type === 'tool/result')
        let restorable = false
        let reason = ''
        if (group.targetSeqs.length === 1) {
          const event = known[0]
          if (event === undefined) restorable = true
          else if (event.type === 'user/message') restorable = true
          else if (event.type === 'developer/message' && !hasToolChange(event)) restorable = true
          else if (event.type === 'assistant/message' && calls.length === 0) {
            restorable = true
            reason = 'appended'
          } else if (event.type === 'tool/result') reason = 'tool'
          else reason = 'group'
        } else if (assistant !== undefined && calls.length > 0 && missing === 0 && results.length === group.targetSeqs.length - 1) {
          const ids = new Set(calls.map((block) => block.id))
          const resultIds = new Set(results.map((event) => event.data?.message?.toolCallId))
          restorable = ids.size === resultIds.size && [...ids].every((id) => resultIds.has(id))
          reason = restorable ? 'appended' : 'group'
        } else {
          reason = missing > 0 ? 'missing' : 'group'
        }
        deleted.push({
          tombstoneSeq: group.tombstoneSeq,
          targetSeqs: [...group.targetSeqs],
          count: group.targetSeqs.length,
          items: known.map((event) => {
            const message = event.type === 'user/message' ? event.data : event.data?.message
            return {
              seq: event.seq,
              role: roleOf(event),
              preview: previewOf(message),
              time: event.time,
            }
          }),
          missing,
          restorable,
          reason,
        })
      }
      return { items, deleted }
    }

    function formatTime(time, locale) {
      if (!Number.isFinite(time)) return ''
      try {
        return new Date(time).toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit' })
      } catch (_error) {
        return ''
      }
    }

    function MessageManagerButton({ sessionId, manager, t }) {
      const state = useManagerState(manager)
      const translate = typeof t === 'function' ? t : manager.translate
      return h(
        React.Fragment,
        null,
        h('style', null, CSS),
        h(
          'button',
          {
            type: 'button',
            className: 'dshmm-btn',
            title: translate('open'),
            'aria-label': translate('open'),
            'data-open': state.open ? 'true' : 'false',
            onClick: () => {
              if (sessionId === undefined) return
              manager.open(sessionId)
            },
          },
          h(IconList),
        ),
      )
    }

    function ManagerDialog({ manager, sessionId, locale, t, onBackdrop }) {
      const window = useSessionWindow(manager.sessions, sessionId)
      const folded = useMemo(() => foldEntries(window.entries), [window])
      const items = folded.items
      const deleted = folded.deleted
      const [selectedItems, setSelectedItems] = useState(() => new Set())
      const [selectedDeleted, setSelectedDeleted] = useState(() => new Set())
      const [pending, setPending] = useState(undefined)
      const [status, setStatus] = useState(undefined)
      const [busy, setBusy] = useState(false)
      const listRef = useRef(null)
      const panelRef = useRef(null)

      useEffect(() => {
        const panel = panelRef.current
        if (panel !== null && typeof panel.focus === 'function') panel.focus()
        const list = listRef.current
        if (list !== null) list.scrollTop = list.scrollHeight
      }, [])

      useEffect(() => {
        const onKeyDown = (event) => {
          if (event.key !== 'Escape') return
          if (busy) return
          event.stopPropagation()
          manager.close()
        }
        document.addEventListener('keydown', onKeyDown, true)
        return () => { document.removeEventListener('keydown', onKeyDown, true) }
      }, [manager, busy])

      const currentSelectedSeqs = items.filter((item) => selectedItems.has(item.seq)).map((item) => item.seq)
      const restorableDeleted = deleted.filter((group) => group.restorable)
      const deletedSelectedSeqs = restorableDeleted
        .filter((group) => selectedDeleted.has(group.tombstoneSeq))
        .map((group) => group.tombstoneSeq)
      const allCurrentSelected = items.length > 0 && currentSelectedSeqs.length === items.length
      const allDeletedSelected = restorableDeleted.length > 0 && deletedSelectedSeqs.length === restorableDeleted.length

      const toggleCurrent = (seq, checked) => {
        setSelectedItems((current) => {
          const next = new Set(current)
          if (checked) next.add(seq)
          else next.delete(seq)
          return next
        })
      }
      const toggleDeleted = (tombstoneSeq, checked) => {
        setSelectedDeleted((current) => {
          const next = new Set(current)
          if (checked) next.add(tombstoneSeq)
          else next.delete(tombstoneSeq)
          return next
        })
      }
      const toggleAllCurrent = () => {
        setSelectedItems(allCurrentSelected ? new Set() : new Set(items.map((item) => item.seq)))
      }
      const toggleAllDeleted = () => {
        setSelectedDeleted(allDeletedSelected ? new Set() : new Set(restorableDeleted.map((group) => group.tombstoneSeq)))
      }

      const run = async (kind, seqs) => {
        if (busy || seqs.length === 0) return
        setBusy(true)
        setStatus(undefined)
        setPending(undefined)
        try {
          const execution = await manager.executeCommand(sessionId, `/msgmgr ${kind} ${seqs.join(',')}`)
          const result = execution?.result !== undefined ? execution.result : execution
          if (result !== undefined && result !== null && result.kind === 'error') {
            setStatus({ kind: 'error', text: result.text || t('failed') })
            return
          }
          const fallback = kind === 'restore'
            ? t('restoreQueued', { count: seqs.length })
            : t('deleted', { count: seqs.length })
          const text = result !== undefined && result !== null && result.kind === 'success' ? result.text : undefined
          setStatus({ kind: 'success', text: text || fallback })
          if (kind === 'delete') setSelectedItems(new Set())
          else setSelectedDeleted(new Set())
        } catch (error) {
          setStatus({ kind: 'error', text: error instanceof Error ? error.message : String(error) })
        } finally {
          setBusy(false)
        }
      }

      const confirmPending = () => {
        if (pending === undefined) return
        const seqs = pending.seqs
        run('delete', seqs)
      }

      const renderCurrent = (item) => h(
        'div',
        { className: 'dshmm-row', key: item.seq, 'data-role': item.role },
        h(
          'label',
          { className: 'dshmm-checkWrap' },
          h('input', {
            type: 'checkbox',
            className: 'dshmm-check',
            checked: selectedItems.has(item.seq),
            disabled: busy,
            'aria-label': `Select #${item.seq}`,
            onChange: (event) => toggleCurrent(item.seq, event.target.checked),
          }),
        ),
        h('span', { className: 'dshmm-role' }, t(item.role)),
        h(
          'div',
          { className: 'dshmm-main' },
          h(
            'div',
            { className: 'dshmm-preview', title: item.preview || undefined },
            item.preview || t('emptyMessage'),
          ),
          h(
            'div',
            { className: 'dshmm-meta' },
            `#${item.seq}`,
            ' · ',
            formatTime(item.time, locale),
            item.turn > 0 ? ` · T${item.turn}S${item.step}` : '',
          ),
        ),
        h(
          'div',
          { className: 'dshmm-actions' },
          h(
            'button',
            {
              type: 'button',
              className: 'dshmm-iconbtn',
              title: t('delete'),
              'aria-label': t('delete'),
              disabled: busy,
              onClick: () => {
                setPending({ seqs: [item.seq] })
                setStatus(undefined)
              },
            },
            h(IconTrash),
          ),
        ),
      )

      const renderDeleted = (group) => {
        const first = group.items[0]
        const summary = group.count === 1
          ? first === undefined
            ? `#${group.targetSeqs[0]} · ${t('contentNotLoaded')}`
            : `${t(first.role)} · ${first.preview || t('emptyMessage')}`
          : `${t('deletedGroup')} · ${group.count}${first !== undefined && first.preview ? ` · ${first.preview}` : ''}`
        const reasonKey = group.reason === 'appended'
          ? 'restoreAppended'
          : group.reason === 'tool'
            ? 'unrestorableTool'
            : group.reason === 'missing'
              ? 'contentNotLoaded'
              : group.reason === 'group'
                ? 'unrestorableGroup'
                : undefined
        return h(
          'div',
          { className: 'dshmm-row dshmm-deletedRow', key: group.tombstoneSeq, 'data-role': first?.role },
          h(
            'label',
            { className: 'dshmm-checkWrap' },
            h('input', {
              type: 'checkbox',
              className: 'dshmm-check',
              checked: selectedDeleted.has(group.tombstoneSeq),
              disabled: busy || !group.restorable,
              'aria-label': `Select deleted #${group.tombstoneSeq}`,
              onChange: (event) => toggleDeleted(group.tombstoneSeq, event.target.checked),
            }),
          ),
          h('span', { className: 'dshmm-role' }, first === undefined ? '—' : t(first.role)),
          h(
            'div',
            { className: 'dshmm-main' },
            h(
              'div',
              { className: 'dshmm-preview', title: first?.preview || undefined },
              summary,
            ),
            h(
              'div',
              { className: 'dshmm-meta' },
              t('deletedRecord', { seq: group.tombstoneSeq }),
              reasonKey === undefined ? '' : ` · ${t(reasonKey)}`,
            ),
          ),
          h(
            'div',
            { className: 'dshmm-actions' },
            group.restorable
              ? h(
                'button',
                {
                  type: 'button',
                  className: 'dshmm-restore',
                  disabled: busy,
                  onClick: () => run('restore', [group.tombstoneSeq]),
                },
                t('restore'),
              )
              : h('span', { className: 'dshmm-reason' }, t(reasonKey || 'unavailable')),
          ),
        )
      }

      const sectionHeader = (title, count, allSelected, onToggleAll, actions, selectable) => h(
        'div',
        { className: 'dshmm-section' },
        selectable
          ? h(
            'label',
            { className: 'dshmm-selectAll' },
            h('input', {
              type: 'checkbox',
              className: 'dshmm-check',
              checked: allSelected,
              disabled: busy || count === 0,
              onChange: onToggleAll,
            }),
            allSelected ? t('clearSelection') : t('selectAll'),
          )
          : null,
        h('span', { className: 'dshmm-sectionTitle' }, title),
        h('span', { className: 'dshmm-sectionCount' }, String(count)),
        h('div', { className: 'dshmm-sectionActions' }, actions),
      )

      return h(
        'div',
        {
          className: 'dshmm-backdrop',
          onMouseDown: (event) => {
            if (event.target === event.currentTarget && !busy) onBackdrop()
          },
        },
        h(
          'div',
          {
            className: 'dshmm-panel',
            ref: panelRef,
            tabIndex: -1,
            role: 'dialog',
            'aria-modal': 'true',
            'aria-label': t('title'),
          },
          h(
            'div',
            { className: 'dshmm-head' },
            h(
              'div',
              { className: 'dshmm-titleRow' },
              h('h2', { className: 'dshmm-title' }, t('title')),
              h(
                'button',
                {
                  type: 'button',
                  className: 'dshmm-close',
                  title: t('close'),
                  'aria-label': t('close'),
                  disabled: busy,
                  onClick: () => manager.close(),
                },
                h(IconClose),
              ),
            ),
            h('p', { className: 'dshmm-subtitle' }, t('subtitle')),
          ),
          status === undefined
            ? null
            : h(
              'div',
              { className: 'dshmm-banner', 'data-kind': status.kind, role: 'status' },
              status.text,
            ),
          pending === undefined
            ? null
            : h(
              'div',
              { className: 'dshmm-confirmBar' },
              h('span', null, t('confirmBatch', { count: pending.seqs.length })),
              h(
                'div',
                { className: 'dshmm-confirmActions' },
                h(
                  'button',
                  {
                    type: 'button',
                    className: 'dshmm-small',
                    disabled: busy,
                    onClick: () => setPending(undefined),
                  },
                  t('cancel'),
                ),
                h(
                  'button',
                  {
                    type: 'button',
                    className: 'dshmm-small',
                    'data-danger': 'true',
                    disabled: busy,
                    onClick: confirmPending,
                  },
                  t('confirmDelete'),
                ),
              ),
            ),
          h(
            'div',
            { className: 'dshmm-list', ref: listRef },
            window.entries.length === 0
              ? h('div', { className: 'dshmm-empty' }, t('notReady'))
              : items.length === 0 && deleted.length === 0
                ? h('div', { className: 'dshmm-empty' }, t('empty'))
                : h(
                  React.Fragment,
                  null,
                  sectionHeader(
                    t('currentSection'),
                    items.length,
                    allCurrentSelected,
                    toggleAllCurrent,
                    h(
                      'button',
                      {
                        type: 'button',
                        className: 'dshmm-small',
                        'data-danger': 'true',
                        disabled: busy || currentSelectedSeqs.length === 0,
                        onClick: () => setPending({ seqs: currentSelectedSeqs }),
                      },
                      t('deleteSelected', { count: currentSelectedSeqs.length }),
                    ),
                    true,
                  ),
                  items.length === 0
                    ? h('div', { className: 'dshmm-empty' }, t('empty'))
                    : items.map(renderCurrent),
                  deleted.length === 0
                    ? null
                    : h(
                      React.Fragment,
                      null,
                      sectionHeader(
                        t('deletedSection'),
                        deleted.length,
                        allDeletedSelected,
                        toggleAllDeleted,
                        h(
                          'button',
                          {
                            type: 'button',
                            className: 'dshmm-small',
                            disabled: busy || deletedSelectedSeqs.length === 0,
                            onClick: () => run('restore', deletedSelectedSeqs),
                          },
                          t('restoreSelected', { count: deletedSelectedSeqs.length }),
                        ),
                        restorableDeleted.length > 0,
                      ),
                      deleted.map(renderDeleted),
                    ),
                ),
          ),
          h(
            'div',
            { className: 'dshmm-foot' },
            h(
              'span',
              { className: 'dshmm-footCount' },
              busy
                ? t('busy')
                : `${t('count', { count: items.length })}${deleted.length > 0 ? ` · ${t('deletedSection')} ${deleted.length}` : ''}`,
            ),
            h(
              'span',
              { className: 'dshmm-footHint' },
              t('hint'),
              ' ',
              h('span', { className: 'dshmm-code' }, t('usage')),
            ),
          ),
        ),
      )
    }

    function ManagerOverlay({ manager, t }) {
      const state = useManagerState(manager)
      const translate = typeof t === 'function' ? t : manager.translate
      const locale = manager.locale
      if (!state.open || state.sessionId === undefined) return null
      return h(
        React.Fragment,
        null,
        h('style', null, CSS),
        h(ManagerDialog, {
          key: state.sessionId,
          manager,
          sessionId: state.sessionId,
          locale,
          t: translate,
          onBackdrop: () => manager.close(),
        }),
      )
    }

    return {
      inject: ['slots', 'sessions', 'locale', 'remote', 'remote.commands'],
      apply(ctx) {
        ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'message-manager: locale dictionaries')
        const t = ctx.locale.bind(NS)
        const manager = createManager(ctx.sessions, ctx.remote)
        manager.translate = t
        manager.locale = ctx.locale.getLocale()?.active

        ctx.slots.inject('conversation.session.header.utilities', () => ctx.slots.register(
          {
            name: 'conversation.session.header.utilities',
            id: 'message-manager',
            order: 20,
            locale: NS,
            inject: () => ({ manager }),
          },
          MessageManagerButton,
        ))

        ctx.slots.inject('shell.overlay', () => ctx.slots.register(
          {
            name: 'shell.overlay',
            id: 'message-manager',
            order: 100,
            locale: NS,
            inject: () => ({ manager }),
          },
          ManagerOverlay,
        ))
      },
    }
  },
})
