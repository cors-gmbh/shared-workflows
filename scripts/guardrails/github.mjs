// Thin GitHub API layer (REST + GraphQL) on top of the global fetch that
// ships with Node >= 18. No third-party dependencies, so the scripts run on
// a bare runner without npm install.
//
// All rule evaluation is pure and lives in rules.mjs — this module only
// gathers facts and applies decisions.

import { commentsEqual } from './comment.mjs'

const API_URL = process.env.GITHUB_API_URL ?? 'https://api.github.com'
const GRAPHQL_URL = process.env.GITHUB_GRAPHQL_URL ?? 'https://api.github.com/graphql'

export class GitHubApiError extends Error {
  constructor(message, { status, details } = {}) {
    super(status ? `${message} (HTTP ${status})` : message)
    this.name = 'GitHubApiError'
    this.status = status
    this.details = details
  }
}

/** Read a required environment variable or fail loudly. */
export function requireEnv(name) {
  const value = process.env[name]
  if (value === undefined || value === '') {
    throw new Error(`Missing required environment variable: ${name}`)
  }
  return value
}

// The one bundled query that fetches everything a guardrail run needs in a
// single roundtrip: PR core data, labels, linked issues, the referenced
// issue (via @include so the lookup is skipped when R1 already failed) and
// the full check/status rollup of the head commit.
const PR_BUNDLE_QUERY = /* GraphQL */ `
  query PrBundle($owner: String!, $repo: String!, $pr: Int!, $issue: Int!, $checkIssue: Boolean!) {
    repository(owner: $owner, name: $repo) {
      pullRequest(number: $pr) {
        id
        number
        state
        isDraft
        title
        body
        headRefName
        headRefOid
        author {
          __typename
          login
        }
        mergeable
        labels(first: 100) {
          nodes {
            name
          }
        }
        closingIssuesReferences(first: 50) {
          nodes {
            number
          }
        }
        commits(last: 1) {
          nodes {
            commit {
              statusCheckRollup {
                state
                contexts(first: 100) {
                  pageInfo {
                    hasNextPage
                    endCursor
                  }
                  nodes {
                    __typename
                    ... on CheckRun {
                      name
                      status
                      conclusion
                    }
                    ... on StatusContext {
                      context
                      state
                    }
                  }
                }
              }
            }
          }
        }
      }
      issueOrPullRequest(number: $issue) @include(if: $checkIssue) {
        __typename
        ... on Issue {
          number
          title
          state
        }
        ... on PullRequest {
          number
        }
      }
    }
  }
`

const MORE_CONTEXTS_QUERY = /* GraphQL */ `
  query MoreContexts($owner: String!, $repo: String!, $pr: Int!, $cursor: String!) {
    repository(owner: $owner, name: $repo) {
      pullRequest(number: $pr) {
        commits(last: 1) {
          nodes {
            commit {
              statusCheckRollup {
                contexts(first: 100, after: $cursor) {
                  pageInfo {
                    hasNextPage
                    endCursor
                  }
                  nodes {
                    __typename
                    ... on CheckRun {
                      name
                      status
                      conclusion
                    }
                    ... on StatusContext {
                      context
                      state
                    }
                  }
                }
              }
            }
          }
        }
      }
    }
  }
`

export class GitHubClient {
  #token

  constructor({ token, owner, repo }) {
    this.#token = token
    this.owner = owner
    this.repo = repo
  }

  async rest(method, path, { body, allow404 = false } = {}) {
    const url = path.startsWith('https://') ? path : `${API_URL}${path}`
    const response = await fetch(url, {
      method,
      headers: {
        authorization: `Bearer ${this.#token}`,
        accept: 'application/vnd.github+json',
        'x-github-api-version': '2022-11-28',
        'user-agent': 'cors-pr-guardrail',
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    })
    if (response.status === 404 && allow404) return null
    if (!response.ok) {
      const details = await response.text().catch(() => '')
      throw new GitHubApiError(`${method} ${path} failed`, { status: response.status, details })
    }
    if (response.status === 204) return null
    return response.json()
  }

  /**
   * Execute a GraphQL query. Returns { data, errors } — HTTP failures throw,
   * GraphQL-level errors are returned for the caller to inspect (partial
   * responses are expected, e.g. for the issue lookup).
   */
  async graphql(query, variables) {
    const response = await fetch(GRAPHQL_URL, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${this.#token}`,
        'content-type': 'application/json',
        'user-agent': 'cors-pr-guardrail',
      },
      body: JSON.stringify({ query, variables }),
    })
    if (!response.ok) {
      const details = await response.text().catch(() => '')
      throw new GitHubApiError('GraphQL request failed', { status: response.status, details })
    }
    return response.json()
  }

