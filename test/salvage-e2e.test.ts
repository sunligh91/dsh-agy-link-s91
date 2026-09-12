// End-to-end proof that the salvage watcher recovers an answer agy finished
// internally but never wrote to stdout. This is the exact failure that used to
// surface as "agy run was idle for 600000ms without output" while the model had
// in fact completed the task.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { GenerateOptions, Message, StreamChunk } from '@deepseek-ai/dsh-llm'
import { AgyAdapter, type AgyAdapterDeps } from '../src/host/adapter.ts'
import { ModelCatalog } from '../src/host/models.ts'
import { SessionStore } from '../src/host/sessions.ts'
import { RunRegistry } from '../src/host/recording.ts'
import { defaultConfig, type PluginConfig } from '../src/common/types.ts'

const fakeBin = join(import.meta.dirname, process.platform === 'win32' ? 'fake-agy.cmd' : 'fake-agy.mjs')

function msg(role: 'user' | 'assistant', text: string): Message {
  return { role, content: [{ type: 'text', text }] } as unknown as Message
}

function opts(messages: Message[]): GenerateOptions {
  return { provider: 'antigravity', model: 'gemini-3.7-flash', messages, sessionId: 'sess-1' } as GenerateOptions
}

async function collect(gen: AsyncIterable<StreamChunk>): Promise<StreamChunk[]> {
  const out: StreamChunk[] = []
  for await (const ch of gen) out.push(ch)
  return out
}

function textOf(chunks: StreamChunk[]): string {
  return chunks.filter((c) => c.type === 'text-delta').map((c) => (c as { text: string }).text).join('')
}

test('adopts an on-disk answer when agy stalls without emitting on stdout', async () => {
  const work = mkdtempSync(join(tmpdir(), 'agy-salvage-e2e-'))
  const saved = {
    mode: process.env.FAKE_AGY_MODE,
    convs: process.env.DSH_AGY_CONVERSATIONS_DIR,
    cliHome: process.env.DSH_AGY_CLI_HOME,
  }
  try {
    process.env.FAKE_AGY_MODE = 'stall'
    process.env.DSH_AGY_CONVERSATIONS_DIR = join(work, 'convs')
    // agy keeps its private data under the Gemini CLI home; point the salvage
    // reader at a scratch tree so the test never touches the real profile.
    const cliHome = join(work, 'cli-home')
    process.env.DSH_AGY_CLI_HOME = cliHome

    const cid = 'salvage-e2e-conv'
    const cfg: PluginConfig = {
      ...defaultConfig(),
      permissionMode: 'plan',
      timeoutMs: 20_000,
      // Tight timings: exercise the real poll -> silence-window -> adopt -> kill
      // sequence without making the suite slow.
      salvageAnswers: true,
      salvagePollMs: 1_000,
      salvageIdleMs: 1_000,
      salvageMinChars: 10,
    }
    const store = new SessionStore(join(work, 'sessions.json'))
    // Bind the session to a known conversation, as a returning session would be,
    // so the watcher knows which transcript to read.
    store.set('sess-1', { conversationId: cid, lastMessageCount: 0, updatedAt: Date.now(), model: 'gemini-3.7-flash' })

    const catalog = new ModelCatalog(async () => { throw new Error('no discovery in tests') }, cfg.fallbackModels, 300_000)
    const runs = new RunRegistry()
    const logs: string[] = []
    const deps: AgyAdapterDeps = {
      getConfig: () => cfg,
      catalog,
      store,
      bin: () => fakeBin,
      acquire: () => Promise.resolve(() => {}),
      runs,
      log: (m) => { logs.push(m) },
    }
    const adapter = new AgyAdapter(deps)

    const logsDir = join(cliHome, 'brain', cid, '.system_generated', 'logs')
    mkdirSync(logsDir, { recursive: true })
    const transcript = join(logsDir, 'transcript_full.jsonl')
    const baseline = JSON.stringify({
      step_index: 0,
      type: 'PLANNER_RESPONSE',
      status: 'DONE',
      content: 'baseline answer from an earlier turn, long enough to be a valid tail',
      created_at: '2026-09-13T00:00:00Z',
    })
    writeFileSync(transcript, baseline + '\n')

    // agy persists the finished answer mid-turn while stdout stays silent.
    const answerText = 'SALVAGED-ANSWER: the task completed; recovered from the on-disk transcript.'
    const timer = setTimeout(() => {
      writeFileSync(transcript,
        baseline + '\n' +
        JSON.stringify({ step_index: 3, type: 'PLANNER_RESPONSE', status: 'DONE', content: answerText, created_at: '2026-09-13T01:00:00Z' }) + '\n')
    }, 2_500)

    const chunks = await collect(adapter.stream(opts([msg('user', 'do the thing')])))
    clearTimeout(timer)

    const finish = chunks.find((c) => c.type === 'finish') as Extract<StreamChunk, { type: 'finish' }> | undefined
    assert.ok(finish !== undefined, 'the turn must finish')
    assert.equal(finish.reason.kind, 'stop', 'a recovered answer must NOT be reported as a failure')
    assert.match(textOf(chunks), /SALVAGED-ANSWER/, 'the recovered answer text must reach the user')
    assert.ok(
      chunks.some((c) => c.type === 'reasoning-delta' && /transcript/.test((c as { text: string }).text)),
      'the recovery must be annotated so the user knows why the answer arrived this way',
    )
    assert.ok(logs.some((l) => /recovered from transcript/.test(l)), 'the recovery must be logged')
  } finally {
    if (saved.mode === undefined) delete process.env.FAKE_AGY_MODE
    else process.env.FAKE_AGY_MODE = saved.mode
    if (saved.convs === undefined) delete process.env.DSH_AGY_CONVERSATIONS_DIR
    else process.env.DSH_AGY_CONVERSATIONS_DIR = saved.convs
    if (saved.cliHome === undefined) delete process.env.DSH_AGY_CLI_HOME
    else process.env.DSH_AGY_CLI_HOME = saved.cliHome
    rmSync(work, { recursive: true, force: true })
  }
})

