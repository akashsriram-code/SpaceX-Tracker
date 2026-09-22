import { AlertTriangle, Loader2, SatelliteDish } from 'lucide-react'

export function LoadingState({ label = 'Acquiring telemetry…' }: { label?: string }) {
  return (
    <div className="flex flex-col items-center justify-center gap-3 py-24 text-white/50">
      <Loader2 className="size-6 animate-spin text-accent" aria-hidden />
      <p className="font-mono text-xs tracking-widest uppercase">{label}</p>
    </div>
  )
}

export function ErrorState({
  error,
  onRetry,
}: {
  error: unknown
  onRetry?: () => void
}) {
  const message = error instanceof Error ? error.message : String(error)
  return (
    <div className="panel flex flex-col items-center gap-4 px-6 py-16 text-center">
      <AlertTriangle className="size-7 text-crimson" aria-hidden />
      <div>
        <h3 className="text-base font-semibold text-white/90">
          Telemetry link failed
        </h3>
        <p className="mx-auto mt-2 max-w-md font-mono text-xs leading-relaxed text-white/45">
          {message}
        </p>
      </div>
      {onRetry && (
        <button
          onClick={onRetry}
          className="rounded-lg border border-accent/30 bg-accent/10 px-4 py-2 text-xs font-semibold text-accent transition-colors hover:bg-accent/20"
        >
          Retry
        </button>
      )}
    </div>
  )
}

export function EmptyState({
  title = 'No missions match',
  hint,
}: {
  title?: string
  hint?: string
}) {
  return (
    <div className="panel flex flex-col items-center gap-3 px-6 py-20 text-center">
      <SatelliteDish className="size-7 text-white/25" aria-hidden />
      <h3 className="text-sm font-semibold text-white/70">{title}</h3>
      {hint && <p className="max-w-sm text-xs text-white/40">{hint}</p>}
    </div>
  )
}
