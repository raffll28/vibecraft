/**
 * Server contract: managed sessions (tmux), permission prompts, tokens,
 * git status and projects.
 *
 * Each test gets its own tmux server and a fake `claude` CLI
 * (tests/fixtures/fake-claude.mjs) first on the PATH, so nothing touches the
 * user's tmux or starts the real Claude Code.
 *
 * Run against another implementation with VIBECRAFT_SERVER_CMD=<command>.
 */

import { strict as assert } from 'node:assert'
import { execFileSync } from 'node:child_process'
import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, it } from 'node:test'
import { createTestEnv, type TestEnv } from '../helpers/env.ts'
import {
  connectClient, getJson, killTmux, makeEvent, sendJson, startServer, tmux, waitFor, type TestClient, type TestServer,
} from '../helpers/server.ts'

let env: TestEnv
let server: TestServer | null = null
let project: string

beforeEach(() => {
  env = createTestEnv()
  const bin = join(env.home, '.local', 'bin')
  mkdirSync(bin, { recursive: true })
  copyFileSync(join(import.meta.dirname, '../fixtures/fake-claude.mjs'), join(bin, 'claude'))
  chmodSync(join(bin, 'claude'), 0o755)
  project = join(env.home, 'project')
  mkdirSync(project)
})

afterEach(async () => {
  await server?.stop()
  server = null
  killTmux(env)
  env.cleanup()
})

const fakeLog = () => {
  const file = join(env.home, 'fake-claude.log')
  return existsSync(file) ? readFileSync(file, 'utf-8') : ''
}
const waitForLog = (text: string, timeoutMs = 5000) =>
  waitFor(() => fakeLog().includes(text), timeoutMs, `fake claude log to contain "${text}"`)

const tmuxSessions = () => {
  try { return tmux(env, 'list-sessions', '-F', '#{session_name}').trim().split('\n') } catch { return [] }
}

async function createSession(body: Record<string, unknown> = {}) {
  const res = await sendJson(server!, 'POST', '/sessions', { cwd: project, ...body })
  assert.equal(res.status, 201, JSON.stringify(res.body))
  await waitForLog('cwd:')
  return res.body.session
}

async function getSession(id: string) {
  return (await getJson(server!, `/sessions/${id}`)).body.session
}

/** Link a Claude session id and make the session busy, so its pane is polled every second */
async function makeWorking(session: { id: string }, client: TestClient) {
  await sendJson(server!, 'POST', `/sessions/${session.id}/link`, { claudeSessionId: 'claude-abc' })
  await sendJson(server!, 'POST', '/event', makeEvent({ sessionId: 'claude-abc', type: 'user_prompt_submit' }))
  await waitFor(async () => (await getSession(session.id)).status === 'working', 3000, 'working status')
  void client
}

