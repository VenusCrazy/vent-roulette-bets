// ==============================================================
// ReQuest — Google Apps Script backend client
// --------------------------------------------------------------
// Set VITE_APPS_SCRIPT_URL in .env to the deployed Web App URL.
// POST bodies use Content-Type: text/plain;charset=utf-8 (NOT
// application/json) to avoid CORS preflight failures in Apps
// Script Web Apps.
// ==============================================================

const BASE_URL = import.meta.env.VITE_APPS_SCRIPT_URL || ''

const POST_HEADERS = { 'Content-Type': 'text/plain;charset=utf-8' }

function ensureConfigured() {
  if (!BASE_URL) {
    throw new Error('VITE_APPS_SCRIPT_URL is not set — add it to .env')
  }
}

function parseResult(json, fallback) {
  if (!json || typeof json !== 'object') {
    throw new Error('Malformed response from backend')
  }
  if (json.success === true) {
    return json.data ?? {}
  }
  const message = json.data?.message || json.message || json.error || fallback || 'Request failed'
  throw new Error(message)
}

async function postAction(action, payload, fallback) {
  ensureConfigured()
  let json
  try {
    const res = await fetch(BASE_URL, {
      method: 'POST',
      headers: POST_HEADERS,
      body: JSON.stringify({ action, payload }),
    })
    json = await res.json()
  } catch {
    throw new Error('Connection error — try again')
  }
  return parseResult(json, fallback)
}

export async function getLeaderboard() {
  ensureConfigured()
  try {
    const res = await fetch(BASE_URL)
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    return await res.json()
  } catch {
    throw new Error('Connection error — try again')
  }
}

export async function getCurrentBets() {
  return postAction('getCurrentBets', undefined, 'Could not fetch current bets')
}

export async function placeBet({ participantId, betAmount, spacewalker }) {
  return postAction(
    'placeBet',
    {
      participantId,
      betAmount: Number(betAmount),
      spacewalker: String(spacewalker).toLowerCase(),
    },
    'Bet could not be placed'
  )
}

export async function declareWinner(winningSpacewalker) {
  return postAction(
    'updateWinners',
    {
      winningSpacewalker: String(winningSpacewalker).toLowerCase(),
    },
    'Winner could not be declared'
  )
}

export async function getTeamTasks(code) {
  ensureConfigured()
  let json
  try {
    const res = await fetch(BASE_URL, {
      method: 'POST',
      headers: POST_HEADERS,
      body: JSON.stringify({ action: 'getTasks', payload: { code } }),
    })
    json = await res.json()
  } catch {
    throw new Error('Connection error — try again')
  }
  if (json && typeof json === 'object') {
    if (json.success === true && json.data) return json.data
    if (json.team !== undefined) return json
    throw new Error(json.data?.message || json.message || json.error || 'Could not load tasks')
  }
  throw new Error('Malformed response from backend')
}