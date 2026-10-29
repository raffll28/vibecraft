//! Configuration and shared server state.

use std::collections::HashMap;
use std::fs;
use std::net::{Shutdown, TcpStream};
use std::path::{Path, PathBuf};
use std::sync::mpsc::SyncSender;
use std::sync::{Arc, Mutex, MutexGuard};

use serde_json::{Value, json};
use vibecraft_core::event_store::{EventStore, LineSplitter};
use vibecraft_core::validation::{expand_home, resolve};

use crate::ws;

/// Same environment variables and defaults as server/index.ts
pub struct Config {
    pub port: u16,
    pub host: String,
    pub events_file: PathBuf,
    pub prompt_file: PathBuf,
    pub sessions_file: PathBuf,
    pub tiles_file: PathBuf,
    pub projects_file: PathBuf,
    pub max_events: usize,
    pub tmux_session: String,
    pub dist_dir: PathBuf,
}

fn env_path(name: &str, default: &str) -> PathBuf {
    resolve(&expand_home(
        &std::env::var(name).unwrap_or_else(|_| default.to_string()),
    ))
}

impl Config {
    pub fn from_env() -> Self {
        let home = std::env::var("HOME").unwrap_or_default();
        Self {
            port: std::env::var("VIBECRAFT_PORT")
                .ok()
                .and_then(|p| p.parse().ok())
                .unwrap_or(4003),
            host: std::env::var("VIBECRAFT_HOST").unwrap_or_else(|_| "127.0.0.1".to_string()),
            events_file: env_path("VIBECRAFT_EVENTS_FILE", "~/.vibecraft/data/events.jsonl"),
            prompt_file: env_path(
                "VIBECRAFT_PROMPT_FILE",
                "~/.vibecraft/data/pending-prompt.txt",
            ),
            sessions_file: env_path("VIBECRAFT_SESSIONS_FILE", "~/.vibecraft/data/sessions.json"),
            tiles_file: env_path("VIBECRAFT_TILES_FILE", "~/.vibecraft/data/tiles.json"),
            projects_file: PathBuf::from(home).join(".vibecraft/projects.json"),
            max_events: std::env::var("VIBECRAFT_MAX_EVENTS")
                .ok()
                .and_then(|v| v.parse().ok())
                .unwrap_or(1000),
            tmux_session: std::env::var("VIBECRAFT_TMUX_SESSION")
                .unwrap_or_else(|_| "claude".to_string()),
            dist_dir: find_dist_dir(),
        }
    }
}

/// The built frontend: $VIBECRAFT_DIST_DIR, else the repo's dist/ relative to
/// this binary (rust/target/release/), else ./dist
fn find_dist_dir() -> PathBuf {
    if let Ok(dir) = std::env::var("VIBECRAFT_DIST_DIR") {
        return resolve(&dir);
    }
    let from_exe = std::env::current_exe()
        .ok()
        .and_then(|exe| exe.parent().map(|d| d.join("../../../dist")))
        .map(|p| resolve(&p.to_string_lossy()));
    match from_exe {
        Some(dir) if dir.join("index.html").exists() => dir,
        _ => resolve("dist"),
    }
}

/// Pre-encoded WebSocket frame shared by every client it's sent to
pub type Frame = Arc<Vec<u8>>;

/// Frames a client may fall behind before it's disconnected. A slow reader
/// would otherwise grow its queue without bound; browsers reconnect and get
/// the history again.
pub const CLIENT_QUEUE_FRAMES: usize = 4096;

pub struct Client {
    pub tx: SyncSender<Frame>,
    /// To disconnect the client when its queue overflows
    pub stream: TcpStream,
}

impl Client {
    /// Queue a frame; false (and the socket shut down) if the client can't keep up
    pub fn send(&self, frame: Frame) -> bool {
        if self.tx.try_send(frame).is_ok() {
            return true;
        }
        let _ = self.stream.shutdown(Shutdown::Both);
        false
    }
}

