import amongus from '../assets/amonguscharacter.png'

const SW_STYLES = {
  red: 'border-red-500 bg-gradient-to-br from-red-500/70 to-red-700/80 text-red-100 shadow-red-500/25',
  yellow:
    'border-yellow-400 bg-gradient-to-br from-yellow-400/80 to-amber-500/80 text-abyss-950',
  blue: 'border-blue-500 bg-gradient-to-br from-blue-500/70 to-blue-700/80 text-blue-100',
  green: 'border-green-500 bg-gradient-to-br from-green-500/70 to-green-700/80 text-green-100',
}

function computePayouts(bets, winningColor) {
  if (!bets || bets.length === 0 || !winningColor) {
    return { totalPool: 0, winningBets: [], losingBets: [], totalWinningBet: 0 }
  }
  const totalPool = bets.reduce((sum, b) => sum + (Number(b.betAmount) || 0), 0)
  const winningBets = bets.filter(
    (b) => String(b.spacewalker).toLowerCase() === winningColor.toLowerCase()
  )
  const losingBets = bets.filter(
    (b) => String(b.spacewalker).toLowerCase() !== winningColor.toLowerCase()
  )
  const totalWinningBet = winningBets.reduce(
    (sum, b) => sum + (Number(b.betAmount) || 0),
    0
  )

  const winnersWithPayout = winningBets.map((b) => {
    const amount = Number(b.betAmount) || 0
    const payout =
      totalWinningBet > 0 ? Math.round((amount / totalWinningBet) * totalPool) : 0
    return { ...b, payout }
  })

  return { totalPool, winningBets: winnersWithPayout, losingBets, totalWinningBet }
}

