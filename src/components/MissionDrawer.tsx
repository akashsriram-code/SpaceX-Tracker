import { format } from 'date-fns'
import { AlertTriangle, ExternalLink, Rocket, X } from 'lucide-react'
import { useEffect, useRef } from 'react'
import {
  boosterLabel,
  customersOf,
  isStarlinkMission,
  outcomeOf,
} from '../lib/launch'
import type { Launch } from '../lib/types'
import { cn, formatInt, formatMassKg, hostOf } from '../lib/utils'
import { Badge } from './ui/Badge'

function Row({
  label,
  value,
  mono,
}: {
  label: string
  value: React.ReactNode
  mono?: boolean
}) {
  if (value == null || value === '') return null
  return (
    <div className="flex items-baseline justify-between gap-4 border-b border-white/[0.06] py-2 last:border-0">
      <dt className="label-caps shrink-0">{label}</dt>
      <dd
        className={cn(
          'min-w-0 text-right text-xs text-white/75',
          mono && 'font-mono tnum',
        )}
      >
        {value}
      </dd>
    </div>
  )
}

function Section({
  title,
  children,
}: {
  title: string
  children: React.ReactNode
}) {
  return (
    <section className="space-y-1">
      <h3 className="mb-2 text-[0.7rem] font-bold uppercase tracking-[0.12em] text-accent/70">
        {title}
      </h3>
      {children}
    </section>
  )
}

