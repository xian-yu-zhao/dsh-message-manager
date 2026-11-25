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
  for (const value of [undefined, null, [], {}, 42]) {
    const out = formatBatches(value)
    assert.ok(out.startsWith('还没有操作台账'), `value=${String(value)} -> ${out}`)
  }
})

test('formatBatches: one line per entry with short id, op, counts, tokens and result', () => {
  const out = formatBatches([
    ledger({ recordSeq: 101, batchId: 'abcdef1234567890', op: 'delete', seqs: [1, 2, 3], estimatedFreedTokens: 1500, result: 'applied' }),
    ledger({ recordSeq: 102, batchId: 'fedcba9876543210', op: 'clean', seqs: [4], estimatedFreedTokens: 200, result: 'queued' }),
    ledger({ recordSeq: 103, batchId: '0123456789abcdef', op: 'deleteturn', seqs: [5, 6], estimatedFreedTokens: 8000, result: 'failed' }),
    ledger({ recordSeq: 104, batchId: '99999999aaaa1111', op: 'delete', seqs: [], estimatedFreedTokens: 0, result: 'skipped' }),
  ])
  assert.ok(out.includes('操作台账（共 4 条'), 'header carries the total')
  assert.ok(out.includes('#101 abcdef12 · delete · 3 条消息 · ≈1,500 tok · 成功'), out)
  assert.ok(out.includes('#102 fedcba98 · clean · 1 条消息 · ≈200 tok · 排队中'), out)
  assert.ok(out.includes('#103 01234567 · deleteturn · 2 条消息 · ≈8,000 tok · 失败'), out)
  assert.ok(out.includes('#104 99999999 · delete · 0 条消息 · ≈0 tok · 跳过'), out)
  assert.ok(out.includes('/ctxmgr undo-batch'), 'undo hint is present')
  assert.ok(out.trimEnd().includes('只增不改'), 'trailer explains durability')
})

test('formatBatches: limit shows only the newest entries but still reports the total', () => {
  const batches = [1, 2, 3, 4, 5].map((n) => ledger({
    recordSeq: 100 + n,
    batchId: `${String(n).repeat(8)}zzzz2222`,
    seqs: [n],
    estimatedFreedTokens: n * 10,
  }))
  const out = formatBatches(batches, 2)
  assert.ok(out.includes('操作台账（共 5 条，显示最近 2 条）'), out)
  assert.ok(out.includes('#105 55555555'), 'newest kept')
  assert.ok(out.includes('#104 44444444'), 'second newest kept')
  for (const old of ['#103', '#102', '#101']) assert.ok(!out.includes(old), `${old} hidden by limit`)
  assert.equal(out.split('\n').filter((line) => line.startsWith('#')).length, 2)
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