export default function AdminDeclareWinner({
  spacewalkers = [],
  selected,
  onSelect,
  onConfirm,
  confirming = false,
  result = null,
  error = '',
  currentBets = [],
  loadingBets = false,
  onRefreshBets,
  lastResolvedBets = null,
}) {
  const preview = selected ? computePayouts(currentBets, selected) : null
  const resolution = lastResolvedBets
    ? computePayouts(lastResolvedBets.bets, lastResolvedBets.winningSpacewalker)
    : null

  return (
    <section className="rounded-2xl border border-siren/40 bg-abyss-950/60 backdrop-blur-sm">
      <header className="flex items-center justify-between border-b border-siren/20 bg-siren/[0.06] px-5 py-4">
        <div className="flex items-center gap-2">
          <img src={amongus} alt="" aria-hidden className="h-6 w-6 object-contain" />
          <h2 className="font-display text-2xl tracking-wide text-siren-light">
            Declare Winning Spacewalker
          </h2>
        </div>
        {onRefreshBets ? (
          <button
            type="button"
            onClick={onRefreshBets}
            disabled={loadingBets}
            className="rounded-lg border border-white/10 bg-white/5 px-3 py-1 text-xs text-slate-300 hover:bg-white/10 disabled:opacity-50"
          >
            {loadingBets ? 'Refreshing…' : '↻ Refresh Bets'}
          </button>
        ) : null}
      </header>

      <div className="flex flex-col gap-5 p-5">
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          {spacewalkers.map((spacewalker) => {
            const value = spacewalker.toLowerCase()
            const isSelected = selected === value
            return (
              <button
                key={value}
                type="button"
                aria-pressed={isSelected}
                onClick={() => onSelect(value)}
                className={`rounded-xl border-2 px-4 py-4 text-left font-display text-lg tracking-wide transition-all ${
                  isSelected
                    ? SW_STYLES[value] ?? 'border-siren bg-siren/70 text-white'
                    : 'border-white/10 bg-white/[0.04] text-slate-300 hover:border-siren/50 hover:text-siren-light'
                }`}
              >
                <span
                  aria-hidden
                  className={`mr-2 inline-block h-3 w-3 rounded-full ${
                    {
                      red: 'bg-red-500',
                      yellow: 'bg-yellow-400',
                      blue: 'bg-blue-500',
                      green: 'bg-green-500',
                    }[value] ?? 'bg-white'
                  }`}
                />
                {spacewalker}
              </button>
            )
          })}
        </div>

        {/* Live Payout Preview when a color is selected */}
        {selected && preview ? (
          <div className="rounded-xl border border-gold/30 bg-gold/[0.04] p-4">
            <div className="mb-3 flex items-center justify-between border-b border-gold/10 pb-2">
              <h3 className="font-display text-lg tracking-wide text-gold-light">
                Payout Preview for {selected.toUpperCase()}
              </h3>
              <span className="text-xs text-slate-400">
                Total Pool: <strong className="text-gold">{preview.totalPool} pts</strong>
              </span>
            </div>

            {preview.winningBets.length === 0 ? (
              <p className="text-xs italic text-slate-400">
                No bets placed on {selected.toUpperCase()} in this round yet.
              </p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-left text-xs">
                  <thead>
                    <tr className="border-b border-white/10 text-slate-400">
                      <th className="pb-2 font-medium">Team Code</th>
                      <th className="pb-2 font-medium">Team Name</th>
                      <th className="pb-2 font-medium">Bet</th>
                      <th className="pb-2 font-medium text-gold">Est. Payout</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-white/5">
                    {preview.winningBets.map((w, idx) => (
                      <tr key={w.id || idx} className="text-slate-200">
                        <td className="py-2 font-mono">{w.id}</td>
                        <td className="py-2">{w.name}</td>
                        <td className="py-2">{w.betAmount} pts</td>
                        <td className="py-2 font-bold text-gold">+{w.payout} pts</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}

            {preview.losingBets.length > 0 ? (
              <p className="mt-3 text-xs text-slate-400">
                ⚠️ {preview.losingBets.length} bet(s) on other spacewalkers will lose their stake.
              </p>
            ) : null}
          </div>
        ) : null}

        {error ? (
          <div role="alert" className="rounded-xl border border-flame/40 bg-flame/10 px-4 py-3 text-sm text-red-300">
            ⚠️ {error}
          </div>
        ) : null}

        {result ? (
          <div role="status" className="rounded-xl border border-green-500/40 bg-green-500/10 p-4 text-sm text-green-300">
            <div className="font-bold">🏆 {result}</div>
            {resolution && resolution.winningBets.length > 0 ? (
              <div className="mt-3 border-t border-green-500/20 pt-2">
                <p className="mb-2 text-xs text-green-200 font-semibold">
                  Distributed Payout Summary ({resolution.winningBets.length} winner team(s)):
                </p>
                <div className="overflow-x-auto">
                  <table className="w-full text-left text-xs text-green-100">
                    <thead>
                      <tr className="border-b border-green-500/20 text-green-300">
                        <th className="pb-1">Team Code</th>
                        <th className="pb-1">Team Name</th>
                        <th className="pb-1">Bet</th>
                        <th className="pb-1">Payout Added</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-green-500/10">
                      {resolution.winningBets.map((w, idx) => (
                        <tr key={w.id || idx}>
                          <td className="py-1 font-mono">{w.id}</td>
                          <td className="py-1">{w.name}</td>
                          <td className="py-1">{w.betAmount} pts</td>
                          <td className="py-1 font-bold text-green-400">+{w.payout} pts</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            ) : null}
          </div>
        ) : null}

        <button
          type="button"
          disabled={!selected || confirming}
          onClick={onConfirm}
          className="shadow-siren-glow flex w-full items-center justify-center gap-2 rounded-xl bg-gradient-to-r from-siren-dark via-siren to-siren-light px-5 py-3.5 font-display text-xl tracking-wide text-white transition-all hover:brightness-110 active:scale-[0.99] disabled:cursor-not-allowed disabled:opacity-50"
        >
          {confirming ? (
            <span
              aria-hidden
              className="h-4 w-4 animate-spin rounded-full border-2 border-white/30 border-t-white"
            />
          ) : null}
          {confirming ? 'Declaring winner…' : 'Declare Winner'}
        </button>
      </div>
    </section>
  )
}