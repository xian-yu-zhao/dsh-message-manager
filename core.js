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

/** Whether one message event carries a tool-addition/removal block. */
export function hasToolChange(event) {
  const content = event?.data?.message?.content
  return Array.isArray(content)
    && content.some((block) => block?.type === 'tool-addition' || block?.type === 'tool-removal')
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
    if (!Number.isSafeInteger(event.seq)) continue // a log object without a seq cannot be indexed
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

/** Fixed text-density estimate: 4 characters per token (token-meter heuristic). */
export const ESTIMATE_CHARS_PER_TOKEN = 4

/**
 * Heuristically price one message in tokens, mirroring the dsh-token-meter
 * fixed-density heuristic (4 characters per token, plus per-block and role
 * framing overhead). This is an estimate only: CJK text and dense JSON
 * underprice badly under this rule, so all token figures surfaced by this
 * plugin must be labeled as estimates.
 * @param message - message (event.data for user, event.data.message otherwise).
 * @param isSystem - price as a rendered system prompt (no per-block overhead).
 * @returns heuristic tokens; 0 for empty content (e.g. tombstones).
 */
export function estimateMessageTokens(message, isSystem = false) {
  if (message === undefined || message === null) return 0
  const content = Array.isArray(message.content) ? message.content : []
  if (content.length === 0) return 0
  if (isSystem) {
    let characters = 0
    for (const block of content) {
      characters += block?.type === 'text' ? block.text.length : JSON.stringify(block).length
    }
    return Math.ceil(characters / ESTIMATE_CHARS_PER_TOKEN) + 4
  }
  let tokens = 0
  for (const block of content) {
    if (block === null || typeof block !== 'object') continue
    switch (block.type) {
      case 'text':
      case 'reasoning':
        tokens += Math.ceil((block.text?.length ?? 0) / ESTIMATE_CHARS_PER_TOKEN) + 4
        break
      case 'tool-call':
        tokens += Math.ceil((block.name?.length ?? 0) / ESTIMATE_CHARS_PER_TOKEN)
          + Math.ceil((block.arguments?.length ?? 0) / ESTIMATE_CHARS_PER_TOKEN)
          + 4
        break
      default:
        // Merge-extensible/unknown blocks (and image references, whose request
        // price is route-owned) keep a conservative structural JSON price.
        tokens += 4 + Math.ceil(JSON.stringify(block).length / ESTIMATE_CHARS_PER_TOKEN)
    }
  }
  return tokens + 4
}

/**
 * Project current surface events into display items, oldest first.
 * `events` is either a complete surface snapshot or the folded output of
 * {@link foldSurface} resolved back to events.
 * @param tokensBySeq - optional seq→tokens map (e.g. from ctx.tokenMeter
 *   measure nodes) overriding the local heuristic per surface node.
 */
export function itemsFromSurface(events, tokensBySeq = undefined) {
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
    const tokens = content.length === 0
      ? 0 // empty/tombstone messages occupy nothing
      : tokensBySeq !== undefined && tokensBySeq.has(event.seq)
        ? tokensBySeq.get(event.seq)
        : estimateMessageTokens(message, event.type === 'system/message')
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
      tokens,
    })
  }
  return items
}

/**
 * Plan a token-budget "clean": choose an ordered set of deletable messages
 * whose estimated tokens roughly reach the budget.
 *
 * Candidates are only large tool / assistant messages; user and context
 * messages are never cleaned, and the most recent items on the surface are
 * protected so the live conversation stays intact. Candidates are ranked by
 * estimated tokens, descending, and taken until the budget is (first) met.
 * @param items - display items from {@link itemsFromSurface} (tokens required).
 * @param targetTokens - the token budget to free.
 * @param options - minCandidateTokens (default 100) and protectRecent
 *   (default 3) thresholds.
 */
