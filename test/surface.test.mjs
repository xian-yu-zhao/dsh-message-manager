import test from 'node:test'
import assert from 'node:assert/strict'
import {
  buildRecall,
  deletedFromSurface,
  foldSurface,
  itemsFromSurface,
  planClean,
  planDeletion,
  RECALL_MAX_ENTRIES,
  RECALL_PREVIEW_LIMIT,
  tombstoneData,
  TOMBSTONE_KIND,
  turnsFromSurface,
} from 'file:///C:/Users/25281/Documents/deepseek-harness/default-workspace/plugins/dsh-context-manager/core.js'

const text = (chars) => [{ type: 'text', text: 'x'.repeat(chars) }]
const textOf = (value) => [{ type: 'text', text: value }]
// ~4 chars per token, +8 framing per message
const priceOf = (chars) => Math.ceil(chars / 4) + 8
const ev = (seq, type, turn, data, extra = {}) => ({
  seq, type, time: 1700000000000 + seq, data: { turn, step: 0, ...data }, surfaceOp: 'append', ...extra,
})
const user = (seq, turn, chars = 40) => ev(seq, 'user/message', turn, { id: `u${seq}`, role: 'user', content: text(chars), source: { kind: 'user' } })
const userText = (seq, turn, value) => ev(seq, 'user/message', turn, { id: `u${seq}`, role: 'user', content: textOf(value), source: { kind: 'user' } })
const asst = (seq, turn, chars = 40) => ev(seq, 'assistant/message', turn, { message: { id: `a${seq}`, role: 'assistant', content: text(chars), source: {} } })
const asstText = (seq, turn, value) => ev(seq, 'assistant/message', turn, { message: { id: `a${seq}`, role: 'assistant', content: textOf(value), source: {} } })
const tool = (seq, turn, chars, callId) => ev(seq, 'tool/result', turn, { message: { id: `t${seq}`, role: 'tool', content: text(chars), toolCallId: callId, source: {} } })
const system = (seq, turn, chars = 200) => ev(seq, 'system/message', turn, { message: { id: `s${seq}`, role: 'system', content: text(chars), source: {} } })
const contextMessage = (seq, turn, chars = 40) => ev(seq, 'developer/message', turn, { message: { id: `d${seq}`, role: 'developer', content: text(chars), source: {} } })
/** An invisible replacement node: empty content, replace op, named targets. */
const tomb = (seq, turn, targets, source = { kind: 'context-manager' }) => ev(seq, 'developer/message', turn,
  { message: { id: `tomb-${seq}`, role: 'developer', content: [], source } },
  { surfaceOp: { op: 'replace', startSeq: targets[0], endSeq: targets[targets.length - 1] }, sourceEventSeqs: [...targets] })
const toolCalls = (...ids) => ids.map((id) => ({ type: 'tool-call', id, name: 'read', arguments: '{}' }))

// ---------------------------------------------------------------- foldSurface

test('foldSurface: append nodes enter the surface in log order', () => {
  const events = [user(1, 0), asst(2, 0), tool(3, 0, 40, 'c1')]
  const surface = foldSurface(events)
  assert.deepEqual(surface.nodes, [1, 2, 3])
  assert.equal(surface.uncertain, false)
  assert.equal(surface.bySeq.size, 3)
  assert.equal(surface.bySeq.get(2).seq, 2, 'bySeq resolves each seq back to its event')
})

test('foldSurface: replace collapses a whole range into the replacement seq', () => {
  const events = [user(1, 0), asst(2, 0), tool(3, 0, 40, 'c1'), user(4, 1), tomb(5, 1, [2, 3])]
  const surface = foldSurface(events)
  assert.deepEqual(surface.nodes, [1, 5, 4], 'seqs 2..3 are shadowed by the tombstone seq 5')
  assert.equal(surface.nodes.length, 3, 'node count shrinks by the replaced range length')
  assert.equal(surface.uncertain, false)
})

test('foldSurface: replace of a single node swaps it in place', () => {
  const events = [user(1, 0), asst(2, 0), tomb(3, 0, [2])]
  assert.deepEqual(foldSurface(events).nodes, [1, 3])
})

test('foldSurface: unresolved bounds flag uncertain instead of throwing', () => {
  const base = [user(1, 0), asst(2, 0)]
  const unknownStart = foldSurface([...base, tomb(3, 0, [99])])
  assert.equal(unknownStart.uncertain, true, 'missing startSeq')
  assert.deepEqual(unknownStart.nodes, [1, 2], 'nodes stay exactly as they were')
  const unknownEnd = foldSurface([...base, tomb(3, 0, [1, 99])])
  assert.equal(unknownEnd.uncertain, true, 'missing endSeq')
  assert.deepEqual(unknownEnd.nodes, [1, 2])
  const reversed = foldSurface([...base, tomb(3, 0, [2, 1])])
  assert.equal(reversed.uncertain, true, 'endSeq before startSeq')
  assert.deepEqual(reversed.nodes, [1, 2])
})

