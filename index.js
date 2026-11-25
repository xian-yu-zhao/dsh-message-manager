/**
 * Host half of the Session Context Manager.
 *
 * A surface replacement whose replacement event derives no model message is the
 * supported way to remove one conversation entry from later model requests: the
 * append-only Session log, its Chat transcript, and every audit surface keep the
 * original record.
 *
 * Session format validation requires every `developer/message` to match an open
 * turn and step, and a Session cannot append from inside its own `session/event`
 * dispatch. A deletion or restore that cannot run safely right now is therefore
 * recorded as a durable `plugin:context-manager/pending` record — plugin records
 * append without an open turn/step and travel with the log across restarts —
 * and replayed on the owning Agent's `agent/request` waterfall. That hook runs
 * after `step/start` (so the step is open and appending is allowed) and before
 * the request messages are derived, so the next request already reflects it.
 * Every replay is idempotent: an applied record is acknowledged with a
 * `plugin:context-manager/ack` record, and a replayed operation whose target
 * vanished is acknowledged as skipped instead of being retried forever.
 *
 * Restore reverses a tombstone:
 * - user/context: the tombstone is replaced by a copy of the original message,
 *   preserving its surface position;
 * - assistant text: a copy is appended at the tail, because assistant messages
 *   cannot carry the source references a surface replacement requires;
 * - assistant tool groups: the assistant message, its tool calls, and its tool
 *   results are appended as one valid lifecycle at the tail.
 */
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import {
  addTurnTokens,
  buildRecall,
  deletedFromSurface,
  formatBatches,
  matchUndoBatches,
  pickUndoBatch,
  foldSurface,
  formatList,
  formatTurns,
  hasToolChange,
  isTombstoneKind,
  itemsFromSurface,
  planClean,
  planDeletion,
  tombstoneData,
  turnsFromSurface,
} from './core.js'

/**
 * Load the Session core the Host itself runs on.
 *
 * A profile-linked plugin cannot resolve `@deepseek-ai/*` by bare name: its
 * realpath sits outside the profile, and the packaged desktop carries the core
 * packages only inside the application asar. Try the bare specifier first (dev
 * checkouts with a real node_modules), then anchor on the Host process's
 * runtime directory — the packaged desktop Host starts with that directory as
 * `process.argv[2]`, and importing the same file URL yields the same module
 * instance the Host itself uses, so Session private-field brand checks pass.
 */
let sessionCore
try {
  sessionCore = await import('@deepseek-ai/dsh-session')
} catch {
  const runtimeDir = process.argv[2]
  if (typeof runtimeDir !== 'string' || runtimeDir.length === 0) {
    throw new Error('context-manager 无法加载 @deepseek-ai/dsh-session：裸导入失败，且当前进程不是携带运行时目录的桌面 Host。')
  }
  sessionCore = await import(pathToFileURL(join(runtimeDir, 'node_modules', '@deepseek-ai', 'dsh-session', 'lib', 'index.js')).href)
}
const { appendPluginRecord, pluginRecordOf } = sessionCore

export const name = 'context-manager'

export const inject = ['sessions', 'agents', 'commands', 'tools']

const RESTORED_PREFIX = 'restored-assistant-'
const PENDING_TYPE = 'plugin:context-manager/pending'
const ACK_TYPE = 'plugin:context-manager/ack'
/** Audit ledger: one record per user-visible batch operation. */
const BATCH_TYPE = 'plugin:context-manager/batch'
/** Queue record types older releases wrote; still applied after an upgrade. */
const LEGACY_PENDING_TYPES = ['plugin:message-manager/pending']
const LEGACY_ACK_TYPES = ['plugin:message-manager/ack']
/** Messages that mean a replayed operation already happened; ack as skipped. */
const IDEMPOTENT_MARKERS = ['已不在当前表面', '已经恢复', '已不在会话日志']

/** Resolve the live Session behind one command/tool agent. */
function liveSession(ctx, agent) {
  if (agent === undefined || agent === null || typeof agent.id !== 'string') {
    throw new Error('上下文管理需要一个会话作用域。')
  }
  const session = ctx.sessions.get(agent.id)
  if (session === undefined) throw new Error('当前会话未处于运行状态，无法读取或修改消息上下文。')
  return session
}

/** Read the complete current model surface for one live Session. */
async function readSurfaceEvents(ctx, session) {
  const query = ctx.get('sessionQuery')
  if (query !== undefined && typeof query.readSurface === 'function') {
    const snapshot = await query.readSurface(session.id)
    return snapshot.events
  }
  const folded = foldSurface(session.snapshotEvents())
  return folded.nodes.map((seq) => session.eventAt(seq)).filter((event) => event !== undefined)
}

/** Read the current surface synchronously (used inside the request hook). */
function surfaceEventsSync(session) {
  return session.surface.nodes
    .map((seq) => session.eventAt(seq))
    .filter((event) => event !== undefined)
}

/** Build an optional seq→tokens map from the token-meter service (when available). */
function buildTokensBySeq(ctx, session) {
  try {
    const meter = ctx.tokenMeter
    if (meter === undefined || meter === null || typeof meter.measure !== 'function') return undefined
    const measurement = meter.measure(session)
    if (measurement === undefined || measurement === null || !Array.isArray(measurement.nodes)) return undefined
    const map = new Map()
    for (const node of measurement.nodes) {
      if (node !== null && typeof node === 'object' && Number.isSafeInteger(node.seq)) {
        map.set(node.seq, node.tokens)
      }
    }
    return map
  } catch (_error) {
    return undefined
  }
}

/**
 * Read the turn/step that is open at the very end of the live log.
 * Scans backward: the last boundary marker decides the state, so an open step
 * deep in a long session is found without walking the whole log.
 * @returns the open coordinates plus the opening step seq, or undefined.
 */
function openStepOf(session) {
  const events = session.snapshotEvents()
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]
    if (event.type === 'turn/end' || event.type === 'step/end' || event.type === 'turn/start') return undefined
    if (event.type === 'step/start') {
      const { turn, step } = event.data ?? {}
      if (Number.isSafeInteger(turn) && Number.isSafeInteger(step) && turn >= 0 && step >= 0) {
        return { turn, step, startSeq: event.seq }
      }
      break // unusual payload; fall back to the full forward scan
    }
  }
  let turn = null
  let step = null
  let startSeq
  for (const event of events) {
    switch (event.type) {
      case 'turn/start':
        turn = event.data.turn
        step = null
        startSeq = undefined
        break
      case 'turn/end':
        turn = null
        step = null
        startSeq = undefined
        break
      case 'step/start':
        step = event.data.step
        startSeq = event.seq
        break
      case 'step/end':
        step = null
        startSeq = undefined
        break
      default:
        break
    }
  }
  return turn !== null && step !== null && startSeq !== undefined
    ? { turn, step, startSeq }
    : undefined
}

