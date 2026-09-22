import { useEffect, useState } from 'react'

export interface Countdown {
  days: number
  hours: number
  minutes: number
  seconds: number
  /** True once T-0 has passed (counting up, or awaiting confirmation). */
  elapsed: boolean
  totalMs: number
}

function diff(targetMs: number): Countdown {
  const deltaMs = targetMs - Date.now()
  const elapsed = deltaMs < 0
  const abs = Math.abs(deltaMs)

  return {
    days: Math.floor(abs / 86_400_000),
    hours: Math.floor((abs % 86_400_000) / 3_600_000),
    minutes: Math.floor((abs % 3_600_000) / 60_000),
    seconds: Math.floor((abs % 60_000) / 1_000),
    elapsed,
    totalMs: deltaMs,
  }
}

/**
 * Ticking T-minus clock.
 *
 * Runs entirely client-side off the snapshot's NET timestamp, so the
 * countdown is genuinely live every second without costing a single API
 * request — which matters because Launch Library 2 allows only 15
 * requests/hour anonymously.
 *
 * Pass `null` to disable (e.g. no upcoming launch, or a NET too imprecise
 * to count down to).
 */
export function useCountdown(isoTarget: string | null): Countdown | null {
  const targetMs = isoTarget ? new Date(isoTarget).getTime() : NaN
  const valid = Number.isFinite(targetMs)

  const [value, setValue] = useState<Countdown | null>(() =>
    valid ? diff(targetMs) : null,
  )

  useEffect(() => {
    if (!valid) {
      setValue(null)
      return
    }
    setValue(diff(targetMs))
    const id = window.setInterval(() => setValue(diff(targetMs)), 1_000)
    return () => window.clearInterval(id)
  }, [targetMs, valid])

  return value
}

export const pad2 = (n: number) => String(Math.max(0, n)).padStart(2, '0')
