import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { END, START, escapeInline, extractKeys, parseProjectKeys, renderBlock, upsertBlock } from './jira.mjs'

describe('extractKeys', () => {
  it('finds the key in a Jira-style branch', () => {
    assert.deepEqual(extractKeys({ branch: 'RON-229-stage', title: '' }), ['RON-229'])
  })

  it('matches branches case-insensitively and normalizes the key', () => {
    assert.deepEqual(extractKeys({ branch: 'feature/ron-0229-fix', title: '' }), ['RON-229'])
  })

  it('only takes upper-case keys from the title', () => {
    assert.deepEqual(extractKeys({ branch: 'main', title: 'Fix utf-8 handling for SUZ-12' }), ['SUZ-12'])
  })

  it('keeps branch before title and drops duplicates', () => {
    assert.deepEqual(extractKeys({ branch: 'RON-229-stage', title: '[RON-229-stage] also TIL-4' }), [
      'RON-229',
      'TIL-4',
    ])
  })

  it('accepts project keys with digits (OVGD, ZR, ...)', () => {
    assert.deepEqual(extractKeys({ branch: 'OVGD-49', title: 'ZR2-1' }), ['OVGD-49', 'ZR2-1'])
  })

  it('ignores keys glued to other words', () => {
    assert.deepEqual(extractKeys({ branch: 'release', title: 'xRON-1 RON-1a2' }), [])
  })

  it('filters by project keys', () => {
    const projectKeys = parseProjectKeys(' ron, til ')
    assert.deepEqual(projectKeys, ['RON', 'TIL'])
    assert.deepEqual(extractKeys({ branch: 'RON-1', title: 'SOM-2 TIL-3', projectKeys }), ['RON-1', 'TIL-3'])
  })

  it('finds nothing in a GitHub-issue branch', () => {
    assert.deepEqual(extractKeys({ branch: 'issue/36', title: '#36 Something' }), [])
  })
})

describe('escapeInline', () => {
  it('flattens whitespace and neutralizes markdown and html', () => {
    assert.equal(escapeInline('  a\n*b* [c](d) <img>  '), 'a \\*b\\* \\[c\\](d) \\<img\\>')
  })
})

describe('renderBlock', () => {
  it('renders nothing without issues', () => {
    assert.equal(renderBlock([], 'https://x.atlassian.net'), '')
  })

  it('links the key and adds summary and status when known', () => {
    const block = renderBlock(
      [{ key: 'RON-229', summary: 'Return 404', status: 'In Progress' }, { key: 'RON-1' }],
      'https://economix.atlassian.net/',
    )
    assert.equal(
      block,
      [
        START,
        '🎫 **Jira:** [RON-229](https://economix.atlassian.net/browse/RON-229) — Return 404 · _In Progress_<br>',
        '🎫 **Jira:** [RON-1](https://economix.atlassian.net/browse/RON-1)',
        END,
      ].join('\n'),
    )
  })
})

describe('upsertBlock', () => {
  const block = `${START}\nlink\n${END}`

  it('prepends the block to an existing body', () => {
    assert.equal(upsertBlock('Beschreibung', block), `${block}\n\nBeschreibung`)
  })

  it('handles an empty body', () => {
    assert.equal(upsertBlock(null, block), block)
  })

  it('replaces an existing block and is idempotent', () => {
    const once = upsertBlock('Beschreibung', block)
    assert.equal(upsertBlock(once, block), once)
    const updated = upsertBlock(once, `${START}\nother\n${END}`)
    assert.equal(updated, `${START}\nother\n${END}\n\nBeschreibung`)
  })

  it('removes the block when there is nothing to link', () => {
    assert.equal(upsertBlock(`${block}\n\nBeschreibung`, ''), 'Beschreibung')
  })

  it('leaves a body with a lone start marker alone apart from prepending', () => {
    assert.equal(upsertBlock(`${START} kaputt`, block), `${block}\n\n${START} kaputt`)
  })
})