/** Append tombstone replacements for one plan inside an open turn/step. */
function appendTombstones(session, runs, turn, step, batchId = undefined) {
  const tombstoneSeqs = []
  try {
    for (const run of runs) {
      const event = session.append(
        'developer/message',
        tombstoneData(turn, step, randomUUID(), batchId,
          buildRecall(run.seqs.map((seq) => session.eventAt(seq)).filter((event) => event !== undefined))),
        {
          surfaceOp: { op: 'replace', startSeq: run.startSeq, endSeq: run.endSeq },
          sourceEventSeqs: run.seqs,
        },
      )
      tombstoneSeqs.push(event.seq)
    }
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    if (tombstoneSeqs.length > 0) {
      throw new Error(`已删除部分内容，后续替换失败：${reason}。请刷新后重试。`)
    }
    throw new Error(`删除失败：${reason}`)
  }
  return tombstoneSeqs
}

/** Whether one event is an empty context-manager tombstone, current or legacy kind. */
function isTombstone(event) {
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

/** Tool-call blocks carried by one assistant message. */
function assistantToolCalls(event) {
  if (event === undefined || event.type !== 'assistant/message') return []
  const content = event.data?.message?.content
  return Array.isArray(content)
    ? content.filter((block) => block !== null && typeof block === 'object' && block.type === 'tool-call')
    : []
}

/** Per-plugin-instance incremental scan state, keyed by plugin ctx then session id. */
const queueCaches = new WeakMap()

/**
 * Unacknowledged pending operations in log order, incrementally.
 *
 * The queue lives in the session log as plugin records, so a restart replays it
 * for free; within one process each event is examined exactly once.
 * @returns durable queue entries: { recordSeq, op, targetSeq }.
 */
function durableQueue(ctx, session) {
  let cache = queueCaches.get(ctx)
  if (cache === undefined) {
    cache = new Map()
    queueCaches.set(ctx, cache)
  }
  const state = cache.get(session.id) ?? { checkedTo: -1, pending: new Map() }
  const events = session.snapshotEvents(Math.max(0, state.checkedTo + 1))
  for (const event of events) {
    const record = pluginRecordOf(event)
    if (record === undefined) continue
    if (record.type === ACK_TYPE || LEGACY_ACK_TYPES.includes(record.type)) {
      const pendingSeq = record.data?.pendingSeq
      if (Number.isSafeInteger(pendingSeq)) state.pending.delete(pendingSeq)
    } else if (record.type === PENDING_TYPE || LEGACY_PENDING_TYPES.includes(record.type)) {
      const op = record.data?.op
      const targetSeq = record.data?.targetSeq
      const batchId = record.data?.batchId
      if ((op === 'delete' || op === 'restore' || op === 'delete-turn') && Number.isSafeInteger(targetSeq)) {
        state.pending.set(record.seq, {
          recordSeq: record.seq,
          op,
          targetSeq,
          batchId: typeof batchId === 'string' ? batchId : undefined,
        })
      }
    }
  }
  if (events.length > 0) state.checkedTo = events[events.length - 1].seq
  cache.set(session.id, state)
  return [...state.pending.values()]
}

/** Durably enqueue one operation; plugin records need no open turn/step. */
function appendPending(session, op, targetSeq, batchId = undefined) {
  return appendPluginRecord(session, PENDING_TYPE, {
    op,
    targetSeq,
    ...typeof batchId === 'string' && batchId.length > 0 ? { batchId } : {},
  })
}

/** Acknowledge one pending record so restarts and replays leave it alone. */
function appendAck(session, pendingSeq, result, detail) {
  appendPluginRecord(session, ACK_TYPE, {
    pendingSeq,
    result,
    ...typeof detail === 'string' && detail.length > 0 ? { detail: detail.slice(0, 300) } : {},
  })
}

/** Append one audit ledger record; plugin records need no open turn/step. */
function appendBatchLedger(session, entry) {
  return appendPluginRecord(session, BATCH_TYPE, {
    batchId: entry.batchId,
    op: entry.op,
    seqs: Array.isArray(entry.seqs) ? entry.seqs.slice(0, 200) : [],
    tombstoneSeqs: Array.isArray(entry.tombstoneSeqs) ? entry.tombstoneSeqs.slice(0, 200) : [],
    ...Number.isSafeInteger(entry.count) && entry.count > 0 ? { count: entry.count } : {},
    estimatedFreedTokens: Number.isSafeInteger(entry.estimatedFreedTokens) ? entry.estimatedFreedTokens : 0,
    result: entry.result,
    ...typeof entry.reason === 'string' && entry.reason.length > 0 ? { reason: entry.reason.slice(0, 300) } : {},
  })
}

/** Per-plugin-instance batch ledger scan state, keyed by ctx then session id. */
const batchCaches = new WeakMap()

/**
 * Batch ledger entries in log order, incrementally.
 *
 * The ledger is a plugin record inside the append-only session log, so the
 * audit trail travels with the session, survives restarts, and never rewrites
 * a past record. Each record carries the batch id, the target seqs, the
 * tombstones it wrote, the estimated relief, and the outcome.
 */
function batchesFromLog(ctx, session) {
  let cache = batchCaches.get(ctx)
  if (cache === undefined) {
    cache = new Map()
    batchCaches.set(ctx, cache)
  }
  const state = cache.get(session.id) ?? { checkedTo: -1, entries: [] }
  const events = session.snapshotEvents(Math.max(0, state.checkedTo + 1))
  for (const event of events) {
    const record = pluginRecordOf(event)
    if (record === undefined || record.type !== BATCH_TYPE) continue
    const data = record.data ?? {}
    if (typeof data.batchId !== 'string') continue
    state.entries.push({
      recordSeq: record.seq,
      time: event.time,
      batchId: data.batchId,
      op: typeof data.op === 'string' ? data.op : 'delete',
      seqs: Array.isArray(data.seqs) ? data.seqs : [],
      tombstoneSeqs: Array.isArray(data.tombstoneSeqs) ? data.tombstoneSeqs : [],
      count: Number.isSafeInteger(data.count) ? data.count : undefined,
      estimatedFreedTokens: Number.isSafeInteger(data.estimatedFreedTokens) ? data.estimatedFreedTokens : 0,
      result: typeof data.result === 'string' ? data.result : 'applied',
      reason: typeof data.reason === 'string' ? data.reason : undefined,
    })
  }
  if (events.length > 0) state.checkedTo = events[events.length - 1].seq
  cache.set(session.id, state)
  return state.entries
}

/** List the audit ledger for one live session. */
async function listBatches(ctx, agent) {
  const session = liveSession(ctx, agent)
  const batches = batchesFromLog(ctx, session)
  return { text: formatBatches(batches), batches }
}

/**
 * Compact exactly one user-selected surface span into a summary node.
 *
 * This is the only place this plugin borrows the official compaction engine,
 * and it stays deliberately narrow: the span is whatever the user named by
 * surface position, never a global pressure threshold (that is the compaction
 * backend's own policy). Both edges must already be tool-pairing balanced; the
 * engine rejects an unbalanced range, and we surface that reason verbatim.
 */
async function compactSelection(ctx, agent, start, end) {
  const session = liveSession(ctx, agent)
  const controller = new AbortController()
  try {
    // Resolve the optional service through ctx.get: compaction is not a hard
    // dependency of this plugin, and reading ctx.compaction would make Cordis
    // throw "cannot get property" for users who never loaded a backend.
    const engine = ctx.get('compaction')
    if (engine === undefined || engine === null || typeof engine.compactRegion !== 'function') {
      throw new Error('当前环境没有加载 compaction 服务（ctx.compaction）；请先启用 dsh-compaction-basic 之类的压缩后端。')
    }
    const nodes = session.surface.nodes
    if (!nodes.includes(start)) throw new Error(`起始序号 #${start} 不在当前表面上（/ctxmgr list 查看）。`)
    if (!nodes.includes(end)) throw new Error(`结束序号 #${end} 不在当前表面上（/ctxmgr list 查看）。`)
    if (nodes.indexOf(start) > nodes.indexOf(end)) {
      throw new Error('起始序号必须位于结束序号之前（按表面位置，不是数值大小）。')
    }
    const options = agent !== null && typeof agent === 'object'
      && agent.options !== null && typeof agent.options === 'object'
      ? agent.options
      : {}
    const agentCtx = { session, options }
    const result = await engine.compactRegion(start, end, agentCtx, controller.signal)
    const shadowedSeqs = Array.isArray(result?.shadowedSeqs) ? result.shadowedSeqs : []
    const tokens = Number.isSafeInteger(result?.shadowedTokenCount) ? result.shadowedTokenCount : 0
    // Node count and token count use different scopes: our tombstones are real
    // surface nodes (so they are counted) but derive no message (so they cost 0).
    // Reporting only the live message count keeps the number meaningful.
    let liveCount = 0
    let tombstoneCount = 0
    for (const seq of shadowedSeqs) {
      if (isTombstone(session.eventAt(seq))) tombstoneCount += 1
      else liveCount += 1
    }
    appendBatchLedger(session, {
      batchId: randomUUID(),
      op: 'compact',
      seqs: [start, end],
      tombstoneSeqs: [],
      count: liveCount,
      estimatedFreedTokens: 0,
      result: 'applied',
      reason: `shadowed ${liveCount} messages + ${tombstoneCount} tombstones / ${tokens} tokens`,
    })
    const tombNote = tombstoneCount > 0 ? `（另有 ${tombstoneCount} 个墓碑节点一并折叠，它们本就不占上下文）` : ''
    return {
      text: `已把表面区间 #${start}…#${end}（${liveCount} 条消息，估算 ${tokens.toLocaleString('en-US')} tokens${tombNote}）压缩成一条摘要消息。原始会话日志与聊天记录仍保留；这只作用于你选中的区间，不做全局阈值压缩。`,
      count: liveCount,
      tokens,
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    // The backend prices the shrink check against model-visible content only, so
    // a span whose live content is mostly already deleted cannot be summarized.
    // Say that plainly, and keep the ledger in the same language as the reply.
    const shrink = /summary is not smaller than the shadowed content \((\d+) estimated framed tokens >= (\d+)\)/.exec(message)
    const explanation = shrink !== null
      ? `选区内模型可见内容只剩约 ${shrink[2]} tokens（墓碑不算内容），而摘要本身就约 ${shrink[1]} tokens，官方压缩会拒绝「摘要不比原文小」的情况。`
      : message
    appendBatchLedger(session, {
      batchId: randomUUID(),
      op: 'compact',
      seqs: [start, end],
      tombstoneSeqs: [],
      estimatedFreedTokens: 0,
      result: 'failed',
      reason: explanation,
    })
    if (shrink !== null) {
      throw new Error(`局部压缩失败：${explanation}建议改用 /ctxmgr delete 或 /ctxmgr clean 直接移出这段，而不是压缩它。`)
    }
    throw new Error(`局部压缩失败：${message}`)
  }
}

/**
 * Undo one batch by restoring the tombstones it wrote.
 *
 * Undo never invents a new restore mechanism: it reuses the queued restore
 * path, so the raw log stays append-only and the restore keeps its usual
 * semantics (user/context at position, assistant content at the tail).
 */
async function undoBatch(ctx, agent, batchId) {
  const session = liveSession(ctx, agent)
  const batches = batchesFromLog(ctx, session)
  const matches = matchUndoBatches(batches, batchId)
  const isNamed = typeof batchId === 'string' && batchId.length > 0
  if (isNamed && matches.length > 1 && !matches.some((entry) => entry.batchId === batchId)) {
    throw new Error(`批次前缀有歧义（匹配 ${matches.length} 条），请给更长的前缀或完整 batchId（/ctxmgr batches 查看台账）。`)
  }
  const target = pickUndoBatch(batches, batchId)
  if (target === undefined) {
    throw new Error(typeof batchId === 'string' && batchId.length > 0
      ? '找不到该批次记录（/ctxmgr batches 查看台账）。'
      : '还没有可撤销的批次记录（台账为空，或只有恢复类操作）。')
  }
  const restoreSeqs = target.tombstoneSeqs.filter((seq) => session.surface.nodes.includes(seq))
  if (restoreSeqs.length === 0) throw new Error('该批次已没有仍在表面的删除记录（可能已恢复过）。')
  const undoBatchId = randomUUID()
  const result = await restoreMessages(ctx, agent, restoreSeqs, { batchId: undoBatchId })
  appendBatchLedger(session, {
    batchId: undoBatchId,
    op: 'undo',
    seqs: restoreSeqs,
    tombstoneSeqs: [],
    count: restoreSeqs.length,
    estimatedFreedTokens: 0,
    result: 'queued',
    reason: target.batchId,
  })
  const short = target.batchId.slice(0, 8)
  return {
    text: `撤销批次 ${short}（${target.op}）：${result.text}`,
    note: '用户与上下文消息回到原位；助手内容与工具结果会追加到末尾（序号会变）。',
    batchId: target.batchId,
    count: restoreSeqs.length,
  }
}

/**
 * Classify one tombstone into a restore plan without mutating the Session.
 * @throws when the tombstone or its original group cannot be restored safely.
 */
function planRestore(session, tombstoneSeq) {
  if (!session.surface.nodes.includes(tombstoneSeq)) throw new Error('该删除记录已不在当前表面，可能已被恢复。')
  const tombstone = session.eventAt(tombstoneSeq)
  if (!isTombstone(tombstone)) throw new Error('该序号不是本插件的删除记录。')
  const targets = tombstone.sourceEventSeqs
  if (!Array.isArray(targets) || targets.length === 0) throw new Error('删除记录缺少原始消息引用。')
  const bySeq = new Map(session.snapshotEvents().map((event) => [event.seq, event]))
  const originals = targets.map((seq) => bySeq.get(seq))
  if (originals.some((event) => event === undefined)) throw new Error('原始消息已不在会话日志中，无法恢复。')

  if (originals.length === 1) {
    const original = originals[0]
    if (original.type === 'user/message') return { kind: 'user', original }
    if (original.type === 'developer/message') {
      if (hasToolChange(original)) throw new Error('该上下文消息携带工具变更，不能恢复。')
      return { kind: 'developer', original }
    }
    if (original.type === 'assistant/message') {
      if (assistantToolCalls(original).length > 0) throw new Error('该助手消息属于工具调用组，无法单独恢复。')
      if (!Array.isArray(original.data?.message?.content) || original.data.message.content.length === 0) {
        throw new Error('该助手消息没有可恢复的内容。')
      }
      return { kind: 'assistant', original }
    }
    throw new Error('该类型的消息暂不支持恢复。')
  }

  const assistant = originals[0]
  if (assistant.type !== 'assistant/message') throw new Error('删除组不是可恢复的助手消息组。')
  const calls = assistantToolCalls(assistant)
  if (calls.length === 0) throw new Error('删除组不是可恢复的助手消息组。')
  const results = originals.slice(1)
  if (results.some((event) => event.type !== 'tool/result')) throw new Error('删除组包含不支持恢复的消息类型。')
  const callIds = new Set(calls.map((block) => block.id))
  const resultIds = new Set()
  for (const result of results) {
    const callId = result.data?.message?.toolCallId
    if (!callIds.has(callId)) throw new Error('删除组的工具调用与结果不匹配，无法恢复。')
    resultIds.add(callId)
  }
  if (resultIds.size !== callIds.size) throw new Error('删除组的工具调用不完整，无法恢复。')
  return { kind: 'group', assistant, calls, results }
}

/** Append an assistant copy at the tail and return its marker message id. */
function appendAssistantCopy(session, original, tombstoneSeq, turn, step) {
  const messageId = `${RESTORED_PREFIX}${tombstoneSeq}-${randomUUID()}`
  session.append('assistant/message', {
    turn,
    step,
    message: {
      id: messageId,
      role: 'assistant',
      content: original.data.message.content,
      source: original.data.message.source,
    },
    stream: [],
  }, { surfaceOp: 'append' })
  return messageId
}

/** Restore one tombstone inside the request's open step. */
function restoreOne(session, tombstoneSeq, turn, step) {
  const plan = planRestore(session, tombstoneSeq)
  if (plan.kind === 'user') {
    session.append(
      'user/message',
      { ...plan.original.data, id: randomUUID() },
      {
        surfaceOp: { op: 'replace', startSeq: tombstoneSeq, endSeq: tombstoneSeq },
        sourceEventSeqs: [tombstoneSeq],
      },
    )
    return
  }
  if (plan.kind === 'developer') {
    const data = {
      ...plan.original.data,
      turn,
      step,
      message: { ...plan.original.data.message, id: randomUUID() },
    }
    delete data.headerSeq
    session.append(
      'developer/message',
      data,
      {
        surfaceOp: { op: 'replace', startSeq: tombstoneSeq, endSeq: tombstoneSeq },
        sourceEventSeqs: [tombstoneSeq],
      },
    )
    return
  }
  if (plan.kind === 'assistant') {
    const marker = `${RESTORED_PREFIX}${tombstoneSeq}-`
    if (surfaceEventsSync(session).some((event) => event.type === 'assistant/message'
      && typeof event.data?.message?.id === 'string'
      && event.data.message.id.startsWith(marker))) {
      throw new Error('该消息已经恢复。')
    }
    appendAssistantCopy(session, plan.original, tombstoneSeq, turn, step)
    return
  }
  if (plan.kind === 'group') {
    const marker = `${RESTORED_PREFIX}${tombstoneSeq}-`
    if (surfaceEventsSync(session).some((event) => event.type === 'assistant/message'
      && typeof event.data?.message?.id === 'string'
      && event.data.message.id.startsWith(marker))) {
      throw new Error('该消息组已经恢复。')
    }
    appendAssistantCopy(session, plan.assistant, tombstoneSeq, turn, step)
    for (const call of plan.calls) {
      session.append('tool/call', {
        turn,
        step,
        callId: call.id,
        name: call.name,
        arguments: call.arguments,
      })
    }
    for (const result of plan.results) {
      const message = result.data.message
      const data = {
        turn,
        step,
        message: {
          id: randomUUID(),
          role: 'tool',
          content: message.content,
          source: message.source,
          toolCallId: message.toolCallId,
          ...message.isError === true ? { isError: true } : {},
        },
        ...result.data.error === undefined ? {} : { error: result.data.error },
      }
      session.append('tool/result', data, { surfaceOp: 'append' })
    }
    return
  }
  throw new Error('不支持恢复该删除记录。')
}

/** List current surface messages plus deleted records and durable queue. */
async function listMessages(ctx, agent) {
  const session = liveSession(ctx, agent)
  const events = await readSurfaceEvents(ctx, session)
  const tokensBySeq = buildTokensBySeq(ctx, session)
  const items = itemsFromSurface(events, tokensBySeq)
  const bySeq = new Map(session.snapshotEvents().map((event) => [event.seq, event]))
  const deleted = deletedFromSurface(events, bySeq)
  const pending = durableQueue(ctx, session)
  return { text: formatList(items, deleted, pending), items, deleted, pending }
}

/** Delete one or more messages now when safe, otherwise queue them durably. */
async function deleteMessages(ctx, agent, seqs, options = {}) {
  const unique = [...new Set(seqs)]
  if (unique.length === 0 || unique.some((seq) => !Number.isSafeInteger(seq) || seq < 0)) {
    throw new Error('序号必须是非负整数。')
  }
  const batchId = typeof options.batchId === 'string' && options.batchId.length > 0
    ? options.batchId
    : randomUUID()
  const opName = typeof options.op === 'string' && options.op.length > 0 ? options.op : 'delete'
  const session = liveSession(ctx, agent)
  const events = await readSurfaceEvents(ctx, session)
  const tokensBySeq = buildTokensBySeq(ctx, session)
  const targets = []
  for (const seq of unique) {
    const plan = planDeletion(events, seq)
    if (!plan.ok) {
      if (plan.reason === 'system') throw new Error('系统提示词不是可删除的对话消息。')
      if (plan.reason === 'tombstone') {
        throw new Error('该序号是一条删除记录（墓碑），不是消息；要回到上下文请用 /ctxmgr restore。')
      }
      if (plan.reason === 'not-found') {
        if (unique.length === 1) throw new Error('该消息已不在当前模型上下文中，可能已被删除；请刷新后重试。')
        continue
      }
      throw new Error('这条消息不支持单独删除。')
    }
    targets.push({ seq, plan })
  }
  if (targets.length === 0) throw new Error('选中的消息都已不在当前模型上下文中。')

  // Items are always priced (meter when available, else the local heuristic),
  // so the reported relief never collapses to 0 when the meter is absent.
  const tokensOfSeq = new Map(itemsFromSurface(events, tokensBySeq).map((item) => [item.seq, item.tokens ?? 0]))
  let estimatedFreedTokens = 0
  for (const target of targets) {
    for (const run of target.plan.runs) {
      for (const seq of run.seqs) estimatedFreedTokens += tokensOfSeq.get(seq) ?? 0
    }
  }

  const open = openStepOf(session)
  const touchesOpenStep = open !== undefined
    && targets.some((target) => target.plan.indices.some((index) => events[index].seq >= open.startSeq))
  if (open !== undefined && !touchesOpenStep) {
    let count = 0
    const tombstoneSeqs = []
    for (const target of targets) {
      // Re-plan against the live surface because an earlier target may have
      // already removed this target as part of the same tool group.
      const current = surfaceEventsSync(session)
      const plan = planDeletion(current, target.seq)
      if (!plan.ok) continue
      tombstoneSeqs.push(...appendTombstones(session, plan.runs, open.turn, open.step, batchId))
      count += plan.count
    }
    appendBatchLedger(session, {
      batchId,
      op: opName,
      seqs: targets.map((target) => target.seq),
      tombstoneSeqs,
      count,
      estimatedFreedTokens,
      result: 'applied',
    })
    return {
      text: `已从模型上下文删除 ${count} 条消息，估算释放约 ${estimatedFreedTokens.toLocaleString('en-US')} tokens（会话日志与聊天记录仍保留）。批次 ${batchId.slice(0, 8)}，可用 /ctxmgr undo-batch 撤销。`,
      count,
      estimatedFreedTokens,
      batchId,
      queued: false,
    }
  }

  const queuedTargets = new Set(durableQueue(ctx, session)
    .filter((entry) => entry.op === 'delete')
    .map((entry) => entry.targetSeq))
  let added = 0
  for (const target of targets) {
    if (queuedTargets.has(target.seq)) continue
    appendPending(session, 'delete', target.seq, batchId)
    queuedTargets.add(target.seq)
    added += 1
  }
  if (!ensureAgentListener(ctx, agent)) {
    throw new Error('当前会话没有可用的 Agent 请求作用域，无法排队删除；请重试。')
  }
  return {
    text: added === 0
      ? '选中的消息已在删除队列中，将在下一次请求开始时生效。'
      : `已加入删除队列：${added} 条消息将在下一次请求开始时从模型上下文移除，估算释放约 ${estimatedFreedTokens.toLocaleString('en-US')} tokens（会话日志与聊天记录仍保留）。批次 ${batchId.slice(0, 8)}，下一次请求生效后可用 /ctxmgr undo-batch 撤销。`,
    count: added,
    estimatedFreedTokens,
    batchId,
    queued: true,
  }
}

/** Token-budget cleanup: plan candidates then delete them via the normal pipeline. */
async function cleanMessages(ctx, agent, targetTokens, options) {
  const session = liveSession(ctx, agent)
  const events = await readSurfaceEvents(ctx, session)
  const tokensBySeq = buildTokensBySeq(ctx, session)
  const items = itemsFromSurface(events, tokensBySeq)
  const cleanPlan = planClean(items, targetTokens, options)
  if (cleanPlan.chosen.length === 0) {
    return {
      text: '没有可清理的消息（只有用户/上下文消息，或剩余消息都太小、太新被保护）。token 数为启发式估算，实际可能略少。',
      count: 0,
      estimatedFreedTokens: 0,
      queued: false,
    }
  }
  const result = await deleteMessages(ctx, agent, cleanPlan.chosen, { op: 'clean' })
  return {
    text: `clean：目标 ${targetTokens.toLocaleString('en-US')} tokens，实际估算释放约 ${result.estimatedFreedTokens.toLocaleString('en-US')} tokens（token 数为启发式估算）。${result.text}`,
    count: result.count,
    estimatedFreedTokens: result.estimatedFreedTokens,
    queued: result.queued,
  }
}

/** Queue one or more tombstones for restore at the next request. */
async function restoreMessages(ctx, agent, tombstoneSeqs, options = {}) {
  const batchId = typeof options.batchId === 'string' && options.batchId.length > 0
    ? options.batchId
    : undefined
  const unique = [...new Set(tombstoneSeqs)]
  if (unique.length === 0 || unique.some((seq) => !Number.isSafeInteger(seq) || seq < 0)) {
    throw new Error('删除记录序号必须是非负整数。')
  }
  const session = liveSession(ctx, agent)
  const bySeq = new Map(session.snapshotEvents().map((event) => [event.seq, event]))
  const accepted = []
  for (const seq of unique) {
    const tombstone = bySeq.get(seq)
    if (tombstone === undefined) {
      if (unique.length === 1) throw new Error('找不到该删除记录。')
      continue
    }
    if (!session.surface.nodes.includes(seq)) continue
    // Validate now so unsupported groups fail before queueing.
    planRestore(session, seq)
    accepted.push(seq)
  }
  if (accepted.length === 0) throw new Error('没有可恢复的删除记录（可能已经恢复）。')
  const queuedTargets = new Set(durableQueue(ctx, session)
    .filter((entry) => entry.op === 'restore')
    .map((entry) => entry.targetSeq))
  let added = 0
  for (const seq of accepted) {
    if (queuedTargets.has(seq)) continue
    appendPending(session, 'restore', seq, batchId)
    queuedTargets.add(seq)
    added += 1
  }
  if (!ensureAgentListener(ctx, agent)) {
    throw new Error('当前会话没有可用的 Agent 请求作用域，无法排队恢复；请重试。')
  }
  return {
    text: added === 0
      ? '选中的删除记录已在恢复队列中，将在下一次请求开始时恢复。'
      : `已加入恢复队列：${added} 条删除记录将在下一次请求开始时恢复到模型上下文。`,
    count: added,
    queued: true,
  }
}

/** List current conversation turns as text. */
async function listTurns(ctx, agent) {
  const session = liveSession(ctx, agent)
  const events = await readSurfaceEvents(ctx, session)
  const bySeq = new Map(session.snapshotEvents().map((event) => [event.seq, event]))
  const open = openStepOf(session)
  const tokensBySeq = buildTokensBySeq(ctx, session)
  const items = itemsFromSurface(events, tokensBySeq)
  const turns = addTurnTokens(
    turnsFromSurface(events, bySeq).map((turn) => ({
      ...turn,
      inProgress: open !== undefined && turn.seqs.some((seq) => seq >= open.startSeq),
    })),
    items,
  )
  return { text: formatTurns(turns), turns }
}

/** Delete whole conversation turns now when safe, otherwise queue them durably. */
async function deleteTurns(ctx, agent, turnNums, options = {}) {
  const unique = [...new Set(turnNums)]
  if (unique.length === 0 || unique.some((num) => !Number.isSafeInteger(num) || num < 0)) {
    throw new Error('轮号必须是非负整数（list-turns 查看）。')
  }
  const session = liveSession(ctx, agent)
  const events = await readSurfaceEvents(ctx, session)
  const bySeq = new Map(session.snapshotEvents().map((event) => [event.seq, event]))
  const open = openStepOf(session)
  const tokensBySeq = buildTokensBySeq(ctx, session)
  const batchId = typeof options.batchId === 'string' && options.batchId.length > 0
    ? options.batchId
    : randomUUID()
  const items = itemsFromSurface(events, tokensBySeq)
  // Attribute each item's tokens to its turn (same rule as turn grouping).
  const tokensByTurn = new Map()
  for (const item of items) {
    tokensByTurn.set(item.turn, (tokensByTurn.get(item.turn) ?? 0) + (item.tokens ?? 0))
  }
  const all = turnsFromSurface(events, bySeq).map((turn) => ({
    ...turn,
    tokens: tokensByTurn.get(turn.turn) ?? 0,
  }))
  const targets = []
  for (const num of unique) {
    const turn = all.find((entry) => entry.turn === num)
    if (turn === undefined) {
      if (unique.length === 1) throw new Error('该轮已不在当前上下文中（可能已删除）；list-turns 查看现有轮。')
      continue
    }
    targets.push(turn)
  }
  if (targets.length === 0) throw new Error('选中的轮都已不在当前上下文中。')

  const estimatedFreedTokens = targets.reduce((total, turn) => total + (turn.tokens ?? 0), 0)

  const touchesOpen = open !== undefined
    && targets.some((turn) => turn.seqs.some((seq) => seq >= open.startSeq))
  if (open !== undefined && !touchesOpen) {
    let turns = 0
    let messages = 0
    const tombstoneSeqs = []
    for (const turn of targets) {
      const done = deleteTurnNow(session, turn.turn, open.turn, open.step, batchId)
      if (done !== null) {
        turns += 1
        messages += done.count
        tombstoneSeqs.push(...done.tombstoneSeqs)
      }
    }
    appendBatchLedger(session, {
      batchId,
      op: 'delete-turn',
      seqs: targets.map((turn) => turn.turn),
      tombstoneSeqs,
      count: messages,
      estimatedFreedTokens,
      result: 'applied',
    })
    return {
      text: `已从模型上下文删除 ${turns} 轮对话（共 ${messages} 条消息，估算释放约 ${estimatedFreedTokens.toLocaleString('en-US')} tokens；会话日志与聊天记录仍保留）。批次 ${batchId.slice(0, 8)}，可用 /ctxmgr undo-batch 撤销。`,
      turns,
      messages,
      estimatedFreedTokens,
      batchId,
      queued: false,
    }
  }

  const queued = new Set(durableQueue(ctx, session)
    .filter((entry) => entry.op === 'delete-turn')
    .map((entry) => entry.targetSeq))
  let added = 0
  for (const turn of targets) {
    if (queued.has(turn.turn)) continue
    appendPending(session, 'delete-turn', turn.turn, batchId)
    queued.add(turn.turn)
    added += 1
  }
  if (!ensureAgentListener(ctx, agent)) {
    throw new Error('当前会话没有可用的 Agent 请求作用域，无法排队删除；请重试。')
  }
  return {
    text: added === 0
      ? '选中的轮已在删除队列中，将在下一次请求开始时生效。'
      : `已加入删除队列：${added} 轮对话将在下一次请求开始时从模型上下文移除，估算释放约 ${estimatedFreedTokens.toLocaleString('en-US')} tokens（会话日志与聊天记录仍保留）。`,
    turns: added,
    estimatedFreedTokens,
    batchId,
    queued: true,
  }
}

/**
 * Delete every remaining content node of one conversation turn, grouping the
 * nodes through the same planner used for single-message deletion so each
 * tombstone keeps its own restore semantics (user in place, assistant groups
 * and text at the tail). Tombstones already on the surface stay untouched.
 * @returns the number of messages removed, or null when none remain.
 */
function deleteTurnNow(session, turnNum, curTurn, curStep, batchId = undefined) {
  const bySeq = new Map(session.snapshotEvents().map((event) => [event.seq, event]))
  const turn = turnsFromSurface(surfaceEventsSync(session), bySeq)
    .find((entry) => entry.turn === turnNum)
  if (turn === undefined || turn.seqs.length === 0) return null
  const planned = new Set()
  const tombstoneSeqs = []
  let count = 0
  for (const seq of turn.seqs) {
    if (planned.has(seq)) continue
    // Re-plan against the live surface: an earlier group may already have
    // absorbed this target, and each append invalidates stale ranges.
    const current = surfaceEventsSync(session)
    const plan = planDeletion(current, seq)
    if (!plan.ok) continue
    tombstoneSeqs.push(...appendTombstones(session, plan.runs, curTurn, curStep, batchId))
    for (const index of plan.indices) planned.add(current[index].seq)
    count += plan.count
  }
  return { count, tombstoneSeqs }
}

/** Per-plugin-instance agent listener registries, keyed by plugin ctx. */
const listenerRegistries = new WeakMap()

/** The listener registry owned by one plugin ctx. */
function listenerRegistry(ctx) {
  let registry = listenerRegistries.get(ctx)
  if (registry === undefined) {
    registry = new Map()
    listenerRegistries.set(ctx, registry)
  }
  return registry
}

/**
 * Replay every durable pending delete/restore for one Agent's Session inside
 * the request's open step, then acknowledge each record so it never replays
 * again. Replayed operations whose target already vanished are acked as
 * skipped; genuine failures are acked with the reason.
 */
function applyQueuedOperations(ctx, agent, turn, step) {
  const session = ctx.sessions.get(agent.id)
  if (session === undefined) return
  const queue = durableQueue(ctx, session)
  if (queue.length === 0) return
  // Price the current surface once, so a replayed entry records the relief it
  // actually produced instead of a zero placeholder.
  const pricedItems = itemsFromSurface(surfaceEventsSync(session), buildTokensBySeq(ctx, session))
  const tokensOfSeq = new Map(pricedItems.map((item) => [item.seq, item.tokens ?? 0]))
  const tokensByTurn = new Map()
  for (const item of pricedItems) {
    tokensByTurn.set(item.turn, (tokensByTurn.get(item.turn) ?? 0) + (item.tokens ?? 0))
  }
  const freedOfPlan = (plan) => plan.runs.reduce((sum, run) => sum
    + run.seqs.reduce((inner, seq) => inner + (tokensOfSeq.get(seq) ?? 0), 0), 0)
  for (const entry of queue) {
    try {
      if (entry.op === 'delete') {
        const plan = planDeletion(surfaceEventsSync(session), entry.targetSeq)
        if (!plan.ok) {
          appendAck(session, entry.recordSeq, 'skipped', `target #${entry.targetSeq} ${plan.reason}`)
          appendBatchLedger(session, {
            batchId: entry.batchId ?? `pending-${entry.recordSeq}`,
            op: 'delete',
            seqs: [entry.targetSeq],
            tombstoneSeqs: [],
            estimatedFreedTokens: 0,
            result: 'skipped',
            reason: `target #${entry.targetSeq} ${plan.reason}`,
          })
          continue
        }
        const tombstoneSeqs = appendTombstones(session, plan.runs, turn, step, entry.batchId)
        appendAck(session, entry.recordSeq, 'applied')
        appendBatchLedger(session, {
          batchId: entry.batchId ?? `pending-${entry.recordSeq}`,
          op: 'delete',
          seqs: [entry.targetSeq],
          tombstoneSeqs,
          count: plan.count,
          estimatedFreedTokens: freedOfPlan(plan),
          result: 'applied',
        })
      } else if (entry.op === 'delete-turn') {
        const done = deleteTurnNow(session, entry.targetSeq, turn, step, entry.batchId)
        if (done === null) {
          appendAck(session, entry.recordSeq, 'skipped', `turn #${entry.targetSeq} has no remaining content`)
          appendBatchLedger(session, {
            batchId: entry.batchId ?? `pending-${entry.recordSeq}`,
            op: 'delete-turn',
            seqs: [entry.targetSeq],
            tombstoneSeqs: [],
            estimatedFreedTokens: 0,
            result: 'skipped',
            reason: `turn #${entry.targetSeq} has no remaining content`,
          })
        } else {
          appendAck(session, entry.recordSeq, 'applied')
          appendBatchLedger(session, {
            batchId: entry.batchId ?? `pending-${entry.recordSeq}`,
            op: 'delete-turn',
            seqs: [entry.targetSeq],
            tombstoneSeqs: done.tombstoneSeqs,
            count: done.count,
            estimatedFreedTokens: tokensByTurn.get(entry.targetSeq) ?? 0,
            result: 'applied',
          })
        }
      } else {
        restoreOne(session, entry.targetSeq, turn, step)
        appendAck(session, entry.recordSeq, 'applied')
        // Close the undo ledger entry once the restore actually landed, so the
        // audit trail does not stay stuck at "queued".
        if (typeof entry.batchId === 'string') {
          appendBatchLedger(session, {
            batchId: entry.batchId,
            op: 'undo',
            seqs: [entry.targetSeq],
            tombstoneSeqs: [],
            count: 1,
            estimatedFreedTokens: 0,
            result: 'applied',
          })
        }
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      const result = IDEMPOTENT_MARKERS.some((marker) => message.includes(marker)) ? 'skipped' : 'failed'
      appendAck(session, entry.recordSeq, result, message)
      if (result === 'failed') {
        ctx.logger?.warn?.(`context-manager: queued ${entry.op} ${entry.targetSeq} failed: ${message}`)
      }
    }
  }
  // Refresh the incremental cache with the acks just appended.
  durableQueue(ctx, session)
}

/**
 * Register one Agent-scoped `agent/request` listener for queued operations.
 * The request hook runs after `step/start` and before request derivation.
 * @returns whether the listener is available.
 */
function ensureAgentListener(ctx, agent) {
  if (agent === undefined || agent === null || typeof agent.id !== 'string') return false
  const agentListeners = listenerRegistry(ctx)
  const id = agent.id
  if (agentListeners.has(id)) return true
  const liveAgent = ctx.agents.get(id) ?? agent
  const owner = liveAgent.ctx ?? agent.ctx
  if (owner === undefined || owner === null || typeof owner.on !== 'function') return false
  const stop = owner.on('agent/request', (payload, next) => {
    if (payload === undefined || payload.agent === undefined || payload.agent.id !== id) return next()
    applyQueuedOperations(ctx, liveAgent, payload.turn, payload.step)
    return next()
  })
  const disposeOwnerEffect = typeof owner.effect === 'function'
    ? owner.effect(() => () => {
      stop()
      agentListeners.delete(id)
    }, 'context-manager: queued operations')
    : () => {
      stop()
      agentListeners.delete(id)
    }
  agentListeners.set(id, { stop, disposeOwnerEffect })
  return true
}

/** Parse `/ctxmgr` input into an operation. */
function parseCommand(rawInput) {
  const text = typeof rawInput === 'string' ? rawInput.trim() : ''
  if (text.length === 0) return { op: 'list' }
  const parts = text.split(/\s+/)
  const head = parts[0].toLowerCase()
  if (head === 'list' || head === 'ls') return { op: 'list' }
  if (head === 'turns' || head === 'list-turns' || head === 'ls-turns') return { op: 'list-turns' }
  if (head === 'clean') {
    const rest = text.slice(head.length).trim()
    if (rest.length === 0) return { op: 'invalid', reason: '缺少要释放的 token 预算。' }
    if (!/^\d+$/.test(rest)) return { op: 'invalid', reason: '目标 token 数必须是正整数。' }
    return { op: 'clean', targetTokens: Number(rest) }
  }
  if (head === 'compact') {
    const rest = text.slice(head.length).trim()
    const values = rest.length === 0 ? [] : rest.split(/[,\s]+/).filter(Boolean)
    if (values.length !== 2) return { op: 'invalid', reason: 'compact 需要两个序号：起始与结束（按表面位置）。' }
    if (values.some((value) => !/^\d+$/.test(value))) return { op: 'invalid', reason: 'compact 的两个序号必须是数字。' }
    return { op: 'compact', start: Number(values[0]), end: Number(values[1]) }
  }
  if (head === 'batches' || head === 'ledger' || head === 'audit') return { op: 'batches' }
  if (head === 'undo-batch' || head === 'undobatch' || head === 'undo-last' || head === 'undolast') {
    const rest = text.slice(head.length).trim()
    return rest.length === 0 ? { op: 'undo-batch' } : { op: 'undo-batch', batchId: rest }
  }
  const deleteTurn = head === 'deleteturn' || head === 'delturn' || head === 'dt'
  if (head === 'delete' || head === 'rm' || head === 'restore' || head === 'undo' || deleteTurn) {
    const rest = text.slice(head.length).trim()
    const values = rest.length === 0 ? [] : rest.split(/[,\s]+/).filter(Boolean)
    if (values.length === 0) return { op: 'invalid', reason: deleteTurn ? '缺少要删除的轮号。' : '缺少要处理的序号。' }
    if (values.some((value) => !/^\d+$/.test(value))) return { op: 'invalid', reason: '轮号/序号必须是数字，多个用逗号分隔。' }
    return {
      op: deleteTurn ? 'delete-turns' : head === 'restore' || head === 'undo' ? 'restore' : 'delete',
      seqs: values.map(Number),
    }
  }
  return { op: 'invalid', reason: `未知子命令 “${parts[0]}”。` }
}

export function apply(ctx) {
  for (const liveAgent of ctx.agents.list()) ensureAgentListener(ctx, liveAgent)
  const stopCreated = ctx.on('agent/created', (payload) => {
    if (payload !== undefined) ensureAgentListener(ctx, payload.agent)
  })

  const command = ctx.commands.register({
    name: 'ctxmgr',
    description: '列出、批量删除或恢复当前会话中的单条消息，并按轮删除整轮对话，支持按 token 预算自动清理（仅移出/恢复模型上下文，保留原始日志）。',
    input: { hint: 'list | turns | delete <序号,...> | deleteturn <轮号,...> | clean <目标tokens> | compact <起序号> <止序号> | batches | undo-batch [batchId] | restore <删除记录序号,...>' },
    recordInput: false,
    async handler(invocation) {
      try {
        const parsed = parseCommand(invocation.rawInput)
        if (parsed.op === 'list') {
          const result = await listMessages(ctx, invocation.agent)
          return { kind: 'success', text: result.text }
        }
        if (parsed.op === 'list-turns') {
          const result = await listTurns(ctx, invocation.agent)
          return { kind: 'success', text: result.text }
        }
        if (parsed.op === 'delete') {
          const result = await deleteMessages(ctx, invocation.agent, parsed.seqs)
          return { kind: 'success', text: result.text }
        }
        if (parsed.op === 'delete-turns') {
          const result = await deleteTurns(ctx, invocation.agent, parsed.seqs)
          return { kind: 'success', text: result.text }
        }
        if (parsed.op === 'clean') {
          const result = await cleanMessages(ctx, invocation.agent, parsed.targetTokens, {})
          return { kind: 'success', text: result.text }
        }
        if (parsed.op === 'compact') {
          const result = await compactSelection(ctx, invocation.agent, parsed.start, parsed.end)
          return { kind: 'success', text: result.text }
        }
        if (parsed.op === 'batches') {
          const result = await listBatches(ctx, invocation.agent)
          return { kind: 'success', text: result.text }
        }
        if (parsed.op === 'undo-batch') {
          const result = await undoBatch(ctx, invocation.agent, parsed.batchId)
          return { kind: 'success', text: result.text }
        }
        if (parsed.op === 'restore') {
          const result = await restoreMessages(ctx, invocation.agent, parsed.seqs)
          return { kind: 'success', text: result.text }
        }
        return { kind: 'error', text: `${parsed.reason} 用法：/ctxmgr list | /ctxmgr turns | /ctxmgr delete <序号,...> | /ctxmgr deleteturn <轮号,...> | /ctxmgr clean <目标tokens> | /ctxmgr compact <起序号> <止序号> | /ctxmgr batches | /ctxmgr undo-batch [batchId] | /ctxmgr restore <删除记录序号,...>` }
      } catch (error) {
        return { kind: 'error', text: error instanceof Error ? error.message : String(error) }
      }
    },
  })

  const tool = ctx.tools.register({
    name: 'context_manager',
    description: 'Manage the model context of the current session. Actions: list (current messages with estimated tokens plus deleted records and queued operations), list-turns (conversation turns with turn numbers), delete (message seqs; any tool results tied to an assistant message that calls tools go with it), delete-turns (whole turns: the user prompt, the assistant work and reply, and that turn\'s injected context), compact (summarize exactly one user-selected surface span via the official ctx.compaction.compactRegion; only the named range, never a global threshold), clean (token-budget cleanup: automatically picks large tool/assistant messages ranked by estimated tokens descending, until target tokens are freed; user messages and the most recent messages are protected, and the planner reuses the same delete pipeline), restore (tombstone seqs from list; user/context restores at its original position, assistant content is appended at the tail). Typical uses: roll back to the start of a turn by deleting that turn and the ones after it, or drop noisy messages that no longer matter. All token figures are estimates from a 4-chars-per-token heuristic and can notably underprice CJK text and JSON. Deletion only affects later model requests; the raw session log and chat transcript are retained. Operations that cannot run safely yet are recorded durably in the session log and applied when the next step starts, surviving restarts. Use only when the user explicitly asks. Requires a live session.',
    parameters: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['list', 'list-turns', 'delete', 'delete-turns', 'clean', 'compact', 'batches', 'undo-batch', 'restore'],
          description: 'list messages, list conversation turns, delete message seqs, delete whole turns by turn number, clean by token budget, list the batch audit ledger, undo a batch, or restore tombstone seqs.',
        },
        seq: {
          type: 'integer',
          description: 'One message seq for delete (legacy single-target form).',
        },
        seqs: {
          type: 'array',
          items: { type: 'integer' },
          description: 'Message seqs for delete, turn numbers for delete-turns, or tombstone seqs for restore (from list/turns output).',
        },
        targetTokens: {
          type: 'integer',
          description: 'For clean: the token budget (target number of tokens to free).',
        },
        minCandidateTokens: {
          type: 'integer',
          description: 'For clean: optional minimum estimated tokens for a message to be considered a candidate (default 100).',
        },
        protectRecent: {
          type: 'integer',
          description: 'For clean: optional number of most recent messages to protect (default 3).',
        },
        batchId: {
          type: 'string',
          description: 'For undo-batch: optional batch id (or unambiguous prefix) from the ledger; omit to undo the most recent applied batch.',
        },
        start: {
          type: 'integer',
          description: 'For compact: first surface seq of the span to compact (inclusive, from list).',
        },
        end: {
          type: 'integer',
          description: 'For compact: last surface seq of the span to compact (inclusive, from list); both edges must be tool-pairing balanced.',
        },
      },
      required: ['action'],
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          ok: { type: 'boolean', description: 'Whether the operation succeeded.' },
          text: { type: 'string', description: 'Human-readable result or message list.' },
        },
        required: ['ok', 'text'],
        additionalProperties: false,
      },
      render(_args, value) {
        return [{ type: 'text', text: typeof value?.text === 'string' ? value.text : '' }]
      },
    },
    async execute(args, exec) {
      const action = args?.action
      const list = Array.isArray(args?.seqs)
        ? args.seqs
        : Number.isSafeInteger(args?.seq) ? [args.seq] : []
      if (action === 'list') {
        const result = await listMessages(ctx, exec.agent)
        return { ok: true, text: result.text }
      }
      if (action === 'list-turns') {
        const result = await listTurns(ctx, exec.agent)
        return { ok: true, text: result.text }
      }
      if (action === 'delete') {
        if (list.length === 0) throw new Error('delete 需要 list 返回的整数 seq 或 seqs。')
        const result = await deleteMessages(ctx, exec.agent, list)
        return { ok: true, text: result.text }
      }
      if (action === 'delete-turns') {
        if (list.length === 0) throw new Error('delete-turns 需要 list-turns 返回的整数轮号。')
        const result = await deleteTurns(ctx, exec.agent, list)
        return { ok: true, text: result.text }
      }
      if (action === 'clean') {
        if (!Number.isSafeInteger(args?.targetTokens) || args.targetTokens <= 0) {
          throw new Error('clean 需要正整数 targetTokens（要释放的 token 预算）。')
        }
        const result = await cleanMessages(ctx, exec.agent, args.targetTokens, {
          minCandidateTokens: args?.minCandidateTokens,
          protectRecent: args?.protectRecent,
        })
        return { ok: true, text: result.text }
      }
      if (action === 'compact') {
        if (!Number.isSafeInteger(args?.start) || !Number.isSafeInteger(args?.end)) {
          throw new Error('compact 需要整数 start 与 end（list 返回的表面序号）。')
        }
        const result = await compactSelection(ctx, exec.agent, args.start, args.end)
        return { ok: true, text: result.text }
      }
      if (action === 'batches') {
        const result = await listBatches(ctx, exec.agent)
        return { ok: true, text: result.text }
      }
      if (action === 'undo-batch') {
        const result = await undoBatch(ctx, exec.agent,
          typeof args?.batchId === 'string' ? args.batchId : undefined)
        return { ok: true, text: result.text }
      }
      if (action === 'restore') {
        if (list.length === 0) throw new Error('restore 需要已删除记录返回的整数 tombstone seq。')
        const result = await restoreMessages(ctx, exec.agent, list)
        return { ok: true, text: result.text }
      }
      throw new Error('action 必须是 list、list-turns、delete、delete-turns、clean、compact、batches、undo-batch 或 restore。')
    },
  })

  ctx.effect(() => () => {
    tool()
    command()
    stopCreated()
    const agentListeners = listenerRegistry(ctx)
    for (const entry of [...agentListeners.values()]) {
      entry.stop()
      entry.disposeOwnerEffect()
    }
    agentListeners.clear()
  }, 'context-manager: command, tool, and queued operations')
}
