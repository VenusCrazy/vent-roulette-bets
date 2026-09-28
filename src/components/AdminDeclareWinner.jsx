import amongus from '../assets/amonguscharacter.png'
import { ventLabel } from '../config/gameConfig.js'
import { computeSettlement } from '../lib/settlement.js'

const selectClass =
  'w-full appearance-none rounded-xl border border-white/10 bg-white/[0.04] px-3 py-3 text-base text-white outline-none transition-colors focus:border-gold/60 disabled:cursor-not-allowed disabled:opacity-40'

function computePreview(bets, winner, losers) {
  if (!Array.isArray(bets) || bets.length === 0) return null
  if (winner == null || !Array.isArray(losers) || losers.length !== 2) return null

  const rows = bets.map((bet) => {
    const amount = Number(bet.amount ?? bet.betAmount) || 0
    const vent = Number(bet.vent)
    return { ...bet, amount, vent, ...computeSettlement(amount, vent, winner, losers) }
  })

  return {
    rows,
    won: rows.filter((row) => row.outcome === 'won').length,
    lost: rows.filter((row) => row.outcome === 'lost').length,
  }
}

const RESULT_STYLES = {
  won: 'text-emerald-400',
  lost: 'text-red-400',
}

const RESULT_LABELS = {
  won: 'Won',
  lost: 'Lost',
}

function VentSelect({ id, label, hint, value, options, disabledOptions, accent, onChange }) {
  return (
    <div
      className={`flex flex-col gap-2.5 rounded-xl border p-4 ${
        accent === 'winner'
          ? 'border-gold/40 bg-gold/[0.06]'
          : 'border-flame/30 bg-flame/[0.05]'
      }`}
    >
      <label htmlFor={id} className="flex flex-col gap-0.5">
        <span
          className={`font-display font-bold tracking-wide ${
            accent === 'winner' ? 'text-gold-light' : 'text-slate-200'
          }`}
        >
          {label}
        </span>
        <span className="text-xs text-slate-400">{hint}</span>
      </label>

      <select
        id={id}
        value={value ?? ''}
        onChange={(event) => onChange(event.target.value)}
        className={selectClass}
      >
        <option value="">Choose a vent…</option>
        {options.map((option) => {
          const takenElsewhere = disabledOptions.includes(option)
          return (
            <option key={option} value={option} disabled={takenElsewhere}>
              {ventLabel(option)}
              {takenElsewhere ? ' — already chosen' : ''}
            </option>
          )
        })}
      </select>
    </div>
  )
}