  /**
   * Fetch everything a guardrail run needs in one GraphQL roundtrip.
   * `issueNumber` may be null when the branch does not reference one — the
   * issue lookup is then skipped server-side via @include.
   */
  async fetchPrBundle({ prNumber, issueNumber }) {
    const checkIssue = Number.isInteger(issueNumber) && issueNumber > 0
    const { data, errors } = await this.graphql(PR_BUNDLE_QUERY, {
      owner: this.owner,
      repo: this.repo,
      pr: prNumber,
      // The variable must validate as Int! even when @include skips the field.
      issue: checkIssue ? issueNumber : 1,
      checkIssue,
    })

    const repository = data?.repository
    if (errors?.length) {
      // A NOT_FOUND on the issue lookup is an expected R2 outcome; anything
      // else is a real error.
      const onlyIssueLookup = errors.every(
        (e) => Array.isArray(e.path) && e.path[0] === 'repository' && e.path[1] === 'issueOrPullRequest',
      )
      if (!onlyIssueLookup) {
        throw new GitHubApiError('PR bundle query failed', { details: JSON.stringify(errors) })
      }
    }
    const prNode = repository?.pullRequest
    if (!prNode) {
      throw new GitHubApiError(`Pull request #${prNumber} not found in ${this.owner}/${this.repo}`)
    }

    // Collect all check/status contexts, following pagination if a PR has
    // more than 100 of them.
    let contexts = prNode.commits?.nodes?.[0]?.commit?.statusCheckRollup?.contexts ?? null
    const contextNodes = contexts ? [...contexts.nodes] : []
    while (contexts?.pageInfo?.hasNextPage) {
      const more = await this.graphql(MORE_CONTEXTS_QUERY, {
        owner: this.owner,
        repo: this.repo,
        pr: prNumber,
        cursor: contexts.pageInfo.endCursor,
      })
      contexts = more.data?.repository?.pullRequest?.commits?.nodes?.[0]?.commit?.statusCheckRollup?.contexts ?? null
      if (contexts) contextNodes.push(...contexts.nodes)
    }

    const issueNode = checkIssue ? (repository?.issueOrPullRequest ?? null) : undefined
    const issue = !checkIssue
      ? null
      : issueNode === null
        ? { exists: false, isPullRequest: false, state: null, title: null }
        : issueNode.__typename === 'PullRequest'
          ? { exists: true, isPullRequest: true, state: null, title: null }
          : { exists: true, isPullRequest: false, state: issueNode.state, title: issueNode.title }

    return {
      pr: {
        id: prNode.id,
        number: prNode.number,
        state: prNode.state,
        isDraft: prNode.isDraft,
        title: prNode.title,
        body: prNode.body ?? '',
        branch: prNode.headRefName,
        headSha: prNode.headRefOid,
        authorLogin: prNode.author?.login ?? '',
        mergeable: prNode.mergeable ?? 'UNKNOWN',
        labels: (prNode.labels?.nodes ?? []).map((l) => l.name),
        linkedIssueNumbers: (prNode.closingIssuesReferences?.nodes ?? []).map((n) => n.number),
      },
      issue,
      checkContexts: contextNodes,
    }
  }

  /** Open PRs whose head currently points at the given SHA (check_suite/status events). */
  async listOpenPrsForSha(sha) {
    const prs = await this.rest('GET', `/repos/${this.owner}/${this.repo}/commits/${sha}/pulls?per_page=100`)
    return (prs ?? [])
      .filter((pr) => pr.state === 'open' && pr.head?.sha === sha)
      .map((pr) => ({ number: pr.number, branch: pr.head.ref }))
  }

