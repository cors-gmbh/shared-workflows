import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { GitHubClient } from './github.mjs'
import { MARKER } from './comment.mjs'

// In-memory stand-in for the comment endpoints: listComments returns the
// fixture, every REST write is recorded instead of sent.
class FakeClient extends GitHubClient {
  constructor(comments) {
    super({ token: 't', owner: 'o', repo: 'r' })
    this.comments = comments
    this.calls = []
  }

  async listComments() {
    return this.comments
  }

  async addComment(prNumber, body) {
    this.calls.push(['POST', prNumber, body])
  }

  async rest(method, path) {
    this.calls.push([method, path])
    return null
  }
}

const bot = { login: 'guardrail-bot[bot]' }
const sticky = (id, body, user = bot) => ({ id, body: `${MARKER}\n${body}`, user })

describe('upsertStickyComment', () => {
  it('updates the first sticky comment and deletes the bot`s duplicates', async () => {
    const api = new FakeClient([sticky(1, 'R1 + R5'), { id: 2, body: 'hi', user: { login: 'dev' } }, sticky(3, 'R1')])
    const outcome = await api.upsertStickyComment(42, MARKER, `${MARKER}\nnew`)
    assert.equal(outcome, 'updated')
    assert.deepEqual(api.calls, [
      ['DELETE', '/repos/o/r/issues/comments/3'],
      ['PATCH', '/repos/o/r/issues/comments/1'],
    ])
  })

  it('deletes duplicates even when the kept comment is already up to date', async () => {
    const api = new FakeClient([sticky(1, 'same'), sticky(3, 'old')])
    assert.equal(await api.upsertStickyComment(42, MARKER, `${MARKER}\nsame`), 'unchanged')
    assert.deepEqual(api.calls, [['DELETE', '/repos/o/r/issues/comments/3']])
  })

  it('never deletes a comment written by someone else', async () => {
    const api = new FakeClient([sticky(1, 'same'), sticky(3, 'quoted', { login: 'dev' })])
    assert.equal(await api.upsertStickyComment(42, MARKER, `${MARKER}\nsame`), 'unchanged')
    assert.deepEqual(api.calls, [])
  })

  it('creates the comment when none exists yet', async () => {
    const api = new FakeClient([])
    assert.equal(await api.upsertStickyComment(42, MARKER, `${MARKER}\nnew`), 'created')
    assert.deepEqual(api.calls, [['POST', 42, `${MARKER}\nnew`]])
  })
})
