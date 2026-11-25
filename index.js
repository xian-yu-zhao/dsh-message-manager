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
  deletedFromSurface,
  foldSurface,
  formatList,
  formatTurns,
  hasToolChange,
  isTombstoneKind,
  itemsFromSurface,
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
function appendTombstones(session, runs, turn, step) {
  const tombstoneSeqs = []
  try {
    for (const run of runs) {
      const event = session.append(
        'developer/message',
        tombstoneData(turn, step, randomUUID()),
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
      if ((op === 'delete' || op === 'restore' || op === 'delete-turn') && Number.isSafeInteger(targetSeq)) {
        state.pending.set(record.seq, { recordSeq: record.seq, op, targetSeq })
      }
    }
  }
  if (events.length > 0) state.checkedTo = events[events.length - 1].seq
  cache.set(session.id, state)
  return [...state.pending.values()]
}

/** Durably enqueue one operation; plugin records need no open turn/step. */
function appendPending(session, op, targetSeq) {
  return appendPluginRecord(session, PENDING_TYPE, { op, targetSeq })
}

/** Acknowledge one pending record so restarts and replays leave it alone. */
function appendAck(session, pendingSeq, result, detail) {
  appendPluginRecord(session, ACK_TYPE, {
    pendingSeq,
    result,
    ...typeof detail === 'string' && detail.length > 0 ? { detail: detail.slice(0, 300) } : {},
  })
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
  const items = itemsFromSurface(events)
  const bySeq = new Map(session.snapshotEvents().map((event) => [event.seq, event]))
  const deleted = deletedFromSurface(events, bySeq)
  const pending = durableQueue(ctx, session)
  return { text: formatList(items, deleted, pending), items, deleted, pending }
}

/** Delete one or more messages now when safe, otherwise queue them durably. */
async function deleteMessages(ctx, agent, seqs) {
  const unique = [...new Set(seqs)]
  if (unique.length === 0 || unique.some((seq) => !Number.isSafeInteger(seq) || seq < 0)) {
    throw new Error('序号必须是非负整数。')
  }
  const session = liveSession(ctx, agent)
  const events = await readSurfaceEvents(ctx, session)
  const targets = []
  for (const seq of unique) {
    const plan = planDeletion(events, seq)
    if (!plan.ok) {
      if (plan.reason === 'system') throw new Error('系统提示词不是可删除的对话消息。')
      if (plan.reason === 'not-found') {
        if (unique.length === 1) throw new Error('该消息已不在当前模型上下文中，可能已被删除；请刷新后重试。')
        continue
      }
      throw new Error('这条消息不支持单独删除。')
    }
    targets.push({ seq, plan })
  }
  if (targets.length === 0) throw new Error('选中的消息都已不在当前模型上下文中。')

  const open = openStepOf(session)
  const touchesOpenStep = open !== undefined
    && targets.some((target) => target.plan.indices.some((index) => events[index].seq >= open.startSeq))
  if (open !== undefined && !touchesOpenStep) {
    let count = 0
    for (const target of targets) {
      // Re-plan against the live surface because an earlier target may have
      // already removed this target as part of the same tool group.
      const current = surfaceEventsSync(session)
      const plan = planDeletion(current, target.seq)
      if (!plan.ok) continue
      appendTombstones(session, plan.runs, open.turn, open.step)
      count += plan.count
    }
    return {
      text: `已从模型上下文删除 ${count} 条消息（会话日志与聊天记录仍保留）。`,
      count,
      queued: false,
    }
  }

  const queuedTargets = new Set(durableQueue(ctx, session)
    .filter((entry) => entry.op === 'delete')
    .map((entry) => entry.targetSeq))
  let added = 0
  for (const target of targets) {
    if (queuedTargets.has(target.seq)) continue
    appendPending(session, 'delete', target.seq)
    queuedTargets.add(target.seq)
    added += 1
  }
  if (!ensureAgentListener(ctx, agent)) {
    throw new Error('当前会话没有可用的 Agent 请求作用域，无法排队删除；请重试。')
  }
  return {
    text: added === 0
      ? '选中的消息已在删除队列中，将在下一回合开始时生效。'
      : `已加入删除队列：${added} 条消息将在下一回合开始时从模型上下文移除（会话日志与聊天记录仍保留）。`,
    count: added,
    queued: true,
  }
}

/** Queue one or more tombstones for restore at the next request. */
async function restoreMessages(ctx, agent, tombstoneSeqs) {
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
    appendPending(session, 'restore', seq)
    queuedTargets.add(seq)
    added += 1
  }
  if (!ensureAgentListener(ctx, agent)) {
    throw new Error('当前会话没有可用的 Agent 请求作用域，无法排队恢复；请重试。')
  }
  return {
    text: added === 0
      ? '选中的删除记录已在恢复队列中，将在下一回合开始时恢复。'
      : `已加入恢复队列：${added} 条删除记录将在下一回合开始时恢复到模型上下文。`,
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
  const turns = turnsFromSurface(events, bySeq).map((turn) => ({
    ...turn,
    inProgress: open !== undefined && turn.seqs.some((seq) => seq >= open.startSeq),
  }))
  return { text: formatTurns(turns), turns }
}

/** Delete whole conversation turns now when safe, otherwise queue them durably. */
async function deleteTurns(ctx, agent, turnNums) {
  const unique = [...new Set(turnNums)]
  if (unique.length === 0 || unique.some((num) => !Number.isSafeInteger(num) || num < 0)) {
    throw new Error('轮号必须是非负整数（list-turns 查看）。')
  }
  const session = liveSession(ctx, agent)
  const events = await readSurfaceEvents(ctx, session)
  const bySeq = new Map(session.snapshotEvents().map((event) => [event.seq, event]))
  const open = openStepOf(session)
  const all = turnsFromSurface(events, bySeq)
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

  const touchesOpen = open !== undefined
    && targets.some((turn) => turn.seqs.some((seq) => seq >= open.startSeq))
  if (open !== undefined && !touchesOpen) {
    let turns = 0
    let messages = 0
    for (const turn of targets) {
      const done = deleteTurnNow(session, turn.turn, open.turn, open.step)
      if (done !== null) {
        turns += 1
        messages += done
      }
    }
    return {
      text: `已从模型上下文删除 ${turns} 轮对话（共 ${messages} 条消息；会话日志与聊天记录仍保留）。`,
      turns,
      messages,
      queued: false,
    }
  }

  const queued = new Set(durableQueue(ctx, session)
    .filter((entry) => entry.op === 'delete-turn')
    .map((entry) => entry.targetSeq))
  let added = 0
  for (const turn of targets) {
    if (queued.has(turn.turn)) continue
    appendPending(session, 'delete-turn', turn.turn)
    queued.add(turn.turn)
    added += 1
  }
  if (!ensureAgentListener(ctx, agent)) {
    throw new Error('当前会话没有可用的 Agent 请求作用域，无法排队删除；请重试。')
  }
  return {
    text: added === 0
      ? '选中的轮已在删除队列中，将在下一回合开始时生效。'
      : `已加入删除队列：${added} 轮对话将在下一回合开始时从模型上下文移除（会话日志与聊天记录仍保留）。`,
    turns: added,
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
function deleteTurnNow(session, turnNum, curTurn, curStep) {
  const bySeq = new Map(session.snapshotEvents().map((event) => [event.seq, event]))
  const turn = turnsFromSurface(surfaceEventsSync(session), bySeq)
    .find((entry) => entry.turn === turnNum)
  if (turn === undefined || turn.seqs.length === 0) return null
  const planned = new Set()
  let count = 0
  for (const seq of turn.seqs) {
    if (planned.has(seq)) continue
    // Re-plan against the live surface: an earlier group may already have
    // absorbed this target, and each append invalidates stale ranges.
    const current = surfaceEventsSync(session)
    const plan = planDeletion(current, seq)
    if (!plan.ok) continue
    appendTombstones(session, plan.runs, curTurn, curStep)
    for (const index of plan.indices) planned.add(current[index].seq)
    count += plan.count
  }
  return count
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
  for (const entry of queue) {
    try {
      if (entry.op === 'delete') {
        const plan = planDeletion(surfaceEventsSync(session), entry.targetSeq)
        if (!plan.ok) {
          appendAck(session, entry.recordSeq, 'skipped', `target #${entry.targetSeq} ${plan.reason}`)
          continue
        }
        appendTombstones(session, plan.runs, turn, step)
        appendAck(session, entry.recordSeq, 'applied')
      } else if (entry.op === 'delete-turn') {
        const done = deleteTurnNow(session, entry.targetSeq, turn, step)
        if (done === null) {
          appendAck(session, entry.recordSeq, 'skipped', `turn #${entry.targetSeq} has no remaining content`)
        } else {
          appendAck(session, entry.recordSeq, 'applied')
        }
      } else {
        restoreOne(session, entry.targetSeq, turn, step)
        appendAck(session, entry.recordSeq, 'applied')
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
    description: '列出、批量删除或恢复当前会话中的单条消息，并按轮删除整轮对话（仅移出/恢复模型上下文，保留原始日志）。',
    input: { hint: 'list | turns | delete <序号,...> | deleteturn <轮号,...> | restore <删除记录序号,...>' },
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
        if (parsed.op === 'restore') {
          const result = await restoreMessages(ctx, invocation.agent, parsed.seqs)
          return { kind: 'success', text: result.text }
        }
        return { kind: 'error', text: `${parsed.reason} 用法：/ctxmgr list | /ctxmgr turns | /ctxmgr delete <序号,...> | /ctxmgr deleteturn <轮号,...> | /ctxmgr restore <删除记录序号,...>` }
      } catch (error) {
        return { kind: 'error', text: error instanceof Error ? error.message : String(error) }
      }
    },
  })

  const tool = ctx.tools.register({
    name: 'context_manager',
    description: 'Manage the model context of the current session. Actions: list (current messages plus deleted records and queued operations), list-turns (conversation turns with turn numbers), delete (message seqs; any tool results tied to an assistant message that calls tools go with it), delete-turns (whole turns: the user prompt, the assistant work and reply, and that turn\'s injected context), restore (tombstone seqs from list; user/context restores at its original position, assistant content is appended at the tail). Typical uses: roll back to the start of a turn by deleting that turn and the ones after it, or drop noisy messages that no longer matter. Deletion only affects later model requests; the raw session log and chat transcript are retained. Operations that cannot run safely yet are recorded durably in the session log and applied when the next step starts, surviving restarts. Use only when the user explicitly asks. Requires a live session.',
    parameters: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['list', 'list-turns', 'delete', 'delete-turns', 'restore'],
          description: 'list messages, list conversation turns, delete message seqs, delete whole turns by turn number, or restore tombstone seqs.',
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
      if (action === 'restore') {
        if (list.length === 0) throw new Error('restore 需要已删除记录返回的整数 tombstone seq。')
        const result = await restoreMessages(ctx, exec.agent, list)
        return { ok: true, text: result.text }
      }
      throw new Error('action 必须是 list、list-turns、delete、delete-turns 或 restore。')
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
