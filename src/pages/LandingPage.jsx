import Header from '../components/Header.jsx'
import StatCard from '../components/StatCard.jsx'
import BetForm from '../components/BetForm.jsx'
import BetsTable from '../components/BetsTable.jsx'
import useBets from '../hooks/useBets.js'
import { getScore, placeBet } from '../api/betting.js'
import amongus from '../assets/amonguscharacter.png'

export default function LandingPage() {
  const { round, totalPoints, activeBets, bets, loading, error, refresh } = useBets()

  async function handlePlaceBet(bet) {
    const data = await placeBet(bet)
    await refresh()
    return data
  }

  return (
    <>
      <Header />

      <section className="mt-12 grid grid-cols-1 gap-4 sm:grid-cols-2">
        <StatCard
          label="Total Bets"
          value={totalPoints}
          icon="🪙"
          suffix="points"
          accent="gold"
        />
        <StatCard
          label="Active Bets"
          value={activeBets}
          suffix="bets"
          accent="ocean"
        />
      </section>

      <section className="mt-10 grid grid-cols-1 gap-6 lg:grid-cols-2">
        <div className="overflow-hidden rounded-2xl border border-gold/40 bg-abyss-950/60 backdrop-blur-sm">
          <header className="flex items-center gap-2 border-b border-gold/20 bg-gold/[0.06] px-5 py-4">
            <img src={amongus} alt="" aria-hidden className="h-6 w-6 object-contain" />
            <h2 className="font-display font-bold text-2xl tracking-wide text-gold-light">
              Place Your Bet
            </h2>
          </header>
          <div className="p-5">
            <BetForm onPlaceBet={handlePlaceBet} onGetScore={getScore} />
          </div>
        </div>

        <div className="overflow-hidden rounded-2xl border border-ocean/40 bg-abyss-950/60 backdrop-blur-sm">
          <header className="flex items-center gap-2 border-b border-ocean/20 bg-ocean/[0.06] px-5 py-4">
            <h2 className="font-display font-bold text-2xl tracking-wide text-ocean-light">
              Current Round Bets
            </h2>
            {round != null ? (
              <span className="ml-3 rounded-full border border-ocean/40 bg-ocean/10 px-2.5 py-0.5 text-xs font-semibold text-ocean-light">
                Round {round}
              </span>
            ) : null}
            <button
              type="button"
              onClick={refresh}
              title="Refresh bets"
              aria-label="Refresh bets"
              disabled={loading}
              className="ml-auto grid h-8 w-8 place-items-center rounded-lg border border-ocean/40 bg-ocean/10 text-ocean-light transition-colors hover:bg-ocean/20 disabled:opacity-50"
            >
              {loading ? (
                <span aria-hidden className="h-4 w-4 animate-spin rounded-full border-2 border-ocean-light/30 border-t-ocean-light" />
              ) : (
                '↻'
              )}
            </button>
          </header>
          <div className="p-5">
            {error ? (
              <div
                role="alert"
                className="mb-4 rounded-xl border border-flame/40 bg-flame/10 px-4 py-3 text-sm text-red-300"
              >
                ⚠️ {error}
              </div>
            ) : null}
            <BetsTable bets={bets} loading={loading} />
          </div>
        </div>
      </section>
    </>
  )
}
