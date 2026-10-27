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
//
// Every rule is evaluated on its own and reported on its own: a failed rule
// never hides the result of another one, so a single comment shows
// everything that has to be fixed.

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

/** All rules in the order the sticky comment lists them. */
export const RULES = Object.freeze([
  Object.freeze({ rule: 'R1', title: 'Branch-Name' }),
  Object.freeze({ rule: 'R2', title: 'Verknüpftes Issue' }),
  Object.freeze({ rule: 'R3', title: 'Titel' }),
  Object.freeze({ rule: 'R4', title: 'Beschreibung' }),
  Object.freeze({ rule: 'R5', title: 'CI' }),
  Object.freeze({ rule: 'R6', title: 'Issue-Referenz' }),
])

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
 * R2 — the issue referenced by the branch must exist. It is looked up in this
 * repository and, when the caller configured one, in a second repository that
 * holds the tickets (manifest repo -> project repo).
 * `issue` is the normalized lookup result:
 *   { exists: boolean, isPullRequest: boolean, state: 'OPEN'|'CLOSED'|null,
 *     title: string|null, repo: string|null }
 * A number that resolves to a pull request is NOT a valid issue. Without an
 * issue number (R1 failed) there is nothing to look up, which fails R2 too.
 * `searchedRepos` names the repositories that were searched, for the message.
 */
