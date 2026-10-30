# Vibecraft - Technical Documentation

Notes for AI assistants working on this codebase.

## Project Purpose

Vibecraft is a 3D status monitor for the Claude Code sessions a user runs in
their terminals. Each session gets a hexagonal zone (named after its working
directory) where a robot walks to a workstation for each tool Claude uses, and
a traffic light shows whether the session is free, busy, or needs the user.

It only watches. Sessions are never created or driven from the browser.

## Architecture

```
Claude Code → vibecraft-hook (Rust) → ~/.vibecraft/data/events.jsonl
                     │                         │ (inotify)
                     └── POST /event ──→ vibecraft-server (Rust) ──WebSocket──→ browser (Three.js)
```

1. **Claude Code** runs `~/.vibecraft/hooks/vibecraft-hook` for every hook event
   (PreToolUse, PostToolUse, Stop, SubagentStop, SessionStart, SessionEnd,
   UserPromptSubmit, Notification, PreCompact), registered by
   `vibecraft-server setup`.
2. **The hook** turns the hook JSON into a vibecraft event, appends it to
   `events.jsonl`, and POSTs it to the server.
3. **The server** dedupes events (they arrive through both paths), adds tool
   durations, keeps the last 1000 in memory, and broadcasts them over WebSocket.
4. **The browser** creates a zone per session and animates it.

Deno is only a development tool (type check, bundle, frontend tests). Running
needs just the two Rust binaries and `dist/`. There is no Node.js or npm.

## Repository Layout

| Path | What |
|---|---|
| `rust/vibecraft-hook` | The Claude Code hook (single binary, serde_json only) |
| `rust/vibecraft-server` | HTTP + WebSocket server, events file watcher, `setup`/`uninstall` |
| `rust/vibecraft-core` | Event log (dedupe, durations, history) and origin/path validation |
| `rust/vibecraft-testkit` | Test/benchmark helpers: temp HOME, server and hook runners, HTTP and WebSocket clients |
| `src/` | Frontend (TypeScript + Three.js), bundled by `deno bundle` into `dist/` |
| `shared/` | Types and defaults used by the frontend |
| `tests/unit/` | Frontend unit tests (`deno test`) |
| `deno.json` | Tasks, the `three` import (npm:, cached by Deno), compiler options |
| `vibecraft.sh` | Launcher: starts the server in the background once, opens the page, adds a `.desktop` entry; `stop` turns it off |

## Rust Side

All three crates depend only on `serde_json` (the server also uses its
`preserve_order` feature, so `setup` rewrites `~/.claude/settings.json`
without reordering keys). HTTP/1.1, the WebSocket protocol (SHA-1 handshake,
framing) and inotify (direct libc FFI) are hand-written in
`vibecraft-server`; keep it that way rather than adding crates.

**Server** (`vibecraft-server/src`):
- `main.rs`: startup (loads events, compacts the file past 10 MB), the events
  file watcher, the connection loop (refuses a `Host` other than
  localhost/127.0.0.1: DNS rebinding), the WebSocket client lifecycle, and
  `stop()` after `POST /shutdown` (close code 4000 to every page, then exit).
- `routes.rs`: `POST /event`, `GET /health`, `POST /shutdown` (the page's
  power button), static files from `dist/`. Requests carrying a non-localhost
  `Origin` get 403 (CSRF; the hook sends no Origin). No CORS: the only browser
  client is the page this server serves, and the WebSocket only accepts
  localhost origins (`validation::is_origin_allowed`).
- `state.rs`: config from env vars, shared state behind a mutex, broadcast.
  Each WebSocket client has a writer thread fed by a bounded queue
  (`CLIENT_QUEUE_FRAMES`); a client that falls behind is disconnected.
- `setup.rs`: installs the hook binary and registers it for all events.

On connect a client gets `connected`, then `history` (events from the last
30 minutes, at most 50). Afterwards: `event`.
The server ignores anything clients send.

**Hook** (`vibecraft-hook/src`): `event.rs` maps hook input to events that
carry only what the frontend uses: session, cwd, tool, a summary of the tool
input (short fields truncated to 300 characters, line counts instead of
contents, todo count), success, and the notification type. Prompts,
responses, tool output and file contents are never recorded; unknown hook
events are skipped. `notify.rs` is a bounded synchronous POST. If the
frontend needs another field, add it to `summarize_input()` /
`ToolInputSummary` (`shared/types.ts`) together.

## Frontend

### Zone status (traffic light)

`src/events/zoneStatus.ts` is the single rule for a zone's status, with unit
tests in `tests/unit/zoneStatus.test.ts`:

| Status | Light | Events |
|---|---|---|
| `idle` | green | `stop`, `session_start`, notification `idle_prompt` |
| `working` | yellow | prompt, tool use, `subagent_stop`, `pre_compact` |
| `attention` | red | notification `permission_prompt`/`elicitation_dialog`, `AskUserQuestion` tool |

