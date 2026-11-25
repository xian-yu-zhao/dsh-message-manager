import test from 'node:test'
import assert from 'node:assert/strict'
import {
  estimateMessageTokens,
  itemsFromSurface,
  planClean,
  planDeletion,
  turnsFromSurface,
  deletedFromSurface,
  foldSurface,
} from 'file:///C:/Users/25281/Documents/deepseek-harness/default-workspace/plugins/dsh-context-manager/core.js'

const text = (chars) => [{ type: 'text', text: 'x'.repeat(chars) }]
// ~4 chars per token, +8 framing per message
const priceOf = (chars) => Math.ceil(chars / 4) + 8
const ev = (seq, type, turn, data, extra = {}) => ({
  seq, type, time: 1700000000000 + seq, data: { turn, step: 0, ...data }, surfaceOp: 'append', ...extra,
})
const user = (seq, turn, chars) => ev(seq, 'user/message', turn, { id: `u${seq}`, role: 'user', content: text(chars), source: { kind: 'user' } })
const asst = (seq, turn, chars) => ev(seq, 'assistant/message', turn, { message: { id: `a${seq}`, role: 'assistant', content: text(chars), source: {} } })
const tool = (seq, turn, chars, callId) => ev(seq, 'tool/result', turn, { message: { id: `t${seq}`, role: 'tool', content: text(chars), toolCallId: callId, source: {} } })

test('estimateMessageTokens: empty content is 0 (tombstone rule)', () => {
  assert.equal(estimateMessageTokens({ content: [] }), 0)
  assert.equal(estimateMessageTokens({ content: [{ type: 'text', text: '' }] }, false), 8)
})

test('estimateMessageTokens: 4 chars per token heuristic', () => {
  assert.equal(estimateMessageTokens({ content: text(400) }, false), priceOf(400))
})

test('itemsFromSurface: every item carries tokens, tombstones 0', () => {
  const tomb = ev(9, 'developer/message', 1, { message: { id: 'x', role: 'developer', content: [], source: { kind: 'context-manager' } } },
    { surfaceOp: { op: 'replace', startSeq: 1, endSeq: 1 }, sourceEventSeqs: [1] })
  const events = [user(1, 0, 40), asst(2, 1, 400), tomb]
  const items = itemsFromSurface(events)
  assert.ok(items.every((i) => Number.isInteger(i.tokens)))
  assert.ok(items.every((i) => i.tokens > 0), 'visible messages priced > 0')
  assert.deepEqual(items.map((i) => i.seq), [1, 2], 'tombstone is not listed as a message')
})

test('planClean: only tool/assistant, desc by tokens, protects recent + user', () => {
  const events = [
    user(1, 0, 4000),          // big user -> never a candidate
    tool(2, 1, 8000, 'c1'),    // biggest candidate
    asst(3, 2, 4000),          // medium candidate
    tool(4, 3, 800, 'c2'),     // small candidate
    user(5, 4, 100),           // recent (protected)
    asst(6, 4, 200),           // recent (protected)
    asst(7, 4, 200),           // recent (protected)
  ]
  const items = itemsFromSurface(events)
  const plan = planClean(items, priceOf(8000))
  assert.ok(!plan.chosen.includes(1), 'user message never cleaned')
  assert.equal(plan.chosen[0], 2, 'largest candidate first')
  for (const seq of [5, 6, 7]) assert.ok(!plan.chosen.includes(seq), `recent #${seq} protected`)
  assert.ok(plan.estimatedFreedTokens >= priceOf(8000))
  assert.equal(plan.meetsTarget, true)
  assert.deepEqual(plan.candidates.map((c) => c.seq), [2, 3, 4], 'candidates ordered by tokens desc')
})

test('planClean: stops once budget met', () => {
  const events = [user(1, 0, 40), tool(2, 1, 8000, 'c1'), tool(3, 2, 400, 'c2'), asst(4, 3, 40), asst(5, 3, 40), asst(6, 3, 40)]
  const plan = planClean(itemsFromSurface(events), 1000)
  assert.deepEqual(plan.chosen, [2])
})

test('planClean: minCandidateTokens and protectRecent are honored', () => {
  const events = [tool(1, 0, 400, 'c1'), tool(2, 1, 400, 'c2'), asst(3, 2, 400)]
  const items = itemsFromSurface(events)
  assert.deepEqual(planClean(items, 100000, { minCandidateTokens: 1000 }).chosen, [])
  assert.deepEqual(planClean(items, 100000, { protectRecent: 0 }).chosen, [1, 2, 3])
})

test('planClean: empty candidate set is reported, not thrown', () => {
  const items = itemsFromSurface([user(1, 0, 4000), user(2, 1, 4000)])
  const plan = planClean(items, 5000)
  assert.deepEqual(plan.chosen, [])
  assert.equal(plan.meetsTarget, false)
})

test('planDeletion still groups assistant tool calls with their results', () => {
  const callBlock = [{ type: 'tool-call', id: 'c1', name: 'read', arguments: '{}' }]
  const assistant = ev(1, 'assistant/message', 0, { message: { id: 'a1', role: 'assistant', content: callBlock, source: {} } })
  const r1 = tool(2, 0, 100, 'c1')
  const events = [assistant, r1, user(3, 1, 40)]
  const plan = planDeletion(events, 2)
  assert.equal(plan.ok, true)
  assert.deepEqual(plan.runs.map((r) => [r.startSeq, r.endSeq]), [[1, 2]])
})

test('turn grouping carries no tokens field by itself (Host adds them)', () => {
  const events = [user(1, 0, 40), asst(2, 0, 400), user(3, 1, 40)]
  const turns = turnsFromSurface(events, new Map(events.map((e) => [e.seq, e])))
  assert.deepEqual(turns.map((x) => x.turn), [0, 1])
  assert.equal(turns[0].messages.length, 2)
})
