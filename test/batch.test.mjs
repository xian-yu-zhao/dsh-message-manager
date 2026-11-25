import test from 'node:test'
import assert from 'node:assert/strict'
import {
  deletedFromSurface,
  formatBatches,
  pickUndoBatch,
  tombstoneData,
} from 'file:///C:/Users/25281/Documents/deepseek-harness/default-workspace/plugins/dsh-context-manager/core.js'

const text = (chars) => [{ type: 'text', text: 'x'.repeat(chars) }]
const ev = (seq, type, turn, data, extra = {}) => ({
  seq, type, time: 1700000000000 + seq, data: { turn, step: 0, ...data }, surfaceOp: 'append', ...extra,
})
const user = (seq, turn, chars = 40) => ev(seq, 'user/message', turn, { id: `u${seq}`, role: 'user', content: text(chars), source: { kind: 'user' } })
/** A tombstone exactly as the plugin writes it: replace op + replaced seqs. */
const tomb = (seq, turn, targetSeq, batchId) => {
  const source = batchId === undefined ? { kind: 'context-manager' } : { kind: 'context-manager', batchId }
  return ev(seq, 'developer/message', turn, {
    message: { id: `tomb-${seq}`, role: 'developer', content: [], source },
  }, { surfaceOp: { op: 'replace', startSeq: targetSeq, endSeq: targetSeq }, sourceEventSeqs: [targetSeq] })
}
/** One ledger entry as the Host's batch scan reports it. */
const ledger = (over = {}) => ({
  recordSeq: 100,
  batchId: 'aaaa1111bbbb2222',
  op: 'delete',
  seqs: [1, 2],
  tombstoneSeqs: [7],
  estimatedFreedTokens: 1234,
  result: 'applied',
  ...over,
})

// ---------------------------------------------------------------- tombstoneData

test('tombstoneData: no batchId keeps the plain source (legacy compatibility)', () => {
  const data = tombstoneData(3, 1, 'm1')
  assert.deepEqual(data, {
    turn: 3,
    step: 1,
    message: {
      id: 'm1',
      role: 'developer',
      content: [],
      source: { kind: 'context-manager' },
    },
  })
  assert.equal('batchId' in data.message.source, false, 'no batchId key at all')
})

test('tombstoneData: batchId lands next to kind, kind is unchanged', () => {
  const data = tombstoneData(0, 0, 'm2', 'abcdef1234567890')
  assert.deepEqual(data.message.source, { kind: 'context-manager', batchId: 'abcdef1234567890' })
  assert.equal(data.message.source.kind, 'context-manager', 'kind is what restore planning keys on')
  assert.equal(data.message.role, 'developer')
  assert.deepEqual(data.message.content, [], 'tombstone is invisible')
})

test('tombstoneData: empty string or non-string batchId counts as absent', () => {
  for (const value of ['', null, undefined, 42, {}, [], true]) {
    const source = tombstoneData(1, 2, 'm3', value).message.source
    assert.deepEqual(source, { kind: 'context-manager' }, `batchId=${String(value)} must be ignored`)
    assert.equal('batchId' in source, false)
  }
})

// ----------------------------------------------------------------- pickUndoBatch

test('pickUndoBatch: the most recent qualifying batch wins, later undo entries skipped', () => {
  const batches = [
    ledger({ recordSeq: 100, batchId: 'aaaa1111bbbb2222', tombstoneSeqs: [7] }),
    ledger({ recordSeq: 200, batchId: 'bbbb2222cccc3333', tombstoneSeqs: [8], result: 'queued' }),
    ledger({ recordSeq: 300, batchId: 'cccc3333dddd4444', op: 'undo', tombstoneSeqs: [7, 8], result: 'applied' }),
  ]
  assert.equal(pickUndoBatch(batches).recordSeq, 200, 'undo entry is not a target')
})