describe('server: creating sessions', () => {
  it('starts claude in tmux with the default flags and reports the session', async () => {
    server = await startServer(env)
    const client = await connectClient(server)
    await client.next('history')

    const session = await createSession({ name: 'Builder' })
    assert.match(session.id, /^[0-9a-f-]{36}$/)
    assert.match(session.tmuxSession, /^vibecraft-[0-9a-f]{8}$/)
    assert.equal(session.name, 'Builder')
    assert.equal(session.status, 'idle')
    assert.equal(session.cwd, project)
    assert.equal(typeof session.createdAt, 'number')
    assert.equal(typeof session.lastActivity, 'number')

    assert.ok(tmuxSessions().includes(session.tmuxSession))
    assert.match(fakeLog(), /args: -c --permission-mode=bypassPermissions --dangerously-skip-permissions\n/)
    assert.match(fakeLog(), new RegExp(`cwd: ${project}\\n`))

    const broadcast = await client.next('sessions')
    assert.deepEqual(broadcast.payload.map((s: { id: string }) => s.id), [session.id])
    assert.deepEqual((await getJson(server, '/sessions')).body.sessions.map((s: { id: string }) => s.id), [session.id])
    assert.equal((await getSession(session.id)).name, 'Builder')
    client.close()
  })

  it('honors flags and numbers unnamed sessions', async () => {
    server = await startServer(env)
    const first = await createSession({ flags: { continue: false, skipPermissions: false, chrome: true } })
    assert.equal(first.name, 'Claude 1')
    assert.match(fakeLog(), /args: --chrome\n/)
    const second = await createSession()
    assert.equal(second.name, 'Claude 2')
  })

  it('rejects a missing directory', async () => {
    server = await startServer(env)
    const res = await sendJson(server, 'POST', '/sessions', { cwd: join(env.home, 'missing') })
    assert.equal(res.status, 500)
    assert.equal(res.body.ok, false)
    assert.match(res.body.error, /Directory does not exist/)
  })

  it('remembers the directory as a project', async () => {
    server = await startServer(env)
    await createSession({ name: 'Proj' })
    const projects = (await getJson(server, '/projects')).body.projects
    assert.equal(projects.length, 1)
    assert.equal(projects[0].path, project)
    assert.equal(projects[0].name, 'Proj')
    assert.equal(projects[0].useCount, 1)
  })

  it('persists sessions across restarts', async () => {
    server = await startServer(env)
    const session = await createSession({ name: 'Keep' })
    await server.stop()
    server = await startServer(env)
    // Reloaded as offline, then the health check finds the tmux session alive
    await waitFor(async () => (await getSession(session.id))?.status === 'idle', 8000, 'session back to idle')
    assert.equal((await getSession(session.id)).name, 'Keep')
  })
})

describe('server: session actions', () => {
  it('404s unknown sessions', async () => {
    server = await startServer(env)
    const id = '00000000-0000-0000-0000-000000000000'
    const notFound = { ok: false, error: 'Session not found' }
    assert.deepEqual(await getJson(server, `/sessions/${id}`).then((r) => [r.status, r.body]), [404, notFound])
    assert.deepEqual(await sendJson(server, 'PATCH', `/sessions/${id}`, { name: 'x' }), { status: 404, body: notFound })
    assert.deepEqual(await sendJson(server, 'DELETE', `/sessions/${id}`), { status: 404, body: notFound })
    assert.deepEqual(await sendJson(server, 'POST', `/sessions/${id}/prompt`, { prompt: 'x' }), { status: 404, body: notFound })
    assert.deepEqual(await sendJson(server, 'POST', `/sessions/${id}/cancel`), { status: 404, body: notFound })
    assert.deepEqual(await sendJson(server, 'POST', `/sessions/${id}/permission`, { response: '1' }), { status: 404, body: notFound })
    assert.deepEqual(await sendJson(server, 'POST', `/sessions/${id}/restart`), { status: 404, body: notFound })
    assert.deepEqual(await sendJson(server, 'POST', `/sessions/${id}/link`, { claudeSessionId: 'c' }), { status: 404, body: notFound })
  })

  it('renames and stores the zone position', async () => {
    server = await startServer(env)
    const session = await createSession()
    const res = await sendJson(server, 'PATCH', `/sessions/${session.id}`, { name: 'Renamed', zonePosition: { q: 2, r: -1 } })
    assert.equal(res.status, 200)
    assert.equal(res.body.session.name, 'Renamed')
    assert.deepEqual(res.body.session.zonePosition, { q: 2, r: -1 })
    assert.deepEqual(await sendJson(server, 'PATCH', `/sessions/${session.id}`, '{x'), {
      status: 400, body: { ok: false, error: 'Invalid JSON' },
    })
  })

  it('sends prompts to the session', async () => {
    server = await startServer(env)
    const session = await createSession()
    assert.deepEqual(await sendJson(server, 'POST', `/sessions/${session.id}/prompt`, { prompt: 'olá "mundo"' }), {
      status: 200, body: { ok: true },
    })
    await waitForLog('input: olá "mundo"')
    assert.deepEqual(await sendJson(server, 'POST', `/sessions/${session.id}/prompt`, {}), {
      status: 400, body: { ok: false, error: 'Prompt is required' },
    })
  })

  it('cancels with Ctrl+C', async () => {
    server = await startServer(env)
    const session = await createSession()
    assert.deepEqual(await sendJson(server, 'POST', `/sessions/${session.id}/cancel`), { status: 200, body: { ok: true } })
    await waitForLog('ctrl-c')
  })

  it('deletes the session and its tmux session', async () => {
    server = await startServer(env)
    const session = await createSession()
    assert.deepEqual(await sendJson(server, 'DELETE', `/sessions/${session.id}`), { status: 200, body: { ok: true } })
    assert.ok(!tmuxSessions().includes(session.tmuxSession))
    assert.equal((await getJson(server, `/sessions/${session.id}`)).status, 404)
    const saved = JSON.parse(readFileSync(join(env.dataDir, 'sessions.json'), 'utf-8'))
    assert.deepEqual(saved.sessions, [])
  })

  it('marks a dead tmux session offline and restarts it', async () => {
    server = await startServer(env)
    const session = await createSession()
    await sendJson(server, 'POST', `/sessions/${session.id}/link`, { claudeSessionId: 'claude-old' })
    tmux(env, 'kill-session', '-t', session.tmuxSession)
    await sendJson(server, 'POST', '/sessions/refresh')
    await waitFor(async () => (await getSession(session.id)).status === 'offline', 3000, 'offline status')

    const res = await sendJson(server, 'POST', `/sessions/${session.id}/restart`)
    assert.equal(res.status, 200)
    assert.equal(res.body.session.status, 'idle')
    assert.equal('claudeSessionId' in res.body.session, false)
    assert.ok(tmuxSessions().includes(session.tmuxSession))
    await waitFor(() => fakeLog().split('args:').length === 3, 5000, 'claude restarted')
    assert.match(fakeLog(), /args: -c --permission-mode=bypassPermissions --dangerously-skip-permissions\n[^]*args: -c --permission-mode=bypassPermissions --dangerously-skip-permissions\n/)
  })
})