export default function AdminDeclareWinner({
  vents = [],
  ventName = ventLabel,
  picks,
  onPick,
  reviewing = false,
  onStartReview,
  onCancelReview,
  onCommit,
  confirming = false,
  result = null,
  error = '',
  currentBets = [],
  loadingBets = false,
  onRefreshBets,
  lastResolvedBets = null,
  round = null,
}) {
  const { winner, loser1, loser2 } = picks
  const losers = [loser1, loser2]
  const preview = computePreview(currentBets, winner, losers)
  const resolution = lastResolvedBets
    ? computePreview(lastResolvedBets.bets, lastResolvedBets.winner, lastResolvedBets.losers)
    : null

  const allPicked = winner != null && loser1 != null && loser2 != null
  const distinct = new Set([winner, loser1, loser2].filter((v) => v != null)).size === 3
  const canDeclare = allPicked && distinct

  return (
    <section className="rounded-2xl border border-siren/40 bg-abyss-950/60 backdrop-blur-sm">
      <header className="flex items-center justify-between border-b border-siren/20 bg-siren/[0.06] px-5 py-4">
        <div className="flex items-center gap-2">
          <img src={amongus} alt="" aria-hidden className="h-6 w-6 object-contain" />
          <h2 className="font-display font-bold text-2xl tracking-wide text-siren-light">
            Declare Round Result
          </h2>
          {round != null ? (
            <span className="rounded-full border border-siren/40 bg-siren/10 px-2.5 py-0.5 text-xs font-semibold text-siren-light">
              Round {round}
            </span>
          ) : null}
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
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
          <VentSelect
            id="pick-winner"
            label="Winning Vent"
            hint="Payout ×2"
            accent="winner"
            value={winner}
            options={vents}
            disabledOptions={losers.filter((v) => v != null)}
            onChange={(value) => onPick('winner', value)}
          />
          <VentSelect
            id="pick-loser-1"
            label="Losing Vent 1"
            hint="Stake lost"
            accent="loser"
            value={loser1}
            options={vents}
            disabledOptions={[winner, loser2].filter((v) => v != null)}
            onChange={(value) => onPick('loser1', value)}
          />
          <VentSelect
            id="pick-loser-2"
            label="Losing Vent 2"
            hint="Stake lost"
            accent="loser"
            value={loser2}
            options={vents}
            disabledOptions={[winner, loser1].filter((v) => v != null)}
            onChange={(value) => onPick('loser2', value)}
          />
        </div>

        {/* Live preview of the Payout column Code.gs will write for each team. */}
        {preview ? (
          <div className="rounded-xl border border-gold/30 bg-gold/[0.04] p-4">
            <div className="mb-3 flex items-center justify-between border-b border-gold/10 pb-2">
              <h3 className="font-display font-bold text-lg tracking-wide text-gold-light">
                Payout — {ventName(winner)} wins
              </h3>
              <span className="text-xs text-slate-400">
                  <strong className="text-gold">{preview.rows.length}</strong> bet(s) this round
              </span>
            </div>

            <div className="overflow-x-auto">
              <table className="w-full text-left text-xs">
                <thead>
                  <tr className="border-b border-white/10 text-slate-400">
                    <th className="pb-2 font-medium">Team Code</th>
                    <th className="pb-2 font-medium">Team Name</th>
                    <th className="pb-2 font-medium">Vent</th>
                    <th className="pb-2 font-medium">Bet</th>
                    <th className="pb-2 font-medium">Outcome</th>
                    <th className="pb-2 font-medium text-gold">Payout</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-white/5">
                  {preview.rows.map((row, index) => (
                    <tr key={row.id || index} className="text-slate-200">
                      <td className="py-2 font-mono">{row.id}</td>
                      <td className="py-2 pr-3">{row.name}</td>
                      <td className="py-2">{ventName(row.vent)}</td>
                      <td className="py-2">{row.amount} pts</td>
                      <td className={`py-2 font-semibold ${RESULT_STYLES[row.outcome]}`}>
                        {RESULT_LABELS[row.outcome]}
                      </td>
                      <td className={`py-2 font-bold ${RESULT_STYLES[row.outcome]}`}>
                        {row.payout > 0 ? `+${row.payout}` : 0} pts
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            {preview.won > 0 ? (
              <p className="mt-3 text-xs text-slate-400">
                {preview.won} bet(s) on vent {ventName(winner)} are paid twice their stake.
              </p>
            ) : null}
            {preview.lost > 0 ? (
              <p className="mt-1 text-xs text-slate-400">
                {preview.lost} bet(s) lose their stake: the two declared losers, and any vent that
                neither won nor lost. There are no refunds this round.
              </p>
            ) : null}
          </div>
        ) : null}

        {error ? (
          <div
            role="alert"
            className="rounded-xl border border-flame/40 bg-flame/10 px-4 py-3 text-sm text-red-300"
          >
            ⚠️ {error}
          </div>
        ) : null}

        {result ? (
          <div
            role="status"
            className="rounded-xl border border-green-500/40 bg-green-500/10 p-4 text-sm text-green-300"
          >
            <div className="font-bold">🏆 {result}</div>
            {resolution && resolution.rows.length > 0 ? (
              <div className="mt-3 border-t border-green-500/20 pt-2">
                <p className="mb-2 text-xs font-semibold text-green-200">
                  Settled against these balances ({resolution.rows.length} team(s)):
                </p>
                <div className="overflow-x-auto">
                  <table className="w-full text-left text-xs text-green-100">
                    <thead>
                      <tr className="border-b border-green-500/20 text-green-300">
                        <th className="pb-1">Team Code</th>
                        <th className="pb-1">Team Name</th>
                        <th className="pb-1">Vent</th>
                        <th className="pb-1">Bet</th>
                        <th className="pb-1">Outcome</th>
                        <th className="pb-1">Result</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-green-500/10">
                      {resolution.rows.map((row, index) => (
                        <tr key={row.id || index}>
                          <td className="py-1 font-mono">{row.id}</td>
                          <td className="py-1 pr-3">{row.name}</td>
                          <td className="py-1">{ventName(row.vent)}</td>
                          <td className="py-1">{row.amount} pts</td>
                          <td className={`py-1 font-semibold ${RESULT_STYLES[row.outcome]}`}>
                            {RESULT_LABELS[row.outcome]}
                          </td>
                          <td className={`py-1 font-bold ${RESULT_STYLES[row.outcome]}`}>
                            {row.payout > 0 ? `+${row.payout}` : 0} pts
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            ) : null}
          </div>
        ) : null}

        {reviewing ? (
          <div className="rounded-xl border border-gold/50 bg-gold/[0.08] p-4">
            <p className="font-display font-bold tracking-wide text-gold-light">
              Confirm this result
            </p>
            <p className="mt-2 text-sm text-slate-200">
              Winning Vent {winner}, losing Vents {loser1} and {loser2}. Confirm?
            </p>
            <p className="mt-2 text-xs text-slate-400">
              This pays every bet on Vent {winner} twice its stake, forfeits the stake on every
              other vent, archives the round and advances it. The held stakes become permanent —
              it cannot be undone.
            </p>

            <div className="mt-4 flex flex-col gap-3 sm:flex-row">
              <button
                type="button"
                onClick={onCancelReview}
                disabled={confirming}
                className="flex-1 rounded-xl border border-white/15 bg-white/5 px-5 py-3 font-display font-bold tracking-wide text-slate-200 transition-colors hover:bg-white/10 disabled:opacity-50"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={onCommit}
                disabled={confirming}
                className="shadow-siren-glow flex flex-1 items-center justify-center gap-2 rounded-xl bg-gradient-to-r from-siren-dark via-siren to-siren-light px-5 py-3 font-display font-bold tracking-wide text-white transition-all hover:brightness-110 active:scale-[0.99] disabled:cursor-not-allowed disabled:opacity-50"
              >
                {confirming ? (
                  <span
                    aria-hidden
                    className="h-4 w-4 animate-spin rounded-full border-2 border-white/30 border-t-white"
                  />
                ) : null}
                {confirming ? 'Declaring…' : 'Confirm'}
              </button>
            </div>
          </div>
        ) : (
          <button
            type="button"
            disabled={!canDeclare || confirming}
            onClick={onStartReview}
            className="shadow-siren-glow flex w-full items-center justify-center gap-2 rounded-xl bg-gradient-to-r from-siren-dark via-siren to-siren-light px-5 py-3.5 font-display font-bold text-xl tracking-wide text-white transition-all hover:brightness-110 active:scale-[0.99] disabled:cursor-not-allowed disabled:opacity-50"
          >
            Declare Result
          </button>
        )}
      </div>
    </section>
  )
}
