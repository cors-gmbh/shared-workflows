// Pure rendering of the guardrail's PR comments.
//
// The sticky status comment is identified by MARKER and gets updated in
// place. Rendering is fully deterministic (no timestamps in the sticky
// comment) so that identical evaluation results produce byte-identical
// bodies — the API layer then skips the write entirely (idempotency).

export const MARKER = '<!-- pr-guardrail -->'
export const AUDIT_MARKER = '<!-- pr-guardrail-audit -->'

const FOOTER =
  '<sub>Automatischer Kommentar des PR Guardrail — Details und FAQ: <a href="https://github.com/cors-gmbh/shared-workflows/blob/main/docs/GUARDRAILS.md"><code>docs/GUARDRAILS.md</code></a> in <code>cors-gmbh/shared-workflows</code>.</sub>'

/** Short success message the sticky comment is reduced to once all rules pass. */
export function renderSuccessComment() {
  return `${MARKER}\n✅ **PR Guardrail:** Alle Regeln erfüllt.`
}

/**
 * Render the sticky status comment for a set of violations.
 * `enforce` toggles between the blocking text (PR was converted to draft)
 * and the clearly marked hint mode.
 */
export function renderStatusComment({ violations, ciPending = false, enforce = false }) {
  if (!violations || violations.length === 0) return renderSuccessComment()

  const lines = [MARKER, '## 🚦 PR Guardrail', '']
  if (enforce) {
    lines.push(
      '> ❌ **Dieser PR wurde auf „Draft“ gesetzt**, weil die folgenden Regeln verletzt sind.',
      '> Nach dem Beheben **„Ready for review“** klicken — die Prüfung läuft dann automatisch erneut.',
    )
  } else {
    lines.push(
      '> ⚠️ **Hinweismodus:** Dieser PR wird (noch) **nicht** blockiert. Sobald der Guardrail scharf geschaltet ist (`enforce: true`), wären die folgenden Punkte Verstöße.',
    )
  }
  lines.push('')

  for (const v of violations) {
    lines.push(`### ❌ ${v.rule} — ${v.title}`, v.message, '', `➡️ ${v.action}`, '')
  }

  if (ciPending) {
    lines.push(
      '_ℹ️ Einzelne CI-Checks laufen noch. Das CI-Ergebnis wird nach deren Abschluss automatisch erneut geprüft._',
      '',
    )
  }

  lines.push(FOOTER)
  return lines.join('\n')
}

/**
 * Permanent audit trail for an authorized bypass. Posted as a NEW comment
 * (never updated or removed) so the decision stays visible in the timeline.
 */
export function renderAuditComment({ login, role, timestamp, bypassLabel = 'guardrail-bypass' }) {
  return [
    AUDIT_MARKER,
    `🔓 **Guardrail-Bypass aktiviert.** @${login} (Berechtigung: \`${role}\`) hat am ${timestamp} das Label \`${bypassLabel}\` gesetzt.`,
    '',
    'Alle Guardrail-Prüfungen werden für diesen PR übersprungen, solange das Label gesetzt ist.',
  ].join('\n')
}

/** Comment posted when a non-admin tried to set the bypass label. */
export function renderBypassDeniedComment({ login, bypassLabel = 'guardrail-bypass' }) {
  return [
    `🚫 @${login}: Das Label \`${bypassLabel}\` dürfen nur Personen mit \`admin\`- oder \`maintain\`-Berechtigung auf diesem Repository setzen.`,
    '',
    'Das Label wurde wieder entfernt, der Guardrail läuft normal weiter.',
  ].join('\n')
}

/**
 * Compare two comment bodies ignoring line-ending and trailing-whitespace
 * differences (GitHub normalizes CRLF). Used to decide whether an API write
 * is necessary at all.
 */
export function commentsEqual(a, b) {
  const normalize = (s) => (s ?? '').replace(/\r\n/g, '\n').trimEnd()
  return normalize(a) === normalize(b)
}
