// Behavioural tests for the polling rules. The scheduling lives in polling.js
// so it can be driven by a fake clock and a fake document — no renderer needed.
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  startBetsPolling,
  POLL_INTERVAL_MS,
  POLL_JITTER_MS,
  POLL_MAX_BACKOFF_MS,
} from './polling.js'

// A controllable stand-in for setTimeout / document.
function makeEnv() {
  const state = { hidden: false, timers: [], listeners: new Map() }
  state.doc = {
    get hidden() {
      return state.hidden
    },
    addEventListener(type, fn) {
      state.listeners.set(type, fn)
    },
    removeEventListener(type) {
      state.listeners.delete(type)
    },
  }
  return state
}

// Patches the global timer functions for the duration of one test. The poller
// reschedules itself after every poll, so firing a timer here replaces it with
// the next one — which is what makes the backoff observable.
function withFakeTimers(run) {
  const originalSet = globalThis.setTimeout
  const originalClear = globalThis.clearTimeout
  const env = makeEnv()
  globalThis.setTimeout = (fn, ms) => {
    const timer = { fn, ms }
    env.timers.push(timer)
    return timer
  }
  globalThis.clearTimeout = (timer) => {
    env.timers = env.timers.filter((entry) => entry !== timer)
  }
  try {
    const result = run(env)
    if (result && typeof result.then === 'function') {
      return result.finally(() => {
        globalThis.setTimeout = originalSet
        globalThis.clearTimeout = originalClear
      })
    }
    globalThis.setTimeout = originalSet
    globalThis.clearTimeout = originalClear
  } catch (error) {
    globalThis.setTimeout = originalSet
    globalThis.clearTimeout = originalClear
    throw error
  }
}

// Fires the pending timer, lets the poller settle, and reports the period the
// poller then chose — which is the interesting one, since that is where the
// backoff shows up.
async function advance(env) {
  const pending = env.timers[env.timers.length - 1]
  if (!pending) throw new Error('nothing scheduled')
  env.timers = []
  pending.fn()
  await settle()
  return nextPeriod(env)
}

const settle = async () => {
  for (let i = 0; i < 5; i++) await Promise.resolve()
}

const nextPeriod = (env) => env.timers[env.timers.length - 1]?.ms

// ---------- the rate ----------

test('the poll rate is 2-4 seconds', () => {
  assert.equal(POLL_INTERVAL_MS, 2000)
  assert.equal(POLL_JITTER_MS, 2000)
  // The pair is the whole request: the fastest a client polls, and the slowest.
  assert.equal(POLL_INTERVAL_MS + POLL_JITTER_MS, 4000)
})

test('clients are staggered across the window instead of firing together', async () => {
  const periods = []
  for (const r of [0, 0.25, 0.5, 0.75, 1]) {
    await withFakeTimers(async (env) => {
      const stop = startBetsPolling({ doc: env.doc, poll: () => {}, random: () => r })
      periods.push(nextPeriod(env))
      stop()
    })
  }
  assert.deepEqual(periods, [2000, 2500, 3000, 3500, 4000])
  assert.equal(new Set(periods).size, periods.length, 'no two clients land together')
})

test('the interval holds steady while the service is healthy', async () => {
  await withFakeTimers(async (env) => {
    const stop = startBetsPolling({ doc: env.doc, jitterMs: 0, poll: () => true })
    assert.equal(nextPeriod(env), POLL_INTERVAL_MS)
    assert.equal(await advance(env), POLL_INTERVAL_MS)
    assert.equal(await advance(env), POLL_INTERVAL_MS)
    stop()
  })
})

// ---------- backoff ----------

test('consecutive failures back the poll off, so throttling cannot spiral', async () => {
  await withFakeTimers(async (env) => {
    // Always failing: a 2-4s request has hit a limit and must give up space. The
    // opening fetch counts as the first failure, so by the time the first tick
    // has also failed the period is already 4x.
    const stop = startBetsPolling({ doc: env.doc, jitterMs: 0, poll: () => false })
    assert.equal(nextPeriod(env), POLL_INTERVAL_MS, 'one fast attempt before the backoff starts')
    assert.equal(await advance(env), 8000, '2 failures')
    assert.equal(await advance(env), 16000, '3 failures')
    assert.equal(await advance(env), POLL_MAX_BACKOFF_MS, 'and then it stops growing')
    assert.equal(await advance(env), POLL_MAX_BACKOFF_MS)
    stop()
  })
})

