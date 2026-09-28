const APPS_SCRIPT_URL = import.meta.env?.VITE_APPS_SCRIPT_URL || ''

export function validateBetInput({ teamCode, amount, vent }) {
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

  return ''
}

export function createBettingApi(baseUrl, fetchImpl = globalThis.fetch) {
  async function request(url, options) {
    if (!baseUrl) {
      throw new Error('VITE_APPS_SCRIPT_URL is not set — add it to .env')
    }

    let response
    try {
      response = await fetchImpl(url, options)
    } catch {
      throw new Error('Network error — could not reach the betting service')
    }

    let payload
    try {
      payload = await response.json()
    } catch {
      throw new Error('The betting service did not return valid JSON')
    }

    if (!response.ok || payload?.ok !== true) {
      throw new Error(payload?.error || `Betting service request failed (HTTP ${response.status})`)
    }

    return Object.fromEntries(Object.entries(payload).filter(([key]) => key !== 'ok'))
  }

  function post(payload) {
    // Deliberately no custom headers: Apps Script does not answer CORS preflight.
    return request(baseUrl, {
      method: 'POST',
      body: JSON.stringify(payload),
    })
  }

  return {
    getBets() {
      const separator = baseUrl.includes('?') ? '&' : '?'
      return request(`${baseUrl}${separator}action=getBets`, { method: 'GET' })
    },

    placeBet({ teamCode, amount, vent }) {
      const validationError = validateBetInput({ teamCode, amount, vent })
      if (validationError) throw new Error(validationError)

      return post({
        action: 'placeBet',
        teamCode: String(teamCode).trim(),
        amount: Number(amount),
        vent: Number(vent),
      })
    },

    declareResult({ winningVent, losingVent1, losingVent2, adminKey }) {
      return post({
        action: 'declareResult',
        winningVent: Number(winningVent),
        losingVent1: Number(losingVent1),
        losingVent2: Number(losingVent2),
        adminKey,
      })
    },
  }
}

const bettingApi = createBettingApi(APPS_SCRIPT_URL)

export const getBets = (...args) => bettingApi.getBets(...args)
export const placeBet = (...args) => bettingApi.placeBet(...args)
export const declareResult = (...args) => bettingApi.declareResult(...args)