test('foldSurface: non-surface events stay out of nodes but remain addressable', () => {
  const events = [
    ev(1, 'turn/start', 0, {}),
    user(2, 0),
    ev(3, 'step/start', 0, {}),
    ev(4, 'tool/call', 0, {}),
    asst(5, 0),
  ]
  const surface = foldSurface(events)
  assert.deepEqual(surface.nodes, [2, 5])
  assert.equal(surface.bySeq.size, 5, 'bySeq indexes the raw log, surface or not')
  for (const seq of [1, 3, 4]) assert.ok(surface.bySeq.has(seq), `#${seq} still addressable`)
})

test('foldSurface: events without a usable surfaceOp are skipped, unknown ops ignored', () => {
  const noOp = { ...user(1, 0) }
  delete noOp.surfaceOp
  const unknownOp = { ...asst(2, 0), surfaceOp: { op: 'purge', startSeq: 1, endSeq: 1 } }
  const surface = foldSurface([noOp, unknownOp, user(3, 0)])
  assert.deepEqual(surface.nodes, [3], 'only the append node is on the surface')
  assert.equal(surface.uncertain, false, 'an unknown op is not an uncertain replace')
  assert.deepEqual(foldSurface([]), { nodes: [], bySeq: new Map(), uncertain: false })
  const malformed = foldSurface([null, undefined, 42])
  assert.deepEqual(malformed.nodes, [])
  assert.equal(malformed.uncertain, false)
})

// ----------------------------------------------------------- turnsFromSurface

test('turnsFromSurface: system prompts never join a turn', () => {
  const events = [system(1, 0), user(2, 0), asst(3, 0)]
  const turns = turnsFromSurface(events, new Map())
  assert.equal(turns.length, 1)
  assert.deepEqual(turns[0].messages.map((m) => m.seq), [2, 3])
  assert.ok(turns[0].messages.every((m) => m.role !== 'system'), 'system is not a manageable message')
})

test('turnsFromSurface: empty-content tombstones join no turn at all', () => {
  const events = [
    tomb(2, 0, [1]), // developer tombstone: deleted turn 0 is invisible
    ev(3, 'assistant/message', 1, { message: { id: 'a3', role: 'assistant', content: [], source: {} } }), // appended empty assistant
    user(4, 1),
  ]
  const turns = turnsFromSurface(events, new Map())
  assert.deepEqual(turns.map((t) => t.turn), [1], 'turn 0 vanished, the empty assistant counted for none')
  assert.deepEqual(turns[0].messages.map((m) => m.seq), [4])
  assert.equal(turns[0].messages.length, 1)
})

test('turnsFromSurface: same-turn messages keep surface order and preview prefers the user', () => {
  const events = [
    contextMessage(1, 0, 40), // injected context arrives first (runtime snapshot)
    userText(2, 0, 'how does foldSurface work?'),
    asstText(3, 0, 'it shadows the range with one node'),
  ]
  const turns = turnsFromSurface(events, new Map())
  assert.equal(turns.length, 1)
  assert.deepEqual(turns[0].seqs, [1, 2, 3], 'seqs carry the whole turn in surface order')
  assert.deepEqual(turns[0].messages.map((m) => [m.seq, m.role]), [[1, 'context'], [2, 'user'], [3, 'assistant']])
  assert.equal(turns[0].preview, 'how does foldSurface work?', 'the user message wins over the leading context message')
})

test('turnsFromSurface: a turn without a user message previews its first message', () => {
  const events = [user(1, 0), asstText(2, 1, 'only assistant here')]
  const turns = turnsFromSurface(events, new Map())
  assert.equal(turns[1].preview, 'only assistant here')
  assert.deepEqual(turnsFromSurface([], new Map()), [], 'empty surface is an empty turn list')
})

test('turnsFromSurface: turns are returned in ascending turn order', () => {
  const events = [user(1, 5), asst(2, 5), user(3, 3), asst(4, 3), user(5, 9)]
  const turns = turnsFromSurface(events, new Map())
  assert.deepEqual(turns.map((t) => t.turn), [3, 5, 9])
})

test('turnsFromSurface: events without a safe-integer turn are ignored', () => {
  const noTurn = ev(1, 'user/message', undefined, { id: 'u1', role: 'user', content: text(40), source: { kind: 'user' } })
  const fractional = ev(2, 'user/message', 1.5, { id: 'u2', role: 'user', content: text(40), source: { kind: 'user' } })
  const turns = turnsFromSurface([noTurn, fractional, user(3, 0)], new Map())
  assert.deepEqual(turns.map((t) => t.turn), [0])
  assert.deepEqual(turns[0].messages.map((m) => m.seq), [3])
})

