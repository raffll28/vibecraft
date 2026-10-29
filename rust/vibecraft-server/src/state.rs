//! Configuration and shared server state.

use std::collections::{HashMap, HashSet};
use std::fs;
use std::net::{Shutdown, TcpStream};
use std::path::{Path, PathBuf};
use std::sync::mpsc::SyncSender;
use std::sync::{Arc, Mutex, MutexGuard};

use serde_json::{Value, json};
use vibecraft_core::event_store::{EventStore, LineSplitter};
use vibecraft_core::validation::{expand_home, resolve};

use crate::routes::now_ms;
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

/// Token counts seen in one tmux pane
pub struct TokenCount {
    pub last_seen: u64,
    pub cumulative: u64,
}

pub struct State {
    pub config: Arc<Config>,
    pub events: EventStore,
    /// Text tiles in insertion order (JS Map order)
    pub tiles: Vec<Value>,
    /// Managed sessions in insertion order
    pub sessions: Vec<Value>,
    /// Claude Code session id → managed session id, in insertion order
    pub claude_to_managed: Vec<(String, String)>,
    pub session_counter: u64,
    /// Token counts by tmux session name, in insertion order
    pub tokens: Vec<(String, TokenCount)>,
    /// Tail of the last capture per tmux session, to skip unchanged output
    pub last_pane_tail: HashMap<String, String>,
    /// Managed session ids with a permission prompt on screen
    pub pending_permissions: HashSet<String>,
    /// Sessions whose bypass-permissions warning was already accepted
    pub bypass_handled: HashSet<String>,
    /// Git status: tracked (session id, directory), cache, sessions to re-check
    pub git_dirs: Vec<(String, String)>,
    pub git_cache: HashMap<String, Value>,
    pub git_dirty: HashSet<String>,
    pub projects: Vec<Value>,
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

/// Tools that can change a repo's git status
const GIT_AFFECTING_TOOLS: [&str; 5] = ["Edit", "MultiEdit", "Write", "NotebookEdit", "Bash"];

impl State {
    pub fn new(config: Arc<Config>) -> Self {
        let mut state = Self {
            events: EventStore::new(config.max_events),
            tiles: load_tiles(&config.tiles_file),
            sessions: Vec::new(),
            claude_to_managed: Vec::new(),
            session_counter: 0,
            tokens: Vec::new(),
            last_pane_tail: HashMap::new(),
            pending_permissions: HashSet::new(),
            bypass_handled: HashSet::new(),
            git_dirs: Vec::new(),
            git_cache: HashMap::new(),
            git_dirty: HashSet::new(),
            projects: load_projects(&config.projects_file),
            clients: HashMap::new(),
            next_client_id: 1,
            events_file_offset: 0,
            events_file_lines: LineSplitter::new(),
            config,
        };
        state.load_sessions();
        state
    }

    /// Send a message to every connected client
    pub fn broadcast(&mut self, message: &Value) {
        let frame: Frame = Arc::new(ws::text_frame(&message.to_string()));
        self.clients.retain(|_, client| client.send(frame.clone()));
    }

    /// Add an event, update its managed session, and broadcast; false for duplicates
    pub fn add_event(&mut self, event: Value) -> bool {
        let Some(added) = self.events.add(event).cloned() else {
            return false;
        };
        self.apply_event_to_session(&added);
        self.broadcast(&json!({ "type": "event", "payload": added }));
        true
    }

    /// Managed session status follows its Claude session's events
    fn apply_event_to_session(&mut self, event: &Value) {
        let Some(claude_id) = event.get("sessionId").and_then(Value::as_str) else {
            return;
        };
        let Some(index) = self.managed_index_for_claude(claude_id) else {
            return;
        };
        let session_id = self.sessions[index]["id"]
            .as_str()
            .unwrap_or_default()
            .to_string();
        let tool = event
            .get("tool")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string();
        let mut mark_dirty = false;

        let Some(session) = self.sessions[index].as_object_mut() else {
            return;
        };
        let prev_status = session.get("status").cloned();
        session.insert("lastActivity".into(), json!(now_ms()));
        match event.get("cwd") {
            Some(cwd) => session.insert("cwd".into(), cwd.clone()),
            None => session.remove("cwd"),
        };
        match event.get("type").and_then(Value::as_str) {
            Some("pre_tool_use") => {
                session.insert("status".into(), json!("working"));
                match event.get("tool") {
                    Some(tool) => session.insert("currentTool".into(), tool.clone()),
                    None => session.remove("currentTool"),
                };
            }
            Some("post_tool_use") => {
                session.remove("currentTool");
                mark_dirty = GIT_AFFECTING_TOOLS.contains(&tool.as_str());
            }
            Some("user_prompt_submit") => {
                session.insert("status".into(), json!("working"));
                session.remove("currentTool");
            }
            Some("stop") | Some("session_end") => {
                mark_dirty = true;
                session.insert("status".into(), json!("idle"));
                session.remove("currentTool");
            }
            _ => {}
        }
        let changed = session.get("status").cloned() != prev_status;

        if mark_dirty && self.git_dirs.iter().any(|(id, _)| *id == session_id) {
            self.git_dirty.insert(session_id);
        }
        if changed {
            self.broadcast_sessions();
            self.save_sessions();
        }
    }

