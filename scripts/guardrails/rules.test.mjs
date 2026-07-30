import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  DEFAULT_CONFIG,
  checkBody,
  checkBranch,
  checkCi,
  checkIssue,
  closingReference,
  evaluate,
  extractIssueNumber,
  isBotAuthor,
  normalizeCheckContexts,
  strippedBody,
  titleAutofix,
} from './rules.mjs'

// ---------------------------------------------------------------------------
// R1 — branch name
// ---------------------------------------------------------------------------

describe('R1: extractIssueNumber / checkBranch', () => {
  it('accepts issue/123', () => {
    assert.equal(extractIssueNumber('issue/123'), 123)
    assert.equal(checkBranch({ branch: 'issue/123' }).violation, null)
  })

  it('accepts a descriptive suffix: issue/123-kurzbeschreibung', () => {
    assert.equal(extractIssueNumber('issue/123-kurzbeschreibung'), 123)
  })

  it('is case-insensitive: Issue/123', () => {
    assert.equal(extractIssueNumber('Issue/123'), 123)
    assert.equal(extractIssueNumber('ISSUE/42-Foo_Bar'), 42)
  })

  it('rejects issue/0 (no valid issue number)', () => {
    assert.equal(extractIssueNumber('issue/0'), null)
    assert.equal(checkBranch({ branch: 'issue/0' }).violation.rule, 'R1')
  })

  it('rejects issue/abc', () => {
    assert.equal(extractIssueNumber('issue/abc'), null)
  })

  it('rejects feature/123', () => {
    assert.equal(extractIssueNumber('feature/123'), null)
  })

  it('rejects a branch without prefix', () => {
    assert.equal(extractIssueNumber('main'), null)
    assert.equal(extractIssueNumber('123'), null)
  })

  it('rejects a number followed by non-suffix characters (issue/123abc)', () => {
    assert.equal(extractIssueNumber('issue/123abc'), null)
  })

  it('handles empty/missing branch names', () => {
    assert.equal(extractIssueNumber(''), null)
    assert.equal(extractIssueNumber(undefined), null)
  })

  it('honors a custom pattern without suffix support', () => {
    const strict = String.raw`^issue/(\d+)$`
    assert.equal(extractIssueNumber('issue/123', strict), 123)
    assert.equal(extractIssueNumber('issue/123-suffix', strict), null)
  })

  it('reports the offending branch in the violation message', () => {
    const { violation } = checkBranch({ branch: 'feature/123' })
    assert.match(violation.message, /feature\/123/)
    assert.ok(violation.action.length > 0)
  })
})

// ---------------------------------------------------------------------------
// R2 — issue exists (and is open)
// ---------------------------------------------------------------------------

