/** The learner timezone, for the day boundary. The server defaults to UTC without it. */
export const learnerTimezone = (): string | undefined => {
  try {
    if (typeof Intl === 'undefined') return undefined
    const zone = Intl.DateTimeFormat().resolvedOptions().timeZone
    return zone !== undefined && zone !== '' ? zone : undefined
  } catch {
    return undefined
  }
}
