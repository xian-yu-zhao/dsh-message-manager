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

// CJK / full-width characters price far denser than ASCII: roughly one token
// per character instead of four. Pricing them separately keeps the ASCII price
// identical to the token-meter heuristic (so plain English text is unchanged)
// while making Chinese text, which every 4-chars-per-token rule badly
// underprices, land close to reality.
const CJK_TOKEN_RANGES = [
  [0x1100, 0x11ff], // Hangul Jamo
  [0x2e80, 0x303e], // CJK radicals and punctuation
  [0x3041, 0x33ff], // Hiragana, Katakana, CJK compatibility
  [0x3400, 0x4dbf], // CJK unified ideographs extension A
  [0x4e00, 0x9fff], // CJK unified ideographs
  [0xa000, 0xa4cf], // Yi syllables
  [0xac00, 0xd7a3], // Hangul syllables
  [0xf900, 0xfaff], // CJK compatibility ideographs
  [0xfe30, 0xfe4f], // CJK compatibility forms
  [0xff00, 0xffef], // Full-width / half-width forms
  [0x20000, 0x3ffff], // CJK unified ideographs extension B and beyond
]

/** Whether one code point prices at roughly one token per character. */
export function isCjkCodePoint(codePoint) {
  if (!Number.isSafeInteger(codePoint)) return false
  for (const range of CJK_TOKEN_RANGES) {
    if (codePoint >= range[0] && codePoint <= range[1]) return true
  }
  return false
}

/** Character density in quarter-token units: CJK counts 4, every other char 1. */
function textUnits(text) {
  const value = typeof text === 'string' ? text : ''
  if (value.length === 0) return 0
  let units = 0
  for (const character of value) {
    units += isCjkCodePoint(character.codePointAt(0)) ? ESTIMATE_CHARS_PER_TOKEN : 1
  }
  return units
}

/**
 * Heuristically price a text fragment: CJK / full-width characters at about one
 * token each, all other characters at 1/4 token.
 * @param text - the fragment to price; non-strings price as 0.
 * @returns heuristic tokens (rounded up).
 */
export function estimateTextTokens(text) {
  return Math.ceil(textUnits(text) / ESTIMATE_CHARS_PER_TOKEN)
}

/**
 * Heuristically price one message in tokens. ASCII text keeps the
 * dsh-token-meter fixed density (4 characters per token); CJK / full-width
 * characters price at about one token each (see {@link estimateTextTokens}),
 * because the 4-chars rule underprices them roughly fourfold. Per-block and
 * role framing overhead are added on top. This is still an estimate only:
 * dense JSON and mixed scripts stay approximate, so every token figure this
 * plugin surfaces is labeled as an estimate.
 * @param message - message (event.data for user, event.data.message otherwise).
 * @param isSystem - price as a rendered system prompt (no per-block overhead).
 * @returns heuristic tokens; 0 for empty content (e.g. tombstones).
 */
