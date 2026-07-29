import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  AUDIT_MARKER,
  MARKER,
  commentsEqual,
  renderAuditComment,
  renderBypassDeniedComment,
  renderStatusComment,
  renderSuccessComment,
} from './comment.mjs'

const violation = {
  rule: 'R1',
  title: 'Branch-Name',
  message: 'Der Branch `feature/foo` folgt nicht dem Schema `issue/<nummer>`.',
  action: 'Benenne den Branch um.',
}

describe('renderStatusComment', () => {
  it('always contains the sticky marker', () => {
    assert.ok(renderStatusComment({ violations: [violation] }).startsWith(MARKER))
    assert.ok(renderSuccessComment().startsWith(MARKER))
  })

  it('labels hint mode clearly and does not claim to block', () => {
    const body = renderStatusComment({ violations: [violation], enforce: false })
    assert.match(body, /Hinweismodus/)
    assert.doesNotMatch(body, /auf „Draft“ gesetzt/)
  })

  it('explains draft conversion and the re-check path in enforce mode', () => {
    const body = renderStatusComment({ violations: [violation], enforce: true })
    assert.match(body, /auf „Draft“ gesetzt/)
    assert.match(body, /Ready for review/)
  })

  it('lists each violation with rule id, message and one action sentence', () => {
    const second = { rule: 'R4', title: 'Beschreibung', message: 'Zu kurz.', action: 'Beschreibe die Änderung.' }
    const body = renderStatusComment({ violations: [violation, second] })
    assert.match(body, /R1 — Branch-Name/)
    assert.match(body, /R4 — Beschreibung/)
    assert.match(body, /➡️ Benenne den Branch um\./)
    assert.match(body, /➡️ Beschreibe die Änderung\./)
  })

  it('mentions running checks only when CI is pending', () => {
    assert.match(renderStatusComment({ violations: [violation], ciPending: true }), /CI-Checks laufen noch/)
    assert.doesNotMatch(renderStatusComment({ violations: [violation], ciPending: false }), /laufen noch/)
  })

  it('is deterministic — identical input yields byte-identical output', () => {
    const a = renderStatusComment({ violations: [violation], ciPending: true, enforce: true })
    const b = renderStatusComment({ violations: [violation], ciPending: true, enforce: true })
    assert.equal(a, b)
  })

  it('falls back to the success message for an empty violation list', () => {
    assert.equal(renderStatusComment({ violations: [] }), renderSuccessComment())
  })
})

describe('renderAuditComment / renderBypassDeniedComment', () => {
  it('audit comment names person, role, timestamp and label', () => {
    const body = renderAuditComment({
      login: 'pfaffenbauer',
      role: 'admin',
      timestamp: '2026-07-29T12:00:00.000Z',
      bypassLabel: 'guardrail-bypass',
    })
    assert.ok(body.startsWith(AUDIT_MARKER))
    assert.match(body, /@pfaffenbauer/)
    assert.match(body, /`admin`/)
    assert.match(body, /2026-07-29T12:00:00\.000Z/)
    assert.match(body, /`guardrail-bypass`/)
  })

  it('audit comment does not carry the sticky marker (never overwritten)', () => {
    const body = renderAuditComment({ login: 'x', role: 'admin', timestamp: 't' })
    assert.ok(!body.includes(MARKER))
  })

  it('denied comment addresses the user and explains the removal', () => {
    const body = renderBypassDeniedComment({ login: 'praktikant', bypassLabel: 'guardrail-bypass' })
    assert.match(body, /@praktikant/)
    assert.match(body, /entfernt/)
    assert.ok(!body.includes(MARKER))
  })
})

describe('commentsEqual', () => {
  it('ignores CRLF vs LF and trailing whitespace', () => {
    assert.equal(commentsEqual('a\r\nb\n', 'a\nb'), true)
  })

  it('detects real differences', () => {
    assert.equal(commentsEqual('a', 'b'), false)
  })

  it('treats null/undefined as empty', () => {
    assert.equal(commentsEqual(null, ''), true)
    assert.equal(commentsEqual(undefined, null), true)
  })
})