export function checkIssue({
  issueNumber,
  issue,
  requireIssueOpen = DEFAULT_CONFIG.requireIssueOpen,
  searchedRepos = [],
}) {
  if (!issueNumber) {
    return {
      rule: 'R2',
      title: 'Verknüpftes Issue',
      message: 'Der Branch-Name enthält keine Issue-Nummer, der PR ist daher mit keinem Issue verknüpft.',
      action:
        'Benenne den Branch nach einem offenen Issue (siehe R1). Lege das Issue vorher an, falls es noch keines gibt.',
    }
  }

  // "in diesem Repository" is only true when nothing else was searched.
  const where =
    searchedRepos.length > 1
      ? `in ${searchedRepos.join(' oder ')}`
      : 'in diesem Repository'

  if (!issue || !issue.exists) {
    return {
      rule: 'R2',
      title: 'Verknüpftes Issue',
      message: `Es gibt kein Issue #${issueNumber} ${where}.`,
      action:
        searchedRepos.length > 1
          ? `Lege das Ticket als Issue in ${searchedRepos[0]} an oder benenne den Branch nach einem existierenden Issue.`
          : 'Lege zuerst das Ticket als Issue in diesem Repository an oder benenne den Branch nach einem existierenden Issue.',
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

/**
 * Repository holding this repo's tickets, or null when they live here.
 * Convention instead of per-repo configuration: `bellaflora-manifest` with
 * the suffix `-manifest` points at `bellaflora`, so one caller template can
 * serve every manifest repo. Returns the bare name (same owner).
 */
export function issueRepoFor(repo, stripSuffix) {
  if (!stripSuffix || !repo || !repo.endsWith(stripSuffix)) return null
  const base = repo.slice(0, -stripSuffix.length)
  return base === '' ? null : base
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

/** True when the PR title is nothing but the branch name (see normalizeForComparison). */
export function isBranchNameTitle(title, branch) {
  return normalizeForComparison(title) === normalizeForComparison(branch)
}

/**
 * R3 without a valid issue: a title that is only the branch name cannot be
 * repaired, because the issue title to put there is unknown.
 */
export function checkTitle({ title, branch }) {
  if (!isBranchNameTitle(title, branch)) return null
  return {
    rule: 'R3',
    title: 'Titel',
    message:
      'Der PR-Titel ist nur der Branch-Name. Der Guardrail ersetzt ihn durch den Issue-Titel, aber erst, wenn der PR mit einem gültigen Issue verknüpft ist (R1/R2).',
    action: 'Behebe R1/R2, dann wird der Titel automatisch gesetzt, oder gib dem PR einen Titel, der sagt, was er ändert.',
  }
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
  if (!isBranchNameTitle(title, branch)) return null
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
 * rule works with:
 *   { name, kind: 'check'|'status', state: 'success'|'failure'|'pending', url: string|null }.
 * Only definitive failures (FAILURE, CANCELLED, TIMED_OUT, STARTUP_FAILURE,
 * ERROR) map to 'failure'; everything unfinished or undecided is 'pending'.
 * `url` points at the log of the job (check run) or the external CI page
 * (commit status).
 */
export function normalizeCheckContexts(nodes = []) {
  const result = []
  for (const node of nodes) {
    if (!node || !node.__typename) continue
    if (node.__typename === 'CheckRun') {
      result.push({ name: node.name, kind: 'check', state: checkRunState(node), url: node.detailsUrl ?? null })
    } else if (node.__typename === 'StatusContext') {
      result.push({
        name: node.context,
        kind: 'status',
        state: statusContextState(node.state),
        url: node.targetUrl ?? null,
      })
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

// Check names and URLs come from whatever workflow or app reported them —
// on a fork PR that is code the contributor controls. Keep a backtick from
// ending the code span and only link plain https URLs.
function codeSpan(text) {
  return `\`${String(text ?? '').replaceAll('`', "'")}\``
}

function safeUrl(url) {
  return typeof url === 'string' && /^https:\/\/[^\s<>]+$/.test(url) ? url : null
}

/**
 * One list line per failed check name. Matrix jobs of different workflows
 * can share a name; they are grouped on one line with a link per job instead
 * of repeating the same text.
 */
function failedCheckLines(failed) {
  const byName = new Map()
  for (const check of failed) {
    if (!byName.has(check.name)) byName.set(check.name, [])
    byName.get(check.name).push(safeUrl(check.url))
  }
  const lines = []
  for (const [name, urls] of byName) {
    const links = urls.filter(Boolean)
    if (urls.length === 1 && links.length === 1) {
      lines.push(`- [${codeSpan(name)}](<${links[0]}>)`)
    } else if (links.length > 0) {
      lines.push(`- ${codeSpan(name)} — ${links.map((url, i) => `[Job ${i + 1}](<${url}>)`).join(', ')}`)
    } else {
      lines.push(`- ${codeSpan(name)}${urls.length > 1 ? ` (${urls.length}×)` : ''}`)
    }
  }
  return lines
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
 *     a failed guardrail run would keep the PR red forever;
 *   - every failed check is listed, each linked to its log, so one round
 *     shows everything that has to be fixed.
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
    const heading =
      failed.length === 1
        ? '1 Check ist am aktuellen Stand fehlgeschlagen:'
        : `${failed.length} Checks sind am aktuellen Stand fehlgeschlagen:`
    violations.push({
      rule: 'R5',
      title: 'CI',
      message: [heading, '', ...failedCheckLines(failed)].join('\n'),
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

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function hasClosingKeywordFor(body, reference) {
  const re = new RegExp(`${CLOSING_KEYWORD.source}${escapeRegExp(reference)}\\b`, 'i')
  return re.test(body ?? '')
}

// The appended `Refs` line itself: without this check every run would add it again.
function hasRefsFor(body, reference) {
  const re = new RegExp(`\\brefs\\s*:?\\s+${escapeRegExp(reference)}\\b`, 'i')
  return re.test(body ?? '')
}

/**
 * R6 — make sure GitHub links the PR to the issue from R1 (Development
 * sidebar, Projects automation). If neither the resolved
 * closingIssuesReferences nor a closing keyword in the body reference the
 * issue, return the line to append; otherwise null.
 *
 * `issueRepo` is where the issue actually lives and `selfRepo` this PR's
 * repository (both `owner/name`). They differ for repos whose tickets are
 * tracked elsewhere; the reference then has to be qualified
 * (`Refs cors-gmbh/bellaflora#123`), because a bare `#123` would point at
 * this repository. `linkedIssues` are the already resolved closing
 * references as { number, repo }.
 */
export function closingReference({
  body,
  issueNumber,
  issueRepo = null,
  selfRepo = null,
  linkedIssues = [],
}) {
  if (!issueNumber) return null

  const crossRepo = Boolean(issueRepo) && Boolean(selfRepo) && issueRepo !== selfRepo
  const reference = crossRepo ? `${issueRepo}#${issueNumber}` : `#${issueNumber}`
  const targetRepo = issueRepo ?? selfRepo

  // Match the repository too: #123 in another repo is a different ticket.
  const alreadyLinked = linkedIssues.some(
    (linked) =>
      linked.number === issueNumber && (!targetRepo || !linked.repo || linked.repo === targetRepo),
  )
  if (alreadyLinked) return null
  if (hasClosingKeywordFor(body, reference) || hasRefsFor(body, reference)) return null
  // `Refs`, not `Closes`: a merge must not close the ticket on its own.
  return `Refs ${reference}`
}

/**
 * R6 without a valid issue: the reference cannot be appended, so the PR stays
 * unlinked unless the body already references some issue on its own
 * (closing keyword or `Refs`, bare or qualified with `owner/name`).
 */
export function checkClosingReference({ body, linkedIssues = [] }) {
  if (linkedIssues.length > 0) return null
  const anyReference = new RegExp(
    `(?:${CLOSING_KEYWORD.source}|\\brefs\\s*:?\\s+)(?:[\\w.-]+/[\\w.-]+)?#\\d+\\b`,
    'i',
  )
  if (anyReference.test(body ?? '')) return null
  return {
    rule: 'R6',
    title: 'Issue-Referenz',
    message:
      'Der PR-Text verweist auf kein Issue (`Refs #<nummer>`), und der Guardrail kann den Verweis erst ergänzen, wenn der PR mit einem gültigen Issue verknüpft ist (R1/R2).',
    action: 'Behebe R1/R2, dann wird der Verweis automatisch ergänzt, oder ergänze `Refs #<nummer>` im PR-Text.',
  }
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
 * @param {Array}  facts.linkedIssues     already linked issues as { number, repo }
 * @param {string|null} facts.issueRepo    `owner/name` where the issue was found
 * @param {string|null} facts.selfRepo     `owner/name` of this PR's repository
 * @param {string[]} facts.searchedRepos   repositories searched for the issue (R2 message)
 * @param {object} config                  see DEFAULT_CONFIG
 *
 * `ruleResults` holds one entry per rule of RULES, in that order:
 *   { rule, title, status: 'pass'|'fail'|'pending'|'repaired'|'skipped', note: string|null }
 * `violations` holds the details of every rule with status 'fail' (R5 can
 * contribute two: failed checks and a merge conflict), in the same order.
 *
 * @returns {{ isBot: boolean, issueNumber: number|null, ruleResults: Array,
 *             violations: Array, ciPending: boolean, titleFix: string|null,
 *             appendClosing: string|null }}
 */
export function evaluate(facts, config = {}) {
  const cfg = { ...DEFAULT_CONFIG, ...config }
  const isBot = isBotAuthor(facts.authorLogin, cfg.bots)
  const results = new Map()
  let issueNumber = null
  let titleFix = null
  let appendClosing = null

  const fail = (...violations) => ({ status: 'fail', note: null, violations })
  const pass = () => ({ status: 'pass', note: null, violations: [] })
  const skip = (note) => ({ status: 'skipped', note, violations: [] })
  const repaired = (note) => ({ status: 'repaired', note, violations: [] })
  const outcome = (violation) => (violation ? fail(violation) : pass())

  // Bot PRs (Renovate, Dependabot, the CD bot's sync PRs, ...) have no
  // issue/<n> branches and no tickets: R1-R3 and R6 are skipped by design.
  if (isBot) {
    for (const rule of ['R1', 'R2', 'R3', 'R6']) results.set(rule, skip('Bot-PR'))
  } else {
    const branchResult = checkBranch({ branch: facts.branch, branchPattern: cfg.branchPattern })
    issueNumber = branchResult.issueNumber
    results.set('R1', outcome(branchResult.violation))

    const issueViolation = checkIssue({
      issueNumber,
      issue: facts.issue,
      requireIssueOpen: cfg.requireIssueOpen,
      searchedRepos: facts.searchedRepos ?? [],
    })
    results.set('R2', outcome(issueViolation))

    if (issueViolation) {
      // Without a valid issue the repairs cannot run; whatever they would
      // have fixed is reported instead of silently left as it is.
      results.set('R3', outcome(checkTitle({ title: facts.title, branch: facts.branch })))
      results.set('R6', outcome(checkClosingReference({ body: facts.body, linkedIssues: facts.linkedIssues ?? [] })))
    } else {
      titleFix = titleAutofix({
        title: facts.title,
        branch: facts.branch,
        issueNumber,
        issueTitle: facts.issue?.title,
        titleTemplate: cfg.titleTemplate,
      })
      results.set('R3', titleFix ? repaired('durch den Issue-Titel ersetzt') : pass())
      appendClosing = closingReference({
        body: facts.body,
        issueNumber,
        issueRepo: facts.issue?.repo ?? null,
        selfRepo: facts.selfRepo ?? null,
        linkedIssues: facts.linkedIssues ?? [],
      })
      results.set('R6', appendClosing ? repaired(`\`${appendClosing}\` ergänzt`) : pass())
    }
  }

  results.set(
    'R4',
    isBot && !cfg.botRequireBody
      ? skip('Bot-PR')
      : outcome(checkBody({ body: facts.body, minBodyChars: cfg.minBodyChars })),
  )

  // R5 applies to everyone, bots included.
  const ci = checkCi({
    checks: facts.checks,
    mergeable: facts.mergeable,
    ownCheckNames: facts.ownCheckNames,
  })
  results.set(
    'R5',
    ci.violations.length > 0
      ? fail(...ci.violations)
      : ci.pending
        ? { status: 'pending', note: 'Checks laufen noch', violations: [] }
        : pass(),
  )

  const ruleResults = RULES.map(({ rule, title }) => {
    const { status, note } = results.get(rule)
    return { rule, title, status, note }
  })
  const violations = RULES.flatMap(({ rule }) => results.get(rule).violations)

  return { isBot, issueNumber, ruleResults, violations, ciPending: ci.pending, titleFix, appendClosing }
}
