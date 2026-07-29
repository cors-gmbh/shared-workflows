// Pure rule evaluation for the PR guardrail.
//
// Everything in this module is side-effect free: input is a plain object
// describing the PR (title, body, branch, issue state, check states), output
// is a list of violations plus the repair actions (title autofix, closing
// reference). All API access lives in github.mjs; the orchestration lives in
// run-guardrail.mjs. This keeps every rule unit-testable with node:test.
//
// Violation shape: { rule: 'R1', title: string, message: string, action: string }
// `message` and `action` are developer-facing German texts that end up in the
// sticky PR comment.

export const DEFAULT_CONFIG = Object.freeze({
  enforce: false,
  minBodyChars: 50,
  requireIssueOpen: true,
  // Case-insensitive. Capture group 1 must contain the issue number.
  // A descriptive suffix after the number is allowed (issue/123-dam-import).
  branchPattern: String.raw`^issue/(\d+)(?:-.*)?$`,
  titleTemplate: '#{number} {issueTitle}',
  bots: Object.freeze(['renovate[bot]', 'dependabot[bot]', 'github-actions[bot]']),
  botRequireBody: false,
  bypassLabel: 'guardrail-bypass',
})

// --- R1: branch name ---------------------------------------------------------

/**
 * Extract the issue number from a head branch name.
 * Returns a positive integer or null when the branch does not follow the
 * pattern (including `issue/0`, which can never be a valid issue number).
 */
export function extractIssueNumber(branch, branchPattern = DEFAULT_CONFIG.branchPattern) {
  const re = new RegExp(branchPattern, 'i')
  const match = re.exec(branch ?? '')
  if (!match || match[1] === undefined) return null
  const number = Number.parseInt(match[1], 10)
  return Number.isInteger(number) && number > 0 ? number : null
}

/** R1 — the head branch must match `issue/<nummer>` (case-insensitive). */
export function checkBranch({ branch, branchPattern = DEFAULT_CONFIG.branchPattern }) {
  const issueNumber = extractIssueNumber(branch, branchPattern)
  if (issueNumber !== null) return { issueNumber, violation: null }
  return {
    issueNumber: null,
    violation: {
      rule: 'R1',
      title: 'Branch-Name',
      message: `Der Branch \`${branch ?? ''}\` folgt nicht dem Schema \`issue/<nummer>\`.`,
      action:
        'Benenne den Branch nach dem Schema `issue/<issue-nummer>` (z. B. `issue/123` oder `issue/123-dam-import`) und eröffne den PR neu. Die Nummer muss auf ein Issue in diesem Repository zeigen.',
    },
  }
}

// --- R2: issue exists (and is open) -------------------------------------------

/**
 * R2 — the issue referenced by the branch must exist in the same repository.
 * `issue` is the normalized lookup result:
 *   { exists: boolean, isPullRequest: boolean, state: 'OPEN'|'CLOSED'|null, title: string|null }
 * A number that resolves to a pull request is NOT a valid issue.
 */
export function checkIssue({ issueNumber, issue, requireIssueOpen = DEFAULT_CONFIG.requireIssueOpen }) {
  if (!issue || !issue.exists) {
    return {
      rule: 'R2',
      title: 'Verknüpftes Issue',
      message: `Es gibt kein Issue #${issueNumber} in diesem Repository.`,
      action:
        'Lege zuerst das Ticket als Issue in diesem Repository an oder benenne den Branch nach einem existierenden Issue.',
    }
  }
  if (issue.isPullRequest) {
    return {
      rule: 'R2',
      title: 'Verknüpftes Issue',
      message: `#${issueNumber} ist ein Pull Request, kein Issue.`,
      action:
        'Verwende im Branch-Namen die Nummer eines Issues (Tickets), nicht die eines Pull Requests.',
    }
  }
  if (requireIssueOpen && issue.state !== 'OPEN') {
    return {
      rule: 'R2',
      title: 'Verknüpftes Issue',
      message: `Issue #${issueNumber} ist geschlossen.`,
      action:
        'Öffne das Issue wieder (wenn die Arbeit noch läuft) oder verknüpfe den PR über einen neuen Branch mit einem offenen Issue.',
    }
  }
  return null
}

// --- R3: title autofix (a repair, not a violation) -----------------------------

// Normalization intentionally maps spaces/underscores/hyphens onto one
// separator so that GitHub's auto-generated PR title for a branch
// (`issue/123-dam-import` -> "Issue/123 dam import") still counts as
// "title consists only of the branch name".
function normalizeForComparison(value) {
  return (value ?? '')
    .trim()
    .toLowerCase()
    .replace(/[\s_-]+/g, '-')
}

/** Render the `title-template` input. Placeholders: {number}, {issueTitle}. */
export function renderTitleTemplate(template, { number, issueTitle }) {
  return template.replaceAll('{number}', String(number)).replaceAll('{issueTitle}', issueTitle)
}

