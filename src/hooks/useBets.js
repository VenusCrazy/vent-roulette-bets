import { useCallback, useEffect, useRef, useState } from 'react'
import { getBets } from '../api/betting.js'
import { startBetsPolling } from './polling.js'

const EMPTY_STATS = { round: null, totalPoints: 0, activeBets: 0 }

/**
 * Polls getBets on mount and every 15s, pausing while the tab is hidden.
 *
 * A failed refresh keeps the last good data on screen and reports the error
 * alongside it, so a blip never blanks the list someone is reading.
 */
export default function useBets({ intervalMs } = {}) {
  const [bets, setBets] = useState([])
  const [stats, setStats] = useState(EMPTY_STATS)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  // A poll still in flight when the next one fires would queue up behind Apps
  // Script's 1-3s latency, so overlapping requests are dropped rather than
  // stacked. Manual refreshes share the same guard.
  const inFlight = useRef(false)
  const mounted = useRef(true)

  const refresh = useCallback(async () => {
    if (inFlight.current) return
    inFlight.current = true
    try {
      const data = await getBets()
      if (!mounted.current) return
      setBets(Array.isArray(data?.bets) ? data.bets : [])
      setStats({
        round: Number.isInteger(data?.round) ? data.round : null,
        totalPoints: data?.totalPoints ?? 0,
        activeBets: data?.activeBets ?? 0,
      })
      setError('')
    } catch (err) {
      // setBets is deliberately untouched here: stale data beats an empty list.
      if (mounted.current) setError(err?.message ?? 'Could not refresh bets.')
    } finally {
      inFlight.current = false
      if (mounted.current) setLoading(false)
    }
  }, [])

  useEffect(() => {
    mounted.current = true
    // startBetsPolling calls poll synchronously, which would setState in the
    // effect body. Deferring one microtask keeps the updates in a promise
    // callback, as the hooks lint rule requires.
    const stop = startBetsPolling({ intervalMs, poll: () => refresh() })
    return () => {
      mounted.current = false
      stop()
    }
  }, [refresh, intervalMs])

  return { ...stats, bets, loading, error, refresh }
}