  /** Job names of a workflow run — used to exclude the guardrail's own check runs. */
  async getJobNames(runId) {
    const data = await this.rest('GET', `/repos/${this.owner}/${this.repo}/actions/runs/${runId}/jobs?per_page=100`)
    return (data?.jobs ?? []).map((job) => job.name)
  }

  /**
   * True when every check run of the given suite belongs to the guardrail
   * itself (same job names as the current run). Breaks the feedback loop of
   * `check_suite: completed` retriggering the guardrail forever.
   */
  async isOwnCheckSuite(checkSuiteId, ownJobNames) {
    const data = await this.rest(
      'GET',
      `/repos/${this.owner}/${this.repo}/check-suites/${checkSuiteId}/check-runs?per_page=100`,
    )
    const runs = data?.check_runs ?? []
    if (runs.length === 0) return false
    const own = new Set(ownJobNames)
    return runs.every((run) => own.has(run.name))
  }

  /** Effective role of a user on this repository: admin | maintain | write | triage | read | none. */
  async getCollaboratorRole(username) {
    const data = await this.rest(
      'GET',
      `/repos/${this.owner}/${this.repo}/collaborators/${encodeURIComponent(username)}/permission`,
    )
    // role_name knows "maintain"; the legacy "permission" field reports it as "write".
    return data?.role_name ?? data?.permission ?? 'none'
  }

  async updatePrTitle(prNumber, title) {
    await this.rest('PATCH', `/repos/${this.owner}/${this.repo}/pulls/${prNumber}`, { body: { title } })
  }

  async updatePrBody(prNumber, body) {
    await this.rest('PATCH', `/repos/${this.owner}/${this.repo}/pulls/${prNumber}`, { body: { body } })
  }

  async convertToDraft(prNodeId) {
    const { errors } = await this.graphql(
      /* GraphQL */ `
        mutation ConvertToDraft($id: ID!) {
          convertPullRequestToDraft(input: { pullRequestId: $id }) {
            pullRequest {
              isDraft
            }
          }
        }
      `,
      { id: prNodeId },
    )
    if (errors?.length) {
      throw new GitHubApiError('convertPullRequestToDraft failed', { details: JSON.stringify(errors) })
    }
  }

  async removeLabel(issueNumber, label) {
    // 404 = label already gone; that is fine (idempotent).
    await this.rest(
      'DELETE',
      `/repos/${this.owner}/${this.repo}/issues/${issueNumber}/labels/${encodeURIComponent(label)}`,
      { allow404: true },
    )
  }

  async listComments(prNumber) {
    const all = []
    for (let page = 1; ; page++) {
      const chunk = await this.rest(
        'GET',
        `/repos/${this.owner}/${this.repo}/issues/${prNumber}/comments?per_page=100&page=${page}`,
      )
      all.push(...(chunk ?? []))
      if (!chunk || chunk.length < 100) break
    }
    return all
  }

  async addComment(prNumber, body) {
    await this.rest('POST', `/repos/${this.owner}/${this.repo}/issues/${prNumber}/comments`, { body: { body } })
  }

  /**
   * Create or update the sticky comment identified by `marker`.
   * Identical content results in NO api write. With createIfMissing=false the
   * comment is only ever reduced/updated, never newly created (used for the
   * success message).
   * Returns 'created' | 'updated' | 'unchanged' | 'skipped'.
   */
  async upsertStickyComment(prNumber, marker, body, { createIfMissing = true } = {}) {
    const comments = await this.listComments(prNumber)
    const existing = comments.find((c) => typeof c.body === 'string' && c.body.includes(marker))
    if (!existing) {
      if (!createIfMissing) return 'skipped'
      await this.addComment(prNumber, body)
      return 'created'
    }
    if (commentsEqual(existing.body, body)) return 'unchanged'
    await this.rest('PATCH', `/repos/${this.owner}/${this.repo}/issues/comments/${existing.id}`, {
      body: { body },
    })
    return 'updated'
  }
}