    pub fn session_index(&self, id: &str) -> Option<usize> {
        self.sessions
            .iter()
            .position(|s| s.get("id").and_then(Value::as_str) == Some(id))
    }

    pub fn managed_index_for_claude(&self, claude_id: &str) -> Option<usize> {
        let managed = &self
            .claude_to_managed
            .iter()
            .find(|(c, _)| c == claude_id)?
            .1;
        self.session_index(managed)
    }

    /// Sessions as clients see them: with git status when known
    pub fn sessions_payload(&self) -> Vec<Value> {
        self.sessions
            .iter()
            .map(|s| {
                let mut s = s.clone();
                let git = s
                    .get("id")
                    .and_then(Value::as_str)
                    .and_then(|id| self.git_cache.get(id));
                if let (Some(obj), Some(git)) = (s.as_object_mut(), git) {
                    obj.insert("gitStatus".into(), git.clone());
                }
                s
            })
            .collect()
    }

    pub fn sessions_message(&self) -> Value {
        json!({ "type": "sessions", "payload": self.sessions_payload() })
    }

    pub fn broadcast_sessions(&mut self) {
        let message = self.sessions_message();
        self.broadcast(&message);
    }

    pub fn save_sessions(&self) {
        let map: Vec<Value> = self
            .claude_to_managed
            .iter()
            .map(|(c, m)| json!([c, m]))
            .collect();
        save_json(
            &self.config.sessions_file,
            &json!({
                "sessions": self.sessions,
                "claudeToManagedMap": map,
                "sessionCounter": self.session_counter,
            }),
        );
    }

    /// Sessions start offline after a restart; the health check revives them
    fn load_sessions(&mut self) {
        let Some(data) = fs::read_to_string(&self.config.sessions_file)
            .ok()
            .and_then(|text| serde_json::from_str::<Value>(&text).ok())
        else {
            return;
        };
        for session in data
            .get("sessions")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
        {
            let mut session = session.clone();
            if let Some(obj) = session.as_object_mut() {
                obj.insert("status".into(), json!("offline"));
                obj.remove("currentTool");
            }
            if let (Some(id), Some(cwd)) = (
                session.get("id").and_then(Value::as_str),
                session
                    .get("cwd")
                    .and_then(Value::as_str)
                    .filter(|c| !c.is_empty()),
            ) {
                self.git_dirs.push((id.to_string(), cwd.to_string()));
            }
            self.sessions.push(session);
        }
        for pair in data
            .get("claudeToManagedMap")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
        {
            if let (Some(c), Some(m)) = (pair[0].as_str(), pair[1].as_str()) {
                self.link(c, m);
            }
        }
        if let Some(counter) = data.get("sessionCounter").and_then(Value::as_u64) {
            self.session_counter = counter;
        }
    }

    /// Map a Claude session id to a managed session (Map.set semantics)
    pub fn link(&mut self, claude_id: &str, managed_id: &str) {
        match self
            .claude_to_managed
            .iter_mut()
            .find(|(c, _)| c == claude_id)
        {
            Some(entry) => entry.1 = managed_id.to_string(),
            None => self
                .claude_to_managed
                .push((claude_id.to_string(), managed_id.to_string())),
        }
    }

    pub fn unlink_managed(&mut self, managed_id: &str) {
        self.claude_to_managed.retain(|(_, m)| m != managed_id);
    }

    pub fn tiles_message(&self) -> Value {
        json!({ "type": "text_tiles", "payload": self.tiles })
    }

    pub fn managed_claude_ids(&self) -> HashSet<String> {
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

fn load_tiles(path: &Path) -> Vec<Value> {
    fs::read_to_string(path)
        .ok()
        .and_then(|text| serde_json::from_str::<Vec<Value>>(&text).ok())
        .unwrap_or_default()
}

fn load_projects(path: &Path) -> Vec<Value> {
    fs::read_to_string(path)
        .ok()
        .and_then(|text| serde_json::from_str::<Value>(&text).ok())
        .and_then(|data| data.get("projects").and_then(Value::as_array).cloned())
        .unwrap_or_default()
}
