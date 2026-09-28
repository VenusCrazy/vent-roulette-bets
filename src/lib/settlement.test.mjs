// The admin preview must predict exactly what backend/Code.gs will write, so
// these cases are the same settlement cases the backend test suite pins.
import test from 'node:test'
import assert from 'node:assert/strict'
import { computeSettlement, WIN_MULTIPLIER } from './settlement.js'

test('the winning vent takes the multiplier', () => {
  assert.deepEqual(computeSettlement(200, 1, 1, [2, 3]), { outcome: 'won', payout: 400 })
})

test('a declared losing vent is paid nothing', () => {
  assert.deepEqual(computeSettlement(150, 3, 1, [3, 5]), { outcome: 'lost', payout: 0 })
  assert.deepEqual(computeSettlement(150, 5, 1, [3, 5]), { outcome: 'lost', payout: 0 })
})

test('a neutral vent loses its stake, the same as a declared losing vent', () => {
  assert.deepEqual(computeSettlement(75, 9, 1, [3, 5]), { outcome: 'lost', payout: 0 })
})

test('only the winning vent is ever paid, so six of the nine vents lose', () => {
  const winner = 4
  const losers = [2, 7]
  const outcomes = []
  for (let vent = 1; vent <= 9; vent++) outcomes.push(computeSettlement(100, vent, winner, losers).outcome)
  assert.deepEqual(
    outcomes.filter((o) => o === 'won').length,
    1,
    'exactly one vent wins'
  )
  assert.equal(outcomes.filter((o) => o === 'lost').length, 8, 'the other eight lose')
  assert.ok(!outcomes.includes('refunded'), 'nothing is refunded')
})

test('every vent 1-9 gets a result for any winner/loser set', () => {
  const winner = 4
  const losers = [2, 7]
  for (let vent = 1; vent <= 9; vent++) {
    const { outcome, payout } = computeSettlement(100, vent, winner, losers)
    assert.ok(['won', 'lost'].includes(outcome), `vent ${vent} got ${outcome}`)
    assert.ok(Number.isFinite(payout) && payout >= 0, `vent ${vent} payout ${payout}`)
  }
})

test('the multiplier is 2, matching Code.gs CONFIG.WIN_MULTIPLIER', () => {
  assert.equal(WIN_MULTIPLIER, 2)
  assert.equal(computeSettlement(50, 1, 1, [2, 3]).payout, 100)
})