export function planClean(items, targetTokens, options = {}) {
  const minTokens = options.minCandidateTokens ?? 100
  const protectRecent = Math.max(0, options.protectRecent ?? 3)
  const protectedSeqs = new Set(
    items.slice(Math.max(0, items.length - protectRecent)).map((item) => item.seq),
  )
  const candidates = items
    .filter((item) => (item.role === 'tool' || item.role === 'assistant')
      && (item.tokens ?? 0) >= minTokens
      && !protectedSeqs.has(item.seq))
    // Total order: tokens descending, then surface order, so equal-priced
    // candidates are always chosen deterministically.
    .sort((a, b) => (b.tokens ?? 0) - (a.tokens ?? 0) || a.seq - b.seq)
  const chosen = []
  let estimatedFreedTokens = 0
  for (const candidate of candidates) {
    if (estimatedFreedTokens >= targetTokens) break
    chosen.push(candidate.seq)
    estimatedFreedTokens = estimatedFreedTokens + (candidate.tokens ?? 0)
  }
  return {
    chosen,
    candidates: candidates.map((item) => ({ seq: item.seq, role: item.role, tokens: item.tokens ?? 0 })),
    estimatedFreedTokens,
    meetsTarget: estimatedFreedTokens >= targetTokens,
  }
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
  // A tombstone is already an invisible replacement; deleting it would nest
  // replacements and produce an empty recall pointer. Restore is the way out.
  if (isTombstone(target)) return { ok: false, reason: 'tombstone' }
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

/** Source kind this plugin writes for its invisible tombstones. */
export const TOMBSTONE_KIND = 'context-manager'
/** Source kinds older releases wrote; their tombstones stay restorable. */
export const LEGACY_TOMBSTONE_KINDS = Object.freeze(['message-manager'])

/** Whether one message source kind belongs to this plugin, current or legacy. */
export function isTombstoneKind(kind) {
  return kind === TOMBSTONE_KIND || LEGACY_TOMBSTONE_KINDS.includes(kind)
}

/** Shortest useful recall pointer: how many removed messages one tombstone names. */
export const RECALL_MAX_ENTRIES = 8
/** Recall preview length; keeps the pointer tiny and avoids copying message text. */
export const RECALL_PREVIEW_LIMIT = 80

/**
 * Build the recall pointer stored inside one tombstone.
 *
 * Each entry names the original seq, its role, and a one-line gist. The gist is
 * an excerpt, never the full message, so a tombstone cannot leak content that
 * the surrounding context no longer carries.
 * @param events - originals being removed, in surface order.
 * @returns recall entries, capped at {@link RECALL_MAX_ENTRIES}.
 */
export function buildRecall(events) {
  const recall = []
  for (const event of events) {
    if (recall.length >= RECALL_MAX_ENTRIES) break
    if (event === undefined || event === null || typeof event.seq !== 'number') continue
    const message = event.type === 'user/message' ? event.data : event.data?.message
    recall.push({
      seq: event.seq,
      role: roleOf(event),
      preview: previewOf(message, RECALL_PREVIEW_LIMIT),
    })
  }
  return recall
}

/**
 * Durable payload of an invisible replacement node.
 *
 * `batchId` ties the tombstone to one auditable batch operation: the ledger
 * record for that batch lists every tombstone it wrote, so an undo can name
 * exactly the nodes one user action produced while the tombstone kind stays
 * the only marker the restore planner relies on.
 * @param turn - open turn coordinate; the node must match an open step.
 * @param step - open step coordinate.
 * @param id - fresh message id for the invisible node.
 * @param batchId - optional batch identifier written into the source.
 * @param recall - optional short pointers to the removed messages.
 */
export function tombstoneData(turn, step, id, batchId = undefined, recall = undefined) {
  const source = typeof batchId === 'string' && batchId.length > 0
    ? { kind: TOMBSTONE_KIND, batchId }
    : { kind: TOMBSTONE_KIND }
  // A recall pointer turns "deleted" into "unloaded": the original seq and a
  // one-line gist stay addressable from inside the tombstone, while no full
  // message text is duplicated into the tombstone.
  if (Array.isArray(recall) && recall.length > 0) {
    // Copy the entries: the tombstone must not alias caller-owned objects.
    source.recall = recall.slice(0, RECALL_MAX_ENTRIES).map((entry) => ({
      seq: entry?.seq,
      role: entry?.role,
      preview: entry?.preview,
    }))
  }
  return {
    turn,
    step,
    message: {
      id,
      role: 'developer',
      content: [],
      source,
    },
  }
}

/** Parse a `restored-assistant-<tombstoneSeq>-…` marker id back to its tombstone seq. */
export function parseRestoredTombstoneId(id) {
  if (typeof id !== 'string' || !id.startsWith('restored-assistant-')) return undefined
  const rest = id.slice('restored-assistant-'.length)
  const dash = rest.indexOf('-')
  if (dash <= 0) return undefined
  const seq = Number(rest.slice(0, dash))
  return Number.isSafeInteger(seq) ? seq : undefined
}

/**
 * Classify the deleted records currently reachable from the surface.
 *
 * Mirrors the restore planner's capability boundaries without throwing: a
 * record is restorable when the same content would pass {@code planRestore}.
 * @param events - current surface events, oldest first (tombstones included).
 * @param bySeq - full-log index used to recover replaced originals.
 * @returns deleted-record descriptors in surface order.
 */
export function deletedFromSurface(events, bySeq) {
  const restored = new Set()
  for (const event of events) {
    if (event === undefined || event === null || event.type !== 'assistant/message') continue
    const seq = parseRestoredTombstoneId(event.data?.message?.id)
    if (seq !== undefined) restored.add(seq)
  }
  const records = []
  for (const event of events) {
    if (event === undefined || event === null || event.type !== 'developer/message') continue
    if (!isTombstoneKind(event.data?.message?.source?.kind)) continue
    const op = event.surfaceOp
    if (op === null || typeof op !== 'object' || op.op !== 'replace') continue
    if (restored.has(event.seq)) continue
    const targets = Array.isArray(event.sourceEventSeqs) ? event.sourceEventSeqs : []
    const originals = targets.map((seq) => bySeq.get(seq))
    const known = originals.filter((original) => original !== undefined)
    const missing = targets.length - known.length
    const assistant = known.find((original) => original.type === 'assistant/message')
    const calls = assistant === undefined ? [] : toolCallIdsOf(assistant)
    const results = known.filter((original) => original.type === 'tool/result')
    let restorable = false
    let reason = ''
    if (targets.length === 1) {
      const original = known[0]
      if (original === undefined) restorable = true
      else if (original.type === 'user/message') restorable = true
      else if (original.type === 'developer/message' && !hasToolChange(original)) restorable = true
      else if (original.type === 'assistant/message' && calls.length === 0) {
        restorable = original.data?.message?.content?.length > 0
        reason = 'appended'
      } else if (original.type === 'tool/result') reason = 'tool'
      else reason = 'group'
    } else if (assistant !== undefined && calls.length > 0 && missing === 0
      && results.length === targets.length - 1) {
      const callIds = new Set(calls)
      const resultIds = new Set(results.map((original) => original.data?.message?.toolCallId))
      restorable = callIds.size === resultIds.size && [...callIds].every((id) => resultIds.has(id))
      reason = restorable ? 'appended' : 'group'
    } else {
      reason = missing > 0 ? 'missing' : 'group'
    }
    records.push({
      tombstoneSeq: event.seq,
      batchId: typeof event.data?.message?.source?.batchId === 'string'
        ? event.data.message.source.batchId
        : undefined,
      recall: Array.isArray(event.data?.message?.source?.recall)
        ? event.data.message.source.recall
        : [],
      targetSeqs: [...targets],
      count: targets.length,
      items: known.map((original) => ({
        seq: original.seq,
        role: roleOf(original),
        preview: previewOf(original.type === 'user/message' ? original.data : original.data?.message),
      })),
      restorable,
      reason,
    })
  }
  return records
}

/** Human-readable Host listing for a command or tool result. */
export function formatList(items, deleted = [], pending = [], limit = 30) {
  const lines = []
  const totalTokens = items.reduce((total, item) => total + (item.tokens ?? 0), 0)
  if (items.length === 0) {
    lines.push('当前模型上下文中没有可管理的消息。')
  } else {
    const shown = items.length > limit ? items.slice(-limit) : items
    const omitted = items.length - shown.length
    lines.push(`当前模型上下文中共 ${items.length} 条可管理消息，估算占用约 ${totalTokens.toLocaleString('en-US')} tokens${omitted > 0 ? `，仅显示最近 ${shown.length} 条` : ''}：`)
    for (const item of shown) {
      const tokensLabel = `≈${(item.tokens ?? 0).toLocaleString('en-US')} tok`
      lines.push(`#${item.seq} [${item.role}] [${tokensLabel}] ${item.preview.length > 0 ? item.preview : '（空消息）'}`)
    }
    if (omitted > 0) lines.push(`（更早的 ${omitted} 条请在标题栏的“上下文管理”中查看。）`)
  }
  if (pending.length > 0) {
    lines.push('', `排队中（下一回合生效，共 ${pending.length} 项）：`)
    for (const entry of pending) {
      lines.push(`#${entry.recordSeq} ${entry.op} #${entry.targetSeq}`)
    }
  }
  if (deleted.length > 0) {
    lines.push('', `已删除 ${deleted.length} 条记录（restore 使用 #后的删除记录序号）：`)
    for (const record of deleted.slice(-20)) {
      const first = record.items[0]
      const recalled = Array.isArray(record.recall) ? record.recall : []
      const summary = record.items.length === 1 && first !== undefined
        ? `${first.role} · ${first.preview.length > 0 ? first.preview : '（空消息）'}`
        : record.items.length === 0 && recalled.length > 0
          ? `召回指针 · #${recalled[0].seq} ${recalled[0].role} · ${recalled[0].preview.length > 0 ? recalled[0].preview : '（空消息）'}`
          : `删除组 · ${record.count} 条`
      const note = record.restorable
        ? record.reason === 'appended' ? '恢复到末尾' : '恢复到原位置'
        : '不可恢复'
      // Name the original seqs so a user can pull the exact events back with
      // session_event_read instead of guessing from the tombstone seq.
      const recallNote = recalled.length > 0
        ? ` · 可召回 ${recalled.map((entry) => `#${entry.seq}`).join(',')}`
        : ''
      lines.push(`#${record.tombstoneSeq} ← ${summary}（${note}${recallNote}）`)
    }
  }
  lines.push('', '删除：/ctxmgr delete <序号,...>')
  lines.push('整轮：/ctxmgr deleteturn <轮号,...>（list-turns 查看轮号）')
  lines.push('清理：/ctxmgr clean <目标tokens>（自动挑选大体积工具/助手消息，保护用户消息与最近消息）')
  lines.push('恢复：/ctxmgr restore <删除记录序号,...>（也可在标题栏的上下文管理弹窗中操作）')
  lines.push('删除只会从后续模型请求的上下文中移除该消息，原始会话日志与聊天记录仍会保留。token 数为启发式估算（4 字符/token），中文与 JSON 内容会明显低估。')
  return lines.join('\n')
}

/** Whether one event is an empty context-manager tombstone, current or legacy kind. */
export function isTombstone(event) {
  return event !== undefined
    && event !== null
    && event.type === 'developer/message'
    && Array.isArray(event.data?.message?.content)
    && event.data.message.content.length === 0
    && isTombstoneKind(event.data?.message?.source?.kind)
    && event.surfaceOp !== null
    && typeof event.surfaceOp === 'object'
    && event.surfaceOp.op === 'replace'
}

/**
 * Group the surface's content nodes into conversation turns, oldest first.
 *
 * A node's turn comes from its own `data.turn`; a tombstone is invisible here
 * (it derives no message), so a fully deleted turn disappears from the list.
 * Injected context (runtime snapshots and reminders) carries the turn it was
 * injected under and therefore joins that turn.
 * @param events - current surface events, oldest first.
 * @param bySeq - full-log index, kept for signature symmetry with the other
 *   surface projections.
 * @returns turn descriptors: { turn, seqs, messages, tokens, preview }.
 */
export function turnsFromSurface(events, bySeq = new Map()) {
  const groups = new Map()
  for (const event of events) {
    if (event === undefined || event === null) continue
    if (!visibleSurfaceEvent(event)) continue
    const turn = Number.isSafeInteger(event.data?.turn) ? event.data.turn : undefined
    if (!Number.isSafeInteger(turn)) continue
    const message = messageOf(event)
    const role = roleOf(event)
    const preview = previewOf(message)
    const group = groups.get(turn) ?? { turn, seqs: [], messages: [], tokens: 0 }
    group.seqs.push(event.seq)
    group.messages.push({ seq: event.seq, role, preview })
    groups.set(turn, group)
  }
  for (const group of groups.values()) {
    const own = group.messages.find((entry) => entry.role === 'user')
    group.preview = (own ?? group.messages[0])?.preview ?? ''
  }
  return [...groups.values()].sort((a, b) => a.turn - b.turn)
}

/**
 * Attach per-turn estimated token totals to turn descriptors.
 * @param turns - descriptors from {@link turnsFromSurface}.
 * @param items - display items from {@link itemsFromSurface} (tokens required);
 *   each message is attributed to exactly one turn.
 */
export function addTurnTokens(turns, items) {
  const byTurn = new Map()
  for (const item of items) byTurn.set(item.turn, (byTurn.get(item.turn) ?? 0) + (item.tokens ?? 0))
  for (const turn of turns) turn.tokens = byTurn.get(turn.turn) ?? 0
  return turns
}

/**
 * Ledger entries an undo request could mean, most specific match first.
 *
 * Undo reuses the restore path, so a batch qualifies whenever it recorded at
 * least one tombstone and was either applied or durably queued. A full batch id
 * wins outright; otherwise the id is treated as a prefix, and the caller must
 * refuse an ambiguous prefix rather than silently undoing a guess.
 * @param batches - ledger entries from the Host's batch scan, in log order.
 * @param batchId - optional full id or prefix.
 * @returns every qualifying entry matching the id (all of them when omitted).
 */
export function matchUndoBatches(batches, batchId = undefined) {
  if (!Array.isArray(batches)) return []
  const eligible = batches.filter((entry) => entry !== null && typeof entry === 'object'
    && entry.op !== 'undo'
    && Array.isArray(entry.tombstoneSeqs) && entry.tombstoneSeqs.length > 0
    && (entry.result === 'applied' || entry.result === 'queued'))
  if (typeof batchId !== 'string' || batchId.length === 0) return eligible
  const exact = eligible.filter((entry) => entry.batchId === batchId)
  if (exact.length > 0) return exact
  return eligible.filter((entry) => typeof entry.batchId === 'string'
    && entry.batchId.startsWith(batchId))
}

/**
 * Choose the batch an undo request targets: a named batch (id or unambiguous
 * prefix), or the most recent batch that still has tombstones worth restoring.
 * @param batches - ledger entries from the Host's batch scan, in log order.
 * @param batchId - optional full id or unambiguous prefix.
 * @returns the chosen ledger entry, or undefined when nothing qualifies.
 */
export function pickUndoBatch(batches, batchId = undefined) {
  const matches = matchUndoBatches(batches, batchId)
  if (matches.length === 0) return undefined
  if (typeof batchId === 'string' && batchId.length > 0) {
    return matches.length === 1 ? matches[0] : undefined
  }
  return matches[matches.length - 1]
}

/** Human-readable audit trail for the batch ledger. */
export function formatBatches(batches, limit = 20) {
  if (!Array.isArray(batches) || batches.length === 0) {
    return [
      '还没有操作台账：每次删除、整轮删除或按预算清理都会记一条。',
      '',
      '撤销最近一次：/ctxmgr undo-batch（有台账后可用）',
    ].join('\n')
  }
  // Clamp so limit=0 cannot accidentally mean "show everything".
  const safeLimit = Math.max(1, Number.isSafeInteger(limit) ? limit : 20)
  const shown = batches.length > safeLimit ? batches.slice(-safeLimit) : batches
  const lines = [`操作台账（共 ${batches.length} 条，显示最近 ${shown.length} 条）：`]
  for (const entry of shown) {
    const short = typeof entry.batchId === 'string' ? entry.batchId.slice(0, 8) : '未知'
    const tokens = (Number.isSafeInteger(entry.estimatedFreedTokens) ? entry.estimatedFreedTokens : 0)
      .toLocaleString('en-US')
    const result = entry.result === 'applied'
      ? '成功'
      : entry.result === 'queued'
        ? '排队中'
        : entry.result === 'failed' ? '失败' : '跳过'
    // Prefer the message count when the Host recorded it: one batch can remove
    // more messages than it names as targets (a tool group travels together).
    const count = Number.isSafeInteger(entry.count) && entry.count > 0
      ? entry.count
      : Array.isArray(entry.seqs) ? entry.seqs.length : 0
    const reason = typeof entry.reason === 'string' && entry.reason.length > 0 ? `（${entry.reason}）` : ''
    lines.push(`#${entry.recordSeq} ${short} · ${entry.op} · ${count} 条消息 · ≈${tokens} tok · ${result}${reason}`)
  }
  lines.push('', '撤销最近一次：/ctxmgr undo-batch',
    '撤销指定批次：/ctxmgr undo-batch <batchId 前几位>（台账里 “·” 前的 8 位）')
  lines.push('台账与墓碑都写在会话日志里，只增不改，重启后仍可查。')
  return lines.join('\n')
}
/** Human-readable turn listing for a command or tool result. */
export function formatTurns(turns, limit = 50) {
  if (turns.length === 0) return '当前上下文中没有可删除的对话轮。'
  const shown = turns.length > limit ? turns.slice(-limit) : turns
  const omitted = turns.length - shown.length
  const lines = [`当前上下文中共 ${turns.length} 轮对话${omitted > 0 ? `，仅显示最近 ${shown.length} 轮` : ''}：`]
  for (const turn of shown) {
    const mark = turn.inProgress ? '（进行中，删除将在下一次请求生效）' : ''
    const tokensLabel = ` · ≈${(turn.tokens ?? 0).toLocaleString('en-US')} tok`
    lines.push(`T${turn.turn} · ${turn.preview.length > 0 ? turn.preview : '（无用户提问）'} · ${turn.messages.length} 条${tokensLabel}${mark}`)
  }
  lines.push('', '删除整轮：/ctxmgr deleteturn <轮号,...>')
  lines.push('整轮删除会一并移除该轮的上下文注入；恢复仍按单条删除记录粒度进行。')
  return lines.join('\n')
}
