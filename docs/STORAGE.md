# Storage

Where Vibecraft keeps data.

## Server files (`~/.vibecraft/`)

| Path | Data | Written by |
|---|---|---|
| `hooks/vibecraft-hook` | The hook binary Claude Code runs | `vibecraft-server setup` |
| `data/events.jsonl` | Event log, one JSON event per line (append-only) | the hook |
| `data/tiles.json` | Text labels on the floor | the server |

`events.jsonl` grows with every tool call. At startup the server loads the
newest `VIBECRAFT_MAX_EVENTS` (1000) events and, once the file passes 10 MB,
rewrites it keeping only those.

`tiles.json` is an array of `{ id, text, position: { q, r }, color?, createdAt }`.

## Browser (localStorage, per browser)

| Key | Data |
|---|---|
| `vibecraft-hexart` | Painted hexes `[{ q, r, color, height }]` |
| `vibecraft-zone-elevations` | Zone heights raised by painting |
| `vibecraft-grid-size` | World grid size (hex rings) |
| `vibecraft-agent-port` | Server port override |
| `vibecraft-streaming-mode` | Hide the username in the HUD |

Painted art lives in the browser because it's personal decoration; labels
live on the server so every browser sees them.
