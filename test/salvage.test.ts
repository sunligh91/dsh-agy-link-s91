import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, appendFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  agyCliDir,
  brainDir,
  candidateTranscriptPaths,
  lastStepIndex,
  readFinishedAnswer,
} from '../src/host/salvage.ts'

/**
 * Build a fake agy home: <root>/.gemini/antigravity-cli/brain/<cid>/.system_generated/logs/transcript_full.jsonl.
 * The salvage module resolves the transcript from the account dir, so a temp
 * directory stands in for one.
 */
function fakeHome(): {
  dir: string
  write: (cid: string, records: unknown[]) => void
  append: (cid: string, record: unknown) => void
} {
  const dir = mkdtempSync(join(tmpdir(), 'agy-salvage-'))
  const write = (cid: string, records: unknown[]): void => {
    const logs = join(brainDir(dir), cid, '.system_generated', 'logs')
    mkdirSync(logs, { recursive: true })
    writeFileSync(join(logs, 'transcript_full.jsonl'), records.map((r) => JSON.stringify(r)).join('\n') + '\n')
  }
  const append = (cid: string, record: unknown): void => {
    const path = candidateTranscriptPaths(cid, dir)[0] as string
    appendFileSync(path, JSON.stringify(record) + '\n')
  }
  return { dir, write, append }
}

function answer(step: number, text: string): unknown {
  return {
    step_index: step,
    source: 'MODEL',
    type: 'PLANNER_RESPONSE',
    status: 'DONE',
    content: text,
    created_at: '2026-09-13T06:40:10Z',
  }
}

function toolDispatch(step: number): unknown {
  return {
    step_index: step,
    source: 'MODEL',
    type: 'PLANNER_RESPONSE',
    status: 'DONE',
    content: '',
    tool_calls: [{ name: 'view_file', args: {} }],
  }
}

test('agyCliDir and brainDir honour an isolated account home', () => {
  assert.equal(agyCliDir('/tmp/acc'), join('/tmp/acc', '.gemini', 'antigravity-cli'))
  assert.equal(brainDir('/tmp/acc'), join('/tmp/acc', '.gemini', 'antigravity-cli', 'brain'))
})

test('DSH_AGY_CLI_HOME overrides the default home, but an account dir still wins', () => {
  const saved = process.env.DSH_AGY_CLI_HOME
  try {
    process.env.DSH_AGY_CLI_HOME = '/tmp/override'
    assert.equal(agyCliDir(), '/tmp/override')
    // An explicit account dir outranks the env override: pool accounts are
    // physically isolated, so their own tree must be the one inspected.
    assert.equal(agyCliDir('/tmp/acc'), join('/tmp/acc', '.gemini', 'antigravity-cli'))
    delete process.env.DSH_AGY_CLI_HOME
    assert.ok(agyCliDir().includes(join('.gemini', 'antigravity-cli')))
  } finally {
    if (saved === undefined) delete process.env.DSH_AGY_CLI_HOME
    else process.env.DSH_AGY_CLI_HOME = saved
  }
})

test('candidateTranscriptPaths returns full then compact, empty for no id', () => {
  const paths = candidateTranscriptPaths('c1', '/tmp/acc')
  assert.equal(paths.length, 2)
  assert.ok(paths[0]?.endsWith('transcript_full.jsonl'))
  assert.ok(paths[1]?.endsWith('transcript.jsonl'))
  assert.deepEqual(candidateTranscriptPaths('', '/tmp/acc'), [])
})

test('lastStepIndex reports the newest step, -1 when absent', () => {
  const home = fakeHome()
  try {
    home.write('c1', [{ step_index: 1 }, toolDispatch(7), answer(9, 'hello')])
    assert.equal(lastStepIndex('c1', home.dir), 9)
    assert.equal(lastStepIndex('missing', home.dir), -1)
  } finally {
    rmSync(home.dir, { recursive: true, force: true })
  }
})

test('a finished answer at the tail is recovered', () => {
  const home = fakeHome()
  try {
    home.write('c1', [toolDispatch(4), answer(6, 'the complete answer text goes here and is long enough')])
    const got = readFinishedAnswer('c1', home.dir, 10, 4)
    assert.ok(got !== null, 'answer must be recovered')
    assert.equal(got.step, 6)
    assert.equal(got.createdAt, '2026-09-13T06:40:10Z')
    assert.match(got.text, /complete answer/)
  } finally {
    rmSync(home.dir, { recursive: true, force: true })
  }
})

test('a mid-turn tool dispatch is never mistaken for an answer', () => {
  const home = fakeHome()
  try {
    home.write('c1', [answer(3, 'an earlier real answer that is sufficiently long'), toolDispatch(5)])
    assert.equal(readFinishedAnswer('c1', home.dir, 10, -1), null)
  } finally {
    rmSync(home.dir, { recursive: true, force: true })
  }
})

test('an answer left over from a previous turn is rejected by the baseline', () => {
  const home = fakeHome()
  try {
    home.write('c1', [answer(6, 'a leftover answer from the previous turn, long enough')])
    assert.equal(readFinishedAnswer('c1', home.dir, 10, 6), null)
    assert.ok(readFinishedAnswer('c1', home.dir, 10, -1) !== null)
  } finally {
    rmSync(home.dir, { recursive: true, force: true })
  }
})

test('short content below minChars is not adopted', () => {
  const home = fakeHome()
  try {
    home.write('c1', [answer(2, 'too short')])
    assert.equal(readFinishedAnswer('c1', home.dir, 40, -1), null)
  } finally {
    rmSync(home.dir, { recursive: true, force: true })
  }
})

test('non-DONE or non-planner records are ignored', () => {
  const home = fakeHome()
  try {
    home.write('c1', [
      { step_index: 1, type: 'PLANNER_RESPONSE', status: 'RUNNING', content: 'x'.repeat(80) },
      { step_index: 2, type: 'GENERIC', status: 'DONE', content: 'y'.repeat(80) },
    ])
    assert.equal(readFinishedAnswer('c1', home.dir, 10, -1), null)
  } finally {
    rmSync(home.dir, { recursive: true, force: true })
  }
})

test('a torn trailing line does not hide the answer before it', () => {
  const home = fakeHome()
  try {
    home.write('c1', [answer(3, 'the answer that must still be found even though the file is torn')])
    const path = candidateTranscriptPaths('c1', home.dir)[0] as string
    appendFileSync(path, '{"step_index":4,"type":"PLANNER_RESPO')
    const got = readFinishedAnswer('c1', home.dir, 10, -1)
    assert.ok(got !== null, 'the complete record before the torn line must be found')
    assert.equal(got.step, 3)
  } finally {
    rmSync(home.dir, { recursive: true, force: true })
  }
})

test('a new answer appended after the baseline is picked up (the salvage case)', () => {
  const home = fakeHome()
  try {
    home.write('c1', [toolDispatch(4), answer(6, 'previous turn answer, long enough to qualify')])
    const baseline = lastStepIndex('c1', home.dir)
    assert.equal(baseline, 6)
    assert.equal(readFinishedAnswer('c1', home.dir, 10, baseline), null)
    home.append('c1', toolDispatch(7))
    assert.equal(readFinishedAnswer('c1', home.dir, 10, baseline), null, 'a tool dispatch is not an answer')
    home.append('c1', answer(9, 'the new turn answer, recovered without any stdout output'))
    const got = readFinishedAnswer('c1', home.dir, 10, baseline)
    assert.ok(got !== null)
    assert.equal(got.step, 9)
  } finally {
    rmSync(home.dir, { recursive: true, force: true })
  }
})