export function MissionDrawer({
  launch,
  onClose,
}: {
  launch: Launch | null
  onClose: () => void
}) {
  const panelRef = useRef<HTMLDivElement>(null)

  // Escape to close, and lock body scroll while the overlay is up.
  useEffect(() => {
    if (!launch) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    const prevOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    panelRef.current?.focus()
    return () => {
      window.removeEventListener('keydown', onKey)
      document.body.style.overflow = prevOverflow
    }
  }, [launch, onClose])

  if (!launch) return null

  const netDate = new Date(launch.net)
  const validDate = !Number.isNaN(netDate.getTime())
  const outcome = outcomeOf(launch)
  const customers = customersOf(launch)
  const totalMass = launch.payloads.reduce(
    (sum, p) => (p.massKg != null ? sum + p.massKg : sum),
    0,
  )

  return (
    <div className="fixed inset-0 z-50 flex justify-end">
      {/* Scrim */}
      <button
        aria-label="Close mission details"
        onClick={onClose}
        className="absolute inset-0 bg-void/80 backdrop-blur-sm"
      />

      <div
        ref={panelRef}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-label={`${launch.missionName ?? launch.name} details`}
        className="relative flex h-full w-full max-w-xl flex-col border-l border-white/10 bg-space shadow-2xl outline-none"
      >
        {/* Header */}
        <header className="flex items-start gap-3 border-b border-white/10 p-5">
          {launch.patchUrl ? (
            <img
              src={launch.patchUrl}
              alt=""
              className="size-14 shrink-0 rounded-lg object-contain"
            />
          ) : (
            <div className="flex size-14 shrink-0 items-center justify-center rounded-lg border border-white/10">
              <Rocket className="size-6 text-white/25" aria-hidden />
            </div>
          )}

          <div className="min-w-0 flex-1">
            <h2 className="text-lg font-bold leading-tight text-white">
              {launch.missionName ?? launch.name}
            </h2>
            <p className="mt-1 font-mono text-[0.7rem] tnum text-white/40">
              {validDate ? `${format(netDate, 'd MMM yyyy HH:mm')} UTC` : 'Date TBD'}
            </p>
            <div className="mt-2 flex flex-wrap gap-1.5">
              <Badge
                tone={
                  outcome === 'success'
                    ? 'emerald'
                    : outcome === 'failure'
                      ? 'crimson'
                      : outcome === 'partial'
                        ? 'amber'
                        : 'accent'
                }
              >
                {launch.status.name}
              </Badge>
              {isStarlinkMission(launch) && <Badge tone="violet">Starlink</Badge>}
              {launch.missionType && <Badge>{launch.missionType}</Badge>}
            </div>
          </div>

          <button
            onClick={onClose}
            aria-label="Close"
            className="shrink-0 rounded-lg p-1.5 text-white/40 transition-colors hover:bg-white/5 hover:text-white"
          >
            <X className="size-4" aria-hidden />
          </button>
        </header>

        {/* Body */}
        <div className="flex-1 space-y-6 overflow-y-auto p-5">
          {launch.failReason && (
            <div className="rounded-lg border border-crimson/25 bg-crimson/[0.07] p-3">
              <p className="flex items-center gap-1.5 text-[0.7rem] font-bold uppercase tracking-wider text-crimson">
                <AlertTriangle className="size-3.5" aria-hidden />
                Anomaly
              </p>
              <p className="mt-1.5 text-xs leading-relaxed text-white/70">
                {launch.failReason}
              </p>
            </div>
          )}

          {launch.missionDescription && (
            <p className="text-xs leading-relaxed text-white/60">
              {launch.missionDescription}
            </p>
          )}

          <Section title="Mission">
            <dl>
              <Row label="Vehicle" value={launch.rocketFullName ?? launch.rocketName} />
              <Row label="Orbit" value={launch.orbitName} />
              <Row label="Launch site" value={launch.padName} />
              <Row label="Location" value={launch.padLocation} />
              <Row
                label="Pad attempt #"
                value={
                  launch.padLaunchAttemptCount != null
                    ? formatInt(launch.padLaunchAttemptCount)
                    : null
                }
                mono
              />
              <Row label="NET precision" value={launch.netPrecision} />
              <Row
                label="Window"
                value={
                  launch.windowStart && launch.windowEnd && launch.windowStart !== launch.windowEnd
                    ? `${format(new Date(launch.windowStart), 'HH:mm')}–${format(new Date(launch.windowEnd), 'HH:mm')} UTC`
                    : null
                }
                mono
              />
              <Row
                label="Weather go"
                value={launch.probability != null ? `${launch.probability}%` : null}
                mono
              />
              <Row label="Weather concerns" value={launch.weatherConcerns} />
            </dl>
          </Section>

          <Section title="Customer (derived)">
            <div className="flex flex-wrap gap-1.5">
              {customers.map((c) => (
                <Badge key={c} tone="accent">
                  {c}
                </Badge>
              ))}
            </div>
            <p className="mt-2 text-[0.65rem] leading-relaxed text-white/30">
              Launch Library 2 has no dedicated customer field. This is inferred
              from mission agencies, then mission-name patterns — treat it as a
              label, not a contract record.
            </p>
          </Section>

          {launch.payloads.length > 0 ? (
            <Section title="Payloads">
              <dl>
                {totalMass > 0 && (
                  <Row label="Total mass" value={formatMassKg(totalMass)} mono />
                )}
                {launch.payloads.map((p, i) => (
                  <Row
                    key={`${p.name}-${i}`}
                    label={p.name ?? `Payload ${i + 1}`}
                    value={
                      [
                        formatMassKg(p.massKg),
                        p.orbit,
                        p.manufacturer,
                        p.customers.join(', ') || null,
                      ]
                        .filter(Boolean)
                        .join(' · ') || '—'
                    }
                  />
                ))}
              </dl>
            </Section>
          ) : (
            <Section title="Payloads">
              <p className="text-xs text-white/35">
                No per-payload breakdown published for this flight. Upstream
                populates payload mass and manufacturer for only a small number
                of launches.
              </p>
            </Section>
          )}

          <Section title="Booster telemetry">
            {launch.boosters.length === 0 ? (
              <p className="text-xs text-white/35">
                No booster data recorded for this flight.
              </p>
            ) : (
              <div className="space-y-3">
                {launch.boosters.map((b, i) => (
                  <div
                    key={`${b.serial}-${i}`}
                    className="rounded-lg border border-white/[0.08] bg-surface/60 p-3"
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span className="font-mono text-sm font-bold tnum text-white/85">
                        {boosterLabel(b.serial, b.flightNumber)}
                      </span>
                      {b.landingAttempt === true ? (
                        <Badge
                          tone={
                            b.landingSuccess === true
                              ? 'emerald'
                              : b.landingSuccess === false
                                ? 'crimson'
                                : 'neutral'
                          }
                        >
                          {b.landingSuccess === true
                            ? 'Recovered'
                            : b.landingSuccess === false
                              ? 'Lost'
                              : 'Pending'}
                        </Badge>
                      ) : (
                        <Badge>Expended</Badge>
                      )}
                    </div>
                    <dl className="mt-1">
                      <Row
                        label="Core flights"
                        value={b.totalFlights != null ? formatInt(b.totalFlights) : null}
                        mono
                      />
                      <Row
                        label="Reused"
                        value={b.reused == null ? null : b.reused ? 'Yes' : 'No (new core)'}
                      />
                      <Row label="Recovery" value={b.landingType} />
                      <Row label="Landing site" value={b.landingLocation} />
                      <Row
                        label="Turnaround"
                        value={
                          b.turnAroundTimeDays != null
                            ? `${formatInt(b.turnAroundTimeDays)} days`
                            : null
                        }
                        mono
                      />
                      <Row
                        label="Previous flight"
                        value={
                          b.previousFlightDate
                            ? format(new Date(b.previousFlightDate), 'd MMM yyyy')
                            : null
                        }
                        mono
                      />
                    </dl>
                  </div>
                ))}
              </div>
            )}
          </Section>

          {(launch.vidUrls.length > 0 ||
            launch.infoUrls.length > 0 ||
            launch.rocketWikiUrl ||
            launch.padWikiUrl) && (
            <Section title="Media & references">
              <ul className="space-y-1.5">
                {[
                  ...launch.vidUrls.map((l) => ({
                    url: l.url,
                    label: l.title ?? l.type ?? 'Webcast',
                  })),
                  ...launch.infoUrls.map((l) => ({
                    url: l.url,
                    label: l.title ?? l.source ?? 'Article',
                  })),
                  ...(launch.rocketWikiUrl
                    ? [{ url: launch.rocketWikiUrl, label: 'Vehicle on Wikipedia' }]
                    : []),
                  ...(launch.padWikiUrl
                    ? [{ url: launch.padWikiUrl, label: 'Launch pad on Wikipedia' }]
                    : []),
                ].map((l) => (
                  <li key={l.url}>
                    <a
                      href={l.url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="flex items-start gap-2 text-xs text-white/55 transition-colors hover:text-accent"
                    >
                      <ExternalLink
                        className="mt-0.5 size-3 shrink-0 text-white/25"
                        aria-hidden
                      />
                      <span className="min-w-0">
                        {l.label}
                        <span className="ml-1.5 font-mono text-[0.65rem] text-white/25">
                          {hostOf(l.url)}
                        </span>
                      </span>
                    </a>
                  </li>
                ))}
              </ul>
            </Section>
          )}
        </div>
      </div>
    </div>
  )
}
