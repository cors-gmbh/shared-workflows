#!/usr/bin/env node
// Guardrail orchestrator. Reads the workflow event + inputs from the
// environment, gathers facts through the API layer (github.mjs), evaluates
// the pure rules (rules.mjs) and applies the outcome: title autofix, closing
// reference, sticky comment, draft conversion, exit code.
//
// Runs under pull_request_target — it must NEVER execute code from the PR
// head. The workflow only checks out cors-gmbh/shared-workflows.

import { readFileSync } from 'node:fs'
import { GitHubClient, requireEnv } from './github.mjs'
import { DEFAULT_CONFIG, evaluate, extractIssueNumber, issueRepoFor, normalizeCheckContexts } from './rules.mjs'
import {
  MARKER,
  renderAuditComment,
  renderBypassDeniedComment,
  renderStatusComment,
  renderSuccessComment,
} from './comment.mjs'

function env(name, fallback) {
  const value = process.env[name]
  return value === undefined || value === '' ? fallback : value
}

function boolEnv(name, fallback) {
  return env(name, String(fallback)) === 'true'
}

function readConfig() {
  return {
    enforce: boolEnv('INPUT_ENFORCE', DEFAULT_CONFIG.enforce),
    minBodyChars: Number.parseInt(env('INPUT_MIN_BODY_CHARS', String(DEFAULT_CONFIG.minBodyChars)), 10),
    requireIssueOpen: boolEnv('INPUT_REQUIRE_ISSUE_OPEN', DEFAULT_CONFIG.requireIssueOpen),
    branchPattern: env('INPUT_BRANCH_PATTERN', DEFAULT_CONFIG.branchPattern),
    titleTemplate: env('INPUT_TITLE_TEMPLATE', DEFAULT_CONFIG.titleTemplate),
    bots: env('INPUT_BOTS', DEFAULT_CONFIG.bots.join(','))
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
    botRequireBody: boolEnv('INPUT_BOT_REQUIRE_BODY', DEFAULT_CONFIG.botRequireBody),
    bypassLabel: env('INPUT_BYPASS_LABEL', DEFAULT_CONFIG.bypassLabel),
    issueRepoStripSuffix: env('INPUT_ISSUE_REPO_STRIP_SUFFIX', ''),
  }
}

/** Resolve the PRs affected by this event as [{ number, branch }]. */
async function resolvePrs({ api, eventName, event }) {
  if (eventName === 'pull_request_target' || eventName === 'pull_request') {
    return [{ number: event.pull_request.number, branch: event.pull_request.head.ref }]
  }
  if (eventName === 'check_suite') {
    return api.listOpenPrsForSha(event.check_suite.head_sha)
  }
  if (eventName === 'status') {
    return api.listOpenPrsForSha(event.sha)
  }
  console.log(`Event ${eventName} is not handled — nothing to do.`)
  return []
}

/**
 * Process one PR. Returns true when the job must fail (enforce mode with
 * violations).
 */
