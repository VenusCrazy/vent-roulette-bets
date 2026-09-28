import { useState } from 'react'
import SelectableGrid from './SelectableGrid.jsx'
import { SPACEWALKERS } from '../config/gameConfig.js'

const inputClass =
  'w-full rounded-xl border border-white/10 bg-abyss-900/60 px-3.5 py-2.5 text-sm text-white placeholder:text-slate-500 outline-none transition-colors focus:border-gold/60'

const labelClass = 'mb-1.5 block text-xs font-semibold uppercase tracking-widest text-slate-400'

export default function BetForm({ onPlaceBet }) {
  const [participantId, setParticipantId] = useState('')
  const [spacewalker, setSpacewalker] = useState('')
  const [betAmount, setBetAmount] = useState('')
  const [status, setStatus] = useState('idle')
  const [message, setMessage] = useState('')
  const [remaining, setRemaining] = useState(null)

  const isValid = participantId.trim() !== '' && spacewalker !== '' && Number(betAmount) > 0
  const busy = status === 'submitting'

  async function handleSubmit(event) {
    event.preventDefault()
    if (!isValid || busy) return
    setStatus('submitting')
    setMessage('')
    setRemaining(null)
    try {
      const data = await onPlaceBet({
        participantId: participantId.trim(),
        betAmount: Number(betAmount),
        spacewalker: spacewalker.toLowerCase(),
      })
      setStatus('success')
      setMessage(data.message ?? 'Bet placed!')
      setRemaining(data.remaining)
      setParticipantId('')
      setBetAmount('')
    } catch (error) {
      setStatus('error')
      setMessage(error?.message ?? 'Connection error — try again')
    }
  }

  return (
    <form onSubmit={handleSubmit} className="flex flex-col gap-5">
      <div>
        <label htmlFor="participant-id" className={labelClass}>
          Team ID
        </label>
        <input
          id="participant-id"
          type="text"
          value={participantId}
          onChange={(e) => setParticipantId(e.target.value)}
          placeholder="e.g., 1002"
          autoComplete="off"
          className={inputClass}
        />
      </div>

      <div>
        <label htmlFor="bet-amount" className={labelClass}>
          Bet Amount
        </label>
        <input
          id="bet-amount"
          type="number"
          min="1"
          step="1"
          value={betAmount}
          onChange={(e) => setBetAmount(e.target.value)}
          placeholder="e.g., 100"
          className={inputClass}
        />
      </div>

      <div>
        <p className={labelClass}>Target Spacewalker</p>
        <SelectableGrid
          options={SPACEWALKERS}
          selected={spacewalker}
          onSelect={setSpacewalker}
          accent="ocean"
        />
      </div>

      {remaining !== null ? (
        <div className="rounded-xl border border-ocean/40 bg-ocean/10 px-4 py-3 text-sm text-ocean-light">
          🪙 Remaining score: {remaining}
        </div>
      ) : null}

      {status !== 'idle' && message ? (
        <div
          role="status"
          className={`mt-1 rounded-xl border px-4 py-3 text-sm ${
            status === 'success'
              ? 'border-green-500/40 bg-green-500/10 text-green-300'
              : 'border-flame/40 bg-flame/10 text-red-300'
          }`}
        >
          {status === 'success' ? '🎉 ' : '⚠️ '}
          {message}
        </div>
      ) : null}

      <button
        type="submit"
        disabled={!isValid || busy}
        className="shadow-gold-glow mt-1 flex w-full items-center justify-center gap-2 rounded-xl bg-gradient-to-r from-gold-light via-gold to-flame px-5 py-3.5 font-display text-xl tracking-wide text-abyss-950 transition-all hover:brightness-110 active:scale-[0.99] disabled:cursor-not-allowed disabled:opacity-50"
      >
        {busy ? (
          <span
            aria-hidden
            className="h-4 w-4 animate-spin rounded-full border-2 border-abyss-950/30 border-t-abyss-950"
          />
        ) : null}
        {busy ? 'Placing bet…' : 'Place Bet & Deduct Score'}
      </button>
    </form>
  )
}