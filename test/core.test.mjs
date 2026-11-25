import test from 'node:test'
import assert from 'node:assert/strict'
import {
  estimateMessageTokens,
  estimateTextTokens,
  formatCleanPlan,
  isCjkCodePoint,
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
/** One item as `planClean` reports it inside `chosenItems`. */
const cleanItem = (seq, role, tokens, preview) => ({ seq, role, tokens, preview })
/** A `planClean` result shape for the formatCleanPlan tests. */
const planOf = (chosenItems, over = {}) => ({
  chosen: chosenItems.map((item) => item.seq),
  chosenItems,
  candidates: chosenItems.map(({ seq, role, tokens }) => ({ seq, role, tokens })),
  estimatedFreedTokens: chosenItems.reduce((total, item) => total + item.tokens, 0),
  meetsTarget: true,
  ...over,
})
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

test('isCjkCodePoint: CJK, Hangul and full-width code points are true', () => {
  for (const character of ['一', '中', 'あ', 'カ', '한', '，', '𠀀']) {
    assert.equal(isCjkCodePoint(character.codePointAt(0)), true, `${character} is CJK`)
  }
  const boundaries = [0x1100, 0x11ff, 0x2e80, 0x303e, 0x3041, 0x33ff, 0x3400, 0x4dbf,
    0x4e00, 0x9fff, 0xa000, 0xa4cf, 0xac00, 0xd7a3, 0xf900, 0xfaff, 0xfe30, 0xfe4f,
    0xff00, 0xffef, 0x20000, 0x3ffff]
  for (const codePoint of boundaries) {
    assert.equal(isCjkCodePoint(codePoint), true, `U+${codePoint.toString(16)} is CJK`)
  }
})

test('isCjkCodePoint: ASCII, range gaps and malformed code points are false', () => {
  assert.equal(isCjkCodePoint('a'.codePointAt(0)), false, "ASCII 'a' is not CJK")
  // One past each range edge, i.e. the gaps between the CJK blocks.
  for (const codePoint of [0x10ff, 0x1200, 0x303f, 0x3040, 0x4dc0, 0xa4d0, 0xd7a4, 0xfb00, 0xfe50, 0xfff0, 0x40000]) {
    assert.equal(isCjkCodePoint(codePoint), false, `U+${codePoint.toString(16)} is outside every range`)
  }
  for (const value of [undefined, null, NaN, 1.5, '一', {}, []]) {
    assert.equal(isCjkCodePoint(value), false, `${String(value)} is not a code point`)
  }
})

test('estimateTextTokens: ASCII keeps the 4-chars-per-token price', () => {
  assert.equal(estimateTextTokens('x'.repeat(400)), 100)
  assert.equal(estimateTextTokens('x'), 1, 'partial tokens round up')
  assert.equal(estimateTextTokens('x'.repeat(5)), 2)
  assert.equal(estimateTextTokens(''), 0)
})

test('estimateTextTokens: CJK prices about one token per character', () => {
  assert.equal(estimateTextTokens('中'.repeat(40)), 40)
  assert.equal(estimateTextTokens('中'.repeat(3)), 3)
  assert.equal(estimateTextTokens('，'.repeat(8)), 8, 'full-width punctuation is CJK-priced')
  assert.equal(estimateTextTokens('𠀀'.repeat(3)), 3, 'an astral code point counts once, not per UTF-16 unit')
})

test('estimateTextTokens: mixed scripts add the CJK weight to the ASCII weight', () => {
  // 10 ASCII chars (10 units) + 10 CJK chars (40 units) => ceil(50 / 4) = 13.
  assert.equal(estimateTextTokens(`abcdefghij${'中'.repeat(10)}`), 13)
})

test('estimateTextTokens: non-string input prices as 0', () => {
  for (const value of [undefined, null, 42, {}, [], true]) {
    assert.equal(estimateTextTokens(value), 0, `${String(value)} is not text`)
  }
})

test('estimateMessageTokens: CJK text prices one token per character plus framing', () => {
  const message = { content: [{ type: 'text', text: '中'.repeat(100) }] }
  assert.equal(estimateMessageTokens(message), 108, '100 text + 4 block + 4 role overhead')
  assert.equal(estimateMessageTokens(message, true), 104, 'system prompt: 100 text + 4 framing, no per-block overhead')
})

test('estimateMessageTokens: mixed text keeps its ASCII framing overhead', () => {
  const message = { content: [{ type: 'text', text: `abcdefghij${'中'.repeat(10)}` }] }
  assert.equal(estimateMessageTokens(message), 21, '13 text + 4 block + 4 role overhead')
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

test('planClean: chosenItems are the full items, aligned with chosen', () => {
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
  const plan = planClean(items, 4000)
  assert.deepEqual(plan.chosenItems.map((item) => item.seq), plan.chosen, 'same seqs, same order')
  assert.equal(plan.chosenItems.length, plan.chosen.length)
  for (let index = 0; index < plan.chosen.length; index += 1) {
    const expected = items.find((item) => item.seq === plan.chosen[index])
    assert.equal(plan.chosenItems[index], expected, `#${plan.chosen[index]} is the original item object`)
    assert.equal(plan.chosenItems[index].tokens, expected.tokens, 'tokens are carried, not stripped')
    assert.equal(plan.chosenItems[index].role, expected.role)
    assert.equal(typeof plan.chosenItems[index].preview, 'string')
  }
  assert.equal(plan.chosenItems[0].seq, 2, 'largest candidate first')
  assert.deepEqual(plan.chosen, [2, 3, 4], 'ordered by tokens descending')
})

test('planClean: equal-priced candidates break ties by ascending seq', () => {
  const events = [tool(1, 0, 400, 'c1'), tool(2, 1, 400, 'c2'), asst(3, 2, 400), user(4, 3, 40), asst(5, 3, 40), asst(6, 3, 40)]
  const items = itemsFromSurface(events)
  const plan = planClean(items, 100000)
  assert.deepEqual(plan.candidates.map((candidate) => candidate.seq), [1, 2, 3], 'equal prices fall back to surface order')
  assert.deepEqual(plan.chosen, [1, 2, 3])
  assert.deepEqual(plan.chosenItems.map((item) => item.seq), [1, 2, 3], 'chosenItems follow the same ranking')
  assert.deepEqual(plan.chosenItems.map((item) => item.tokens), [priceOf(400), priceOf(400), priceOf(400)])
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
  assert.deepEqual(plan.chosenItems, [], 'nothing chosen, nothing to describe')
  assert.equal(plan.meetsTarget, false)
})

// ------------------------------------------------------------ formatCleanPlan

test('formatCleanPlan: an empty plan previews the hint and never asks to confirm', () => {
  const plan = { chosen: [], chosenItems: [], candidates: [], estimatedFreedTokens: 0, meetsTarget: false }
  const out = formatCleanPlan(plan, 5000)
  assert.equal(out.split('\n')[0], '按预算清理预览（目标 ≈5,000 tokens，未删除任何消息）：')
  assert.ok(out.includes('候选池 0 条里没有可清理的消息'), out)
  assert.ok(out.includes('/ctxmgr clean <目标tokens> --min 50 --protect 1'), 'hint names the relax flags')
  assert.ok(!out.includes('确认执行'), 'a dry run never prints the confirm command')
})

test('formatCleanPlan: lists each chosen item with role, price and preview', () => {
  const plan = planOf([
    cleanItem(12, 'tool', 4000, 'tool:read src/core.js'),
    cleanItem(30, 'assistant', 2500, 'the assistant summary'),
  ], { estimatedFreedTokens: 6500 })
  const out = formatCleanPlan(plan, 6000)
  assert.ok(out.includes('将从 2 条候选里清理 2 条，预计释放 ≈6,500 tokens'), out)
  assert.ok(out.includes('  #12 工具 ≈4,000 tok · tool:read src/core.js'), out)
  assert.ok(out.includes('  #30 助手 ≈2,500 tok · the assistant summary'), out)
  assert.ok(out.includes('确认执行：/ctxmgr clean 6000'), 'confirm line repeats the budget')
  assert.ok(!out.includes('候选池不够'), 'the plan meets the target')
  assert.ok(!out.includes('条未展开'), 'two items are inside the default preview limit')
})

test('formatCleanPlan: long previews are cut at 60 characters with an ellipsis', () => {
  const plan = planOf([
    cleanItem(1, 'tool', 10, 'x'.repeat(80)),
    cleanItem(2, 'assistant', 20, 'y'.repeat(60)),
    cleanItem(3, 'tool', 30, 'z'.repeat(61)),
  ])
  const lines = formatCleanPlan(plan, 1000).split('\n')
  const lineOf = (seq) => lines.find((line) => line.startsWith(`  #${seq} `))
  assert.equal(lineOf(1), `  #1 工具 ≈10 tok · ${'x'.repeat(60)}…`, 'over the limit is cut to 60 and marked')
  assert.equal(lineOf(2), `  #2 助手 ≈20 tok · ${'y'.repeat(60)}`, 'exactly 60 characters stay whole')
  assert.equal(lineOf(3), `  #3 工具 ≈30 tok · ${'z'.repeat(60)}…`, 'one character over is still cut')
})

test('formatCleanPlan: a plan short of the budget reports the remaining gap', () => {
  const plan = planOf([cleanItem(2, 'tool', 3016, 'tool:read big')], { estimatedFreedTokens: 3016, meetsTarget: false })
  const out = formatCleanPlan(plan, 6000)
  assert.ok(out.includes('将从 1 条候选里清理 1 条，预计释放 ≈3,016 tokens'), out)
  assert.ok(out.split('\n').some((line) => line.startsWith('候选池不够：最多只能释放 ≈3,016 tokens，离目标还差 ≈2,984。')), out)
  assert.ok(out.includes('确认执行：/ctxmgr clean 6000'), 'the preview still offers the run')
})

test('formatCleanPlan: chosen items beyond previewLimit are counted, not listed', () => {
  const items = Array.from({ length: 4 }, (_, index) => cleanItem(index + 1, 'tool', 100, `message ${index + 1}`))
  const out = formatCleanPlan(planOf(items), 1000, 2)
  const lines = out.split('\n')
  assert.equal(lines.filter((line) => line.startsWith('  #')).length, 2, 'only two items are expanded')
  assert.ok(out.includes('  …另 2 条未展开'), out)
  assert.ok(out.includes('将从 4 条候选里清理 4 条'), 'the header still counts every chosen item')
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
