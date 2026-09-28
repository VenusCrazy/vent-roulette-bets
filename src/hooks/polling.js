export const POLL_INTERVAL_MS = 15000

// Every tab on every device, polling on the same 15s boundary, arrives at the
// same asleep container at the same moment and makes it wake up the hard way.
// A few extra seconds of stagger per client spreads that out.
export const POLL_JITTER_MS = 7000

/**
 * Fetches once immediately, then on an interval while the document is visible.
 *
 * Returns a stop function that clears the interval and detaches the listener.
 * Kept separate from the hook so the scheduling can be driven by a fake clock
 * in tests, and so useBets only has to worry about turning the result into
 * state.
 */
export function startBetsPolling({
  doc = document,
  poll,
  intervalMs = POLL_INTERVAL_MS,
  jitterMs = POLL_JITTER_MS,
  random = Math.random,
}) {
  poll()

  // Fixed per client, not per tick: it shifts this client off the shared
  // boundary without letting the interval drift on every cycle.
  const period = intervalMs + Math.round(random() * jitterMs)
  const timer = setInterval(() => {
    if (!doc.hidden) poll()
  }, period)

  // Coming back to the tab should show current data straight away rather than
  // waiting out the remainder of the interval.
  const onVisibilityChange = () => {
    if (!doc.hidden) poll()
  }
  doc.addEventListener('visibilitychange', onVisibilityChange)

  return function stop() {
    clearInterval(timer)
    doc.removeEventListener('visibilitychange', onVisibilityChange)
  }
}