// ---------------------------------------------------------------- buildRecall

test('buildRecall: one pointer per removed message with seq, role and gist', () => {
  const events = [user(1, 0), asst(2, 0), tool(3, 0, 40, 'c1'), contextMessage(4, 0)]
  assert.deepEqual(buildRecall(events), [
    { seq: 1, role: 'user', preview: 'x'.repeat(40) },
    { seq: 2, role: 'assistant', preview: 'x'.repeat(40) },
    { seq: 3, role: 'tool', preview: 'x'.repeat(40) },
    { seq: 4, role: 'context', preview: 'x'.repeat(40) },
  ])
})

test('buildRecall: preview is cut to the recall limit and ends with an ellipsis', () => {
  assert.equal(RECALL_PREVIEW_LIMIT, 80)
  const long = buildRecall([user(1, 0, 400)])[0]
  assert.equal(long.preview.length, RECALL_PREVIEW_LIMIT)
  assert.ok(long.preview.endsWith('…'), 'truncated gist is marked with an ellipsis')
  assert.equal(long.preview, `${'x'.repeat(RECALL_PREVIEW_LIMIT - 1)}…`)
  const exact = buildRecall([user(2, 0, 80)])[0]
  assert.equal(exact.preview, 'x'.repeat(80), 'exactly at the limit stays whole')
  const over = buildRecall([user(3, 0, 81)])[0]
  assert.equal(over.preview.length, 80, 'one char over the limit is still capped')
  assert.ok(over.preview.endsWith('…'))
})

test('buildRecall: capped at RECALL_MAX_ENTRIES in surface order', () => {
  assert.equal(RECALL_MAX_ENTRIES, 8)
  const events = Array.from({ length: 12 }, (_, index) => user(index + 1, 0))
  const recall = buildRecall(events)
  assert.equal(recall.length, RECALL_MAX_ENTRIES)
  assert.deepEqual(recall.map((entry) => entry.seq), [1, 2, 3, 4, 5, 6, 7, 8], 'oldest eight, in surface order')
})

test('buildRecall: malformed events are skipped without throwing', () => {
  const recall = buildRecall([null, undefined, 42, 'nope', {}, { seq: '7' }, user(1, 0)])
  assert.deepEqual(recall.map((entry) => entry.seq), [1])
  assert.deepEqual(recall[0], { seq: 1, role: 'user', preview: 'x'.repeat(40) })
  assert.deepEqual(buildRecall([]), [])
})

// -------------------------------------------------------------- tombstoneData

test('tombstoneData: recall lands in source, capped and without mutating the input', () => {
  const recall = Array.from({ length: 10 }, (_, index) => ({ seq: index + 1, role: 'user', preview: `p${index + 1}` }))
  const data = tombstoneData(4, 2, 'tomb-1', 'abcdef1234567890', recall)
  assert.equal(data.message.source.kind, TOMBSTONE_KIND)
  assert.equal(data.message.source.kind, 'context-manager', 'kind is what restore planning keys on')
  assert.equal(data.message.source.batchId, 'abcdef1234567890')
  assert.ok(Array.isArray(data.message.source.recall))
  assert.equal(data.message.source.recall.length, RECALL_MAX_ENTRIES)
  assert.deepEqual(data.message.source.recall[0], { seq: 1, role: 'user', preview: 'p1' })
  assert.equal(recall.length, 10, 'the caller array is untouched')
})

test('tombstoneData: no recall means no recall key at all', () => {
  for (const value of [undefined, null, [], 'recall', {}, true]) {
    const source = tombstoneData(1, 1, 'tomb-2', undefined, value).message.source
    assert.deepEqual(source, { kind: TOMBSTONE_KIND }, `recall=${String(value)} must be ignored`)
    assert.equal('recall' in source, false)
  }
})

test('tombstoneData: content stays [] with or without recall', () => {
  const plain = tombstoneData(0, 0, 'tomb-a')
  const recalled = tombstoneData(1, 2, 'tomb-b', undefined, [{ seq: 9, role: 'user', preview: 'x' }])
  assert.deepEqual(plain.message.content, [], 'empty content is the whole tombstone mechanism')
  assert.deepEqual(recalled.message.content, [], 'recall must never re-materialize the message')
  assert.equal(plain.message.role, 'developer')
  assert.equal(recalled.message.role, 'developer')
  assert.deepEqual(Object.keys(plain), ['turn', 'step', 'message'])
  assert.equal(plain.turn, 0)
  assert.equal(plain.step, 0)
})

// ---------------------------------------------------------- deletedFromSurface

