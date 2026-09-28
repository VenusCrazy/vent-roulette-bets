// Behavioural tests for the polling rules. The scheduling lives in polling.js
// so it can be driven by a fake clock and a fake document — no renderer needed.
import test from 'node:test'
import assert from 'node:assert/strict'
import { startBetsPolling, POLL_INTERVAL_MS } from './polling.js'

// A controllable stand-in for setInterval / document.
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
  state.ticks = (ms) => {
    for (const timer of state.timers) {
      if (timer.ms === ms) timer.fn()
    }
  }
  return state
}

// Patches the global timer functions for the duration of one test.
function withFakeTimers(run) {
  const originalSet = globalThis.setInterval
  const originalClear = globalThis.clearInterval
  const env = makeEnv()
  globalThis.setInterval = (fn, ms) => {
    const timer = { fn, ms }
    env.timers.push(timer)
    return timer
  }
  globalThis.clearInterval = (timer) => {
    env.timers = env.timers.filter((entry) => entry !== timer)
  }
  try {
    run(env)
  } finally {
    globalThis.setInterval = originalSet
    globalThis.clearInterval = originalClear
  }
}

test('the default interval is 15 seconds', () => {
  assert.equal(POLL_INTERVAL_MS, 15000)
})

test('fetches once immediately on start', () => {
  withFakeTimers((env) => {
    const calls = []
    const stop = startBetsPolling({ doc: env.doc, poll: () => calls.push('poll') })
    assert.deepEqual(calls, ['poll'])
    stop()
  })
})

test('polls on every interval tick while the tab is visible', () => {
  withFakeTimers((env) => {
    const calls = []
    const stop = startBetsPolling({ doc: env.doc, poll: () => calls.push('poll') })
    env.ticks(POLL_INTERVAL_MS)
    env.ticks(POLL_INTERVAL_MS)
    assert.deepEqual(calls, ['poll', 'poll', 'poll'], 'initial + two ticks')
    stop()
  })
})

test('does not poll on a tick while the tab is hidden', () => {
  withFakeTimers((env) => {
    const calls = []
    const stop = startBetsPolling({ doc: env.doc, poll: () => calls.push('poll') })
    env.hidden = true
    env.ticks(POLL_INTERVAL_MS)
    env.ticks(POLL_INTERVAL_MS)
    assert.deepEqual(calls, ['poll'], 'only the initial fetch happened')
    stop()
  })
})

test('resumes polling on later ticks once the tab is visible again', () => {
  withFakeTimers((env) => {
    const calls = []
    const stop = startBetsPolling({ doc: env.doc, poll: () => calls.push('poll') })
    env.hidden = true
    env.ticks(POLL_INTERVAL_MS)
    env.hidden = false
    env.ticks(POLL_INTERVAL_MS)
    assert.deepEqual(calls, ['poll', 'poll'])
    stop()
  })
})

test('becoming visible fetches immediately instead of waiting for a tick', () => {
  withFakeTimers((env) => {
    const calls = []
    const stop = startBetsPolling({ doc: env.doc, poll: () => calls.push('poll') })
    env.hidden = true
    env.listeners.get('visibilitychange')()
    assert.deepEqual(calls, ['poll'], 'staying hidden does not fetch')

    env.hidden = false
    env.listeners.get('visibilitychange')()
    assert.deepEqual(calls, ['poll', 'poll'], 'returning to the tab fetches at once')
    stop()
  })
})

test('a custom interval is honoured', () => {
  withFakeTimers((env) => {
    const calls = []
    const stop = startBetsPolling({ doc: env.doc, poll: () => calls.push('poll'), intervalMs: 1000 })
    env.ticks(1000)
    env.ticks(POLL_INTERVAL_MS)
    assert.deepEqual(calls, ['poll', 'poll'], 'only the 1s tick fired')
    stop()
  })
})

test('stop clears the interval and detaches the listener', () => {
  withFakeTimers((env) => {
    const calls = []
    const stop = startBetsPolling({ doc: env.doc, poll: () => calls.push('poll') })

    assert.equal(env.timers.length, 1)
    assert.equal(env.listeners.has('visibilitychange'), true)

    stop()

    assert.equal(env.timers.length, 0, 'interval cleared')
    assert.equal(env.listeners.has('visibilitychange'), false, 'listener removed')

    env.ticks(POLL_INTERVAL_MS)
    assert.deepEqual(calls, ['poll'], 'no polls after stop')
  })
})
