import amongus from '../assets/amonguscharacter.png'

const DOT = {
  red: 'bg-red-500',
  yellow: 'bg-yellow-400',
  blue: 'bg-blue-500',
  green: 'bg-green-500',
}

const capitalize = (value) =>
  value ? value.charAt(0).toUpperCase() + value.slice(1) : ''

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
              Team ID
            </th>
            <th className="pb-3 pr-3 font-semibold">Spacewalker</th>
            <th className="pb-3 font-semibold">Bet Amount</th>
          </tr>
        </thead>
        <tbody>
          {bets.map((bet, index) => (
            <tr key={bet.id ?? `${bet.spacewalker}-${bet.betAmount}-${index}`} className="border-t border-white/10 align-top">
              <td className="py-3 pr-3">
                <span className="font-semibold text-white">{bet.id}</span>
                {bet.name ? (
                  <span className="mt-0.5 block text-xs text-slate-500">{bet.name}</span>
                ) : null}
              </td>
              <td className="py-3 pr-3 text-slate-300">
                <span
                  className={`mr-2 inline-block h-2.5 w-2.5 rounded-full ${
                    DOT[bet.spacewalker] ?? 'bg-slate-400'
                  }`}
                />
                {capitalize(bet.spacewalker)}
              </td>
              <td className="py-3 font-semibold text-gold-light">{bet.betAmount}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}