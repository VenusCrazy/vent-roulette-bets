const ACCENTS = {
  gold: {
    selected:
      'border-gold bg-gradient-to-br from-gold-light to-gold-dark text-abyss-950 shadow-gold-glow',
    unselected:
      'border-white/10 bg-white/[0.04] text-slate-300 hover:border-gold/50 hover:text-gold-light',
    check: 'text-abyss-950',
  },
  ocean: {
    selected:
      'border-ocean bg-gradient-to-br from-ocean-light to-ocean-dark text-white shadow-ocean-glow',
    unselected:
      'border-white/10 bg-white/[0.04] text-slate-300 hover:border-ocean/50 hover:text-ocean-light',
    check: 'text-white',
  },
  siren: {
    selected:
      'border-siren bg-gradient-to-br from-siren-light to-siren-dark text-white shadow-siren-glow',
    unselected:
      'border-white/10 bg-white/[0.04] text-slate-300 hover:border-siren/50 hover:text-siren-light',
    check: 'text-white',
  },
}

export default function SelectableGrid({
  options = [],
  selected,
  onSelect,
  columns = 2,
  accent = 'gold',
  getLabel = (option) => String(option),
}) {
  const a = ACCENTS[accent] ?? ACCENTS.gold
  return (
    <div
      className="grid gap-2"
      style={{ gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))` }}
    >
      {options.map((option) => {
        const isSelected = selected === option
        return (
          <button
            key={option}
            type="button"
            aria-pressed={isSelected}
            onClick={() => onSelect(option)}
            className={`rounded-xl border px-2 py-2 text-xs font-medium transition-all sm:px-3 sm:py-2.5 sm:text-sm ${
              isSelected ? a.selected : a.unselected
            }`}
          >
            <span className="flex items-center justify-center gap-1">
              {isSelected ? (
                <span aria-hidden className={a.check}>
                  ✔
                </span>
              ) : null}
              {getLabel(option)}
            </span>
          </button>
        )
      })}
    </div>
  )
}