async function processPr({ api, prRef, event, eventName, cfg, ownJobNames }) {
  const prNumber = prRef.number
  const issueNumber = extractIssueNumber(prRef.branch, cfg.branchPattern)
  const issueRepo = issueRepoFor(api.repo, cfg.issueRepoStripSuffix)
  const bundle = await api.fetchPrBundle({ prNumber, issueNumber, issueRepo })
  const { pr, issue } = bundle

  if (pr.state !== 'OPEN') {
    console.log(`PR #${prNumber}: not open (${pr.state}) — skipping.`)
    return false
  }

  // ---- Bypass label: admins/maintainers only ---------------------------------
  const isBypassLabelEvent =
    eventName === 'pull_request_target' &&
    event.action === 'labeled' &&
    event.label?.name === cfg.bypassLabel &&
    event.pull_request?.number === prNumber

  if (isBypassLabelEvent) {
    const login = event.sender?.login ?? ''
    const role = await api.getCollaboratorRole(login)
    if (role === 'admin' || role === 'maintain') {
      // Permanent audit trail, then skip the guardrail entirely.
      await api.addComment(
        prNumber,
        renderAuditComment({
          login,
          role,
          timestamp: new Date().toISOString(),
          bypassLabel: cfg.bypassLabel,
        }),
      )
      console.log(`PR #${prNumber}: bypass authorized for @${login} (${role}) — guardrail skipped.`)
      return false
    }
    // Not authorized: remove the label and continue with the normal checks.
    await api.removeLabel(prNumber, cfg.bypassLabel)
    await api.addComment(prNumber, renderBypassDeniedComment({ login, bypassLabel: cfg.bypassLabel }))
    console.log(`PR #${prNumber}: bypass denied for @${login} (${role}) — label removed.`)
  } else if (pr.labels.includes(cfg.bypassLabel)) {
    // Label already present. Unauthorized labelings are removed immediately
    // on the `labeled` event, so a persisting label was authorized.
    console.log(`PR #${prNumber}: bypass label active — guardrail skipped.`)
    return false
  }

  // ---- Evaluate the pure rules -------------------------------------------------
  const result = evaluate(
    {
      branch: pr.branch,
      title: pr.title,
      body: pr.body,
      authorLogin: pr.authorLogin,
      issue,
      checks: normalizeCheckContexts(bundle.checkContexts),
      mergeable: pr.mergeable,
      ownCheckNames: ownJobNames,
      linkedIssues: pr.linkedIssues,
      selfRepo: `${api.owner}/${api.repo}`,
      // Order mirrors the lookup priority in fetchPrBundle.
      searchedRepos: issueRepo
        ? [`${api.owner}/${issueRepo}`, `${api.owner}/${api.repo}`]
        : [`${api.owner}/${api.repo}`],
    },
    cfg,
  )

  // ---- Apply repairs -----------------------------------------------------------
  // R3 (title autofix) is the only thing that also runs for drafts.
  if (result.titleFix) {
    await api.updatePrTitle(prNumber, result.titleFix)
    console.log(`PR #${prNumber}: title autofix -> ${JSON.stringify(result.titleFix)}`)
  }

  if (pr.isDraft) {
    console.log(`PR #${prNumber}: draft — all other rules skipped until "Ready for review".`)
    return false
  }

  if (result.appendClosing) {
    const newBody = pr.body ? `${pr.body}\n\n${result.appendClosing}` : result.appendClosing
    await api.updatePrBody(prNumber, newBody)
    console.log(`PR #${prNumber}: appended closing reference "${result.appendClosing}".`)
  }

  // ---- Report -------------------------------------------------------------------
  if (result.violations.length === 0) {
    if (result.ciPending) {
      // Checks still running: do nothing at all. The next check_suite/status
      // event finalizes the verdict.
      console.log(`PR #${prNumber}: no violations, CI still running — leaving everything untouched.`)
      return false
    }
    const outcome = await api.upsertStickyComment(prNumber, MARKER, renderSuccessComment(), {
      createIfMissing: false,
    })
    console.log(`PR #${prNumber}: all rules pass (comment: ${outcome}).`)
    return false
  }

  const commentBody = renderStatusComment({
    violations: result.violations,
    ciPending: result.ciPending,
    enforce: cfg.enforce,
  })
  const outcome = await api.upsertStickyComment(prNumber, MARKER, commentBody)
  const ruleIds = result.violations.map((v) => v.rule).join(', ')
  console.log(`PR #${prNumber}: violations [${ruleIds}] (comment: ${outcome}).`)

  if (cfg.enforce) {
    await api.convertToDraft(pr.id)
    console.error(`PR #${prNumber}: converted to draft (enforce mode).`)
    return true
  }
  console.log(`PR #${prNumber}: hint mode — job stays green.`)
  return false
}

async function main() {
  const [owner, repo] = requireEnv('GITHUB_REPOSITORY').split('/')
  const eventName = requireEnv('GITHUB_EVENT_NAME')
  const event = JSON.parse(readFileSync(requireEnv('GITHUB_EVENT_PATH'), 'utf8'))
  const cfg = readConfig()

  // PRs of the CD bot itself (e.g. file-sync PRs) take the bot path: the app
  // that runs the guardrail is always part of the bot list.
  const appSlug = env('APP_SLUG', '')
  if (appSlug) cfg.bots = [...cfg.bots, `${appSlug}[bot]`]

  const api = new GitHubClient({ token: requireEnv('GUARDRAIL_TOKEN'), owner, repo })
  // The jobs lookup runs with the workflow's own GITHUB_TOKEN (actions: read).
  const actionsApi = new GitHubClient({ token: requireEnv('ACTIONS_TOKEN'), owner, repo })

  // Our own title/body autofixes fire `edited` events. Re-evaluating them
  // would always be a no-op, so skip early.
  if (
    eventName === 'pull_request_target' &&
    event.action === 'edited' &&
    appSlug &&
    event.sender?.login === `${appSlug}[bot]`
  ) {
    console.log('Edited by the guardrail app itself — skipping.')
    return
  }

  const ownJobNames = await actionsApi.getJobNames(requireEnv('GITHUB_RUN_ID'))

  // Completion of our own check suite must not re-trigger an evaluation
  // (endless loop otherwise).
  if (eventName === 'check_suite') {
    if (await api.isOwnCheckSuite(event.check_suite.id, ownJobNames)) {
      console.log('Own check suite completed — skipping to avoid a trigger loop.')
      return
    }
  }

  const prs = await resolvePrs({ api, eventName, event })
  if (prs.length === 0) {
    console.log('No open PRs affected by this event — done.')
    return
  }

  let failed = false
  for (const prRef of prs) {
    failed = (await processPr({ api, prRef, event, eventName, cfg, ownJobNames })) || failed
  }
  if (failed) process.exitCode = 1
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