export function estimateMessageTokens(message, isSystem = false) {
  if (message === undefined || message === null) return 0
  const content = Array.isArray(message.content) ? message.content : []
  if (content.length === 0) return 0
  if (isSystem) {
    let units = 0
    for (const block of content) {
      units += textUnits(block?.type === 'text' ? (block.text ?? '') : JSON.stringify(block))
    }
    return Math.ceil(units / ESTIMATE_CHARS_PER_TOKEN) + 4
  }
  let tokens = 0
  for (const block of content) {
    if (block === null || typeof block !== 'object') continue
    switch (block.type) {
      case 'text':
      case 'reasoning':
        tokens += estimateTextTokens(block.text ?? '') + 4
        break
      case 'tool-call':
        tokens += estimateTextTokens(block.name ?? '')
          + estimateTextTokens(block.arguments ?? '')
          + 4
        break
      default:
        // Merge-extensible/unknown blocks (and image references, whose request
        // price is route-owned) keep a conservative structural JSON price.
        tokens += 4 + estimateTextTokens(JSON.stringify(block))
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
  const chosenItems = []
  let estimatedFreedTokens = 0
  for (const candidate of candidates) {
    if (estimatedFreedTokens >= targetTokens) break
    chosen.push(candidate.seq)
    chosenItems.push(candidate)
    estimatedFreedTokens = estimatedFreedTokens + (candidate.tokens ?? 0)
  }
  return {
    chosen,
    chosenItems,
    candidates: candidates.map((item) => ({ seq: item.seq, role: item.role, tokens: item.tokens ?? 0 })),
    estimatedFreedTokens,
    meetsTarget: estimatedFreedTokens >= targetTokens,
  }
}

/**
 * Dry-run preview for {@link planClean}: exactly what a budget clean would
 * remove, priced the same way, without touching the surface.
 *
 * The preview is the plan, not a guess: the same `planClean` result powers the
 * real clean, so the seqs listed here are the seqs that a confirmed run would
 * delete (unless the surface changed in between).
 * @param plan - the result of {@link planClean}.
 * @param targetTokens - the requested budget, for the header line.
 * @param previewLimit - how many would-be deletions to list (default 10).
 */
export function formatCleanPlan(plan, targetTokens, previewLimit = 10) {
  const target = Number.isSafeInteger(targetTokens)
    ? targetTokens.toLocaleString('en-US')
    : String(targetTokens ?? 0)
  const chosenItems = Array.isArray(plan?.chosenItems) ? plan.chosenItems : []
  const candidateCount = Array.isArray(plan?.candidates) ? plan.candidates.length : 0
  const freed = Number.isSafeInteger(plan?.estimatedFreedTokens) ? plan.estimatedFreedTokens : 0
  const limit = Math.max(1, Number.isSafeInteger(previewLimit) ? previewLimit : 10)
  const lines = [`按预算清理预览（目标 ≈${target} tokens，未删除任何消息）：`]
  if (chosenItems.length === 0) {
    lines.push(`候选池 ${candidateCount} 条里没有可清理的消息——只有用户/上下文消息，或剩下的都太小、太新被保护。`)
    lines.push('想放宽：/ctxmgr clean <目标tokens> --min 50 --protect 1（候选阈值与保护条数）。')
    return lines.join('\n')
  }
  lines.push(`将从 ${candidateCount} 条候选里清理 ${chosenItems.length} 条，预计释放 ≈${freed.toLocaleString('en-US')} tokens（启发式估算）。`)
  const shown = chosenItems.slice(0, limit)
  for (const item of shown) {
    const role = item.role === 'tool' ? '工具' : item.role === 'assistant' ? '助手' : String(item.role ?? '?')
    const preview = typeof item.preview === 'string' && item.preview.length > 0
      ? item.preview.length > 60 ? `${item.preview.slice(0, 60)}…` : item.preview
      : '（无预览）'
    lines.push(`  #${item.seq} ${role} ≈${(item.tokens ?? 0).toLocaleString('en-US')} tok · ${preview}`)
  }
  if (chosenItems.length > shown.length) lines.push(`  …另 ${chosenItems.length - shown.length} 条未展开`)
  if (!plan?.meetsTarget && Number.isSafeInteger(targetTokens)) {
    const gap = Math.max(0, targetTokens - freed)
    lines.push('', `候选池不够：最多只能释放 ≈${freed.toLocaleString('en-US')} tokens，离目标还差 ≈${gap.toLocaleString('en-US')}。`)
  }
  lines.push('', `确认执行：/ctxmgr clean ${Number.isSafeInteger(targetTokens) ? targetTokens : target}`)
  lines.push('删除复用按条删除的墓碑与持久队列，之后仍可 /ctxmgr undo-batch 撤销。')
  return lines.join('\n')
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
  lines.push('删除只会从后续模型请求的上下文中移除该消息，原始会话日志与聊天记录仍会保留。token 数为启发式估算：ASCII 按 4 字符/token、中日韩与全角字符约 1 字符/token，密集 JSON 仍是近似值。')
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

/** Human-readable label for a ledger result. */
function batchResultLabel(result) {
  return result === 'applied'
    ? '成功'
    : result === 'queued'
      ? '排队中'
      : result === 'failed' ? '失败' : '跳过'
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
  // One operation can append several records — queued when it was written,
  // then applied (or kept queued) at replay — so the ledger must read as one
  // row per batch, not as N operations. Grouping by batchId keeps the audit
  // trail truthful without the append-only log having to be rewritten.
  const groups = new Map()
  const order = []
  for (const entry of batches) {
    if (entry === null || typeof entry !== 'object') continue
    const key = typeof entry.batchId === 'string' && entry.batchId.length > 0
      ? entry.batchId
      : `record:${entry.recordSeq}`
    if (!groups.has(key)) {
      groups.set(key, [])
      order.push(key)
    }
    groups.get(key).push(entry)
  }
  const collapsed = order.map((key) => {
    const entries = groups.get(key)
    const results = []
    for (const entry of entries) {
      if (!results.includes(entry.result)) results.push(entry.result)
    }
    return { entries, results, final: entries[entries.length - 1] }
  })
  // Clamp so limit=0 cannot accidentally mean "show everything".
  const safeLimit = Math.max(1, Number.isSafeInteger(limit) ? limit : 20)
  const shown = collapsed.length > safeLimit ? collapsed.slice(-safeLimit) : collapsed
  const lines = collapsed.length === batches.length
    ? [`操作台账（共 ${collapsed.length} 个批次，显示最近 ${shown.length} 个）：`]
    : [`操作台账（共 ${collapsed.length} 个批次 / ${batches.length} 条记录，显示最近 ${shown.length} 个）：`]
  for (const group of shown) {
    const entry = group.final
    const short = typeof entry.batchId === 'string' ? entry.batchId.slice(0, 8) : '未知'
    // One batch can span several records: a queued operation is applied one
    // target at a time at replay, so each target gets its own applied/skipped
    // record. Total the rows that actually landed (falling back to the queued
    // estimate when nothing has landed yet) so the row reports the batch, not
    // just its last record.
    const landed = group.entries.filter((candidate) => candidate.result === 'applied'
      || candidate.result === 'skipped' || candidate.result === 'failed')
    const basis = landed.length > 0
      ? landed
      : group.entries.filter((candidate) => candidate.result === 'queued')
    const pricedRows = basis.length > 0 ? basis : group.entries
    let tokens = 0
    let count = 0
    for (const row of pricedRows) {
      // Only applied/queued rows say how many messages the batch moved and how
      // much it relieved; a skipped or failed target removed nothing, so it must
      // not inflate either figure.
      if (row.result !== 'applied' && row.result !== 'queued') continue
      tokens += Number.isSafeInteger(row.estimatedFreedTokens) ? row.estimatedFreedTokens : 0
      if (Number.isSafeInteger(row.count) && row.count > 0) count += row.count
      else if (Array.isArray(row.seqs)) count += row.seqs.length
    }
    const result = group.results.map(batchResultLabel).join(' → ')
    const withReason = [...group.entries].reverse()
      .find((candidate) => typeof candidate.reason === 'string' && candidate.reason.length > 0)
    const reason = withReason !== undefined ? `（${withReason.reason}）` : ''
    // Undo rows count deletion records (tombstones), not messages, and a restore
    // frees no tokens — label them so the two units are never read as one.
    const undoRow = entry.op === 'undo'
    const unit = undoRow ? '条删除记录' : '条消息'
    const tokenText = undoRow ? '—' : `≈${tokens.toLocaleString('en-US')} tok`
    lines.push(`#${entry.recordSeq} ${short} · ${entry.op} · ${count} ${unit} · ${tokenText} · ${result}${reason}`)
  }
  if (collapsed.length > shown.length) lines.push(`…另 ${collapsed.length - shown.length} 个更早的批次未展开`)
  lines.push('', '撤销最近一次：/ctxmgr undo-batch',
    '撤销指定批次：/ctxmgr undo-batch <batchId 前几位>（台账里 “·” 前的 8 位）')
  lines.push('台账与墓碑都写在会话日志里，只增不改，重启后仍可查；同一批次的「排队中 → 成功」是同一操作的两条记录，不是两次操作。')
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
