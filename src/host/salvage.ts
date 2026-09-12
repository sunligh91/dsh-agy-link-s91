// Salvage for agy runs that finish internally but never emit a result on
// stdout (observed on agy 1.2.x: the response SSE stalls at a quota boundary,
// agy writes the completed answer to its own on-disk transcript, and stdout
// stays silent until the idle watchdog kills the process). Before this
// module existed the bridge reported that as a TIMEOUT failure and threw
// away a perfectly good answer.
//
// Extraction rule, verified against 1723 real transcript records covering 27
// turn boundaries with zero false positives:
//   1. the LAST record must be PLANNER_RESPONSE with status DONE
//   2. it must NOT carry tool_calls — of 844 PLANNER_RESPONSE records, 822
//      carry tool_calls, 22 carry content, and 0 carry both, so the presence
//      of tool_calls reliably identifies a mid-turn dispatch rather than the
//      turn's final answer
//   3. its content must be at least minChars long
//   4. its step_index must EXCEED the spawn-time baseline, so an answer left
//      over from a previous turn is never mistaken for this turn's result
import { closeSync, existsSync, openSync, readFileSync, readSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

/** How much of the transcript tail is read per poll (records are appended). */
const TAIL_BYTES = 262_144

export interface SalvagedAnswer {
  /** Transcript step_index the answer was recovered from. */
  step: number
  text: string
  /** ISO timestamp agy recorded for that step. */
  createdAt: string
}

/**
 * agy CLI's private data dir.
 *
 * Resolution order matters: a pool account relocates its whole home directory,
 * so its own dir must win. DSH_AGY_CLI_HOME overrides the location outright,
 * which tests use to keep the salvage reader away from the real user profile.
 */
export function agyCliDir(accountDir?: string): string {
  if (accountDir !== undefined && accountDir !== '') {
    return join(accountDir, '.gemini', 'antigravity-cli')
  }
  const override = process.env.DSH_AGY_CLI_HOME
  if (override !== undefined && override !== '') return override
  return join(homedir(), '.gemini', 'antigravity-cli')
}

/** Directory holding one sub-folder per agy conversation. */
export function brainDir(accountDir?: string): string {
  return join(agyCliDir(accountDir), 'brain')
}

/**
 * Transcript files agy maintains for one conversation, most complete first.
 * agy writes both a full and a compact transcript; either is authoritative
 * for the final answer.
 */
export function candidateTranscriptPaths(conversationId: string, accountDir?: string): string[] {
  if (conversationId === '') return []
  const logs = join(brainDir(accountDir), conversationId, '.system_generated', 'logs')
  return [join(logs, 'transcript_full.jsonl'), join(logs, 'transcript.jsonl')]
}

interface TranscriptRecord {
  step_index?: unknown
  type?: unknown
  status?: unknown
  content?: unknown
  created_at?: unknown
  tool_calls?: unknown
}

/** Read up to maxBytes from the end of a file (whole file when smaller). */
function readTail(path: string, maxBytes: number): string | null {
  try {
    const size = statSync(path).size
    if (size === 0) return null
    const start = Math.max(0, size - maxBytes)
    if (start === 0) return readFileSync(path, 'utf8')
    const length = size - start
    const buffer = Buffer.allocUnsafe(length)
    const fd = openSync(path, 'r')
    try {
      const read = readSync(fd, buffer, 0, length, start)
      return buffer.subarray(0, read).toString('utf8')
    } finally {
      closeSync(fd)
    }
  } catch {
    return null
  }
}

/**
 * Newest parseable record in the transcript tail.
 *
 * Walking backwards (rather than taking the literal last line) tolerates the
 * torn final line agy leaves while it is still appending a record.
 */
function lastParsedRecord(path: string): TranscriptRecord | null {
  const text = readTail(path, TAIL_BYTES)
  if (text === null) return null
  const lines = text.split('\n')
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = (lines[i] ?? '').trim()
    if (line === '') continue
    try {
      const parsed: unknown = JSON.parse(line)
      if (parsed !== null && typeof parsed === 'object') return parsed as TranscriptRecord
    } catch {
      // Torn line (agy still appending) or corruption: keep walking back.
    }
  }
  return null
}

function stepIndexOf(rec: TranscriptRecord | null): number {
  if (rec === null) return -1
  return typeof rec.step_index === 'number' && Number.isFinite(rec.step_index) ? rec.step_index : -1
}

/**
 * Highest step_index in the transcript, or -1 when there is none.
 *
 * Called once per spawn to establish the baseline, so the salvage poll can
 * tell "this turn produced a new answer" apart from "an old answer is still
 * sitting at the tail".
 */
export function lastStepIndex(conversationId: string, accountDir?: string): number {
  for (const path of candidateTranscriptPaths(conversationId, accountDir)) {
    if (!existsSync(path)) continue
    const idx = stepIndexOf(lastParsedRecord(path))
    if (idx >= 0) return idx
  }
  return -1
}

/**
 * The finished answer at the tail of the conversation transcript, or null.
 *
 * @param afterStep Only accept answers recorded after this step index (the
 *        baseline captured at spawn time); pass -1 to accept any.
 */
export function readFinishedAnswer(
  conversationId: string,
  accountDir: string | undefined,
  minChars: number,
  afterStep: number,
): SalvagedAnswer | null {
  for (const path of candidateTranscriptPaths(conversationId, accountDir)) {
    if (!existsSync(path)) continue
    const rec = lastParsedRecord(path)
    if (rec === null) continue
    // (1) terminal planner response...
    if (rec.type !== 'PLANNER_RESPONSE') continue
    if (rec.status !== 'DONE') continue
    // (2) ...that is not a mid-turn tool dispatch
    if (Array.isArray(rec.tool_calls) && rec.tool_calls.length > 0) continue
    // (3) with real answer text
    const text = typeof rec.content === 'string' ? rec.content : ''
    if (text.length < minChars) continue
    // (4) produced by THIS run, not a leftover from an earlier turn
    const step = stepIndexOf(rec)
    if (step <= afterStep) continue
    return {
      step,
      text,
      createdAt: typeof rec.created_at === 'string' ? rec.created_at : '',
    }
  }
  return null
}
