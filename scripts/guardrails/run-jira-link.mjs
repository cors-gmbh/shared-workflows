#!/usr/bin/env node
// Links the Jira tickets a PR refers to (branch/title, e.g. RON-229-stage)
// in a managed block at the top of the PR body.
//
// With Jira credentials (JIRA_USER_EMAIL + a scoped JIRA_API_TOKEN with
// read:jira-work) every candidate key is looked up and only existing tickets are linked, with summary and
// status. Without credentials the keys are linked unverified. Failures of
// the Jira lookup never fail the job — the link is the useful part.

import { readFileSync } from 'node:fs'
import { GitHubClient, requireEnv } from './github.mjs'
import { extractKeys, parseProjectKeys, renderBlock, upsertBlock } from './jira.mjs'

// Scoped API tokens only work through the Atlassian gateway, addressed by the
// site's cloud ID — the site URL itself rejects them. The ID comes from the
// site's public tenant_info endpoint, so callers need no extra setting.
async function resolveApiUrl(baseUrl) {
  const response = await fetch(`${baseUrl.replace(/\/+$/, '')}/_edge/tenant_info`, {
    headers: { accept: 'application/json', 'user-agent': 'cors-pr-jira-link' },
  })
  if (!response.ok) throw new Error(`Jira cloud ID lookup failed (HTTP ${response.status})`)
  const { cloudId } = await response.json()
  if (!cloudId) throw new Error('Jira cloud ID lookup returned no cloudId')
  return `https://api.atlassian.com/ex/jira/${cloudId}`
}

async function lookupIssue(apiUrl, auth, key) {
  const url = `${apiUrl}/rest/api/3/issue/${encodeURIComponent(key)}?fields=summary,status`
  const response = await fetch(url, {
    headers: { authorization: `Basic ${auth}`, accept: 'application/json', 'user-agent': 'cors-pr-jira-link' },
  })
  if (response.status === 404) return null
  if (!response.ok) throw new Error(`Jira lookup ${key} failed (HTTP ${response.status})`)
  const issue = await response.json()
  return { key: issue.key ?? key, summary: issue.fields?.summary, status: issue.fields?.status?.name }
}

async function resolveIssues(keys, baseUrl) {
  const email = process.env.JIRA_USER_EMAIL
  const token = process.env.JIRA_API_TOKEN
  if (!email || !token) {
    console.log('No Jira credentials — linking the keys without lookup.')
    return keys.map((key) => ({ key }))
  }

  let apiUrl
  try {
    apiUrl = await resolveApiUrl(baseUrl)
  } catch (error) {
    console.log(`::warning::${error.message} — linking the keys without lookup.`)
    return keys.map((key) => ({ key }))
  }

  const auth = Buffer.from(`${email}:${token}`).toString('base64')
  const issues = []
  for (const key of keys) {
    try {
      const issue = await lookupIssue(apiUrl, auth, key)
      if (issue) issues.push(issue)
      else console.log(`${key} does not exist in Jira — skipped.`)
    } catch (error) {
      console.log(`::warning::${error.message} — linking ${key} without details.`)
      issues.push({ key })
    }
  }
  return issues
}

async function main() {
  const [owner, repo] = requireEnv('GITHUB_REPOSITORY').split('/')
  const event = JSON.parse(readFileSync(requireEnv('GITHUB_EVENT_PATH'), 'utf8'))
  const pr = event.pull_request
  if (!pr?.number) {
    console.log('No pull_request payload in this event — nothing to do.')
    return
  }

  // Bot branches (dependabot/npm_and_yarn/vite-5, renovate/node-20.x) look
  // like Jira keys but never are.
  if (pr.user?.type === 'Bot') {
    console.log(`PR by bot ${pr.user.login} — nothing to link.`)
    return
  }

  const baseUrl = requireEnv('JIRA_BASE_URL')
  const keys = extractKeys({
    branch: pr.head?.ref,
    title: pr.title,
    projectKeys: parseProjectKeys(process.env.JIRA_PROJECT_KEYS),
  })
  console.log(keys.length ? `Candidate keys: ${keys.join(', ')}` : 'No Jira key in branch or title.')

  const issues = keys.length ? await resolveIssues(keys, baseUrl) : []
  const block = renderBlock(issues, baseUrl)

  // Re-read the body: the event payload may predate an edit made since.
  const api = new GitHubClient({ token: requireEnv('GITHUB_TOKEN'), owner, repo })
  const current = await api.rest('GET', `/repos/${owner}/${repo}/pulls/${pr.number}`)
  const body = current.body ?? ''
  const next = upsertBlock(body, block)
  if (next === body) {
    console.log('PR body already up to date.')
    return
  }
  await api.updatePrBody(pr.number, next)
  console.log(issues.length ? `Linked ${issues.map((i) => i.key).join(', ')}.` : 'Removed the stale Jira block.')
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
