/**
 * Pure helpers shared by the Host half of the message manager.
 *
 * The session surface is the model-visible projection of the append-only log.
 * Deleting one message means appending a surface replacement whose derived
 * message is empty, so later model requests no longer see the shadowed node
 * while the raw log and the Chat transcript stay intact.
 */

/** Surface event types that participate in the model-visible surface. */
export const SURFACE_TYPES = new Set([
  'system/message',
  'developer/message',
  'user/message',
  'assistant/message',
  'tool/result',
])

/** Message carried by one surface event, or undefined for non-surface events. */
export function messageOf(event) {
  if (event === undefined || event === null) return undefined
  if (event.type === 'user/message') return event.data
  return event.data?.message
}

/** Stable role label used by the Host listing. */
export function roleOf(event) {
  switch (event.type) {
    case 'user/message':
      return event.data?.source?.kind === 'user' ? 'user' : 'context'
    case 'assistant/message':
      return 'assistant'
    case 'tool/result':
      return 'tool'
    case 'developer/message':
      return 'context'
    default:
      return 'system'
  }
}

/** Tool-call ids requested by one assistant message. */
export function toolCallIdsOf(event) {
  if (event.type !== 'assistant/message') return []
  const content = event.data?.message?.content
  if (!Array.isArray(content)) return []
  const ids = []
  for (const block of content) {
    if (block?.type === 'tool-call' && typeof block.id === 'string') ids.push(block.id)
  }
  return ids
}

/** Collapse one message's content blocks into a one-line preview. */
export function previewOf(message, limit = 160) {
  const content = Array.isArray(message?.content) ? message.content : []
  const parts = []
  for (const block of content) {
    if (block === null || typeof block !== 'object') continue
    switch (block.type) {
      case 'text':
        if (typeof block.text === 'string') parts.push(block.text)
        break
      case 'tool-call':
        parts.push(`tool:${typeof block.name === 'string' ? block.name : '?'}`)
        break
      case 'image':
        parts.push('[image]')
        break
      case 'file':
        parts.push(`[file${block.attachment?.name ? `: ${block.attachment.name}` : ''}]`)
        break
      case 'tool-addition':
        parts.push(`+${String(block.toolName)}`)
        break
      case 'tool-removal':
        parts.push(`-${String(block.toolName)}`)
        break
      case 'reasoning':
        break
      default:
        break
    }
  }
  const text = parts.join(' ').replace(/\s+/g, ' ').trim()
  if (text.length === 0) return ''
  return text.length > limit ? `${text.slice(0, limit - 1)}…` : text
}

/** Fold raw log events into the current surface sequence list. */
export function foldSurface(events) {
  const nodes = []
  const bySeq = new Map()
  let uncertain = false
  for (const event of events) {
    if (event === null || typeof event !== 'object') continue
    bySeq.set(event.seq, event)
    if (!SURFACE_TYPES.has(event.type)) continue
    const op = event.surfaceOp
    if (op === undefined) continue
    if (op === 'append') {
      nodes.push(event.seq)
      continue
    }
    if (op !== null && typeof op === 'object' && op.op === 'replace') {
      const start = nodes.indexOf(op.startSeq)
      const end = nodes.indexOf(op.endSeq)
      if (start >= 0 && end >= start) nodes.splice(start, end - start + 1, event.seq)
      else uncertain = true
    }
  }
  return { nodes, bySeq, uncertain }
}

/** Whether a surface event should appear in the management list. */
function visibleSurfaceEvent(event) {
  if (event.type === 'system/message') return false
  const message = messageOf(event)
  if (message === undefined) return false
  const content = message.content
  if ((event.type === 'developer/message' || event.type === 'assistant/message')
    && (!Array.isArray(content) || content.length === 0)) return false
  return true
}

/**
 * Project current surface events into display items, oldest first.
 * `events` is either a complete surface snapshot or the folded output of
 * {@link foldSurface} resolved back to events.
 */
export function itemsFromSurface(events) {
  const items = []
  let currentTurn = 0
  let currentStep = 0
  for (let index = 0; index < events.length; index += 1) {
    const event = events[index]
    if (typeof event?.data?.turn === 'number' && Number.isSafeInteger(event.data.turn)) currentTurn = event.data.turn
    if (typeof event?.data?.step === 'number' && Number.isSafeInteger(event.data.step)) currentStep = event.data.step
    if (!visibleSurfaceEvent(event)) continue
    const message = messageOf(event)
    const content = Array.isArray(message.content) ? message.content : []
    const callIds = toolCallIdsOf(event)
    let turn = Number.isSafeInteger(event.data?.turn) ? event.data.turn : undefined
    let step = Number.isSafeInteger(event.data?.step) ? event.data.step : undefined
    if (turn === undefined || step === undefined) {
      for (let next = index + 1; next < events.length; next += 1) {
        const data = events[next]?.data
        if (Number.isSafeInteger(data?.turn) && Number.isSafeInteger(data?.step)) {
          turn = data.turn
          step = data.step
          break
        }
      }
    }
    items.push({
      seq: event.seq,
      time: event.time,
      type: event.type,
      role: roleOf(event),
      turn: turn ?? currentTurn,
      step: step ?? currentStep,
      messageId: typeof message.id === 'string' ? message.id : undefined,
      preview: previewOf(message),
      callIds,
      toolCallId: event.type === 'tool/result' && typeof message.toolCallId === 'string' ? message.toolCallId : undefined,
      blocks: content.length,
    })
  }
  return items
}