describe('server: linking and status from events', () => {
  it('links a Claude session and follows its events', async () => {
    server = await startServer(env)
    const client = await connectClient(server)
    await client.next('history')
    const session = await createSession()
    await client.next('sessions')

    assert.deepEqual(await sendJson(server, 'POST', `/sessions/${session.id}/link`, {}), {
      status: 400, body: { ok: false, error: 'claudeSessionId is required' },
    })
    const linked = await sendJson(server, 'POST', `/sessions/${session.id}/link`, { claudeSessionId: 'claude-abc' })
    assert.equal(linked.body.session.claudeSessionId, 'claude-abc')

    const post = (overrides: Record<string, unknown>) =>
      sendJson(server!, 'POST', '/event', makeEvent({ sessionId: 'claude-abc', cwd: '/elsewhere', ...overrides }))

    await post({ type: 'user_prompt_submit' })
    let s = await getSession(session.id)
    assert.equal(s.status, 'working')
    assert.equal(s.cwd, '/elsewhere')

    await post({ type: 'pre_tool_use', tool: 'Read', toolUseId: 't1', toolInput: {} })
    assert.equal((await getSession(session.id)).currentTool, 'Read')
    await post({ type: 'post_tool_use', tool: 'Read', toolUseId: 't1', toolInput: {}, success: true })
    s = await getSession(session.id)
    assert.equal(s.status, 'working')
    assert.equal('currentTool' in s, false)

    await post({ type: 'stop' })
    assert.equal((await getSession(session.id)).status, 'idle')

    // Status changes are broadcast
    const statuses: string[] = []
    for (const m of client.messages) if (m.type === 'sessions' && m.payload[0]) statuses.push(m.payload[0].status)
    assert.ok(statuses.includes('working') && statuses.at(-1) === 'idle', statuses.join(','))

    // Initial history includes a managed session's events at any age
    await post({ type: 'stop', id: 'old-managed', timestamp: Date.now() - 24 * 3600 * 1000 })
    const fresh = await connectClient(server)
    const history = (await fresh.next('history')).payload
    assert.ok(history.some((e: { id: string }) => e.id === 'old-managed'))
    fresh.close()
    client.close()
  })
})