test('pickUndoBatch: an id prefix selects that batch', () => {
  const batches = [
    ledger({ recordSeq: 100, batchId: 'aaaa1111bbbb2222' }),
    ledger({ recordSeq: 200, batchId: 'bbbb2222cccc3333' }),
  ]
  assert.equal(pickUndoBatch(batches, 'bbb').recordSeq, 200)
  assert.equal(pickUndoBatch(batches, 'bbbb2222').recordSeq, 200, 'full id also matches')
  assert.equal(pickUndoBatch(batches, 'aaaa1111bbbb2222').recordSeq, 100)
})

test('pickUndoBatch: a prefix matching nothing returns undefined', () => {
  const batches = [ledger({ batchId: 'aaaa1111bbbb2222' })]
  assert.equal(pickUndoBatch(batches, 'zzz'), undefined)
  assert.equal(pickUndoBatch(batches, 'ffff'), undefined)
})

test('pickUndoBatch: durably queued batches are selectable', () => {
  const batches = [ledger({ recordSeq: 100, result: 'applied' }), ledger({ recordSeq: 200, batchId: 'bbbb2222cccc3333', result: 'queued' })]
  const picked = pickUndoBatch(batches)
  assert.equal(picked.recordSeq, 200)
  assert.equal(picked.result, 'queued')
  assert.equal(pickUndoBatch(batches, 'bbbb').recordSeq, 200, 'prefix reaches a queued batch too')
})

test('pickUndoBatch: empty tombstone list, skipped and failed results are all ignored', () => {
  const batches = [
    ledger({ recordSeq: 100, tombstoneSeqs: [], result: 'applied' }),
    ledger({ recordSeq: 200, tombstoneSeqs: [9], result: 'skipped' }),
    ledger({ recordSeq: 300, tombstoneSeqs: [10], result: 'failed' }),
    ledger({ recordSeq: 400, op: 'undo', tombstoneSeqs: [9], result: 'applied' }),
  ]
  assert.equal(pickUndoBatch(batches), undefined)
})

test('pickUndoBatch: empty or malformed ledger returns undefined without throwing', () => {
  assert.equal(pickUndoBatch([]), undefined)
  assert.equal(pickUndoBatch(undefined), undefined)
  assert.equal(pickUndoBatch([null, undefined, 42, {}]), undefined)
})

// ---------------------------------------------------------------- formatBatches

test('formatBatches: empty or malformed ledger explains the audit trail', () => {
  const expected = [
    '还没有操作台账：每次删除、整轮删除或按预算清理都会记一条。',
    '',
    '撤销最近一次：/ctxmgr undo-batch（有台账后可用）',
  ].join('\n')
  for (const value of [undefined, null, [], {}, 42]) {
    assert.equal(formatBatches(value), expected, `value=${String(value)}`)
  }
})

test('formatBatches: one row per batch with short id, op, counts, tokens and result', () => {
  const out = formatBatches([
    ledger({ recordSeq: 101, batchId: 'abcdef1234567890', op: 'delete', seqs: [1, 2, 3], estimatedFreedTokens: 1500, result: 'applied' }),
    ledger({ recordSeq: 102, batchId: 'fedcba9876543210', op: 'clean', seqs: [4], estimatedFreedTokens: 200, result: 'queued' }),
    ledger({ recordSeq: 103, batchId: '0123456789abcdef', op: 'deleteturn', seqs: [5, 6], estimatedFreedTokens: 8000, result: 'failed' }),
    ledger({ recordSeq: 104, batchId: '99999999aaaa1111', op: 'delete', seqs: [], estimatedFreedTokens: 0, result: 'skipped' }),
  ])
  assert.ok(out.includes('操作台账（共 4 个批次，显示最近 4 个）：'), 'header counts batches, not records')
  assert.ok(out.includes('#101 abcdef12 · delete · 3 条消息 · ≈1,500 tok · 成功'), out)
  assert.ok(out.includes('#102 fedcba98 · clean · 1 条消息 · ≈200 tok · 排队中'), out)
  // A failed batch moved nothing, so its row reports zero messages and zero
  // tokens even though the record carried a planned estimate.
  assert.ok(out.includes('#103 01234567 · deleteturn · 0 条消息 · ≈0 tok · 失败'), out)
  assert.ok(out.includes('#104 99999999 · delete · 0 条消息 · ≈0 tok · 跳过'), out)
  assert.equal(out.split('\n').filter((line) => line.startsWith('#')).length, 4, 'one row per batch')
  assert.ok(out.includes('/ctxmgr undo-batch'), 'undo hint is present')
  assert.ok(out.trimEnd().includes('只增不改'), 'trailer explains durability')
  assert.ok(out.includes('同一批次的「排队中 → 成功」是同一操作的两条记录，不是两次操作。'), 'footer explains the transition rows')
})