describe('R2: checkIssue', () => {
  const openIssue = { exists: true, isPullRequest: false, state: 'OPEN', title: 'Titel' }

  it('passes for an existing open issue', () => {
    assert.equal(checkIssue({ issueNumber: 5, issue: openIssue, requireIssueOpen: true }), null)
  })

  it('flags a missing issue', () => {
    const v = checkIssue({ issueNumber: 999, issue: { exists: false }, requireIssueOpen: true })
    assert.equal(v.rule, 'R2')
    assert.match(v.message, /#999/)
  })

  it('flags a number that points to a pull request instead of an issue', () => {
    const v = checkIssue({
      issueNumber: 7,
      issue: { exists: true, isPullRequest: true, state: null, title: null },
    })
    assert.equal(v.rule, 'R2')
    assert.match(v.message, /Pull Request/)
  })

  it('flags a closed issue when require-issue-open is set', () => {
    const closed = { exists: true, isPullRequest: false, state: 'CLOSED', title: 'Titel' }
    const v = checkIssue({ issueNumber: 5, issue: closed, requireIssueOpen: true })
    assert.equal(v.rule, 'R2')
    assert.match(v.message, /geschlossen/)
  })

  it('accepts a closed issue when require-issue-open is off', () => {
    const closed = { exists: true, isPullRequest: false, state: 'CLOSED', title: 'Titel' }
    assert.equal(checkIssue({ issueNumber: 5, issue: closed, requireIssueOpen: false }), null)
  })
})

// ---------------------------------------------------------------------------
// R3 — title autofix
// ---------------------------------------------------------------------------

describe('R3: titleAutofix', () => {
  const base = { issueNumber: 123, issueTitle: 'DAM Import bricht ab' }

  it('fixes a title that is exactly the branch name', () => {
    const fixed = titleAutofix({ ...base, title: 'issue/123', branch: 'issue/123' })
    assert.equal(fixed, '#123 DAM Import bricht ab')
  })

  it('fixes a title that differs only in casing (Issue/123)', () => {
    const fixed = titleAutofix({ ...base, title: 'Issue/123', branch: 'issue/123' })
    assert.equal(fixed, '#123 DAM Import bricht ab')
  })

  it("fixes GitHub's auto-generated title for suffixed branches", () => {
    // Branch issue/123-dam-import -> GitHub suggests "Issue/123 dam import".
    const fixed = titleAutofix({ ...base, title: 'Issue/123 dam import', branch: 'issue/123-dam-import' })
    assert.equal(fixed, '#123 DAM Import bricht ab')
  })

  it('leaves a title alone that merely CONTAINS the branch name', () => {
    assert.equal(titleAutofix({ ...base, title: 'issue/123 fix crash', branch: 'issue/123' }), null)
  })

  it('never touches a human-written title', () => {
    assert.equal(titleAutofix({ ...base, title: 'DAM-Import reparieren', branch: 'issue/123' }), null)
  })

  it('does nothing without an issue title to copy from', () => {
    assert.equal(titleAutofix({ issueNumber: 123, issueTitle: null, title: 'issue/123', branch: 'issue/123' }), null)
  })

  it('respects a custom title template', () => {
    const fixed = titleAutofix({
      ...base,
      title: 'issue/123',
      branch: 'issue/123',
      titleTemplate: '{issueTitle} (#{number})',
    })
    assert.equal(fixed, 'DAM Import bricht ab (#123)')
  })

  it('returns null when the title already equals the rendered template', () => {
    assert.equal(
      titleAutofix({ ...base, title: '#123 DAM Import bricht ab', branch: 'issue/123' }),
      null,
    )
  })
})

// ---------------------------------------------------------------------------
// R4 — description
// ---------------------------------------------------------------------------

describe('R4: strippedBody / checkBody', () => {
  it('strips HTML comments (also multiline)', () => {
    assert.equal(strippedBody('<!-- bitte beschreiben -->'), '')
    assert.equal(strippedBody('<!--\nmehrzeiliger\nkommentar\n-->'), '')
  })

  it('flags a body that consists only of template comments', () => {
    const v = checkBody({ body: '<!-- Was wurde geändert? -->\n<!-- Warum? -->', minBodyChars: 10 })
    assert.equal(v.rule, 'R4')
  })

  it('strips markdown headings', () => {
    assert.equal(strippedBody('## Was wurde geändert?\n### Warum?'), '')
  })

  it('strips unchecked checkboxes but keeps checked ones', () => {
    const body = '- [ ] Tests geschrieben\n- [x] Lokal getestet'
    assert.equal(strippedBody(body), '- [x] Lokal getestet')
  })

  it('strips an unchecked checkbox without trailing text', () => {
    assert.equal(strippedBody('- [ ]'), '')
  })

  it('does not treat issue references like #123 as headings', () => {
    assert.equal(strippedBody('#123 hmm'), '#123 hmm')
  })

  it('enforces the exact threshold', () => {
    const text49 = 'a'.repeat(49)
    const text50 = 'a'.repeat(50)
    assert.equal(checkBody({ body: text49, minBodyChars: 50 }).rule, 'R4')
    assert.equal(checkBody({ body: text50, minBodyChars: 50 }), null)
  })

  it('flags empty and missing bodies', () => {
    assert.equal(checkBody({ body: '', minBodyChars: 1 }).rule, 'R4')
    assert.equal(checkBody({ body: null, minBodyChars: 1 }).rule, 'R4')
  })

  it('counts real prose surrounded by template noise', () => {
    const body = [
      '## Was wurde geändert?',
      'Der DAM-Import bricht bei Umlauten nicht mehr ab, Encoding wird jetzt erkannt.',
      '- [ ] offener Punkt',
    ].join('\n')
    assert.equal(checkBody({ body, minBodyChars: 50 }), null)
  })
})

// ---------------------------------------------------------------------------
// R5 — CI
// ---------------------------------------------------------------------------

describe('R5: checkCi', () => {
  const ok = (name) => ({ name, kind: 'check', state: 'success' })
  const pending = (name) => ({ name, kind: 'check', state: 'pending' })
  const failed = (name) => ({ name, kind: 'check', state: 'failure' })

  it('passes when everything is green and mergeable', () => {
    const result = checkCi({ checks: [ok('build'), ok('lint')], mergeable: 'MERGEABLE' })
    assert.deepEqual(result.violations, [])
    assert.equal(result.pending, false)
  })

  it('does NOTHING while checks are still running', () => {
    const result = checkCi({ checks: [ok('build'), pending('tests')], mergeable: 'MERGEABLE' })
    assert.deepEqual(result.violations, [])
    assert.equal(result.pending, true)
  })

  it('treats mergeable UNKNOWN as pending, not as a violation', () => {
    const result = checkCi({ checks: [ok('build')], mergeable: 'UNKNOWN' })
    assert.deepEqual(result.violations, [])
    assert.equal(result.pending, true)
  })

  it('flags a definitive failure even while other checks still run', () => {
    const result = checkCi({ checks: [failed('tests'), pending('build')], mergeable: 'MERGEABLE' })
    assert.equal(result.violations.length, 1)
    assert.match(result.violations[0].message, /`tests`/)
  })

  it('flags merge conflicts', () => {
    const result = checkCi({ checks: [ok('build')], mergeable: 'CONFLICTING' })
    assert.equal(result.violations.length, 1)
    assert.match(result.violations[0].message, /Konflikt/)
  })

  it('excludes the guardrail`s own check runs (no endless loop)', () => {
    const result = checkCi({
      checks: [failed('guardrail / guardrail'), ok('build')],
      mergeable: 'MERGEABLE',
      ownCheckNames: ['guardrail / guardrail'],
    })
    assert.deepEqual(result.violations, [])
    assert.equal(result.pending, false)
  })

  it('passes vacuously when a repo has no CI at all', () => {
    const result = checkCi({ checks: [], mergeable: 'MERGEABLE' })
    assert.deepEqual(result.violations, [])
    assert.equal(result.pending, false)
  })
})

describe('R5: normalizeCheckContexts', () => {
  it('maps check runs and statuses onto the neutral shape', () => {
    const nodes = [
      { __typename: 'CheckRun', name: 'build', status: 'COMPLETED', conclusion: 'SUCCESS' },
      { __typename: 'CheckRun', name: 'tests', status: 'COMPLETED', conclusion: 'FAILURE' },
      { __typename: 'CheckRun', name: 'e2e', status: 'IN_PROGRESS', conclusion: null },
      { __typename: 'CheckRun', name: 'deploy', status: 'COMPLETED', conclusion: 'CANCELLED' },
      { __typename: 'CheckRun', name: 'slow', status: 'COMPLETED', conclusion: 'TIMED_OUT' },
      { __typename: 'CheckRun', name: 'optional', status: 'COMPLETED', conclusion: 'NEUTRAL' },
      { __typename: 'CheckRun', name: 'skipped', status: 'COMPLETED', conclusion: 'SKIPPED' },
      { __typename: 'CheckRun', name: 'gate', status: 'COMPLETED', conclusion: 'ACTION_REQUIRED' },
      { __typename: 'StatusContext', context: 'ci/legacy', state: 'ERROR' },
      { __typename: 'StatusContext', context: 'ci/other', state: 'PENDING' },
      { __typename: 'StatusContext', context: 'ci/fine', state: 'SUCCESS' },
    ]
    const states = Object.fromEntries(normalizeCheckContexts(nodes).map((c) => [c.name, c.state]))
    assert.deepEqual(states, {
      build: 'success',
      tests: 'failure',
      e2e: 'pending',
      deploy: 'failure',
      slow: 'failure',
      optional: 'success',
      skipped: 'success',
      gate: 'pending',
      'ci/legacy': 'failure',
      'ci/other': 'pending',
      'ci/fine': 'success',
    })
  })

  it('ignores unknown nodes gracefully', () => {
    assert.deepEqual(normalizeCheckContexts([null, {}, { __typename: 'Other' }]), [])
  })
})

// ---------------------------------------------------------------------------
// R6 — closing reference
// ---------------------------------------------------------------------------

describe('R6: closingReference', () => {
  it('appends when the body has no reference at all', () => {
    assert.equal(closingReference({ body: 'Beschreibung.', issueNumber: 123 }), 'Closes #123')
  })

  it('appends for an empty body', () => {
    assert.equal(closingReference({ body: '', issueNumber: 123 }), 'Closes #123')
  })

  it('does not append when GitHub already resolved the link', () => {
    assert.equal(closingReference({ body: '', issueNumber: 123, linkedIssueNumbers: [123] }), null)
  })

  it('does not append when a closing keyword is present (any casing)', () => {
    assert.equal(closingReference({ body: 'closes #123', issueNumber: 123 }), null)
    assert.equal(closingReference({ body: 'Fixes #123', issueNumber: 123 }), null)
    assert.equal(closingReference({ body: 'Resolved: #123', issueNumber: 123 }), null)
  })

  it('appends when only a bare #123 without keyword is present', () => {
    assert.equal(closingReference({ body: 'siehe #123', issueNumber: 123 }), 'Closes #123')
  })

  it('is exact about the number (no prefix matches)', () => {
    assert.equal(closingReference({ body: 'Closes #12', issueNumber: 123 }), 'Closes #123')
    assert.equal(closingReference({ body: 'Closes #1234', issueNumber: 123 }), 'Closes #123')
  })

  it('does nothing without an issue number', () => {
    assert.equal(closingReference({ body: '', issueNumber: null }), null)
  })
})

// ---------------------------------------------------------------------------
// Bot detection
// ---------------------------------------------------------------------------

describe('isBotAuthor', () => {
  it('matches webhook-style logins (renovate[bot])', () => {
    assert.equal(isBotAuthor('renovate[bot]'), true)
    assert.equal(isBotAuthor('dependabot[bot]'), true)
  })

  it('matches GraphQL-style logins without the [bot] suffix', () => {
    assert.equal(isBotAuthor('renovate'), true)
    assert.equal(isBotAuthor('github-actions'), true)
  })

  it('does not match humans', () => {
    assert.equal(isBotAuthor('pfaffenbauer'), false)
    assert.equal(isBotAuthor(''), false)
    assert.equal(isBotAuthor(undefined), false)
  })

  it('honors a custom bot list (e.g. the CD bot)', () => {
    const bots = [...DEFAULT_CONFIG.bots, 'cors-cd[bot]']
    assert.equal(isBotAuthor('cors-cd', bots), true)
    assert.equal(isBotAuthor('cors-cd[bot]', bots), true)
  })
})

// ---------------------------------------------------------------------------
// evaluate — integration of all rules
// ---------------------------------------------------------------------------

describe('evaluate', () => {
  const greenChecks = [{ name: 'build', kind: 'check', state: 'success' }]
  const humanFacts = {
    branch: 'issue/123',
    title: 'issue/123',
    body: 'Der DAM-Import bricht bei Umlauten nicht mehr ab, Encoding wird korrekt erkannt.',
    authorLogin: 'pfaffenbauer',
    issue: { exists: true, isPullRequest: false, state: 'OPEN', title: 'DAM Import bricht ab' },
    checks: greenChecks,
    mergeable: 'MERGEABLE',
    ownCheckNames: [],
    linkedIssueNumbers: [],
  }

  it('happy path: no violations, title autofix + closing reference', () => {
    const result = evaluate(humanFacts)
    assert.deepEqual(result.violations, [])
    assert.equal(result.isBot, false)
    assert.equal(result.issueNumber, 123)
    assert.equal(result.titleFix, '#123 DAM Import bricht ab')
    assert.equal(result.appendClosing, 'Closes #123')
    assert.equal(result.ciPending, false)
  })

  it('R1 violation skips the issue rules but still checks body and CI', () => {
    const result = evaluate({ ...humanFacts, branch: 'feature/123', body: '', issue: null })
    const rules = result.violations.map((v) => v.rule)
    assert.deepEqual(rules, ['R1', 'R4'])
    assert.equal(result.titleFix, null)
    assert.equal(result.appendClosing, null)
  })

  it('closed issue: violation and NO repairs', () => {
    const result = evaluate({
      ...humanFacts,
      issue: { exists: true, isPullRequest: false, state: 'CLOSED', title: 'DAM Import bricht ab' },
    })
    assert.deepEqual(result.violations.map((v) => v.rule), ['R2'])
    assert.equal(result.titleFix, null)
    assert.equal(result.appendClosing, null)
  })

  it('closed issue passes when require-issue-open is off', () => {
    const result = evaluate(
      {
        ...humanFacts,
        issue: { exists: true, isPullRequest: false, state: 'CLOSED', title: 'DAM Import bricht ab' },
      },
      { requireIssueOpen: false },
    )
    assert.deepEqual(result.violations, [])
  })

  it('bot author: R1-R3/R6 skipped, R4 off by default, R5 still applies', () => {
    const result = evaluate({
      ...humanFacts,
      authorLogin: 'renovate[bot]',
      branch: 'renovate/symfony-7.x',
      body: '',
      issue: null,
      checks: [{ name: 'build', kind: 'check', state: 'failure' }],
    })
    assert.equal(result.isBot, true)
    assert.deepEqual(result.violations.map((v) => v.rule), ['R5'])
    assert.equal(result.titleFix, null)
    assert.equal(result.appendClosing, null)
  })

  it('bot author with bot-require-body: R4 applies', () => {
    const result = evaluate(
      { ...humanFacts, authorLogin: 'renovate[bot]', branch: 'renovate/x', body: '', issue: null },
      { botRequireBody: true },
    )
    assert.deepEqual(result.violations.map((v) => v.rule), ['R4'])
  })

  it('pending CI produces no violation but marks the result as pending', () => {
    const result = evaluate({
      ...humanFacts,
      title: 'Sauberer Titel',
      checks: [{ name: 'build', kind: 'check', state: 'pending' }],
    })
    assert.deepEqual(result.violations, [])
    assert.equal(result.ciPending, true)
  })

  it('collects multiple violations at once', () => {
    const result = evaluate({
      ...humanFacts,
      branch: 'issue/999',
      title: 'egal',
      body: '<!-- nur template -->',
      issue: { exists: false },
      checks: [{ name: 'build', kind: 'check', state: 'failure' }],
      mergeable: 'CONFLICTING',
    })
    assert.deepEqual(result.violations.map((v) => v.rule), ['R2', 'R4', 'R5', 'R5'])
  })
})