describe('server: permission prompts and tokens', () => {
  it('detects a permission prompt and answers it over HTTP', async () => {
    server = await startServer(env)
    const client = await connectClient(server)
    await client.next('history')
    const session = await createSession()
    await makeWorking(session, client)

    await sendJson(server, 'POST', `/sessions/${session.id}/prompt`, { prompt: 'show-prompt' })
    const prompt = (await client.next('permission_prompt', 8000)).payload
    assert.equal(prompt.sessionId, session.id)
    assert.equal(prompt.tool, 'Bash')
    assert.deepEqual(prompt.options.map((o: { number: string }) => o.number), ['1', '2', '3'])
    assert.match(prompt.context, /Do you want to proceed\?/)
    const waiting = await getSession(session.id)
    assert.equal(waiting.status, 'waiting')
    assert.equal(waiting.currentTool, 'Bash')

    assert.deepEqual(await sendJson(server, 'POST', `/sessions/${session.id}/permission`, {}), {
      status: 400, body: { ok: false, error: 'Missing response field' },
    })
    assert.deepEqual(await sendJson(server, 'POST', `/sessions/${session.id}/permission`, { response: '2' }), {
      status: 200, body: { ok: true },
    })
    await waitForLog('answer prompt: 2')
    await waitFor(async () => (await getSession(session.id)).status === 'working', 3000, 'working after answer')
    client.close()
  })

  it('answers over WebSocket, and reports prompts resolved elsewhere', async () => {
    server = await startServer(env)
    const client = await connectClient(server)
    await client.next('history')
    const session = await createSession()
    await makeWorking(session, client)

    await sendJson(server, 'POST', `/sessions/${session.id}/prompt`, { prompt: 'show-prompt' })
    await client.next('permission_prompt', 8000)
    client.ws.send(JSON.stringify({ type: 'permission_response', payload: { sessionId: session.id, response: '1' } }))
    await waitForLog('answer prompt: 1')

    // Answered in the terminal instead: the prompt disappears from the pane
    await sendJson(server, 'POST', `/sessions/${session.id}/prompt`, { prompt: 'show-prompt' })
    await client.next('permission_prompt', 8000)
    tmux(env, 'send-keys', '-t', session.tmuxSession, '3')
    assert.deepEqual((await client.next('permission_resolved', 8000)).payload, { sessionId: session.id })
    await waitFor(async () => (await getSession(session.id)).status === 'working', 3000, 'working after resolve')
    client.close()
  })

  it('ignores non-numeric permission responses', async () => {
    server = await startServer(env)
    const session = await createSession()
    await sendJson(server, 'POST', `/sessions/${session.id}/permission`, { response: 'rm -rf' })
    await sendJson(server, 'POST', `/sessions/${session.id}/prompt`, { prompt: 'marker' })
    await waitForLog('input: marker')
    assert.doesNotMatch(fakeLog(), /rm -rf/)
  })

  it('accepts the bypass permissions warning automatically', async () => {
    server = await startServer(env)
    const client = await connectClient(server)
    await client.next('history')
    const session = await createSession()
    await makeWorking(session, client)
    await sendJson(server, 'POST', `/sessions/${session.id}/prompt`, { prompt: 'show-warning' })
    await waitForLog('answer warning: 2', 8000)
    client.close()
  })

  it('tracks token counts per tmux session', async () => {
    server = await startServer(env)
    const client = await connectClient(server)
    await client.next('history')
    const session = await createSession()
    await makeWorking(session, client)

    await sendJson(server, 'POST', `/sessions/${session.id}/prompt`, { prompt: 'tokens 1,200' })
    assert.deepEqual((await client.next('tokens', 8000)).payload, { session: session.tmuxSession, current: 1200, cumulative: 1200 })
    await sendJson(server, 'POST', `/sessions/${session.id}/prompt`, { prompt: 'tokens 2k' })
    assert.deepEqual((await client.next('tokens', 8000)).payload, { session: session.tmuxSession, current: 2000, cumulative: 2000 })
    const stats = (await getJson(server, '/stats')).body
    assert.deepEqual(stats.tokens, { [session.tmuxSession]: { current: 2000, cumulative: 2000 } })
    client.close()
  })
})