test('formatBatches: limit keeps the newest batches and names the hidden ones', () => {
  const batches = [1, 2, 3, 4, 5].map((n) => ledger({
    recordSeq: 100 + n,
    batchId: `${String(n).repeat(8)}zzzz2222`,
    seqs: [n],
    estimatedFreedTokens: n * 10,
  }))
  const out = formatBatches(batches, 2)
  assert.ok(out.includes('操作台账（共 5 个批次，显示最近 2 个）：'), out)
  assert.ok(out.includes('#105 55555555'), 'newest kept')
  assert.ok(out.includes('#104 44444444'), 'second newest kept')
  for (const old of ['#103', '#102', '#101']) assert.ok(!out.includes(old), `${old} hidden by limit`)
  assert.ok(out.includes('…另 3 个更早的批次未展开'), 'hidden batches are named')
  assert.equal(out.split('\n').filter((line) => line.startsWith('#')).length, 2)
})

test('formatBatches: one batch written twice collapses into one transition row', () => {
  const out = formatBatches([
    ledger({ recordSeq: 200, batchId: 'aaaa1111bbbb2222', op: 'clean', seqs: [4], estimatedFreedTokens: 500, result: 'queued', reason: 'budget' }),
    ledger({ recordSeq: 210, batchId: 'aaaa1111bbbb2222', op: 'clean', seqs: [4], count: 6, estimatedFreedTokens: 480, result: 'applied' }),
    ledger({ recordSeq: 300, batchId: 'cccc3333dddd4444', op: 'delete', seqs: [8, 9], estimatedFreedTokens: 900, result: 'applied' }),
  ])
  assert.ok(out.includes('操作台账（共 2 个批次 / 3 条记录，显示最近 2 个）：'), out)
  // One row for the two records of the first batch: it shows the newest
  // recordSeq, the newest count and tokens, and the transition of results.
  assert.ok(out.includes('#210 aaaa1111 · clean · 6 条消息 · ≈480 tok · 排队中 → 成功（budget）'), out)
  assert.ok(!out.includes('#200 '), 'the queued record is folded into the batch row')
  assert.ok(out.includes('#300 cccc3333 · delete · 2 条消息 · ≈900 tok · 成功'), out)
  assert.equal(out.split('\n').filter((line) => line.startsWith('#')).length, 2, 'two batches, two rows')
})

test('formatBatches: the transition lists every distinct result in log order', () => {
  const out = formatBatches([
    ledger({ recordSeq: 10, batchId: 'bbbb2222cccc3333', result: 'queued' }),
    ledger({ recordSeq: 20, batchId: 'bbbb2222cccc3333', result: 'failed' }),
    ledger({ recordSeq: 30, batchId: 'bbbb2222cccc3333', result: 'applied' }),
  ])
  assert.ok(out.includes('操作台账（共 1 个批次 / 3 条记录，显示最近 1 个）：'), out)
  // The row totals the landed records (applied only): a failed record moved no
  // messages, so it contributes neither count nor tokens.
  assert.ok(out.includes('#30 bbbb2222 · delete · 2 条消息 · ≈1,234 tok · 排队中 → 失败 → 成功'), out)
  assert.equal(out.split('\n').filter((line) => line.startsWith('#')).length, 1, 'three records, one batch')
})

