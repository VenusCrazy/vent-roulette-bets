import { useCallback, useEffect, useState } from 'react'
import Header from '../components/Header.jsx'
import StatCard from '../components/StatCard.jsx'
import BetForm from '../components/BetForm.jsx'
import BetsTable from '../components/BetsTable.jsx'
import { placeBet, getLeaderboard, getCurrentBets } from '../api.js'
import amongus from '../assets/amonguscharacter.png'

const POLL_INTERVAL_MS = 20000

export default function LandingPage() {
  const [bets, setBets] = useState([])
  const [stats, setStats] = useState({ totalBets: 0, activeBets: 0 })
  const [loadingBets, setLoadingBets] = useState(true)
  const [refreshing, setRefreshing] = useState(false)

  const refreshCurrentBets = useCallback(async () => {
    try {
      const data = await getCurrentBets()
      setBets(Array.isArray(data?.bets) ? data.bets : [])
      setStats({
        totalBets: data?.totalBets ?? 0,
        activeBets: data?.activeBets ?? 0,
      })
    } catch (error) {
      console.error('ReQuest current bets refresh failed:', error?.message)
    } finally {
      setLoadingBets(false)
    }
  }, [])

  useEffect(() => {
    getLeaderboard()
      .then(() => console.info('ReQuest backend connected.'))
      .catch((error) => {
        console.error(
          `ReQuest backend unreachable — check VITE_APPS_SCRIPT_URL (${import.meta.env.VITE_APPS_SCRIPT_URL ?? 'not set'}):`,
          error?.message
        )
      })
    getCurrentBets()
      .then((data) => {
        setBets(Array.isArray(data?.bets) ? data.bets : [])
        setStats({
          totalBets: data?.totalBets ?? 0,
          activeBets: data?.activeBets ?? 0,
        })
      })
      .catch((error) => {
        console.error('ReQuest current bets refresh failed:', error?.message)
      })
      .finally(() => setLoadingBets(false))
    const timer = setInterval(() => {
      refreshCurrentBets()
      getLeaderboard().catch(() => {})
    }, POLL_INTERVAL_MS)
    return () => clearInterval(timer)
  }, [refreshCurrentBets])

  async function handleRefresh() {
    setRefreshing(true)
    try {
      await refreshCurrentBets()
      await getLeaderboard().catch(() => {})
    } finally {
      setRefreshing(false)
    }
  }

  async function handlePlaceBet(bet) {
    const data = await placeBet(bet)
    setBets((prev) => [
      ...prev,
      {
        id: data.id,
        name: data.name,
        spacewalker: data.spacewalker,
        betAmount: Number(bet.betAmount),
      },
    ])
    await refreshCurrentBets()
    return data
  }

  return (
    <>
      <Header />

      <section className="mt-12 grid grid-cols-1 gap-4 sm:grid-cols-2">
        <StatCard
          label="Total Bets"
          value={stats.totalBets}
          icon="🪙"
          suffix="points"
          accent="gold"
        />
        <StatCard
          label="Active Bets"
          value={stats.activeBets}
          suffix="bets"
          accent="ocean"
        />
      </section>

      <section className="mt-10 grid grid-cols-1 gap-6 lg:grid-cols-2">
        <div className="overflow-hidden rounded-2xl border border-gold/40 bg-abyss-950/60 backdrop-blur-sm">
          <header className="flex items-center gap-2 border-b border-gold/20 bg-gold/[0.06] px-5 py-4">
            <img src={amongus} alt="" aria-hidden className="h-6 w-6 object-contain" />
            <h2 className="font-display text-2xl tracking-wide text-gold-light">
              Place Your Bet
            </h2>
          </header>
          <div className="p-5">
            <BetForm onPlaceBet={handlePlaceBet} />
          </div>
        </div>

        <div className="overflow-hidden rounded-2xl border border-ocean/40 bg-abyss-950/60 backdrop-blur-sm">
          <header className="flex items-center gap-2 border-b border-ocean/20 bg-ocean/[0.06] px-5 py-4">
            <h2 className="font-display text-2xl tracking-wide text-ocean-light">
              Current Round Bets
            </h2>
            <button
              type="button"
              onClick={handleRefresh}
              title="Refresh bets"
              aria-label="Refresh bets"
              disabled={refreshing}
              className="ml-auto grid h-8 w-8 place-items-center rounded-lg border border-ocean/40 bg-ocean/10 text-ocean-light transition-colors hover:bg-ocean/20 disabled:opacity-50"
            >
              {refreshing ? (
                <span aria-hidden className="h-4 w-4 animate-spin rounded-full border-2 border-ocean-light/30 border-t-ocean-light" />
              ) : (
                '↻'
              )}
            </button>
          </header>
          <div className="p-5">
            <BetsTable bets={bets} loading={loadingBets} />
          </div>
        </div>
      </section>
    </>
  )
}