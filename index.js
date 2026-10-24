/**
 * Host half of the Session Message Manager.
 *
 * A surface replacement whose replacement event derives no model message is the
 * supported way to remove one conversation entry from later model requests: the
 * append-only Session log, its Chat transcript, and every audit surface keep the
 * original record.
 *
 * Session format validation requires every `developer/message` to match an open
 * turn and step, and a Session cannot append from inside its own `session/event`
 * dispatch. A deletion or restore that cannot run safely right now is queued on
 * the owning Agent's `agent/request` waterfall: that hook runs after
 * `step/start` (so the step is open and appending is allowed) and before the
 * request messages are derived, so the next request already reflects it.
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
import {
  foldSurface,
  formatList,
  itemsFromSurface,
  planDeletion,
  tombstoneData,
} from './core.js'

export const name = 'message-manager'

export const inject = ['sessions', 'agents', 'commands', 'tools']

const TOMBSTONE_SOURCE = 'message-manager'
const RESTORED_PREFIX = 'restored-assistant-'

/** Resolve the live Session behind one command/tool agent. */
function liveSession(ctx, agent) {
  if (agent === undefined || agent === null || typeof agent.id !== 'string') {
    throw new Error('消息管理需要一个会话作用域。')
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
 * @returns the open coordinates plus the opening step seq, or undefined.
 */
function openStepOf(session) {
  let turn = null
  let step = null
  let startSeq
  for (const event of session.snapshotEvents()) {
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

/** Whether one event is an empty message-manager tombstone. */
function isTombstone(event) {
  return event !== undefined
    && event !== null
    && event.type === 'developer/message'
    && Array.isArray(event.data?.message?.content)
    && event.data.message.content.length === 0
    && event.data?.message?.source?.kind === TOMBSTONE_SOURCE
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

/** Whether one developer message carries a tool-addition/removal block. */
function hasToolChange(event) {
  const content = event?.data?.message?.content
  return Array.isArray(content)
    && content.some((block) => block?.type === 'tool-addition' || block?.type === 'tool-removal')
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

/** List current surface messages as text. */
async function listMessages(ctx, agent) {
  const session = liveSession(ctx, agent)
  const events = await readSurfaceEvents(ctx, session)
  const items = itemsFromSurface(events)
  return { text: formatList(items), items }
}

/** Delete one or more messages now when safe, otherwise queue them. */
async function deleteMessages(ctx, agent, seqs, runtime) {
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

  const queue = runtime.pendingBySession.get(session.id) ?? []
  let added = 0
  for (const target of targets) {
    if (queue.some((entry) => entry.kind === 'delete' && entry.targetSeq === target.seq)) continue
    queue.push({ kind: 'delete', targetSeq: target.seq })
    added += 1
  }
  runtime.pendingBySession.set(session.id, queue)
  if (!runtime.ensureAgentListener(agent)) {
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
async function restoreMessages(ctx, agent, tombstoneSeqs, runtime) {
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
  const queue = runtime.pendingBySession.get(session.id) ?? []
  let added = 0
  for (const seq of accepted) {
    if (queue.some((entry) => entry.kind === 'restore' && entry.targetSeq === seq)) continue
    queue.push({ kind: 'restore', targetSeq: seq })
    added += 1
  }
  runtime.pendingBySession.set(session.id, queue)
  if (!runtime.ensureAgentListener(agent)) {
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

/** Parse `/msgmgr` input into an operation. */
function parseCommand(rawInput) {
  const text = typeof rawInput === 'string' ? rawInput.trim() : ''
  if (text.length === 0) return { op: 'list' }
  const parts = text.split(/\s+/)
  const head = parts[0].toLowerCase()
  if (head === 'list' || head === 'ls') return { op: 'list' }
  if (head === 'delete' || head === 'rm' || head === 'restore' || head === 'undo') {
    const rest = text.slice(head.length).trim()
    const values = rest.length === 0 ? [] : rest.split(/[,\s]+/).filter(Boolean)
    if (values.length === 0) return { op: 'invalid', reason: '缺少要处理的序号。' }
    if (values.some((value) => !/^\d+$/.test(value))) return { op: 'invalid', reason: '序号必须是数字，多个用逗号分隔。' }
    return { op: head === 'restore' || head === 'undo' ? 'restore' : 'delete', seqs: values.map(Number) }
  }
  return { op: 'invalid', reason: `未知子命令 “${parts[0]}”。` }
}

export function apply(ctx) {
  const pendingBySession = new Map()
  const agentListeners = new Map()

  /** Apply every queued delete/restore for this Session inside the request's step. */
  function applyQueuedOperations(agent, turn, step) {
    const session = ctx.sessions.get(agent.id)
    if (session === undefined) {
      pendingBySession.delete(agent.id)
      return
    }
    const queue = pendingBySession.get(session.id)
    if (queue === undefined || queue.length === 0) return
    pendingBySession.delete(session.id)
    for (const entry of queue) {
      try {
        if (entry.kind === 'delete') {
          const plan = planDeletion(surfaceEventsSync(session), entry.targetSeq)
          if (!plan.ok) {
            ctx.logger?.warn?.(`message-manager: queued deletion target ${entry.targetSeq} is no longer on the surface; skipped`)
            continue
          }
          appendTombstones(session, plan.runs, turn, step)
        } else {
          restoreOne(session, entry.targetSeq, turn, step)
        }
      } catch (error) {
        ctx.logger?.warn?.(`message-manager: queued ${entry.kind} ${entry.targetSeq} failed: ${String(error)}`)
      }
    }
  }

  /**
   * Register one Agent-scoped `agent/request` listener for queued operations.
   * The request hook runs after `step/start` and before request derivation.
   * @returns whether the listener is available.
   */
  function ensureAgentListener(agent) {
    if (agent === undefined || agent === null || typeof agent.id !== 'string') return false
    const id = agent.id
    if (agentListeners.has(id)) return true
    const liveAgent = ctx.agents.get(id) ?? agent
    const owner = liveAgent.ctx ?? agent.ctx
    if (owner === undefined || owner === null || typeof owner.on !== 'function') return false
    const stop = owner.on('agent/request', (payload, next) => {
      if (payload === undefined || payload.agent === undefined || payload.agent.id !== id) return next()
      const queue = pendingBySession.get(id)
      if (queue !== undefined && queue.length > 0) applyQueuedOperations(liveAgent, payload.turn, payload.step)
      return next()
    })
    const disposeOwnerEffect = typeof owner.effect === 'function'
      ? owner.effect(() => () => {
        stop()
        pendingBySession.delete(id)
        agentListeners.delete(id)
      }, 'message-manager: queued operations')
      : () => {
        stop()
        pendingBySession.delete(id)
        agentListeners.delete(id)
      }
    agentListeners.set(id, { stop, disposeOwnerEffect })
    return true
  }

  for (const liveAgent of ctx.agents.list()) ensureAgentListener(liveAgent)
  const stopCreated = ctx.on('agent/created', (payload) => {
    if (payload !== undefined) ensureAgentListener(payload.agent)
  })

  const runtime = { pendingBySession, ensureAgentListener }

  const command = ctx.commands.register({
    name: 'msgmgr',
    description: '列出、批量删除或恢复当前会话中的单条消息（仅移出/恢复模型上下文，保留原始日志）。',
    input: { hint: 'list | delete <序号,...> | restore <删除记录序号,...>' },
    recordInput: false,
    async handler(invocation) {
      try {
        const parsed = parseCommand(invocation.rawInput)
        if (parsed.op === 'list') {
          const result = await listMessages(ctx, invocation.agent)
          return { kind: 'success', text: result.text }
        }
        if (parsed.op === 'delete') {
          const result = await deleteMessages(ctx, invocation.agent, parsed.seqs, runtime)
          return { kind: 'success', text: result.text }
        }
        if (parsed.op === 'restore') {
          const result = await restoreMessages(ctx, invocation.agent, parsed.seqs, runtime)
          return { kind: 'success', text: result.text }
        }
        return { kind: 'error', text: `${parsed.reason} 用法：/msgmgr list | /msgmgr delete <序号,...> | /msgmgr restore <删除记录序号,...>` }
      } catch (error) {
        return { kind: 'error', text: error instanceof Error ? error.message : String(error) }
      }
    },
  })

  const tool = ctx.tools.register({
    name: 'message_manager',
    description: 'List, delete, or restore messages in the current session. Delete removes the selected messages, and any tool results tied to an assistant message that calls tools, from the model context of later requests; the raw session log and the chat transcript are retained. Restore re-introduces a previously deleted message or tool group (user/context restores at its original position; assistant content is appended at the tail). Operations that cannot run safely yet are queued and applied when the next step starts. Use only when the user explicitly asks. Requires a live session.',
    parameters: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['list', 'delete', 'restore'],
          description: 'list current messages, delete message seqs, or restore tombstone seqs.',
        },
        seq: {
          type: 'integer',
          description: 'One message seq for delete (legacy single-target form).',
        },
        seqs: {
          type: 'array',
          items: { type: 'integer' },
          description: 'Message seqs for delete, or tombstone seqs for restore.',
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
      if (action === 'delete') {
        if (list.length === 0) throw new Error('delete 需要 list 返回的整数 seq 或 seqs。')
        const result = await deleteMessages(ctx, exec.agent, list, runtime)
        return { ok: true, text: result.text }
      }
      if (action === 'restore') {
        if (list.length === 0) throw new Error('restore 需要已删除记录返回的整数 tombstone seq。')
        const result = await restoreMessages(ctx, exec.agent, list, runtime)
        return { ok: true, text: result.text }
      }
      throw new Error('action 必须是 list、delete 或 restore。')
    },
  })

  ctx.effect(() => () => {
    tool()
    command()
    stopCreated()
    for (const entry of [...agentListeners.values()]) {
      entry.stop()
      entry.disposeOwnerEffect()
    }
    agentListeners.clear()
    pendingBySession.clear()
  }, 'message-manager: command, tool, and queued operations')
}