test('one success puts the poll straight back to 2-4s', async () => {
  await withFakeTimers(async (env) => {
    let healthy = false
    const stop = startBetsPolling({ doc: env.doc, jitterMs: 0, poll: () => healthy })
    assert.equal(await advance(env), 8000, 'backed off')
    assert.equal(await advance(env), 16000, 'backed off further')

    healthy = true
    assert.equal(await advance(env), POLL_INTERVAL_MS, 'recovered immediately, not gradually')
    stop()
  })
})

test('a skipped tick is not treated as a failure', async () => {
  await withFakeTimers(async (env) => {
    // useBets returns true for a tick it dropped because one was already in
    // flight. Backing off for being busy would punish the busiest moments.
    const stop = startBetsPolling({ doc: env.doc, jitterMs: 0, poll: () => true })
    assert.equal(await advance(env), POLL_INTERVAL_MS)
    stop()
  })
})

// ---------- visibility ----------

test('fetches once immediately on start', async () => {
  await withFakeTimers(async (env) => {
    const calls = []
    const stop = startBetsPolling({ doc: env.doc, jitterMs: 0, poll: () => calls.push('poll') })
    assert.deepEqual(calls, ['poll'])
    stop()
  })
})

test('polls on every tick while the tab is visible', async () => {
  await withFakeTimers(async (env) => {
    const calls = []
    const stop = startBetsPolling({ doc: env.doc, jitterMs: 0, poll: () => calls.push('poll') })
    await advance(env)
    await advance(env)
    assert.deepEqual(calls, ['poll', 'poll', 'poll'], 'initial + two ticks')
    stop()
  })
})

test('does not poll on a tick while the tab is hidden, but keeps the schedule', async () => {
  await withFakeTimers(async (env) => {
    const calls = []
    const stop = startBetsPolling({ doc: env.doc, jitterMs: 0, poll: () => calls.push('poll') })
    env.hidden = true
    await advance(env)
    await advance(env)
    assert.deepEqual(calls, ['poll'], 'only the initial fetch happened')
    stop()
  })
})

test('resumes polling once the tab is visible again', async () => {
  await withFakeTimers(async (env) => {
    const calls = []
    const stop = startBetsPolling({ doc: env.doc, jitterMs: 0, poll: () => calls.push('poll') })
    env.hidden = true
    await advance(env)
    env.hidden = false
    await advance(env)
    assert.deepEqual(calls, ['poll', 'poll'])
    stop()
  })
})

test('becoming visible fetches immediately instead of waiting out a backed-off period', async () => {
  await withFakeTimers(async (env) => {
    const calls = []
    // Once the period has backed off to 30s, someone switching back to the tab
    // should not wait 30 seconds for the board.
    const stop = startBetsPolling({ doc: env.doc, jitterMs: 0, poll: () => { calls.push('poll'); return false } })
    await advance(env)
    await advance(env)
    await advance(env)
    await advance(env)
    assert.equal(nextPeriod(env), POLL_MAX_BACKOFF_MS, 'backed all the way off')
    const before = calls.length

    env.listeners.get('visibilitychange')()
    await settle()
    assert.equal(calls.length, before + 1, 'returning to the tab fetches at once')
    assert.equal(nextPeriod(env), POLL_MAX_BACKOFF_MS, 'and the failures still count')
    stop()
  })
})

// ---------- configuration and teardown ----------

test('a custom interval is honoured', async () => {
  await withFakeTimers(async (env) => {
    const calls = []
    const stop = startBetsPolling({ doc: env.doc, jitterMs: 0, poll: () => calls.push('poll'), intervalMs: 1000 })
    assert.equal(await advance(env), 1000)
    assert.equal(await advance(env), 1000)
    assert.deepEqual(calls, ['poll', 'poll', 'poll'])
    stop()
  })
})

test('stop clears the timer, detaches the listener, and cannot be restarted', async () => {
  await withFakeTimers(async (env) => {
    const calls = []
    const stop = startBetsPolling({ doc: env.doc, jitterMs: 0, poll: () => calls.push('poll') })
    assert.equal(env.timers.length, 1)
    assert.equal(env.listeners.has('visibilitychange'), true)

    // A timer that fires after stop must not poll, and must not reschedule —
    // otherwise a closed tab keeps hitting Apps Script forever.
    const stale = env.timers[env.timers.length - 1]
    stop()
    assert.equal(env.timers.length, 0, 'timer cleared')
    assert.equal(env.listeners.has('visibilitychange'), false, 'listener removed')

    stale.fn()
    await settle()
    assert.deepEqual(calls, ['poll'], 'no polls after stop')
    assert.equal(env.timers.length, 0, 'and nothing rescheduled')
  })
})
