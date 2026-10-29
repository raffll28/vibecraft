/**
 * Contract tests for the hook: Claude Code hook JSON in → vibecraft event out.
 *
 * Run against another implementation with VIBECRAFT_HOOK_CMD=<command>.
 */

import { strict as assert } from 'node:assert'
import { createServer } from 'node:http'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, it } from 'node:test'
import { createTestEnv, type TestEnv } from '../helpers/env.ts'
import { runHook, stripVolatile } from '../helpers/hook.ts'

let env: TestEnv

beforeEach(() => { env = createTestEnv() })
afterEach(() => env.cleanup())

/** Write a transcript (one JSON object per line) and return its path */
function writeTranscript(entries: object[], trailing = ''): string {
  const path = join(env.home, 'transcript.jsonl')
  writeFileSync(path, entries.map((e) => JSON.stringify(e)).join('\n') + '\n' + trailing)
  return path
}

const user = (text: string) => ({ type: 'user', message: { content: [{ type: 'text', text }] } })
const assistant = (...texts: string[]) => ({
  type: 'assistant',
  message: { content: texts.map((text) => ({ type: 'text', text })) },
})
const assistantToolUse = () => ({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Read' }] } })

async function single(input: object, extraEnv?: Record<string, string>) {
  const result = await runHook(env, input, extraEnv)
  assert.equal(result.code, 0, result.stderr)
  assert.equal(result.events.length, 1, `expected one event, got lines: ${JSON.stringify(result.lines)}`)
  return stripVolatile(result.events[0])
}

describe('hook: event mapping', () => {
  it('user_prompt_submit keeps the prompt verbatim (unicode, quotes, newlines)', async () => {
    const prompt = 'olá "aspas" \\ barra\nnova linha\t🚀'
    assert.deepEqual(await single({ hook_event_name: 'UserPromptSubmit', session_id: 's1', cwd: '/w', prompt }), {
      type: 'user_prompt_submit', sessionId: 's1', cwd: '/w', prompt,
    })
  })

  it('session_start defaults source to "startup"', async () => {
    assert.deepEqual(await single({ hook_event_name: 'SessionStart', session_id: 's1', cwd: '/w' }), {
      type: 'session_start', sessionId: 's1', cwd: '/w', source: 'startup',
    })
    env.cleanup(); env = createTestEnv()
    assert.deepEqual(await single({ hook_event_name: 'SessionStart', session_id: 's1', cwd: '/w', source: 'resume' }), {
      type: 'session_start', sessionId: 's1', cwd: '/w', source: 'resume',
    })
  })

  it('session_end defaults reason to "other"', async () => {
    assert.deepEqual(await single({ hook_event_name: 'SessionEnd', session_id: 's1', cwd: '/w' }), {
      type: 'session_end', sessionId: 's1', cwd: '/w', reason: 'other',
    })
  })

  it('notification carries message and type', async () => {
    assert.deepEqual(await single({
      hook_event_name: 'Notification', session_id: 's1', cwd: '/w',
      message: 'Claude needs your permission', notification_type: 'permission_prompt',
    }), {
      type: 'notification', sessionId: 's1', cwd: '/w',
      message: 'Claude needs your permission', notificationType: 'permission_prompt',
    })
  })

  it('notification defaults', async () => {
    assert.deepEqual(await single({ hook_event_name: 'Notification', session_id: 's1', cwd: '/w' }), {
      type: 'notification', sessionId: 's1', cwd: '/w', message: '', notificationType: 'unknown',
    })
  })

  it('pre_compact carries trigger and instructions', async () => {
    assert.deepEqual(await single({ hook_event_name: 'PreCompact', session_id: 's1', cwd: '/w' }), {
      type: 'pre_compact', sessionId: 's1', cwd: '/w', trigger: 'manual', customInstructions: '',
    })
  })

  it('unknown hook names keep the raw input', async () => {
    const input = { hook_event_name: 'SomethingNew', session_id: 's1', cwd: '/w', extra: [1, 2] }
    assert.deepEqual(await single(input), { type: 'unknown', sessionId: 's1', cwd: '/w', raw: input })
  })

  it('missing session_id and cwd fall back to "unknown" and ""', async () => {
    assert.deepEqual(await single({ hook_event_name: 'SessionEnd' }), {
      type: 'session_end', sessionId: 'unknown', cwd: '', reason: 'other',
    })
  })

  it('non-string fields are stringified', async () => {
    assert.deepEqual(await single({ hook_event_name: 'UserPromptSubmit', session_id: 42, cwd: '/w', prompt: 7 }), {
      type: 'user_prompt_submit', sessionId: '42', cwd: '/w', prompt: '7',
    })
  })
})

describe('hook: tool events', () => {
  it('pre_tool_use includes tool input and the assistant text since the last user message', async () => {
    const transcript = writeTranscript([
      user('first'),
      assistant('old reply'),
      user('second'),
      assistant('Let me look.', 'Reading now.'),
      assistantToolUse(),
    ])
    assert.deepEqual(await single({
      hook_event_name: 'PreToolUse', session_id: 's1', cwd: '/w', transcript_path: transcript,
      tool_name: 'Read', tool_input: { file_path: '/w/a.ts' }, tool_use_id: 'tu1',
    }), {
      type: 'pre_tool_use', sessionId: 's1', cwd: '/w',
      tool: 'Read', toolInput: { file_path: '/w/a.ts' }, toolUseId: 'tu1',
      assistantText: 'Let me look.\nReading now.',
    })
  })

  it('pre_tool_use tolerates a missing transcript and a partial last line', async () => {
    assert.equal((await single({
      hook_event_name: 'PreToolUse', session_id: 's1', cwd: '/w', tool_name: 'Bash',
      transcript_path: '/nonexistent/transcript.jsonl',
    })).assistantText, '')

    env.cleanup(); env = createTestEnv()
    const transcript = writeTranscript([user('q'), assistant('answer')], '{"type":"assistant","mess')
    assert.equal((await single({
      hook_event_name: 'PreToolUse', session_id: 's1', cwd: '/w', tool_name: 'Bash', transcript_path: transcript,
    })).assistantText, 'answer')
  })

  it('pre_tool_use defaults', async () => {
    assert.deepEqual(await single({ hook_event_name: 'PreToolUse', session_id: 's1', cwd: '/w' }), {
      type: 'pre_tool_use', sessionId: 's1', cwd: '/w',
      tool: 'unknown', toolInput: {}, toolUseId: '', assistantText: '',
    })
  })

  it('post_tool_use reports success unless tool_response.success is false', async () => {
    const base = { hook_event_name: 'PostToolUse', session_id: 's1', cwd: '/w', tool_name: 'Bash', tool_use_id: 'tu1' }
    assert.equal((await single({ ...base, tool_response: { stdout: 'ok' } })).success, true)
    env.cleanup(); env = createTestEnv()
    assert.equal((await single({ ...base, tool_response: { success: false } })).success, false)
    env.cleanup(); env = createTestEnv()
    assert.equal((await single({ ...base, tool_response: 'plain string' })).success, true)
    env.cleanup(); env = createTestEnv()
    assert.deepEqual(await single(base), {
      type: 'post_tool_use', sessionId: 's1', cwd: '/w',
      tool: 'Bash', toolInput: {}, toolResponse: {}, toolUseId: 'tu1', success: true,
    })
  })

  it('post_tool_use truncates long strings anywhere in tool_response', async () => {
    const long = 'x'.repeat(5000)
    const event = await single({
      hook_event_name: 'PostToolUse', session_id: 's1', cwd: '/w', tool_name: 'Read',
      tool_input: { file_path: long },
      tool_response: { stdout: long, nested: [{ deep: long }], short: 'kept', n: 3 },
    })
    const truncated = 'x'.repeat(4096) + '…[truncated]'
    assert.deepEqual(event.toolResponse, { stdout: truncated, nested: [{ deep: truncated }], short: 'kept', n: 3 })
    // tool_input is passed through untouched
    assert.deepEqual(event.toolInput, { file_path: long })
  })

  it('VIBECRAFT_MAX_RESPONSE_CHARS controls truncation', async () => {
    const event = await single({
      hook_event_name: 'PostToolUse', session_id: 's1', cwd: '/w', tool_response: { stdout: 'abcdef' },
    }, { VIBECRAFT_MAX_RESPONSE_CHARS: '3' })
    assert.deepEqual(event.toolResponse, { stdout: 'abc…[truncated]' })
  })
})

describe('hook: stop events', () => {
  it('stop captures the latest assistant message that has text', async () => {
    const transcript = writeTranscript([
      user('q'),
      assistant('first part'),
      assistant('Final', 'answer'),
      assistantToolUse(),
    ])
    assert.deepEqual(await single({
      hook_event_name: 'Stop', session_id: 's1', cwd: '/w', transcript_path: transcript, stop_hook_active: true,
    }), {
      type: 'stop', sessionId: 's1', cwd: '/w', stopHookActive: true, response: 'Final\nanswer',
    })
  })

  it('subagent_stop uses the same shape', async () => {
    assert.deepEqual(await single({ hook_event_name: 'SubagentStop', session_id: 's1', cwd: '/w' }), {
      type: 'subagent_stop', sessionId: 's1', cwd: '/w', stopHookActive: false, response: '',
    })
  })
})

describe('hook: robustness', () => {
  it('malformed input writes nothing and exits 0', async () => {
    const result = await runHook(env, '{not json')
    assert.equal(result.code, 0)
    assert.deepEqual(result.lines, [])
  })

  it('empty input writes nothing and exits 0', async () => {
    const result = await runHook(env, '')
    assert.equal(result.code, 0)
    assert.deepEqual(result.lines.filter(Boolean), [])
  })

  it('each event is one compact JSON line, appended', async () => {
    await runHook(env, { hook_event_name: 'SessionStart', session_id: 's1', cwd: '/w' })
    const result = await runHook(env, { hook_event_name: 'UserPromptSubmit', session_id: 's1', cwd: '/w', prompt: 'a\nb' })
    assert.equal(result.lines.length, 2)
    assert.deepEqual(result.events.map((e) => e.type), ['session_start', 'user_prompt_submit'])
  })

  it('ids are unique per event', async () => {
    for (let i = 0; i < 5; i++) {
      await runHook(env, { hook_event_name: 'SessionStart', session_id: 's1', cwd: '/w' })
    }
    const { events } = await runHook(env, { hook_event_name: 'SessionStart', session_id: 's1', cwd: '/w' })
    assert.equal(new Set(events.map((e) => e.id)).size, 6)
  })

  it('creates the events directory if missing', async () => {
    const eventsFile = join(env.home, 'nested', 'dir', 'events.jsonl')
    const result = await runHook({ ...env, eventsFile }, { hook_event_name: 'SessionEnd', session_id: 's1' })
    assert.equal(result.events.length, 1)
  })
})

describe('hook: server notification', () => {
  it('POSTs the same event to VIBECRAFT_WS_NOTIFY, including bodies over 128 KiB', async () => {
    const received: string[] = []
    const server = createServer((req, res) => {
      let body = ''
      req.on('data', (d) => { body += d })
      req.on('end', () => {
        received.push(body)
        res.end('{"ok":true}')
      })
    })
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()))
    const port = (server.address() as { port: number }).port

    try {
      const big = 'y'.repeat(200 * 1024)
      const result = await runHook(env, {
        hook_event_name: 'UserPromptSubmit', session_id: 's1', cwd: '/w', prompt: big,
      }, { VIBECRAFT_ENABLE_WS_NOTIFY: 'true', VIBECRAFT_WS_NOTIFY: `http://127.0.0.1:${port}/event` })

      // The notify is fire-and-forget, so it may land after the hook exits
      const deadline = Date.now() + 3000
      while (received.length === 0 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 25))

      assert.equal(received.length, 1)
      assert.deepEqual(JSON.parse(received[0]), result.events[0])
    } finally {
      server.close()
    }
  })
})
