/**
 * EventStore and LineSplitter, driven by tests/fixtures/event-store.json
 * (shared with the Rust port).
 */

import { strict as assert } from 'node:assert'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { EventStore, LineSplitter } from '../../server/eventStore.ts'

const fixture = JSON.parse(readFileSync(join(import.meta.dirname, '../fixtures/event-store.json'), 'utf-8'))
const ids = (events: { id: string }[]) => events.map((e) => e.id)

describe('EventStore.add', () => {
  for (const scenario of fixture.eventStore) {
    it(scenario.name, () => {
      const store = new EventStore(scenario.maxEvents)
      for (const [i, step] of scenario.steps.entries()) {
        const result = store.add(structuredClone(step.add))
        if (step.expect === 'duplicate') {
          assert.equal(result, null, `step ${i}`)
          continue
        }
        assert.ok(result, `step ${i} should be added`)
        if (typeof step.expect === 'object') {
          for (const [key, value] of Object.entries(step.expect)) {
            if (value === null) assert.equal(key in result, false, `step ${i}: ${key} should be absent`)
            else assert.deepEqual((result as Record<string, unknown>)[key], value, `step ${i}: ${key}`)
          }
        }
      }
      assert.deepEqual(ids(store.events), scenario.expectedIds)
    })
  }
})

describe('EventStore queries', () => {
  const { queries } = fixture
  const store = new EventStore(100)
  for (const event of queries.events) store.add(structuredClone(event))

  for (const q of queries.initialHistory) {
    it(`initialHistory: ${q.name}`, () => {
      assert.deepEqual(ids(store.initialHistory(new Set(q.managed), q.cutoff, q.limit)), q.expectedIds)
    })
  }
  for (const q of queries.recent) {
    it(`recent(${q.limit})`, () => assert.deepEqual(ids(store.recent(q.limit)), q.expectedIds))
  }
  it('lastSessionId', () => {
    assert.equal(store.lastSessionId(), queries.lastSessionId)
    assert.equal(new EventStore(10).lastSessionId(), 'unknown')
  })
})

describe('LineSplitter', () => {
  for (const c of fixture.lineSplitter) {
    it(c.name, () => {
      const splitter = new LineSplitter()
      const got = c.chunksHex.map((hex: string) => splitter.push(Buffer.from(hex, 'hex')))
      assert.deepEqual(got, c.expected)
    })
  }
  it('reset drops the held partial line', () => {
    const splitter = new LineSplitter()
    splitter.push(Buffer.from('partial'))
    splitter.reset()
    assert.deepEqual(splitter.push(Buffer.from('new\n')), ['new'])
  })
})
