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

// An Apps Script web app runs on a container that is shut down when it sits
// idle, so the first call after a pause pays for a cold start on top of the
// work. Measured against the live deployment: 2-3s warm, 12-15s cold. The old
// 20s ceiling therefore failed exactly when the service was slowest, which is
// backwards. 25s leaves room for a cold start; RETRY_BELOW catches the rest.
const DEFAULT_TIMEOUT_MS = 25000

// A cold start is transient by nature, so one retry is worth far more than the
// extra request costs. Long enough that a container still spinning up has
// finished, short enough that nobody is still staring at the button.
const RETRY_DELAY_MS = 1000
const TIMEOUT_MESSAGE = 'The betting service took too long to respond — please try again'

// placeBet is idempotent per team per round: the script refuses a second bet
// from the same team, so a retry can never record the same stake twice. That
// makes retrying a bet safe — and it means "already placed a bet this round"
// coming back from a retry is proof the first attempt got through, not a
// failure to report.
const ALREADY_BETTED = /already placed a bet/i

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
  const { timeoutMs = DEFAULT_TIMEOUT_MS, retryDelayMs = RETRY_DELAY_MS } = options

  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

  // One fetch, with its own abort timer. A retry needs a fresh controller: the
  // first one is already aborted, and reusing it would abort the retry instantly.
  async function attempt(url, init) {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    try {
      return await fetchImpl(url, { ...init, signal: controller.signal })
    } finally {
      clearTimeout(timer)
    }
  }

  async function request(url, init) {
    if (!baseUrl) {
      throw new Error('VITE_APPS_SCRIPT_URL is not set — add it to .env')
    }

    let response
    let retried = false
    try {
      response = await attempt(url, init)
    } catch (error) {
      // AbortError is our own timeout. TypeError is fetch's way of saying the
      // request never reached the server. Both are worth one more go; anything
      // else is a bug in the caller and retrying would only hide it.
      const transient = error?.name === 'AbortError' || error?.name === 'TypeError'
      if (!transient) throw new Error(NETWORK_ERROR, { cause: error })

      await sleep(retryDelayMs)
      retried = true
      try {
        response = await attempt(url, init)
      } catch (retryError) {
        throw new Error(
          retryError?.name === 'AbortError' ? TIMEOUT_MESSAGE : NETWORK_ERROR,
          { cause: retryError }
        )
      }
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
      const message = payload?.error || `Betting service request failed (HTTP ${response.status})`
      if (retried && init?.method === 'POST' && ALREADY_BETTED.test(message)) {
        // The bet landed on the attempt that timed out, and the retry was
        // turned away because the team has already bet. That is a success, and
        // the honest thing to say: the only figure we cannot quote is what is
        // left, so the form falls back to its plain confirmation.
        return { reconciled: true }
      }
      // A real response came back this time, so its error is the true one and
      // is surfaced verbatim.
      throw new Error(message)
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
