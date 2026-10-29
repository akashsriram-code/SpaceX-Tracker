/**
 * Small, slow-changing reference facts for the Starlink tab, hard-coded with
 * their sources rather than scraped on every build. Each changes a few times
 * a year at most; update by hand and bump the `asOf`.
 */

/**
 * SpaceX's published target altitudes per shell (end-of-2026 configuration,
 * after the 2026 shell-lowering campaign). Drawn as reference lines on the
 * altitude chart. V1 and V2 broadband satellites share shells, so a shell's
 * altitude can't tell those versions apart.
 */
export const TARGET_ALTITUDES = {
  source: 'https://space-safety.starlink.com/docs/space-safety-articles/constellation_altitudes/',
  asOf: '2026-10-29',
  shells: [
    { label: 'Broadband 43°', incDeg: 43, altitudeKm: 485 },
    { label: 'Broadband 70°', incDeg: 70, altitudeKm: 472.5 },
    { label: 'Broadband 53°', incDeg: 53, altitudeKm: 463 },
    { label: 'Broadband 97.3°', incDeg: 97.3, altitudeKm: 462.5 },
    { label: 'DTC 53°', incDeg: 53, altitudeKm: 360 },
    { label: 'DTC 43°', incDeg: 43, altitudeKm: 358.5 },
  ],
  /** V3 is published as a band rather than a single height. */
  v3BandKm: [330, 360] as const,
}

/**
 * Space-weather events marked on the reentry timeline. Only the Feb 2022
 * event has a documented, attributable Starlink loss; the 2024 storms are
 * marked as context, not as a claimed cause of any particular reentry.
 */
export const STORM_EVENTS = [
  {
    date: '2022-02-04',
    label: 'Feb 2022 storm',
    note: 'Group 4-7 (2022-010): 38 of 49 satellites lost from their ~210 km staging orbit after a geomagnetic storm raised drag (Berger et al. 2023, doi:10.1029/2022SW003330).',
  },
  {
    date: '2024-05-10',
    label: 'May 2024 G5 storm',
    note: 'Strongest geomagnetic storm since 2003. Marked for context only.',
  },
  {
    date: '2024-10-10',
    label: 'Oct 2024 G4 storm',
    note: 'Severe geomagnetic storm. Marked for context only.',
  },
] as const
