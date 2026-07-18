// Consent bookkeeping for the welcome/disclaimer dialog. Kept apart from the
// React component so the show-again policy is plain logic with unit tests.

const COOKIE_NAME = 'oversolved_disclaimer_ack'

// The disclaimer must reappear after 48h, so the cookie simply expires then.
export const DISCLAIMER_COOKIE_MAX_AGE_SECONDS = 48 * 60 * 60

export function hasAcknowledgedDisclaimer(): boolean {
  return document.cookie
    .split(';')
    .some(part => part.trim().startsWith(`${COOKIE_NAME}=`))
}

export function acknowledgeDisclaimer(): void {
  document.cookie =
    `${COOKIE_NAME}=1; max-age=${DISCLAIMER_COOKIE_MAX_AGE_SECONDS}; path=/; samesite=lax`
}
