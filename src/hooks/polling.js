// 2-4s rather than 15s: a bet should show up on everyone's board while the
// round is still being talked about, not up to fifteen seconds later. Polling
// this often also keeps the Apps Script container awake, which is the whole
// reason the site used to feel slow after a pause.
export const POLL_INTERVAL_MS = 2000

// Every tab on every device, polling on the same boundary, arrives at the same
// container at the same moment. The stagger spreads clients out; it also means
// the rate is a ceiling rather than a hard value, which is what keeps a handful
// of open tabs under Google's 60-executions-per-minute limit.
export const POLL_JITTER_MS = 2000

// The safety valve. Polling hard and getting throttled is a spiral: each refusal
// is another request, which invites the next refusal. So consecutive failures
// double the period up to this ceiling, and one success puts it straight back.
export const POLL_MAX_BACKOFF_MS = 30000

/**
 * Fetches immediately, then on a self-rescheduling timeout while the document
 * is visible. The period is recomputed after every poll rather than fixed by
 * setInterval, because it has to be able to lengthen on failure and shorten
 * again on recovery.
 *
 * `poll` may return false to report failure, which is what drives the backoff.
 * Anything else — including a promise for a request that is still in flight —
 * counts as healthy.
 *
 * Returns a stop function that clears the timeout and detaches the listener.
 * Kept separate from the hook so the scheduling can be driven by a fake clock
 * in tests, and so useBets only has to worry about turning the result into
 * state.
 */
export function startBetsPolling({
  doc = document,
  poll,
  intervalMs = POLL_INTERVAL_MS,
  jitterMs = POLL_JITTER_MS,
  maxIntervalMs = POLL_MAX_BACKOFF_MS,
  random = Math.random,
}) {
  let failures = 0
  let timer = null
  let stopped = false

  const period = () => {
    const backedOff = Math.min(intervalMs * Math.pow(2, failures), maxIntervalMs)
    return backedOff + Math.round(random() * jitterMs)
  }

  const schedule = () => {
    if (stopped) return
    timer = setTimeout(tick, period())
  }

  function record(ok) {
    if (ok === false) failures += 1
    else failures = 0
  }

  async function tick() {
    if (stopped) return
    if (!doc.hidden) record(await poll())
    schedule()
  }

  // Whoever opens the page wants data, visible or not, so this first fetch is
  // unconditional. It is deliberately not awaited: startBetsPolling has to hand
  // back its stop function synchronously, and by the time React runs the
  // cleanup effect this request is already gone.
  Promise.resolve(poll()).then(record)
  schedule()

  // Coming back to the tab shows current data straight away rather than waiting
  // out the remainder of a period that may have backed off to 30s. The pending
  // timer is dropped first so the two cannot double up.
  const onVisibilityChange = async () => {
    if (stopped || doc.hidden) return
    clearTimeout(timer)
    record(await poll())
    schedule()
  }
  doc.addEventListener('visibilitychange', onVisibilityChange)

  return function stop() {
    stopped = true
    clearTimeout(timer)
    doc.removeEventListener('visibilitychange', onVisibilityChange)
  }
}
