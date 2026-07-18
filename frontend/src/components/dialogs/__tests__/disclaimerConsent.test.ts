import { describe, it, expect, beforeEach } from 'vitest'
import {
  hasAcknowledgedDisclaimer,
  acknowledgeDisclaimer,
  DISCLAIMER_COOKIE_MAX_AGE_SECONDS,
} from '@/components/dialogs/disclaimerConsent'

function clearDisclaimerCookie() {
  document.cookie = 'oversolved_disclaimer_ack=; max-age=0; path=/'
}

describe('disclaimerConsent', () => {
  beforeEach(() => {
    clearDisclaimerCookie()
  })

  it('reports not acknowledged when the cookie is absent', () => {
    expect(hasAcknowledgedDisclaimer()).toBe(false)
  })

  it('reports acknowledged after acknowledging', () => {
    acknowledgeDisclaimer()
    expect(hasAcknowledgedDisclaimer()).toBe(true)
  })

  it('ignores unrelated cookies', () => {
    document.cookie = 'some_other_cookie=1; path=/'
    expect(hasAcknowledgedDisclaimer()).toBe(false)
    document.cookie = 'some_other_cookie=; max-age=0; path=/'
  })

  it('reports not acknowledged again once the cookie expired', () => {
    acknowledgeDisclaimer()
    clearDisclaimerCookie()  // simulates the 48h max-age running out
    expect(hasAcknowledgedDisclaimer()).toBe(false)
  })

  it('snoozes for exactly 48 hours', () => {
    expect(DISCLAIMER_COOKIE_MAX_AGE_SECONDS).toBe(48 * 60 * 60)
  })
})
