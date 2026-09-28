import test from 'node:test'
import assert from 'node:assert/strict'
import { createBettingApi, validateBetInput, DEFAULT_TIMEOUT_MS } from '../src/api/betting.js'

function response(body, { status = 200, jsonError } = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async json() {
      if (jsonError) throw jsonError
      return body
    },
  }
}

test('getBets sends the specified GET query and returns its success payload', async () => {
  let request
  const api = createBettingApi('https://script.example/exec', async (...args) => {
    request = args
    return response({ ok: true, bets: [{ teamName: 'Alpha', amount: 200, vent: 1 }], totalPoints: 200, activeBets: 1 })
  })

  const before = Date.now()
  const result = await api.getBets()

  const url = new URL(request[0])
  assert.equal(url.origin + url.pathname, 'https://script.example/exec')
  assert.equal(url.searchParams.get('action'), 'getBets')
  // Apps Script caches aggressively; the timestamp keeps polling honest.
  assert.ok(url.searchParams.get('_'), 'expected a cache-busting _ param')
  assert.ok(Number(url.searchParams.get('_')) >= before)
  assert.equal(request[1].method, 'GET')
  assert.deepEqual(result, {
    bets: [{ teamName: 'Alpha', amount: 200, vent: 1 }],
    totalPoints: 200,
    activeBets: 1,
  })
})

test('a base URL that already has a query string still gets the cache buster', async () => {
  let requested = ''
  const api = createBettingApi('https://script.example/exec?foo=bar', async (url) => {
    requested = url
    return response({ ok: true, bets: [] })
  })
  await api.getBets()
  const url = new URL(requested)
  assert.equal(url.searchParams.get('foo'), 'bar')
  assert.equal(url.searchParams.get('action'), 'getBets')
  assert.ok(url.searchParams.get('_'))
})

// Apps Script does not answer CORS preflight, so a POST must stay inside the
// CORS-safelisted set: no custom headers, and a Content-Type whose value is
// byte-equal to a safelisted MIME type. "application/json" — or a charset
// parameter on text/plain — would both trigger a preflight and fail.
function assertNoPreflight(init) {
  const headers = init.headers ?? {}
  const names = Object.keys(headers).map((name) => name.toLowerCase())
  assert.ok(
    names.every((name) => name === 'content-type'),
    `unexpected header(s) would trigger a preflight: ${names.join(', ')}`
  )
  if ('content-type' in headers) {
    const value = String(headers['content-type']).toLowerCase()
    assert.ok(
      ['text/plain', 'application/x-www-form-urlencoded', 'multipart/form-data'].includes(value),
      `Content-Type "${value}" is not CORS-safelisted and would trigger a preflight`
    )
  }
  assert.notEqual(init.mode, 'no-cors', 'no-cors makes the response unreadable')
}

test('getTeams asks for the roster and can narrow it with q', async () => {
  let request
  const api = createBettingApi('https://script.example/exec', async (...args) => {
    request = args
    return response({ ok: true, teams: [{ teamCode: '1092', teamName: 'Alpha', totalScore: 500 }] })
  })

  const all = await api.getTeams()
  const url = new URL(request[0])
  assert.equal(url.searchParams.get('action'), 'getTeams')
  assert.equal(url.searchParams.get('q'), null, 'no search term is sent when there is none')
  assert.ok(url.searchParams.get('_'), 'expected a cache-busting _ param')
  assert.equal(request[1].method, 'GET')
  assert.deepEqual(all.teams, [{ teamCode: '1092', teamName: 'Alpha', totalScore: 500 }])

  await api.getTeams({ q: ' alp ' })
  assert.equal(new URL(request[0]).searchParams.get('q'), 'alp', 'the search term is trimmed')
})

test('getScore asks for one team by code and returns its total score', async () => {
  let request
  const api = createBettingApi('https://script.example/exec', async (...args) => {
    request = args
    return response({ ok: true, teamCode: '1092', teamName: 'Alpha', totalScore: 500 })
  })

  const result = await api.getScore({ teamCode: ' 1092 ' })

  const url = new URL(request[0])
  assert.equal(url.searchParams.get('action'), 'getScore')
  assert.equal(url.searchParams.get('teamCode'), '1092', 'the code is trimmed before it is sent')
  assert.ok(url.searchParams.get('_'), 'expected a cache-busting _ param')
  assert.equal(request[1].method, 'GET')
  assert.deepEqual(result, { teamCode: '1092', teamName: 'Alpha', totalScore: 500 })
})

test('getScore surfaces an unknown team verbatim and does not call the server for a blank code', async () => {
  const unknown = createBettingApi('https://script.example/exec', async () =>
    response({ ok: false, error: 'Unknown team ID' })
  )
  await assert.rejects(unknown.getScore({ teamCode: '9999' }), /Unknown team ID/)

  let called = false
  const blank = createBettingApi('https://script.example/exec', async () => {
    called = true
    return response({ ok: true })
  })
  await assert.rejects(blank.getScore({ teamCode: '   ' }), /Team ID/)
  assert.equal(called, false, 'a blank code is rejected without a pointless request')
})

