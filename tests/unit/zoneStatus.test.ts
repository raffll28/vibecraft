/**
 * The zone traffic light: which events make a zone free, busy or in need
 * of the user.
 */

import { strict as assert } from 'node:assert'
import { describe, it } from 'node:test'
import { zoneStatusForEvent } from '../../src/events/zoneStatus.ts'
import type { ClaudeEvent } from '../../shared/types.ts'

const event = (fields: Record<string, unknown>) =>
  ({ id: 'e', timestamp: 0, sessionId: 's', cwd: '/w', ...fields }) as unknown as ClaudeEvent

describe('zoneStatusForEvent', () => {
  const cases: [string, Record<string, unknown>, string | null][] = [
    ['prompt submitted', { type: 'user_prompt_submit', prompt: 'x' }, 'working'],
    ['tool starts', { type: 'pre_tool_use', tool: 'Bash' }, 'working'],
    ['tool finishes', { type: 'post_tool_use', tool: 'Bash', success: true }, 'working'],
    ['tool fails (Claude carries on)', { type: 'post_tool_use', tool: 'Bash', success: false }, 'working'],
    ['subagent finishes', { type: 'subagent_stop' }, 'working'],
    ['compacting', { type: 'pre_compact' }, 'working'],
    ['Claude asks a question', { type: 'pre_tool_use', tool: 'AskUserQuestion' }, 'attention'],
    ['permission prompt', { type: 'notification', notificationType: 'permission_prompt' }, 'attention'],
    ['dialog', { type: 'notification', notificationType: 'elicitation_dialog' }, 'attention'],
    ['finished', { type: 'stop' }, 'idle'],
    ['session started', { type: 'session_start', source: 'startup' }, 'idle'],
    ['waiting for input', { type: 'notification', notificationType: 'idle_prompt' }, 'idle'],
    ['other notifications', { type: 'notification', notificationType: 'auth_success' }, null],
    ['session end (zone is removed)', { type: 'session_end' }, null],
  ]
  for (const [name, fields, expected] of cases) {
    it(name, () => assert.equal(zoneStatusForEvent(event(fields)), expected))
  }
})
