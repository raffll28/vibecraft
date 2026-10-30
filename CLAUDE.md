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

Node.js is only a development tool (Vite build, tests). It isn't needed to run.

## Repository Layout

| Path | What |
|---|---|
| `rust/vibecraft-hook` | The Claude Code hook (single binary, serde_json only) |
| `rust/vibecraft-server` | HTTP + WebSocket server, events file watcher, `setup`/`uninstall` |
| `rust/vibecraft-core` | Event log (dedupe, durations, history) and origin/path validation |
| `rust/vibecraft-testkit` | Test/benchmark helpers: temp HOME, server and hook runners, HTTP and WebSocket clients |
| `src/` | Frontend (TypeScript + Three.js), built by Vite into `dist/` |
| `shared/` | Types and defaults shared by the frontend and Vite config |
| `tests/unit/` | Frontend unit tests (`node --test`) |

## Rust Side

All three crates depend only on `serde_json` (the server also uses its
`preserve_order` feature, so `setup` rewrites `~/.claude/settings.json`
without reordering keys). HTTP/1.1, the WebSocket protocol (SHA-1 handshake,
framing) and inotify (direct libc FFI) are hand-written in
`vibecraft-server`; keep it that way rather than adding crates.

**Server** (`vibecraft-server/src`):
- `main.rs`: startup (loads events, compacts the file past 10 MB), the events
  file watcher, the connection loop and the WebSocket client lifecycle.
- `routes.rs`: `POST /event`, `GET /health`, `GET /config` (username for the
  HUD), CORS, static files from `dist/`.
- `state.rs`: config from env vars, shared state behind a mutex, broadcast.
  Each WebSocket client has a writer thread fed by a bounded queue
  (`CLIENT_QUEUE_FRAMES`); a client that falls behind is disconnected.
- `setup.rs`: installs the hook binary and registers it for all events.

On connect a client gets `connected`, then `history` (events from the last
30 minutes, at most 50). Afterwards: `event`.
The server ignores anything clients send.

**Hook** (`vibecraft-hook/src`): `event.rs` maps hook input to events
following the semantics of the original jq program (see the module docs:
`//` defaults, codepoint truncation); `transcript.rs` reads only the tail of
the transcript; `notify.rs` is a bounded synchronous POST.

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
  `thinking`; `moveTo(station)` animates with TWEEN. Don't set `idle` while
  walking, or the robot stops mid-path (check `state !== 'walking'`).
- `entities/Claude.ts`: the simpler character, used for subagents
  (`SubagentManager`, 60% scale, fanned out around the portal).
- `entities/animations/`: `IdleBehaviors.ts` (random idle animations) and
  `WorkingBehaviors.ts` (per-station loops). Each behavior has `update(parts,
  progress, delta)` and must `reset(parts)` everything it moved.
  `Alt+D` opens a panel to test them.

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
| `npm run build` | Frontend (`dist/`) and Rust release binaries |
| `npm test` | Frontend build (type check), `cargo test`, then the frontend unit tests |
| `npm run test:rust` / `test:unit` | One side |
| `npm run dev` | Vite on :4002 with hot reload, proxying to the server on :4003 |
| `npm run bench` | Hook latency, server startup/throughput/fan-out/memory |

`cargo test` (in `rust/`) runs the unit tests, the JSON fixtures
(`vibecraft-core/tests/fixtures/`) and the contract tests
(`vibecraft-hook/tests/contract.rs`, `vibecraft-server/tests/{events,http}.rs`).
The contract tests run the binaries as black boxes in a temp `HOME`, so they
never touch `~/.vibecraft`: the hook gets its input on a socket stdin, like
Claude Code gives it, and the server is driven over HTTP and WebSocket
(`vibecraft-testkit`). The benchmarks are the `hook_bench` and `server_bench`
examples.

## Data

`~/.vibecraft/data/events.jsonl` (hook), and in the browser's localStorage:
grid size, port, streaming mode. See
[docs/STORAGE.md](docs/STORAGE.md).
