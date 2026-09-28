// Mirrors CONFIG.WIN_MULTIPLIER and CONFIG.REFUND_NEUTRAL in backend/Code.gs.
// The script is authoritative — these two values must be changed together or
// the admin preview will disagree with what the spreadsheet actually credits.
const WIN_MULTIPLIER = 2
const REFUND_NEUTRAL = false

/**
 * What declareResult_ in Code.gs will credit back to a team.
 *
 * The stake is already debited when the bet is placed, so this is only the
 * payout: the winning vent takes the multiplier and every other vent is paid
 * nothing — the two declared losers, and the six that neither won nor lost.
 * REFUND_NEUTRAL is false, so a neutral vent loses the stake like any other.
 */
export function computeSettlement(amount, vent, winner, losers) {
  const stake = Number(amount) || 0
  if (vent === winner) return { outcome: 'won', payout: stake * WIN_MULTIPLIER }
  if (losers.includes(vent)) return { outcome: 'lost', payout: 0 }
  if (REFUND_NEUTRAL) return { outcome: 'refunded', payout: stake }
  return { outcome: 'lost', payout: 0 }
}

export { WIN_MULTIPLIER, REFUND_NEUTRAL }