/** Boundary turn/step for a tombstone: prefer the deleted nodes, then neighbors. */
export function boundaryFor(events, indices) {
  const valid = (data) => Number.isSafeInteger(data?.turn) && Number.isSafeInteger(data?.step)
  for (const index of indices) {
    const data = events[index]?.data
    if (valid(data)) return { turn: data.turn, step: data.step }
  }
  const first = Math.min(...indices)
  for (let index = first + 1; index < events.length; index += 1) {
    const data = events[index]?.data
    if (valid(data)) return { turn: data.turn, step: data.step }
  }
  for (let index = first - 1; index >= 0; index -= 1) {
    const data = events[index]?.data
    if (valid(data)) return { turn: data.turn, step: data.step }
  }
  return { turn: 0, step: 0 }
}

/**
 * Plan one message deletion over a complete current surface.
 *
 * Deleting a tool result also removes its owning assistant message and every
 * sibling result of that message, and deleting an assistant message removes its
 * tool results, so the derived history never keeps a tool call without an answer
 * (or the reverse). The returned runs are contiguous surface ranges, in surface
 * order, each replaceable by a single tombstone event.
 */
export function planDeletion(events, targetSeq) {
  const targetIndex = events.findIndex((event) => event.seq === targetSeq)
  if (targetIndex < 0) return { ok: false, reason: 'not-found' }
  const target = events[targetIndex]
  if (target.type === 'system/message') return { ok: false, reason: 'system' }
  if (target.type === 'tool/result' && typeof target.data?.message?.toolCallId !== 'string') {
    return { ok: false, reason: 'unsupported' }
  }

  const chosen = new Set([targetIndex])
  const addAssistantGroup = (index) => {
    chosen.add(index)
    const callIds = new Set(toolCallIdsOf(events[index]))
    if (callIds.size === 0) return
    for (let i = 0; i < events.length; i += 1) {
      const event = events[i]
      if (event.type !== 'tool/result') continue
      if (callIds.has(event.data?.message?.toolCallId)) chosen.add(i)
    }
  }

  if (target.type === 'assistant/message') {
    addAssistantGroup(targetIndex)
  } else if (target.type === 'tool/result') {
    const callId = target.data.message.toolCallId
    let ownerFound = false
    for (let i = 0; i < events.length; i += 1) {
      const event = events[i]
      if (event.type !== 'assistant/message') continue
      if (!toolCallIdsOf(event).includes(callId)) continue
      ownerFound = true
      addAssistantGroup(i)
    }
    if (!ownerFound) chosen.add(targetIndex)
  }

  const indices = [...chosen].sort((a, b) => a - b)
  const runs = []
  let run = null
  for (const index of indices) {
    if (run !== null && index === run.endIndex + 1) {
      run.endIndex = index
      run.seqs.push(events[index].seq)
      continue
    }
    run = { startIndex: index, endIndex: index, seqs: [events[index].seq] }
    runs.push(run)
  }
  return {
    ok: true,
    target,
    indices,
    runs: runs.map((entry) => ({
      startSeq: entry.seqs[0],
      endSeq: entry.seqs[entry.seqs.length - 1],
      seqs: entry.seqs,
    })),
    count: indices.length,
    targetSeq,
  }
}

/** Durable payload of an invisible replacement node. */
export function tombstoneData(turn, step, id) {
  return {
    turn,
    step,
    message: {
      id,
      role: 'developer',
      content: [],
      source: { kind: 'message-manager' },
    },
  }
}

/** Human-readable Host listing for a command or tool result. */
export function formatList(items, limit = 30) {
  if (items.length === 0) return '当前模型上下文中没有可管理的消息。'
  const shown = items.length > limit ? items.slice(-limit) : items
  const omitted = items.length - shown.length
  const lines = [
    `当前模型上下文中共 ${items.length} 条可管理消息${omitted > 0 ? `，仅显示最近 ${shown.length} 条` : ''}：`,
  ]
  for (const item of shown) {
    lines.push(`#${item.seq} [${item.role}] ${item.preview.length > 0 ? item.preview : '（空消息）'}`)
  }
  if (omitted > 0) lines.push(`（更早的 ${omitted} 条请在标题栏的“消息管理”中查看。）`)
  lines.push('', '删除：/msgmgr delete <序号,...>')
  lines.push('恢复：/msgmgr restore <删除记录序号,...>（删除记录序号在标题栏的消息管理弹窗中查看）')
  lines.push('删除只会从后续模型请求的上下文中移除该消息，原始会话日志与聊天记录仍会保留。')
  return lines.join('\n')
}