test('placeBet posts exactly the specified payload without custom headers', async () => {
  let request
  const api = createBettingApi('https://script.example/exec', async (...args) => {
    request = args
    return response({ ok: true, pointsAfterBet: 800 })
  })

  const result = await api.placeBet({ teamCode: '1092', amount: 200, vent: 4 })

  assert.equal(request[0], 'https://script.example/exec')
  assert.equal(request[1].method, 'POST')
  assert.equal(request[1].body, JSON.stringify({ action: 'placeBet', teamCode: '1092', amount: 200, vent: 4 }))
  assert.deepEqual(request[1].headers, { 'Content-Type': 'text/plain' })
  assertNoPreflight(request[1])
  assert.deepEqual(result, { pointsAfterBet: 800 })
})

test('declareResult posts the winning and losing vents without custom headers', async () => {
  let request
  const api = createBettingApi('https://script.example/exec', async (...args) => {
    request = args
    return response({ ok: true, settled: 7, winningVent: 6 })
  })

  const result = await api.declareResult({
    winningVent: 6,
    losingVent1: 2,
    losingVent2: 9,
  })

  const { signal, ...init } = request[1]
  assert.ok(signal instanceof AbortSignal)
  assert.deepEqual(init, {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain' },
    body: JSON.stringify({
      action: 'declareResult',
      winningVent: 6,
      losingVent1: 2,
      losingVent2: 9,
    }),
  })
  assertNoPreflight(request[1])
  assert.deepEqual(result, { settled: 7, winningVent: 6 })
})

test('resetRound posts only the action, without custom headers', async () => {
  let request
  const api = createBettingApi('https://script.example/exec', async (...args) => {
    request = args
    return response({ ok: true, archived: 3 })
  })

  const result = await api.resetRound()

  assert.equal(request[0], 'https://script.example/exec')
  assert.equal(request[1].method, 'POST')
  assert.equal(request[1].body, JSON.stringify({ action: 'resetRound' }))
  assertNoPreflight(request[1])
  assert.deepEqual(result, { archived: 3 })
})

test('every request carries an AbortSignal so a hung call cannot hang the UI', async () => {
  const seen = []
  const api = createBettingApi('https://script.example/exec', async (url, init) => {
    seen.push(init.signal)
    return response({ ok: true })
  })
  await api.getBets()
  await api.placeBet({ teamCode: '1092', amount: 10, vent: 1 })
  assert.equal(seen.length, 2)
  for (const signal of seen) {
    assert.ok(signal, 'expected an AbortSignal on the request')
    assert.equal(signal.aborted, false)
  }
})

// ---------- the cold start ----------
//
// An Apps Script container is shut down when idle, so the first request after a
// pause pays a cold start: measured at 12-15s against the live deployment while
// a warm call is 2-3s. That is why a request is given a second attempt before
// it is called a failure.

const abortError = () => {
  const error = new Error('The operation was aborted.')
  error.name = 'AbortError'
  return error
}
const networkError = () => {
  const error = new Error('Failed to fetch')
  error.name = 'TypeError'
  return error
}

test('a request that outlives the timeout twice rejects with a friendly message', async () => {
  let attempts = 0
  const api = createBettingApi(
    'https://script.example/exec',
    (url, init) => {
      attempts += 1
      return new Promise((resolve, reject) => {
        init.signal.addEventListener('abort', () => reject(abortError()))
      })
    },
    { timeoutMs: 25, retryDelayMs: 0 }
  )
  await assert.rejects(api.getBets(), /too long|timed out/i)
  assert.equal(attempts, 2, 'one attempt, one retry, and no more')
})

test('a cold start is retried and the retry is what the caller sees', async () => {
  let attempts = 0
  const api = createBettingApi(
    'https://script.example/exec',
    async () => {
      attempts += 1
      if (attempts === 1) throw abortError()
      return response({ ok: true, bets: [{ teamName: 'Alpha', amount: 200, vent: 1 }] })
    },
    { timeoutMs: 25, retryDelayMs: 0 }
  )
  const result = await api.getBets()
  assert.equal(attempts, 2)
  assert.equal(result.bets.length, 1, 'the sleeper is woken and nobody is told')
})

test('a request that never reached the server is retried too', async () => {
  let attempts = 0
  const api = createBettingApi(
    'https://script.example/exec',
    async () => {
      attempts += 1
      if (attempts === 1) throw networkError()
      return response({ ok: true, activeBets: 0 })
    },
    { timeoutMs: 25, retryDelayMs: 0 }
  )
  assert.deepEqual(await api.getBets(), { activeBets: 0 })
  assert.equal(attempts, 2)
})