pub struct State {
    pub events: EventStore,
    /// Text tiles in insertion order (JS Map order)
    pub tiles: Vec<Value>,
    /// Managed sessions as persisted by the Node server
    pub sessions: Vec<Value>,
    pub clients: HashMap<u64, Client>,
    pub next_client_id: u64,
    pub events_file_offset: u64,
    pub events_file_lines: LineSplitter,
}

pub type Shared = Arc<Mutex<State>>;

/// Lock the state; a panicked holder doesn't poison it for everyone else
pub fn lock(shared: &Shared) -> MutexGuard<'_, State> {
    shared.lock().unwrap_or_else(|e| e.into_inner())
}

impl State {
    pub fn new(max_events: usize) -> Self {
        Self {
            events: EventStore::new(max_events),
            tiles: Vec::new(),
            sessions: Vec::new(),
            clients: HashMap::new(),
            next_client_id: 1,
            events_file_offset: 0,
            events_file_lines: LineSplitter::new(),
        }
    }

    /// Send a message to every connected client
    pub fn broadcast(&mut self, message: &Value) {
        let frame: Frame = Arc::new(ws::text_frame(&message.to_string()));
        self.clients.retain(|_, client| client.send(frame.clone()));
    }

    /// Add an event and broadcast it; false for duplicates
    pub fn add_event(&mut self, event: Value) -> bool {
        let Some(added) = self.events.add(event) else {
            return false;
        };
        let message = json!({ "type": "event", "payload": added });
        self.broadcast(&message);
        true
    }

    pub fn sessions_message(&self) -> Value {
        json!({ "type": "sessions", "payload": self.sessions })
    }

    pub fn tiles_message(&self) -> Value {
        json!({ "type": "text_tiles", "payload": self.tiles })
    }

    pub fn managed_claude_ids(&self) -> std::collections::HashSet<String> {
        self.sessions
            .iter()
            .filter_map(|s| s.get("claudeSessionId").and_then(Value::as_str))
            .filter(|id| !id.is_empty())
            .map(str::to_string)
            .collect()
    }
}

/// Write pretty JSON (2-space indent, like JSON.stringify(data, null, 2))
pub fn save_json(path: &Path, value: &Value) {
    let text = serde_json::to_string_pretty(value).unwrap_or_default();
    if let Err(e) = fs::write(path, text) {
        eprintln!("Failed to save {}: {e}", path.display());
    }
}

pub fn load_tiles(path: &Path) -> Vec<Value> {
    fs::read_to_string(path)
        .ok()
        .and_then(|text| serde_json::from_str::<Vec<Value>>(&text).ok())
        .unwrap_or_default()
}

/// Sessions start offline after a restart, like loadSessions() in Node
pub fn load_sessions(path: &Path) -> Vec<Value> {
    let Some(data) = fs::read_to_string(path)
        .ok()
        .and_then(|text| serde_json::from_str::<Value>(&text).ok())
    else {
        return Vec::new();
    };
    let Some(sessions) = data.get("sessions").and_then(Value::as_array) else {
        return Vec::new();
    };
    sessions
        .iter()
        .cloned()
        .map(|mut s| {
            if let Some(obj) = s.as_object_mut() {
                obj.insert("status".into(), json!("offline"));
                obj.remove("currentTool");
            }
            s
        })
        .collect()
}

/// Known projects, most recently used first
pub fn load_projects(path: &Path) -> Vec<Value> {
    let mut projects: Vec<Value> = fs::read_to_string(path)
        .ok()
        .and_then(|text| serde_json::from_str::<Value>(&text).ok())
        .and_then(|data| data.get("projects").and_then(Value::as_array).cloned())
        .unwrap_or_default();
    let last_used = |p: &Value| p.get("lastUsed").and_then(Value::as_f64).unwrap_or(0.0);
    projects.sort_by(|a, b| last_used(b).total_cmp(&last_used(a)));
    projects
}
