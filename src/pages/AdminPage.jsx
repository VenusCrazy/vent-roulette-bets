import { useState, useEffect, useCallback } from 'react'
import AdminDeclareWinner from '../components/AdminDeclareWinner.jsx'
import { SPACEWALKERS } from '../config/gameConfig.js'
import { declareWinner, getCurrentBets } from '../api.js'
import amongus from '../assets/amonguscharacter.png'

export default function AdminPage() {
  const [selected, setSelected] = useState('')
  const [confirming, setConfirming] = useState(false)
  const [result, setResult] = useState(null)
  const [error, setError] = useState('')
  const [currentBets, setCurrentBets] = useState([])
  const [loadingBets, setLoadingBets] = useState(true)
  const [lastResolvedBets, setLastResolvedBets] = useState(null)

  const refreshBets = useCallback(async () => {
    try {
      const data = await getCurrentBets()
      setCurrentBets(Array.isArray(data?.bets) ? data.bets : [])
    } catch (err) {
      console.error('Failed to fetch current bets on admin page:', err?.message)
    } finally {
      setLoadingBets(false)
    }
  }, [])

  // Manual refresh: show the spinner, then reload.
  const fetchBets = useCallback(async () => {
    setLoadingBets(true)
    await refreshBets()
  }, [refreshBets])

  // Mount load, chained like LandingPage so the state updates land in
  // promise callbacks rather than synchronously in the effect body.
  useEffect(() => {
    getCurrentBets()
      .then((data) => {
        setCurrentBets(Array.isArray(data?.bets) ? data.bets : [])
      })
      .catch((error) => {
        console.error('Failed to fetch current bets on admin page:', error?.message)
      })
      .finally(() => setLoadingBets(false))
  }, [])

  async function handleConfirm() {
    if (!selected || confirming) return
    setConfirming(true)
    setError('')
    setResult(null)
    const activeBetsForResolution = [...currentBets]
    try {
      const data = await declareWinner(selected)
      setResult(data.message ?? 'Winner declared!')
      setLastResolvedBets({
        winningSpacewalker: selected,
        bets: activeBetsForResolution,
      })
      setSelected('')
      await fetchBets()
    } catch (err) {
      setError(err?.message ?? 'Connection error — try again')
    } finally {
      setConfirming(false)
    }
  }

  return (
    <div className="mx-auto max-w-2xl">
      <header className="mb-8 text-center">
        <img src={amongus} alt="" aria-hidden className="mx-auto mb-3 h-9 w-9 object-contain" />
        <h1 className="font-display text-5xl tracking-wide text-siren-light text-shadow-pirate">
          Declare Winner
        </h1>
        <p className="mt-3 text-slate-400">
          Choose the spacewalker that carried the day. Winnings split among its backers.
        </p>
        <div aria-hidden className="mx-auto mt-6 h-px w-40 bg-gradient-to-r from-transparent via-siren to-transparent" />
      </header>

      <AdminDeclareWinner
        spacewalkers={SPACEWALKERS}
        selected={selected}
        onSelect={setSelected}
        onConfirm={handleConfirm}
        confirming={confirming}
        result={result}
        error={error}
        currentBets={currentBets}
        loadingBets={loadingBets}
        onRefreshBets={fetchBets}
        lastResolvedBets={lastResolvedBets}
      />
    </div>
  )
}