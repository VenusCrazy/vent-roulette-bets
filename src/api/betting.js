const APPS_SCRIPT_URL = import.meta.env?.VITE_APPS_SCRIPT_URL || ''

// `maxPoints` is the team's total score, once it has been looked up. The sheet
// refuses a bet that exceeds it, so the form refuses it first with the same
// words. It is optional: an unknown ceiling must not stand between a user and
// a valid bet.
export function validateBetInput({ teamCode, amount, vent, maxPoints }) {
  if (!String(teamCode ?? '').trim()) return 'Enter your Team ID.'

  const numericAmount = Number(amount)
  if (!Number.isInteger(numericAmount) || numericAmount <= 0) {
    return 'Enter a positive whole-number bet amount.'
  }

  const numericVent = Number(vent)
  if (vent == null || vent === '') return 'Choose a target vent.'
  if (!Number.isInteger(numericVent) || numericVent < 1 || numericVent > 9) {
    return 'Choose a valid vent from 1 to 9.'
  }

  if (maxPoints != null && Number.isFinite(Number(maxPoints))) {
    const ceiling = Number(maxPoints)
    if (numericAmount > ceiling) {
      return `Bet exceeds your total score (${ceiling}).`
    }
  }

  return ''
}

// Apps Script can take a few seconds per call; 20s is a ceiling that stops a
// hung request from pinning the UI in a permanent spinner, not a target.
const DEFAULT_TIMEOUT_MS = 20000

const NETWORK_ERROR = 'Network error, please try again'
const INVALID_JSON_ERROR =
  'The betting service did not return valid JSON — check the web app is deployed with access set to "Anyone"'

function buildUrl(baseUrl, action, params = {}) {
  // Apps Script caches aggressively behind a CDN; a timestamp per poll keeps
  // a stale response from looking like "no bets yet".
  const separator = baseUrl.includes('?') ? '&' : '?'
  const query = new URLSearchParams({ action, ...params })
  return `${baseUrl}${separator}${query}&_=${Date.now()}`
}

export { DEFAULT_TIMEOUT_MS }

export function createBettingApi(baseUrl, fetchImpl = globalThis.fetch, options = {}) {
  const { timeoutMs = DEFAULT_TIMEOUT_MS } = options

  async function request(url, init) {
    if (!baseUrl) {
      throw new Error('VITE_APPS_SCRIPT_URL is not set — add it to .env')
    }

    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)

    let response
    try {
      response = await fetchImpl(url, { ...init, signal: controller.signal })
    } catch (error) {
      if (error?.name === 'AbortError') {
        throw new Error('The betting service took too long to respond — please try again', {
          cause: error,
        })
      }
      throw new Error(NETWORK_ERROR, { cause: error })
    } finally {
      clearTimeout(timer)
    }

    let payload
    try {
      payload = await response.json()
    } catch (error) {
      throw new Error(INVALID_JSON_ERROR, { cause: error })
    }

    // Apps Script answers HTTP 200 even for errors, so `ok` is the only
    // trustworthy success signal. `response.ok` is checked too, for the
    // redirect/HTML cases a misconfigured deployment produces.
    if (!response.ok || payload?.ok !== true) {
      throw new Error(payload?.error || `Betting service request failed (HTTP ${response.status})`)
    }

    return Object.fromEntries(Object.entries(payload).filter(([key]) => key !== 'ok'))
  }

  function post(payload) {
    return request(baseUrl, {
      method: 'POST',
      // Apps Script web apps do not answer the CORS preflight (OPTIONS) that any
      // non-safelisted header triggers, and the request then fails outright.
      // 'text/plain' is CORS-safelisted byte-for-byte — no charset parameter,
      // which would make the value unsafe — so this stays preflight-free while
      // still being explicit about the wire format. doPost parses the body as
      // JSON regardless of the declared type. No other headers, no mode override.
      headers: { 'Content-Type': 'text/plain' },
      body: JSON.stringify(payload),
    })
  }

  // Every method rejects rather than throwing synchronously, so callers only
  // ever need one error path.
  return {
    async getBets() {
      return request(buildUrl(baseUrl, 'getBets'), { method: 'GET' })
    },

    async getTeams({ q } = {}) {
      const search = String(q ?? '').trim()
      return request(buildUrl(baseUrl, 'getTeams', search ? { q: search } : {}), { method: 'GET' })
    },

    async getScore({ teamCode }) {
      const code = String(teamCode ?? '').trim()
      if (!code) throw new Error('Enter your Team ID.')
      return request(buildUrl(baseUrl, 'getScore', { teamCode: code }), { method: 'GET' })
    },

    async placeBet({ teamCode, amount, vent, maxPoints }) {
      const validationError = validateBetInput({ teamCode, amount, vent, maxPoints })
      if (validationError) throw new Error(validationError)

      return post({
        action: 'placeBet',
        teamCode: String(teamCode).trim(),
        amount: Number(amount),
        vent: Number(vent),
      })
    },

    async declareResult({ winningVent, losingVent1, losingVent2 }) {
      return post({
        action: 'declareResult',
        winningVent: Number(winningVent),
        losingVent1: Number(losingVent1),
        losingVent2: Number(losingVent2),
      })
    },

    async resetRound() {
      return post({ action: 'resetRound' })
    },
  }
}

const bettingApi = createBettingApi(APPS_SCRIPT_URL)

export const getBets = (...args) => bettingApi.getBets(...args)
export const getTeams = (...args) => bettingApi.getTeams(...args)
export const getScore = (...args) => bettingApi.getScore(...args)
export const placeBet = (...args) => bettingApi.placeBet(...args)
export const declareResult = (...args) => bettingApi.declareResult(...args)
export const resetRound = (...args) => bettingApi.resetRound(...args)
