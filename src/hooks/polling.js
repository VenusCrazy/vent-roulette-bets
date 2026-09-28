export const POLL_INTERVAL_MS = 15000

/**
 * Fetches once immediately, then on an interval while the document is visible.
 *
 * Returns a stop function that clears the interval and detaches the listener.
 * Kept separate from the hook so the scheduling can be driven by a fake clock
 * in tests, and so useBets only has to worry about turning the result into
 * state.
 */
export function startBetsPolling({ doc = document, poll, intervalMs = POLL_INTERVAL_MS }) {
  poll()

  const timer = setInterval(() => {
    if (!doc.hidden) poll()
  }, intervalMs)

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
