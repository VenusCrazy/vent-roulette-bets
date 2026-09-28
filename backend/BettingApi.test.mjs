import test from 'node:test'
import assert from 'node:assert/strict'
import { createBettingApi, validateBetInput } from '../src/api/betting.js'

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

  const result = await api.getBets()

  assert.equal(request[0], 'https://script.example/exec?action=getBets')
  assert.deepEqual(request[1], { method: 'GET' })
  assert.deepEqual(result, {
    bets: [{ teamName: 'Alpha', amount: 200, vent: 1 }],
    totalPoints: 200,
    activeBets: 1,
  })
})

test('placeBet posts exactly the specified payload without custom headers', async () => {
  let request
  const api = createBettingApi('https://script.example/exec', async (...args) => {
    request = args
    return response({ ok: true, pointsAfterBet: 800 })
  })

  const result = await api.placeBet({ teamCode: '1092', amount: 200, vent: 4 })

  assert.equal(request[0], 'https://script.example/exec')
  assert.deepEqual(request[1], {
    method: 'POST',
    body: JSON.stringify({ action: 'placeBet', teamCode: '1092', amount: 200, vent: 4 }),
  })
  assert.deepEqual(result, { pointsAfterBet: 800 })
})

test('declareResult posts both losing vents and the admin key without custom headers', async () => {
  let request
  const api = createBettingApi('https://script.example/exec', async (...args) => {
    request = args
    return response({ ok: true, settled: 7, winningVent: 6 })
  })

  const result = await api.declareResult({
    winningVent: 6,
    losingVent1: 2,
    losingVent2: 9,
    adminKey: 'secret',
  })

  assert.deepEqual(request[1], {
    method: 'POST',
    body: JSON.stringify({
      action: 'declareResult',
      winningVent: 6,
      losingVent1: 2,
      losingVent2: 9,
      adminKey: 'secret',
    }),
  })
  assert.deepEqual(result, { settled: 7, winningVent: 6 })
})

test('bet input validation requires team code, positive whole amount, and vent 1-9', () => {
  assert.equal(validateBetInput({ teamCode: '  ', amount: 20, vent: 1 }), 'Enter your Team ID.')
  assert.equal(validateBetInput({ teamCode: '1092', amount: 0, vent: 1 }), 'Enter a positive whole-number bet amount.')
  assert.equal(validateBetInput({ teamCode: '1092', amount: 2.5, vent: 1 }), 'Enter a positive whole-number bet amount.')
  assert.equal(validateBetInput({ teamCode: '1092', amount: 20, vent: null }), 'Choose a target vent.')
  assert.equal(validateBetInput({ teamCode: '1092', amount: 20, vent: 10 }), 'Choose a valid vent from 1 to 9.')
  assert.equal(validateBetInput({ teamCode: '1092', amount: 20, vent: 9 }), '')
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
