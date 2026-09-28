import { useRef, useState } from 'react'
import SelectableGrid from './SelectableGrid.jsx'
import { VENTS, ventLabel } from '../config/gameConfig.js'
import { validateBetInput } from '../api/betting.js'

const inputClass =
  'w-full rounded-xl border border-white/10 bg-abyss-900/60 px-3.5 py-2.5 text-sm text-white placeholder:text-slate-500 outline-none transition-colors focus:border-gold/60'

const labelClass = 'mb-1.5 block text-xs font-semibold uppercase tracking-widest text-slate-400'

export default function BetForm({ onPlaceBet, onGetScore }) {
  const [participantId, setParticipantId] = useState('')
  const [vent, setVent] = useState(null)
  const [betAmount, setBetAmount] = useState('')
  const [status, setStatus] = useState('idle')
  const [message, setMessage] = useState('')
  const [team, setTeam] = useState(null)
  const [teamStatus, setTeamStatus] = useState('idle')

  // A slow lookup must not overwrite the result for a code typed since, so the
  // answer is discarded unless it is still the one being asked about.
  const lookupRef = useRef('')

  const busy = status === 'submitting'

  // Nothing is flagged as wrong until the user has actually tried to submit,
  // so the form never opens scolding someone who has not typed yet.
  const showProblem = status === 'error'
  const showSuccess = status === 'success'

  // The script refuses a bet larger than the team's points, so the form reads
  // that balance for the entered code and applies the same ceiling up front.
  const maxPoints = team?.totalScore >= 0 ? team.totalScore : undefined

  function selectVent(value) {
    setVent(value)
    setStatus('idle')
  }

  function updateInput(setter, value) {
    setter(value)
    if (status === 'error' || status === 'success') setStatus('idle')
  }

  function lookupTeam(code) {
    const trimmed = String(code ?? '').trim()
    if (!trimmed) {
      lookupRef.current = ''
      setTeam(null)
      setTeamStatus('idle')
      return Promise.resolve()
    }

    lookupRef.current = trimmed
    setTeamStatus('loading')
    return Promise.resolve(onGetScore({ teamCode: trimmed }))
      .then((data) => {
        if (lookupRef.current !== trimmed) return
        setTeam(data)
        setTeamStatus('found')
      })
      .catch((error) => {
        if (lookupRef.current !== trimmed) return
        setTeam(null)
        // A lookup miss is information, not a failure to shout about: the code
        // may simply be mistyped, and the submit button still explains itself.
        setTeamStatus(error?.message === 'Unknown team ID' ? 'missing' : 'error')
      })
  }

  function handleTeamIdChange(value) {
    updateInput(setParticipantId, value)
    // The previous code's numbers no longer describe what is being typed.
    setTeam(null)
    setTeamStatus('idle')
    lookupRef.current = ''
  }

  async function handleSubmit(event) {
    event.preventDefault()
    if (busy) return

    const validationError = validateBetInput({
      teamCode: participantId,
      amount: betAmount,
      vent,
      maxPoints,
    })
    if (validationError) {
      setStatus('error')
      setMessage(validationError)
      return
    }

    setStatus('submitting')
    setMessage('')
    try {
      const data = await onPlaceBet({
        teamCode: participantId.trim(),
        amount: Number(betAmount),
        vent,
        maxPoints,
      })
      setStatus('success')
      setMessage(
        data.pointsAfterBet != null
          ? `Bet placed! Points remaining: ${data.pointsAfterBet}`
          : 'Bet placed successfully.'
      )
      // The Team ID survives so a second bet needs no retyping; the amount and
      // vent are cleared so the next bet cannot silently reuse them.
      setBetAmount('')
      setVent(null)
      // Re-read the team so the panel shows the debited balance rather than
      // the pre-bet numbers.
      lookupTeam(participantId)
    } catch (error) {
      // Server rejections like "already placed a bet this round" are ordinary
      // outcomes here, so the message is shown as-is rather than treated as a bug.
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
          onChange={(e) => handleTeamIdChange(e.target.value)}
          onBlur={(e) => lookupTeam(e.target.value)}
          placeholder="e.g., 1002"
          autoComplete="off"
          className={inputClass}
        />

        {teamStatus === 'loading' ? (
          <p className="mt-2 flex items-center gap-2 text-xs text-slate-400">
            <span
              aria-hidden
              className="h-3 w-3 animate-spin rounded-full border-2 border-slate-600 border-t-gold"
            />
            Looking up team…
          </p>
        ) : null}

        {teamStatus === 'found' && team ? (
          <div className="mt-2 rounded-xl border border-ocean/40 bg-ocean/10 px-4 py-3 text-sm">
            <p className="font-semibold text-ocean-light">{team.teamName}</p>
            <p className="mt-1 text-slate-300">
              Points available:{' '}
              <span className="font-semibold text-white">{team.totalScore}</span>
            </p>
            <p className="mt-1 text-xs text-slate-400">
              Your bet cannot exceed {team.totalScore}. Stakes are taken from your points straight
              away and returned doubled if your vent wins.
            </p>
          </div>
        ) : null}

        {teamStatus === 'missing' ? (
          <p role="alert" className="mt-2 text-xs text-red-300">
            ⚠️ No team found with that ID.
          </p>
        ) : null}

        {teamStatus === 'error' ? (
          <p role="alert" className="mt-2 text-xs text-slate-400">
            Could not read that team&apos;s score — you can still try to place the bet.
          </p>
        ) : null}
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
          onChange={(e) => updateInput(setBetAmount, e.target.value)}
          placeholder="e.g., 100"
          className={inputClass}
        />
      </div>

      <div>
        <p className={labelClass}>Target Vent</p>
        <SelectableGrid
          options={VENTS}
          columns={3}
          selected={vent}
          onSelect={selectVent}
          getLabel={ventLabel}
          accent="ocean"
        />
      </div>

      {message && (showProblem || showSuccess) ? (
        <div
          role={showProblem ? 'alert' : 'status'}
          className={`mt-1 rounded-xl border px-4 py-3 text-sm ${
            showSuccess
              ? 'border-green-500/40 bg-green-500/10 text-green-300'
              : 'border-flame/40 bg-flame/10 text-red-300'
          }`}
        >
          {showSuccess ? '🎉 ' : '⚠️ '}
          {message}
        </div>
      ) : null}

      <button
        type="submit"
        disabled={busy}
        className="shadow-gold-glow mt-1 flex w-full items-center justify-center gap-2 rounded-xl bg-gradient-to-r from-gold-light via-gold to-flame px-5 py-3.5 font-display font-bold text-xl tracking-wide text-abyss-950 transition-all hover:brightness-110 active:scale-[0.99] disabled:cursor-not-allowed disabled:opacity-50"
      >
        {busy ? (
          <span
            aria-hidden
            className="h-4 w-4 animate-spin rounded-full border-2 border-abyss-950/30 border-t-abyss-950"
          />
        ) : null}
        {busy ? 'Placing bet…' : 'Place Bet'}
      </button>
    </form>
  )
}
