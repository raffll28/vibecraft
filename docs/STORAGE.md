# Storage

Where Vibecraft keeps data.

## Server files (`~/.vibecraft/`)

| Path | Data | Written by |
|---|---|---|
| `hooks/vibecraft-hook` | The hook binary Claude Code runs | `vibecraft-server setup` |
| `data/events.jsonl` | Event log, one JSON event per line (append-only) | the hook |

`events.jsonl` grows with every tool call. At startup the server loads the
newest `VIBECRAFT_MAX_EVENTS` (1000) events and, once the file passes 10 MB,
rewrites it keeping only those.

Each event holds the session, its directory, the tool, a short summary of the
tool input (file name, first 300 characters of a command, line counts) and
whether it succeeded. Prompts, replies, tool output and file contents are
not recorded.

The browser stores nothing.
