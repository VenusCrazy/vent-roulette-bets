import amongus from '../assets/amonguscharacter.png'
import { ventLabel } from '../config/gameConfig.js'

// Tolerates a value that isn't a clean 1-9 so one bad cell can't blank the
// table. Valid bets always store the number.
const ventText = (vent) => (vent == null || vent === '' ? '—' : ventLabel(vent))

export default function BetsTable({ bets = [], loading = false }) {
  if (loading && bets.length === 0) {
    return (
      <div className="grid gap-3" aria-busy="true" aria-label="Loading bets">
        {[0, 1, 2].map((item) => (
          <div key={item} className="h-10 animate-pulse rounded-lg bg-white/5" />
        ))}
      </div>
    )
  }

  if (bets.length === 0) {
    return (
      <div className="grid place-items-center rounded-xl border border-dashed border-white/10 bg-white/[0.02] px-4 py-12 text-center text-slate-400">
        <span className="mt-3 block text-sm">No bets placed yet...</span>
      </div>
    )
  }

  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[340px] text-left text-sm">
        <thead>
          <tr className="text-xs uppercase tracking-widest text-slate-400">
            <th className="pb-3 pr-3 font-semibold">
              <img
                src={amongus}
                alt=""
                aria-hidden
                className="mr-1 -mt-0.5 inline-block h-3 w-3 object-contain"
              />
              Team Name
            </th>
            <th className="pb-3 pr-3 font-semibold">Target Vent</th>
            <th className="pb-3 font-semibold">Bet Amount</th>
          </tr>
        </thead>
        <tbody>
          {bets.map((bet, index) => (
            <tr key={`${bet.teamName}-${bet.vent}-${index}`} className="border-t border-white/10 align-top">
              <td className="py-3 pr-3 font-semibold text-white">{bet.teamName}</td>
              <td className="py-3 pr-3 text-slate-300">{ventText(bet.vent)}</td>
              <td className="py-3 font-semibold text-gold-light">{bet.amount}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