test('a normal run is unaffected: no salvage note and no transcript read', async () => {
  const work = mkdtempSync(join(tmpdir(), 'agy-salvage-none-'))
  const saved = {
    mode: process.env.FAKE_AGY_MODE,
    convs: process.env.DSH_AGY_CONVERSATIONS_DIR,
    cliHome: process.env.DSH_AGY_CLI_HOME,
  }
  try {
    process.env.FAKE_AGY_MODE = 'ok'
    process.env.DSH_AGY_CONVERSATIONS_DIR = join(work, 'convs')
    process.env.DSH_AGY_CLI_HOME = join(work, 'cli-home')

    const cfg: PluginConfig = { ...defaultConfig(), permissionMode: 'plan', timeoutMs: 20_000 }
    const store = new SessionStore(join(work, 'sessions.json'))
    const catalog = new ModelCatalog(async () => { throw new Error('no discovery in tests') }, cfg.fallbackModels, 300_000)
    const logs: string[] = []
    const adapter = new AgyAdapter({
      getConfig: () => cfg,
      catalog,
      store,
      bin: () => fakeBin,
      acquire: () => Promise.resolve(() => {}),
      runs: new RunRegistry(),
      log: (m) => { logs.push(m) },
    })

    const chunks = await collect(adapter.stream(opts([msg('user', 'hi')])))
    const finish = chunks.find((c) => c.type === 'finish') as Extract<StreamChunk, { type: 'finish' }> | undefined
    // The legacy 'ok' shape contains a tool step, so the first span correctly
    // ends with tool-calls (the mirror resumes it). What matters here is that
    // the run is NOT a failure and carries no salvage annotation.
    assert.equal(finish?.reason.kind, 'tool-calls')
    // A tool card was produced, proving the ordinary path still works.
    assert.ok(
      chunks.some((c) => c.type === 'block-end' && (c as { block?: { type?: string } }).block?.type === 'tool-call'),
      'the ordinary tool mirroring must be unaffected',
    )
    assert.equal(
      chunks.some((c) => c.type === 'reasoning-delta' && /transcript/.test((c as { text: string }).text)),
      false,
      'an ordinary run must carry no recovery note',
    )
    assert.equal(logs.some((l) => /recovered from transcript/.test(l)), false)
  } finally {
    if (saved.mode === undefined) delete process.env.FAKE_AGY_MODE
    else process.env.FAKE_AGY_MODE = saved.mode
    if (saved.convs === undefined) delete process.env.DSH_AGY_CONVERSATIONS_DIR
    else process.env.DSH_AGY_CONVERSATIONS_DIR = saved.convs
    if (saved.cliHome === undefined) delete process.env.DSH_AGY_CLI_HOME
    else process.env.DSH_AGY_CLI_HOME = saved.cliHome
    rmSync(work, { recursive: true, force: true })
  }
})
