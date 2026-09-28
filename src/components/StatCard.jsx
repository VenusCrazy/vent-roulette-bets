const ACCENTS = {
  gold: {
    border: 'border-gold/40',
    icon: 'bg-gold/10 text-gold-light',
    glow: 'shadow-gold-glow',
  },
  ocean: {
    border: 'border-ocean/40',
    icon: 'bg-ocean/10 text-ocean-light',
    glow: 'shadow-ocean-glow',
  },
  siren: {
    border: 'border-siren/40',
    icon: 'bg-siren/10 text-siren-light',
    glow: 'shadow-siren-glow',
  },
}

export default function StatCard({ label, value, icon = '', suffix = '', accent = 'gold' }) {
  const a = ACCENTS[accent] ?? ACCENTS.gold
  return (
    <div
      className={`rounded-2xl border bg-white/[0.04] p-6 backdrop-blur-sm ${a.border} ${a.glow}`}
    >
      <div className="flex items-center justify-between gap-4">
        <div>
          <p className="text-xs font-semibold uppercase tracking-[0.2em] text-slate-400">
            {label}
          </p>
          <p className="mt-2 font-display text-4xl text-white">
            {value}
            <span className="ml-1 font-sans text-lg text-slate-400">{suffix}</span>
          </p>
        </div>
        {icon ? (
          <span
            aria-hidden
            className={`grid h-12 w-12 shrink-0 place-items-center rounded-full text-xl ${a.icon}`}
          >
            {icon}
          </span>
        ) : null}
      </div>
    </div>
  )
}