/**
 * R3 — if the PR title consists solely of the branch name (case-insensitive),
 * replace it with the issue title formatted via the template. Any other title
 * is left untouched — the guardrail never "improves" human-written titles.
 * Returns the new title or null.
 */
export function titleAutofix({
  title,
  branch,
  issueNumber,
  issueTitle,
  titleTemplate = DEFAULT_CONFIG.titleTemplate,
}) {
  if (!issueNumber || !issueTitle) return null
  if (normalizeForComparison(title) !== normalizeForComparison(branch)) return null
  const fixed = renderTitleTemplate(titleTemplate, { number: issueNumber, issueTitle })
  return fixed === title ? null : fixed
}

// --- R4: description ----------------------------------------------------------

/**
 * Strip template noise from a PR body: HTML comments, markdown headings and
 * unchecked checkbox lines. What remains (collapsed whitespace) counts as
 * prose for the `min-body-chars` threshold.
 */
export function strippedBody(body) {
  return (body ?? '')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/^[ \t]*#{1,6}[ \t]+.*$/gm, ' ')
    .replace(/^[ \t]*[-*+][ \t]+\[ \][ \t]*.*$/gm, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

/** R4 — the PR body must contain at least `minBodyChars` characters of prose. */
export function checkBody({ body, minBodyChars = DEFAULT_CONFIG.minBodyChars }) {
  const text = strippedBody(body)
  if (text.length >= minBodyChars) return null
  return {
    rule: 'R4',
    title: 'Beschreibung',
    message: `Die PR-Beschreibung enthält nach Abzug von Template-Resten (HTML-Kommentare, Überschriften, leere Checkboxen) nur ${text.length} von mindestens ${minBodyChars} Zeichen Fließtext.`,
    action:
      'Beschreibe im PR-Text kurz, **was** geändert wurde und **warum**. Template-Überschriften und nicht angehakte Checkboxen zählen nicht als Beschreibung.',
  }
}

// --- R5: CI (check runs, commit statuses, merge conflicts) ---------------------

/**
 * Map the GraphQL statusCheckRollup context nodes onto the neutral shape the
 * rule works with: { name, kind: 'check'|'status', state: 'success'|'failure'|'pending' }.
 * Only definitive failures (FAILURE, CANCELLED, TIMED_OUT, STARTUP_FAILURE,
 * ERROR) map to 'failure'; everything unfinished or undecided is 'pending'.
 */
export function normalizeCheckContexts(nodes = []) {
  const result = []
  for (const node of nodes) {
    if (!node || !node.__typename) continue
    if (node.__typename === 'CheckRun') {
      result.push({ name: node.name, kind: 'check', state: checkRunState(node) })
    } else if (node.__typename === 'StatusContext') {
      result.push({ name: node.context, kind: 'status', state: statusContextState(node.state) })
    }
  }
  return result
}

function checkRunState(node) {
  if (node.status !== 'COMPLETED') return 'pending'
  switch (node.conclusion) {
    case 'SUCCESS':
    case 'NEUTRAL':
    case 'SKIPPED':
      return 'success'
    case 'FAILURE':
    case 'CANCELLED':
    case 'TIMED_OUT':
    case 'STARTUP_FAILURE':
      return 'failure'
    default:
      // ACTION_REQUIRED, STALE, null — not a definitive failure.
      return 'pending'
  }
}

function statusContextState(state) {
  switch (state) {
    case 'SUCCESS':
      return 'success'
    case 'FAILURE':
    case 'ERROR':
      return 'failure'
    default:
      // PENDING, EXPECTED
      return 'pending'
  }
}

/**
 * R5 — every check run / commit status on the head SHA must succeed and the
 * PR must be free of merge conflicts.
 *
 * Semantics required by the rollout plan:
 *   - a definitive failure is a violation immediately, even while other
 *     checks are still running;
 *   - checks that are merely pending (or mergeable UNKNOWN) never produce a
 *     violation — the guardrail waits for the next check_suite/status event;
 *   - the guardrail's own check runs (ownCheckNames) are excluded, otherwise
 *     a failed guardrail run would keep the PR red forever.
 *
 * Returns { violations, pending }.
 */
export function checkCi({ checks = [], mergeable = 'UNKNOWN', ownCheckNames = [] }) {
  const own = new Set(ownCheckNames)
  const relevant = checks.filter((c) => !own.has(c.name))
  const failed = relevant.filter((c) => c.state === 'failure')
  const pending = relevant.some((c) => c.state === 'pending') || mergeable === 'UNKNOWN'

  const violations = []
  if (failed.length > 0) {
    const names = failed.map((c) => `\`${c.name}\``)
    const shown = names.slice(0, 5).join(', ') + (names.length > 5 ? ` … (+${names.length - 5} weitere)` : '')
    violations.push({
      rule: 'R5',
      title: 'CI',
      message: `Fehlgeschlagene Checks am aktuellen Stand: ${shown}.`,
      action:
        'Behebe die fehlgeschlagenen Checks und pushe den Fix. Der Guardrail prüft nach Abschluss der CI automatisch erneut.',
    })
  }
  if (mergeable === 'CONFLICTING') {
    violations.push({
      rule: 'R5',
      title: 'Merge-Konflikt',
      message: 'Der PR hat Merge-Konflikte mit dem Base-Branch.',
      action: 'Merge den Base-Branch in deinen Branch (oder rebase) und löse die Konflikte auf.',
    })
  }
  return { violations, pending }
}

// --- R6: closing reference (a repair, not a violation) --------------------------

const CLOSING_KEYWORD = /\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\s*:?\s+/i

function hasClosingKeywordFor(body, issueNumber) {
  const re = new RegExp(`${CLOSING_KEYWORD.source}#${issueNumber}\\b`, 'i')
  return re.test(body ?? '')
}

/**
 * R6 — make sure GitHub links the PR to the issue from R1 (Development
 * sidebar, Projects automation). If neither the resolved
 * closingIssuesReferences nor a closing keyword in the body reference the
 * issue, return the line to append; otherwise null.
 */
export function closingReference({ body, issueNumber, linkedIssueNumbers = [] }) {
  if (!issueNumber) return null
  if (linkedIssueNumbers.includes(issueNumber)) return null
  if (hasClosingKeywordFor(body, issueNumber)) return null
  return `Closes #${issueNumber}`
}

// --- Bot detection --------------------------------------------------------------

// GraphQL reports bot authors without the "[bot]" suffix ("renovate"), REST
// and webhook payloads with it ("renovate[bot]") — normalize both sides.
function normalizeLogin(login) {
  return (login ?? '').toLowerCase().replace(/\[bot\]$/, '')
}

export function isBotAuthor(login, bots = DEFAULT_CONFIG.bots) {
  const normalized = normalizeLogin(login)
  return normalized !== '' && bots.some((bot) => normalizeLogin(bot) === normalized)
}

// --- Master evaluation ------------------------------------------------------------

/**
 * Evaluate all rules against a fact object. Pure — the caller is responsible
 * for gathering the facts and applying the resulting actions.
 *
 * @param {object} facts
 * @param {string} facts.branch            head branch name
 * @param {string} facts.title             PR title
 * @param {string|null} facts.body         PR body
 * @param {string} facts.authorLogin       PR author login
 * @param {object|null} facts.issue        normalized issue lookup (see checkIssue)
 * @param {Array}  facts.checks            normalized check states (see normalizeCheckContexts)
 * @param {string} facts.mergeable         'MERGEABLE' | 'CONFLICTING' | 'UNKNOWN'
 * @param {string[]} facts.ownCheckNames   check-run names of the guardrail itself
 * @param {number[]} facts.linkedIssueNumbers  issues already linked via closing references
 * @param {object} config                  see DEFAULT_CONFIG
 *
 * @returns {{ isBot: boolean, issueNumber: number|null, violations: Array,
 *             ciPending: boolean, titleFix: string|null, appendClosing: string|null }}
 */
export function evaluate(facts, config = {}) {
  const cfg = { ...DEFAULT_CONFIG, ...config }
  const isBot = isBotAuthor(facts.authorLogin, cfg.bots)
  const violations = []
  let issueNumber = null
  let titleFix = null
  let appendClosing = null

  // Bot PRs (Renovate, Dependabot, the CD bot's sync PRs, ...) have no
  // issue/<n> branches and no tickets: R1-R3 and R6 are skipped by design.
  if (!isBot) {
    const branchResult = checkBranch({ branch: facts.branch, branchPattern: cfg.branchPattern })
    issueNumber = branchResult.issueNumber
    if (branchResult.violation) {
      violations.push(branchResult.violation)
    } else {
      const issueViolation = checkIssue({
        issueNumber,
        issue: facts.issue,
        requireIssueOpen: cfg.requireIssueOpen,
      })
      if (issueViolation) {
        violations.push(issueViolation)
      } else {
        // Repairs only make sense against a valid issue reference.
        titleFix = titleAutofix({
          title: facts.title,
          branch: facts.branch,
          issueNumber,
          issueTitle: facts.issue?.title,
          titleTemplate: cfg.titleTemplate,
        })
        appendClosing = closingReference({
          body: facts.body,
          issueNumber,
          linkedIssueNumbers: facts.linkedIssueNumbers ?? [],
        })
      }
    }
  }

  if (!isBot || cfg.botRequireBody) {
    const bodyViolation = checkBody({ body: facts.body, minBodyChars: cfg.minBodyChars })
    if (bodyViolation) violations.push(bodyViolation)
  }

  // R5 applies to everyone, bots included.
  const ci = checkCi({
    checks: facts.checks,
    mergeable: facts.mergeable,
    ownCheckNames: facts.ownCheckNames,
  })
  violations.push(...ci.violations)

  return { isBot, issueNumber, violations, ciPending: ci.pending, titleFix, appendClosing }
}