test('formatBatches: an undo row counts deletion records and frees no tokens', () => {
  const out = formatBatches([
    ledger({ recordSeq: 119, batchId: '254ff2ac', op: 'undo', seqs: [77], tombstoneSeqs: [], count: 1, estimatedFreedTokens: 0, result: 'applied' }),
  ])
  assert.ok(out.includes('#119 254ff2ac · undo · 1 条删除记录 · — · 成功'), out)
})

test('formatBatches: a batch applied one target at a time totals every applied record', () => {
  // A queued clean replays one target per record, so the batch row must sum the
  // landed records instead of reporting only the newest one; skipped targets
  // removed nothing and must not inflate the count.
  const entries = [
    ledger({ recordSeq: 400, batchId: 'ffff0000cccc1111', op: 'clean', seqs: [31], result: 'queued', count: 8, estimatedFreedTokens: 9000 }),
    ...Array.from({ length: 4 }, (_, index) => ledger({
      recordSeq: 401 + index,
      batchId: 'ffff0000cccc1111',
      op: 'clean',
      seqs: [31 + index],
      count: 2,
      estimatedFreedTokens: 500,
      result: 'applied',
    })),
    ledger({ recordSeq: 405, batchId: 'ffff0000cccc1111', op: 'clean', seqs: [40], count: 0, estimatedFreedTokens: 0, result: 'skipped', reason: 'target #40 not-found' }),
  ]
  const out = formatBatches(entries)
  assert.ok(out.includes('操作台账（共 1 个批次 / 6 条记录，显示最近 1 个）：'), out)
  assert.ok(out.includes('#405 ffff0000 · clean · 8 条消息 · ≈2,000 tok · 排队中 → 成功 → 跳过（target #40 not-found）'), out)
})

test('formatBatches: records without a batchId stay one row each', () => {
  const out = formatBatches([
    ledger({ recordSeq: 400, batchId: undefined, seqs: [], estimatedFreedTokens: 0 }),
    ledger({ recordSeq: 410, batchId: undefined, seqs: [2] }),
  ])
  assert.ok(out.includes('操作台账（共 2 个批次，显示最近 2 个）：'), out)
  assert.ok(out.includes('#400 未知 · delete · 0 条消息 · ≈0 tok · 成功'), out)
  assert.ok(out.includes('#410 未知 · delete · 1 条消息 · ≈1,234 tok · 成功'), out)
})

// ------------------------------------------------------------ deletedFromSurface

test('deletedFromSurface: batchId from the tombstone source reaches the record', () => {
  const original = user(1, 0)
  const bySeq = new Map([[1, original]])
  const records = deletedFromSurface([original, tomb(2, 0, 1, 'abcdef1234567890')], bySeq)
  assert.equal(records.length, 1)
  assert.equal(records[0].tombstoneSeq, 2)
  assert.equal(records[0].batchId, 'abcdef1234567890')
  assert.deepEqual(records[0].targetSeqs, [1])
  assert.equal(records[0].count, 1)
  assert.equal(records[0].restorable, true, 'kind still drives restorability')
})

test('deletedFromSurface: legacy tombstones without batchId report undefined batchId', () => {
  const original = user(3, 1)
  const bySeq = new Map([[3, original]])
  const legacyKind = ev(4, 'developer/message', 1, {
    message: { id: 'tomb-legacy', role: 'developer', content: [], source: { kind: 'message-manager' } },
  }, { surfaceOp: { op: 'replace', startSeq: 3, endSeq: 3 }, sourceEventSeqs: [3] })
  const records = deletedFromSurface([original, legacyKind], bySeq)
  assert.equal(records.length, 1, 'legacy kind is still recognized')
  assert.equal(records[0].batchId, undefined)
  assert.equal(records[0].restorable, true)
})