test('a genuine error from the script is shown once, not retried away', async () => {
  let attempts = 0
  const api = createBettingApi(
    'https://script.example/exec',
    async () => {
      attempts += 1
      return response({ ok: false, error: 'Unknown team ID' })
    },
    { timeoutMs: 25, retryDelayMs: 0 }
  )
  await assert.rejects(api.getScore({ teamCode: '9999' }), /Unknown team ID/)
  assert.equal(attempts, 1, 'a rejection is an answer, not a transport failure')
})

test('a retry that finds the bet already placed is reported as the success it is', async () => {
  // The first attempt timed out but had already landed. placeBet refuses a
  // second bet from the same team, so that refusal is proof the bet went in.
  let attempts = 0
  const api = createBettingApi(
    'https://script.example/exec',
    async () => {
      attempts += 1
      if (attempts === 1) throw abortError()
      return response({ ok: false, error: 'This team has already placed a bet this round' })
    },
    { timeoutMs: 25, retryDelayMs: 0 }
  )
  const result = await api.placeBet({ teamCode: '1092', amount: 200, vent: 3 })
  assert.deepEqual(result, { reconciled: true })
  assert.equal(attempts, 2)
})

test('"already placed a bet" is still an error when nothing was retried', async () => {
  // The user really is betting twice. The reconciliation above must not paper
  // over a genuine second attempt.
  const api = createBettingApi('https://script.example/exec', async () =>
    response({ ok: false, error: 'This team has already placed a bet this round' })
  )
  await assert.rejects(
    api.placeBet({ teamCode: '1092', amount: 200, vent: 3 }),
    /already placed a bet this round/
  )
})

test('the default timeout is long enough for a cold start', () => {
  // Measured warm at 2-3s and cold at 12-15s on the live deployment. The old
  // 20s ceiling failed precisely when the service was slowest.
  assert.equal(DEFAULT_TIMEOUT_MS, 25000)
})

test('bet input validation requires team code, positive whole amount, and vent 1-9', () => {
  assert.equal(validateBetInput({ teamCode: '  ', amount: 20, vent: 1 }), 'Enter your Team ID.')
  assert.equal(validateBetInput({ teamCode: '1092', amount: 0, vent: 1 }), 'Enter a positive whole-number bet amount.')
  assert.equal(validateBetInput({ teamCode: '1092', amount: 2.5, vent: 1 }), 'Enter a positive whole-number bet amount.')
  assert.equal(validateBetInput({ teamCode: '1092', amount: 20, vent: null }), 'Choose a target vent.')
  assert.equal(validateBetInput({ teamCode: '1092', amount: 20, vent: 10 }), 'Choose a valid vent from 1 to 9.')
  assert.equal(validateBetInput({ teamCode: '1092', amount: 20, vent: 9 }), '')
})

// The form mirrors the sheet's own ceiling so a bet that cannot possibly land is
// caught before the round trip, with the same words the server would use.
test('bet validation enforces the points ceiling once the team score is known', () => {
  assert.equal(validateBetInput({ teamCode: '1092', amount: 499, vent: 1, maxPoints: 500 }), '')
  assert.equal(validateBetInput({ teamCode: '1092', amount: 500, vent: 1, maxPoints: 500 }), '', 'a bet equal to the score is allowed')
  assert.equal(validateBetInput({ teamCode: '1092', amount: 501, vent: 1, maxPoints: 500 }), 'Bet exceeds your total score (500).')
  // A non-numeric or absent ceiling must not block an otherwise valid bet.
  assert.equal(validateBetInput({ teamCode: '1092', amount: 9999, vent: 1 }), '')
  assert.equal(validateBetInput({ teamCode: '1092', amount: 9999, vent: 1, maxPoints: null }), '')
  assert.equal(validateBetInput({ teamCode: '1092', amount: 9999, vent: 1, maxPoints: 0 }), 'Bet exceeds your total score (0).')
  // The ceiling never displaces the basic checks.
  assert.equal(validateBetInput({ teamCode: '1092', amount: 0, vent: 1, maxPoints: 500 }), 'Enter a positive whole-number bet amount.')
  assert.equal(validateBetInput({ teamCode: '1092', amount: 600, vent: 99, maxPoints: 500 }), 'Choose a valid vent from 1 to 9.')
})

test('API errors surface server messages, network failures, non-JSON, and not-configured errors', async () => {
  const serverApi = createBettingApi('https://script.example/exec', async () =>
    response({ ok: false, error: 'Not enough points' })
  )
  await assert.rejects(
    serverApi.placeBet({ teamCode: '1092', amount: 200, vent: 1 }),
    /Not enough points/
  )

  const networkApi = createBettingApi('https://script.example/exec', async () => {
    throw new Error('offline')
  })
  await assert.rejects(networkApi.getBets(), /Network error/)

  const invalidJsonApi = createBettingApi('https://script.example/exec', async () =>
    response(null, { jsonError: new SyntaxError('unexpected token') })
  )
  await assert.rejects(invalidJsonApi.getBets(), /valid JSON/)

  await assert.rejects(createBettingApi('', async () => {}).getBets(), /VITE_APPS_SCRIPT_URL/)
})
