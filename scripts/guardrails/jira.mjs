// Pure logic of the Jira link workflow: find Jira keys in a PR's branch and
// title, render the managed link block and splice it into the PR body.
//
// The block sits between START/END markers at the top of the body and is
// rewritten in place, so repeated runs with the same result produce a
// byte-identical body (the runner then skips the write).

export const START = '<!-- jira-link:start -->'
export const END = '<!-- jira-link:end -->'

// A Jira key is PROJECT-123: an uppercase project key (letter first) and a
// number. Branches are matched case-insensitively (ron-229-fix), titles only
// in upper case, so prose like "utf-8" in a title is not a ticket.
const KEY_PATTERN = /(?<![A-Za-z0-9])([A-Za-z][A-Za-z0-9]+)-(\d+)(?![A-Za-z0-9])/g

/** Parse the comma-separated project key list; empty = every key is allowed. */
export function parseProjectKeys(value) {
  return (value ?? '')
    .split(',')
    .map((key) => key.trim().toUpperCase())
    .filter(Boolean)
}

function keysIn(text, { caseSensitive }) {
  const keys = []
  for (const match of (text ?? '').matchAll(KEY_PATTERN)) {
    const project = match[1]
    if (caseSensitive && project !== project.toUpperCase()) continue
    keys.push(`${project.toUpperCase()}-${Number(match[2])}`)
  }
  return keys
}

/**
 * Candidate keys in priority order: branch first, then title. Duplicates are
 * dropped; with `projectKeys` only keys of those Jira projects survive.
 */
export function extractKeys({ branch, title, projectKeys = [] }) {
  const all = [...keysIn(branch, { caseSensitive: false }), ...keysIn(title, { caseSensitive: true })]
  const allowed = new Set(projectKeys)
  return [...new Set(all)].filter((key) => allowed.size === 0 || allowed.has(key.split('-')[0]))
}

/** Jira summaries are third-party text: keep them on one line and inert in Markdown. */
export function escapeInline(text) {
  return String(text ?? '')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[\\`*_[\]<>|#~]/g, (char) => `\\${char}`)
}

/**
 * Render the managed block. `issues` are { key, summary?, status? } — without
 * summary (no Jira credentials or lookup failed) the key is linked as is.
 * Returns '' when there is nothing to link.
 */
export function renderBlock(issues, baseUrl) {
  if (issues.length === 0) return ''
  const base = baseUrl.replace(/\/+$/, '')
  const lines = issues.map(({ key, summary, status }) => {
    let line = `🎫 **Jira:** [${key}](${base}/browse/${key})`
    if (summary) line += ` — ${escapeInline(summary)}`
    if (status) line += ` · _${escapeInline(status)}_`
    return line
  })
  return [START, lines.join('<br>\n'), END].join('\n')
}

/**
 * Replace the managed block in `body` (or prepend it). An empty `block`
 * removes an existing one. Text outside the markers is never touched.
 */
export function upsertBlock(body, block) {
  const current = body ?? ''
  const start = current.indexOf(START)
  const end = start === -1 ? -1 : current.indexOf(END, start)

  let rest = current
  if (start !== -1 && end !== -1) {
    rest = current.slice(0, start) + current.slice(end + END.length)
  }
  rest = rest.replace(/^\s+/, '')

  if (!block) return rest
  return rest ? `${block}\n\n${rest}` : block
}
