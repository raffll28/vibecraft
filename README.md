# Vibecraft

![Vibecraft monitoring three Claude Code sessions](public/monitor.png)

A 3D status monitor for the Claude Code sessions running in your terminals.

Each session gets a hexagonal zone named after its directory, with a robot
that walks to a workstation for every tool Claude uses (bookshelf for Read,
terminal for Bash, desk for Write...). A light next to the name tells you at a
glance what each session needs:

| Light | Meaning | When |
|---|---|---|
| 🟢 Green | Free | Claude finished, or is waiting for your next prompt |
| 🟡 Yellow | Busy | Processing a prompt or running tools |
| 🔴 Red | Needs you | A permission prompt, a dialog, or a question from Claude (pulses until answered) |

Several sessions in the same directory are told apart as `name`, `name (2)`,
`name (3)`... Zones disappear when their session ends.

Everything stays on your machine: a Claude Code hook records events, a local
server streams them to the page, and nothing is sent anywhere else. Events
hold only what the picture needs (tool names, file names, short commands):
never your prompts, Claude's replies, tool output or file contents.

## Requirements

- Linux (macOS should work but is untested)
- [Rust](https://rustup.rs) to build the hook and the server
- [Deno](https://deno.com) to build the frontend (no Node.js or npm)

## Setup

```bash
deno task build                                 # frontend (dist/) + Rust binaries
rust/target/release/vibecraft-server setup      # install the hook into ~/.claude/settings.json
./vibecraft.sh                                  # start the server and open the monitor
```

Use Claude Code in your terminals as usual. Sessions already running pick up
the hook after a restart.

`vibecraft-server uninstall` removes the hook (your data in `~/.vibecraft/data` is kept).

## Starting and stopping

`./vibecraft.sh` starts the server in the background (once: running it again
just opens the page) and opens http://localhost:4003. Its first run adds
**Vibecraft** to your applications menu, so afterwards you can start it with a
click or pin it to the dock. The server keeps running when the terminal is
closed; its log is `~/.vibecraft/server.log`.

To turn it off, use the ⏻ button next to the connection light, or
`./vibecraft.sh stop`. Open pages show "Vibecraft is off" and reconnect by
themselves when it starts again. Nothing is lost meanwhile: the hook keeps
recording to `~/.vibecraft/data/events.jsonl`, and the page shows the last 30
minutes when the server is back.

To run it in the foreground instead: `rust/target/release/vibecraft-server`.

## Keyboard

| Key | Action |
|---|---|
| `1`-`9` | Focus a zone |
| `0` / `` ` `` | Overview of all zones |
| `F` | Follow the active session |
| `P` | Station panels (last tools per workstation) |

Click a zone to focus it, right-click it to dismiss it.

## Configuration

Environment variables of `vibecraft-server`, all optional:

| Variable | Default | |
|---|---|---|
| `VIBECRAFT_PORT` | 4003 | HTTP and WebSocket port |
| `VIBECRAFT_HOST` | 127.0.0.1 | Bind address (keep it local, see Security) |
| `VIBECRAFT_EVENTS_FILE` | `~/.vibecraft/data/events.jsonl` | Event log written by the hook |
| `VIBECRAFT_MAX_EVENTS` | 1000 | Events kept in memory |
| `VIBECRAFT_DIST_DIR` | `dist/` next to the repo | Built frontend |

## Security

The monitor is only for your own machine:

- The server listens on 127.0.0.1, so other devices on your network can't reach it.
- Requests must address it as `localhost` or `127.0.0.1` (the `Host` header),
  which stops DNS rebinding: a website pointing its own domain at 127.0.0.1.
- Requests that a browser marks as coming from another site (`Origin`) are
  refused, so a page you visit can't post fake events or turn the server off.
  The WebSocket only accepts the page the server itself serves.

## Development

```bash
deno task dev     # rebuild dist/ on every change (reload the page served on :4003)
deno task test    # type check, Rust tests (unit + contract), frontend unit tests
deno task bench   # hook latency and server throughput
```

See [CLAUDE.md](CLAUDE.md) for the architecture and
[docs/RUST_MIGRATION.md](docs/RUST_MIGRATION.md) for how this fork got here.

## Credits

Fork of [vibecraft](https://github.com/nearcyan/vibecraft) by nearcyan.

## License

MIT