test('deletedFromSurface: a tombstone recall pointer is passed through', () => {
  const original = user(1, 0)
  const recall = [
    { seq: 1, role: 'user', preview: 'x'.repeat(40) },
    { seq: 2, role: 'assistant', preview: 'y'.repeat(40) },
  ]
  const bySeq = new Map([[1, original]])
  const records = deletedFromSurface([original, tomb(2, 0, [1], { kind: 'context-manager', recall })], bySeq)
  assert.equal(records.length, 1)
  assert.deepEqual(records[0].recall, recall, 'recall survives the projection unchanged')
  assert.deepEqual(records[0].targetSeqs, [1])
  assert.equal(records[0].restorable, true, 'recall does not change restorability')
})

test('deletedFromSurface: tombstones without a recall report an empty array', () => {
  const original = user(5, 1)
  const bySeq = new Map([[5, original]])
  const legacy = deletedFromSurface([original, tomb(6, 1, [5], { kind: 'message-manager' })], bySeq)
  assert.equal(legacy.length, 1)
  assert.deepEqual(legacy[0].recall, [])
  const malformed = deletedFromSurface([original, tomb(7, 1, [5], { kind: 'context-manager', recall: 'nope' })], bySeq)
  assert.deepEqual(malformed[0].recall, [], 'a non-array recall is not trusted')
})

// --------------------------------------------------------------- planDeletion

test('planDeletion: deleting an assistant takes all of its tool results', () => {
  const events = [
    ev(1, 'assistant/message', 0, { message: { id: 'a1', role: 'assistant', content: toolCalls('c1', 'c2'), source: {} } }),
    tool(2, 0, 100, 'c1'),
    tool(3, 0, 100, 'c2'),
    user(4, 1),
  ]
  const plan = planDeletion(events, 1)
  assert.equal(plan.ok, true)
  assert.equal(plan.count, 3)
  assert.deepEqual(plan.indices, [0, 1, 2])
  assert.deepEqual(plan.runs.map((run) => [run.startSeq, run.endSeq]), [[1, 3]])
})

test('planDeletion: deleting one tool result drags its assistant and sibling results', () => {
  const events = [
    ev(1, 'assistant/message', 0, { message: { id: 'a1', role: 'assistant', content: toolCalls('c1', 'c2'), source: {} } }),
    tool(2, 0, 100, 'c1'),
    tool(3, 0, 100, 'c2'),
    user(4, 1),
  ]
  const plan = planDeletion(events, 3)
  assert.equal(plan.ok, true)
  assert.equal(plan.count, 3, 'assistant + both results travel together')
  assert.deepEqual(plan.runs.map((run) => [run.startSeq, run.endSeq]), [[1, 3]])
})

test('planDeletion: user and developer messages are removed alone', () => {
  const events = [user(1, 0), asst(2, 0), contextMessage(3, 1), user(4, 1)]
  const userPlan = planDeletion(events, 1)
  assert.equal(userPlan.ok, true)
  assert.equal(userPlan.count, 1)
  assert.deepEqual(userPlan.runs.map((run) => run.seqs), [[1]])
  const contextPlan = planDeletion(events, 3)
  assert.equal(contextPlan.ok, true)
  assert.equal(contextPlan.count, 1)
  assert.deepEqual(contextPlan.runs.map((run) => run.seqs), [[3]])
})

test('planDeletion: an orphan tool result is removed alone', () => {
  const events = [user(1, 0), tool(2, 0, 40, 'c9')]
  const plan = planDeletion(events, 2)
  assert.equal(plan.ok, true)
  assert.equal(plan.count, 1, 'no owner assistant, so nothing else is dragged in')
  assert.deepEqual(plan.runs.map((run) => run.seqs), [[2]])
  assert.deepEqual(planDeletion([user(1, 0)], 99), { ok: false, reason: 'not-found' })
})

// ------------------------------------------------------------------ planClean

test('planClean: tool and assistant candidates are ranked together by tokens', () => {
  const events = [
    tool(1, 0, 4000, 'c1'), // ≈1,008 tok
    asst(2, 1, 12000), // ≈3,008 tok -> biggest candidate
    tool(3, 2, 2000, 'c2'), // ≈508 tok
  ]
  const items = itemsFromSurface(events)
  // Budget just under the three prices, so every candidate is taken and met.
  const plan = planClean(items, priceOf(12000) + priceOf(4000) + priceOf(2000) - 1, { protectRecent: 0 })
  assert.deepEqual(plan.candidates.map((candidate) => [candidate.seq, candidate.role, candidate.tokens]), [
    [2, 'assistant', priceOf(12000)],
    [1, 'tool', priceOf(4000)],
    [3, 'tool', priceOf(2000)],
  ], 'one global desc sort, not tool-first')
  assert.deepEqual(plan.chosen, [2, 1, 3])
  assert.equal(plan.meetsTarget, true)
})