describe('server: git status', () => {
  it('reports git status for sessions in a repository', async () => {
    const git = (...args: string[]) => execFileSync('git', args, {
      cwd: project, stdio: 'ignore',
      env: { ...process.env, HOME: env.home, GIT_CONFIG_NOSYSTEM: '1', GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' },
    })
    git('init', '-q', '-b', 'main')
    execFileSync('sh', ['-c', 'printf "a\\nb\\n" > tracked.txt'], { cwd: project })
    git('add', 'tracked.txt')
    git('commit', '-q', '-m', 'first commit')
    execFileSync('sh', ['-c', 'printf "a\\nc\\nd\\n" > tracked.txt && touch new.txt'], { cwd: project })

    server = await startServer(env)
    const session = await createSession()
    // Only the session list includes gitStatus, not GET /sessions/:id
    const status = await waitFor(async () => (await getJson(server!, '/sessions')).body.sessions[0].gitStatus, 5000, 'git status')
    void session
    assert.equal(status.isRepo, true)
    assert.equal(status.branch, 'main')
    assert.deepEqual(status.staged, { added: 0, modified: 0, deleted: 0 })
    assert.deepEqual(status.unstaged, { added: 0, modified: 1, deleted: 0 })
    assert.equal(status.untracked, 1)
    assert.equal(status.totalFiles, 2)
    assert.equal(status.linesAdded, 2)
    assert.equal(status.linesRemoved, 1)
    assert.equal(status.lastCommitMessage, 'first commit')
    assert.equal(typeof status.lastCommitTime, 'number')
  })

  it('reports isRepo false outside a repository', async () => {
    server = await startServer(env)
    const session = await createSession()
    await waitFor(async () => (await getJson(server!, '/sessions')).body.sessions[0].gitStatus, 5000, 'git status')
    const status = (await getJson(server, '/sessions')).body.sessions[0].gitStatus
    assert.equal(status.isRepo, false)
    assert.equal(status.branch, '')
    void session
  })
})

describe('server: projects', () => {
  it('autocompletes directories and known projects, and removes projects', async () => {
    mkdirSync(join(env.home, 'code', 'alpha'), { recursive: true })
    mkdirSync(join(env.home, 'code', 'beta'), { recursive: true })
    mkdirSync(join(env.home, 'code', '.hidden'), { recursive: true })
    server = await startServer(env)
    await createSession({ name: 'Known' })

    const complete = async (q: string) =>
      (await getJson(server!, `/projects/autocomplete?q=${encodeURIComponent(q)}`)).body.results
    assert.deepEqual((await complete('~/code/')).sort(), [join(env.home, 'code', 'alpha'), join(env.home, 'code', 'beta')])
    assert.deepEqual(await complete('~/code/al'), [join(env.home, 'code', 'alpha')])
    // A trailing /. lists everything, hidden entries included
    assert.deepEqual((await complete('~/code/.')).sort(), ['.hidden', 'alpha', 'beta'].map((d) => join(env.home, 'code', d)))
    assert.deepEqual(await complete('proj'), [project])

    assert.deepEqual(await sendJson(server, 'DELETE', `/projects/${encodeURIComponent(project)}`), { status: 200, body: { ok: true } })
    assert.deepEqual((await getJson(server, '/projects')).body.projects, [])
  })
})
