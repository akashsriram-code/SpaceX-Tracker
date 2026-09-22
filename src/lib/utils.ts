import { type ClassValue, clsx } from 'clsx'
import { twMerge } from 'tailwind-merge'

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

/** Compact integer formatting, e.g. 1234 -> "1,234". */
const intFmt = new Intl.NumberFormat('en-US')
export const formatInt = (n: number) => intFmt.format(Math.round(n))

/** Percentage with one decimal, e.g. 0.9871 -> "98.7%". */
export function formatPct(ratio: number, digits = 1): string {
  if (!Number.isFinite(ratio)) return '—'
  return `${(ratio * 100).toFixed(digits)}%`
}

export function formatMassKg(kg: number | null): string | null {
  if (kg == null || !Number.isFinite(kg)) return null
  const lbs = kg * 2.20462
  return `${formatInt(kg)} kg / ${formatInt(lbs)} lb`
}

/** Hostname without "www.", for labelling external links. */
export function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '')
  } catch {
    return url
  }
}
