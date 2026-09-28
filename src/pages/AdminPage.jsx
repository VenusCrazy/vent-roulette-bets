import { useState, useEffect, useCallback } from 'react'
import AdminDeclareWinner from '../components/AdminDeclareWinner.jsx'
import { VENTS, VENT_MIN, VENT_MAX } from '../config/gameConfig.js'
import { declareResult, getBets, resetRound } from '../api/betting.js'
import amongus from '../assets/amonguscharacter.png'

const EMPTY_PICKS = { winner: null, loser1: null, loser2: null }
const PICK_FIELDS = ['winner', 'loser1', 'loser2']

// A <select> hands back a string. Keep state as vent numbers everywhere.
function toVent(value) {
  if (value === '' || value == null) return null
  const n = Number(value)
  return Number.isInteger(n) && n >= VENT_MIN && n <= VENT_MAX ? n : null
}

function ventName(vent) {
  return vent == null ? '' : `Vent ${vent}`
}

export default function AdminPage() {
  const [picks, setPicks] = useState(EMPTY_PICKS)
  const [reviewing, setReviewing] = useState(false)
  const [confirming, setConfirming] = useState(false)
  const [result, setResult] = useState(null)
  const [error, setError] = useState('')
  const [currentBets, setCurrentBets] = useState([])
  const [round, setRound] = useState(null)
  const [loadingBets, setLoadingBets] = useState(true)
  const [lastResolvedBets, setLastResolvedBets] = useState(null)

  // The refresh (archive & clear) control has its own two-step confirm, so it
  // can never be fired by accident mid-declaration.
  const [refreshArmed, setRefreshArmed] = useState(false)
  const [refreshBusy, setRefreshBusy] = useState(false)
  const [refreshMessage, setRefreshMessage] = useState('')

  const refreshBets = useCallback(async () => {
    const data = await getBets()
    const bets = Array.isArray(data?.bets) ? data.bets : []
    setRound(Number.isInteger(data?.round) ? data.round : null)
    setCurrentBets(
      bets.map((bet) => ({
        id: bet.teamCode ?? '—',
        name: bet.teamName,
        betAmount: Number(bet.amount),
        vent: Number(bet.vent),
      }))
    )
  }, [])

  // Manual refresh: show the spinner, then reload.
  const fetchBets = useCallback(async () => {
    setLoadingBets(true)
    setError('')
    try {
      await refreshBets()
    } catch (err) {
      setError(err?.message ?? 'Could not refresh bets.')
    } finally {
      setLoadingBets(false)
    }
  }, [refreshBets])

  // Mount load, chained like LandingPage so the state updates land in
  // promise callbacks rather than synchronously in the effect body.
  useEffect(() => {
    Promise.resolve()
      .then(refreshBets)
      .catch((err) => {
        setError(err?.message ?? 'Could not refresh bets.')
      })
      .finally(() => setLoadingBets(false))
  }, [refreshBets])

  // The selects already disable vents chosen elsewhere, but enforcing it here
  // too means a duplicate can never reach the payload, whatever the UI does.
  const handlePick = useCallback((field, value) => {
    setPicks((prev) => {
      const next = { ...prev, [field]: toVent(value) }
      const seen = new Set()
      for (const key of PICK_FIELDS) {
        const chosen = next[key]
        if (chosen == null) continue
        if (seen.has(chosen)) next[key] = null
        else seen.add(chosen)
      }
      return next
    })
    setResult(null)
    setError('')
  }, [])

  const handleStartReview = useCallback(() => {
    const { winner, loser1, loser2 } = picks
    if (winner == null || loser1 == null || loser2 == null) {
      setError('Choose a winning vent and two losing vents before declaring.')
      return
    }
    if (new Set([winner, loser1, loser2]).size !== 3) {
      setError('The winning vent and the two losing vents must all be different.')
      return
    }
    setError('')
    setReviewing(true)
  }, [picks])

  const handleCancelReview = useCallback(() => {
    setReviewing(false)
  }, [])

  const handleCommit = useCallback(async () => {
    const { winner, loser1, loser2 } = picks
    if (confirming || winner == null || loser1 == null || loser2 == null) return

    setConfirming(true)
    setError('')
    setResult(null)
    const betsForResolution = [...currentBets]

    try {
      const data = await declareResult({
        winningVent: winner,
        losingVent1: loser1,
        losingVent2: loser2,
      })
      const nextRound = Number.isInteger(data?.nextRound) ? data.nextRound : null
      setResult(
        `Settled ${data.settled} bets — winning Vent ${data.winningVent}.` +
          (nextRound != null ? ` Round ${nextRound} is now open for betting.` : '')
      )
      setLastResolvedBets({ winner, losers: [loser1, loser2], bets: betsForResolution })
      setPicks(EMPTY_PICKS)
      setReviewing(false)
      await fetchBets()
    } catch (err) {
      setError(err?.message ?? 'Connection error — try again')
      setReviewing(false)
    } finally {
      setConfirming(false)
    }
  }, [picks, confirming, currentBets, fetchBets])

  // First click arms the button; the second actually archives and clears.
  const handleRefreshRound = useCallback(async () => {
    if (refreshBusy) return
    if (!refreshArmed) {
      setRefreshArmed(true)
      setRefreshMessage('')
      return
    }
    setRefreshBusy(true)
    setRefreshMessage('')
    try {
      const data = await resetRound()
      setRefreshMessage(
        data.archived
          ? `Archived ${data.archived} bet(s), started the next round and returned ${data.returned ?? data.archived} held stake(s). Nothing was settled.`
          : 'Nothing to archive — no bets are live.'
      )
      setRefreshArmed(false)
      await fetchBets()
    } catch (err) {
      setRefreshMessage(err?.message ?? 'Connection error — try again')
      setRefreshArmed(false)
    } finally {
      setRefreshBusy(false)
    }
  }, [refreshArmed, refreshBusy, fetchBets])

  return (
    <div className="mx-auto max-w-4xl">
      <header className="mb-8 text-center">
        <img src={amongus} alt="" aria-hidden className="mx-auto mb-3 h-9 w-9 object-contain" />
        <h1 className="font-display font-bold text-5xl tracking-wide text-siren-light text-shadow-pirate">
          Declare Result
        </h1>
        <p className="mt-3 text-slate-400">
          Name the vent that carried the day and the two that lost. The winner&apos;s bets are
          paid twice their stake; every other bet loses its stake.
        </p>
        <div
          aria-hidden
          className="mx-auto mt-6 h-px w-40 bg-gradient-to-r from-transparent via-siren to-transparent"
        />
      </header>

      <AdminDeclareWinner
        vents={VENTS}
        ventName={ventName}
        picks={picks}
        onPick={handlePick}
        reviewing={reviewing}
        onStartReview={handleStartReview}
        onCancelReview={handleCancelReview}
        onCommit={handleCommit}
        confirming={confirming}
        result={result}
        error={error}
        currentBets={currentBets}
        loadingBets={loadingBets}
        onRefreshBets={fetchBets}
        lastResolvedBets={lastResolvedBets}
        round={round}
      />

      <section className="mt-6 rounded-2xl border border-white/15 bg-abyss-950/60 backdrop-blur-sm">
        <header className="border-b border-white/10 px-5 py-4">
          <h2 className="font-display font-bold text-2xl tracking-wide text-slate-200">
            Refresh Round
          </h2>
          <p className="mt-1 text-xs text-slate-400">
            Archives the live round, starts the next one and hands every held stake straight back.
            Nothing is settled and no points move — declaring a result does that, so a refresh is
            always safe to run.
          </p>
        </header>
        <div className="flex flex-col gap-4 p-5">
          {refreshMessage ? (
            <p
              role="status"
              className="rounded-xl border border-white/15 bg-white/5 px-4 py-3 text-sm text-slate-200"
            >
              {refreshMessage}
            </p>
          ) : null}

          <button
            type="button"
            onClick={handleRefreshRound}
            disabled={refreshBusy}
            className={`flex w-full items-center justify-center gap-2 rounded-xl px-5 py-3 font-display font-bold tracking-wide transition-all disabled:cursor-not-allowed disabled:opacity-50 ${
              refreshArmed
                ? 'bg-gradient-to-r from-flame-dark via-flame to-flame-dark text-white hover:brightness-110'
                : 'border border-white/15 bg-white/5 text-slate-200 hover:bg-white/10'
            }`}
          >
            {refreshBusy ? (
              <span
                aria-hidden
                className="h-4 w-4 animate-spin rounded-full border-2 border-white/30 border-t-white"
              />
            ) : null}
            {refreshBusy
              ? 'Archiving…'
              : refreshArmed
                ? 'Click again to archive & clear'
                : '↻ Refresh round'}
          </button>
        </div>
      </section>
    </div>
  )
}