`events/handlers/zoneHandlers.ts` applies it; red zones also pulse
(`setZoneAttention`). `WorkshopScene.setZoneStatus()` colors the floor and
ring and redraws the label's status light (`STATUS_LIGHT`).

### Sessions and zones (`src/main.ts`)

- `getOrCreateSession()` creates a zone on a session's first recent event
  (older than `DEFAULTS.SESSION_MAX_AGE_MS` is ignored), labeled by
  `zoneNameFor()`: the directory name, or `name (2)`, `name (3)`... while
  other live sessions use it.
- `session_end` (or right-click → Dismiss) removes the zone; a dismissed
  session comes back with its next event.
- With 2+ zones the camera switches to overview once, unless the user moved it.

### EventBus

Events are dispatched to focused handler modules:

```
handleEvent(event) → eventBus.emit(type, event, context)
  ├─ characterHandlers.ts    → robot movement and states
  ├─ animationHandlers.ts    → reactions (victory dance on git commit, head shake on errors)
  ├─ notificationHandlers.ts → floating text above zones, station panels
  ├─ subagentHandlers.ts     → mini-robots at the portal for Task
  └─ zoneHandlers.ts         → status light
```

`EventContext` gives handlers `scene` and `session` (claude, subagents, zone,
stats). To add a handler, create `src/events/handlers/myHandlers.ts` with a
`registerMyHandlers()` that calls `eventBus.on(type, (event, ctx) => ...)`,
and call it from `handlers/index.ts`. New event types go in `EventTypeMap`
(`EventBus.ts`).

### Stations

`getStationForTool()` (`shared/types.ts`, `TOOL_STATION_MAP`) maps tools to
stations: Read → bookshelf, Write → desk, Edit → workbench, Bash → terminal,
Grep/Glob → scanner, WebFetch/WebSearch → antenna, Task → portal,
TodoWrite → taskboard. Tools mapped to `center` (MCP tools) don't move the
robot. To add a station: its position in `createZoneStations()`
(`WorkshopScene.ts`), its details in `src/scene/stations/`, `StationType`,
and the map.

### Characters and animations

- `entities/ClaudeMon.ts`: the robot. States `idle`, `walking`, `working`,
  `thinking`; `moveToPosition(position, station)` walks it there frame by
  frame (stations belong to zones: use `zone.stations`). Don't set `idle`
  while walking, or the robot stops mid-path (check `state !== 'walking'`).
- `entities/Claude.ts`: the simpler character, used for subagents
  (`SubagentManager`, one per session, 60% scale, fanned out around its
  zone's portal).
- `entities/animations/`: `IdleBehaviors.ts` (random idle animations) and
  `WorkingBehaviors.ts` (per-station loops). Each behavior has `update(parts,
  progress, delta)` and must `reset(parts)` everything it moved.

### Scene

- `WorkshopScene.ts`: hex world grid, zones in a honeycomb spiral
  (`HexGrid`), cameras (focused, overview, follow-active). Performance
  choices: `BasicShadowMap`, 512px shadow map, one hemisphere light, no
  antialiasing, 30 fps when idle.
- `ZoneNotifications.ts`: floating text per zone (`showForTool()`).
- `StationPanels.ts`: last 3 tools per station (`P`).

## Commands

| Command | |
|---|---|
| `deno task build` | Frontend (`dist/`) and Rust release binaries |
| `./vibecraft.sh` / `./vibecraft.sh stop` | Start the server in the background and open the page / stop it (log: `~/.vibecraft/server.log`) |
| `deno task check` | Type check the frontend and its tests |
| `deno task test` | Frontend build (type check), `cargo test`, then the frontend unit tests |
| `deno task test:rust` / `test:unit` | One side |
| `deno task dev` | Rebuild `dist/` on every change; the server on :4003 serves it (reload the page) |
| `deno task bench` | Hook latency, server startup/throughput/fan-out/memory |

Relative imports carry their `.ts` extension (Deno resolves files exactly).
`deno.lock` pins `three` and `@types/three`.

`cargo test` (in `rust/`) runs the unit tests, the JSON fixtures
(`vibecraft-core/tests/fixtures/`) and the contract tests
(`vibecraft-hook/tests/contract.rs`, `vibecraft-server/tests/{events,http}.rs`).
The contract tests run the binaries as black boxes in a temp `HOME`, so they
never touch `~/.vibecraft`: the hook gets its input on a socket stdin, like
Claude Code gives it, and the server is driven over HTTP and WebSocket
(`vibecraft-testkit`). The benchmarks are the `hook_bench` and `server_bench`
examples.

## Data

`~/.vibecraft/data/events.jsonl` (hook). The browser stores nothing. See
[docs/STORAGE.md](docs/STORAGE.md).
