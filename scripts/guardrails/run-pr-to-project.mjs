#!/usr/bin/env node
// Adds a PR to the Projects-V2 boards of its linked (closing) issues.
//
// Resolution: PR -> closingIssuesReferences -> projectItems of those issues.
// The PR is added to every board it is not already on, in ONE batched
// GraphQL mutation (aliased addProjectV2ItemById fields). Idempotent: boards
// the PR is already on are skipped, and no linked projects is a success.

import { readFileSync } from 'node:fs'
import { GitHubClient, GitHubApiError, requireEnv } from './github.mjs'

const PROJECTS_QUERY = /* GraphQL */ `
  query PrProjects($owner: String!, $repo: String!, $pr: Int!) {
    repository(owner: $owner, name: $repo) {
      pullRequest(number: $pr) {
        id
        projectItems(first: 50, includeArchived: false) {
          nodes {
            project {
              id
            }
          }
        }
        closingIssuesReferences(first: 50) {
          nodes {
            number
            projectItems(first: 50, includeArchived: false) {
              nodes {
                project {
                  id
                  title
                }
              }
            }
          }
        }
      }
    }
  }
`

async function main() {
  const [owner, repo] = requireEnv('GITHUB_REPOSITORY').split('/')
  const event = JSON.parse(readFileSync(requireEnv('GITHUB_EVENT_PATH'), 'utf8'))

  const prNumber = event.pull_request?.number
  if (!prNumber) {
    console.log('No pull_request payload in this event — nothing to do.')
    return
  }

  const api = new GitHubClient({ token: requireEnv('GUARDRAIL_TOKEN'), owner, repo })
  const { data, errors } = await api.graphql(PROJECTS_QUERY, { owner, repo, pr: prNumber })
  if (errors?.length) {
    throw new GitHubApiError('Projects query failed', { details: JSON.stringify(errors) })
  }
  const pr = data?.repository?.pullRequest
  if (!pr) {
    console.log(`PR #${prNumber} not found — nothing to do.`)
    return
  }

  const alreadyOn = new Set((pr.projectItems?.nodes ?? []).map((node) => node.project.id))
  const targets = new Map()
  for (const issue of pr.closingIssuesReferences?.nodes ?? []) {
    for (const item of issue.projectItems?.nodes ?? []) {
      if (!alreadyOn.has(item.project.id)) {
        targets.set(item.project.id, item.project.title)
      }
    }
  }

  if (targets.size === 0) {
    console.log(`PR #${prNumber}: no (new) projects on the linked issues — done.`)
    return
  }

  // One batched mutation instead of a roundtrip per project.
  const projectIds = [...targets.keys()]
  const variableDefs = projectIds.map((_, i) => `$p${i}: ID!`).join(', ')
  const fields = projectIds
    .map((_, i) => `add${i}: addProjectV2ItemById(input: { projectId: $p${i}, contentId: $content }) { item { id } }`)
    .join('\n')
  const mutation = `mutation AddToProjects($content: ID!, ${variableDefs}) {\n${fields}\n}`
  const variables = { content: pr.id, ...Object.fromEntries(projectIds.map((id, i) => [`p${i}`, id])) }

  const result = await api.graphql(mutation, variables)
  if (result.errors?.length) {
    throw new GitHubApiError('addProjectV2ItemById failed', { details: JSON.stringify(result.errors) })
  }
  console.log(`PR #${prNumber}: added to ${targets.size} project(s): ${[...targets.values()].join(', ')}`)
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
