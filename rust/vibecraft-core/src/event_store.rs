//! In-memory event log: dedupe, tool durations, size limit and history.
//!
//! Events stay as `serde_json::Value`, so fields the server doesn't know
//! about pass through untouched.

use std::collections::{HashMap, HashSet, VecDeque};

use serde_json::{Number, Value};

/// Map key for an id-like field. JS Maps/Sets key by value, and a missing
/// field (undefined) is its own key, distinct from any string.
fn key_of(value: Option<&Value>) -> String {
    match value {
        None => "\0undefined".to_string(),
        Some(Value::String(s)) => s.clone(),
        Some(other) => format!("\0{other}"),
    }
}

pub struct EventStore {
    max_events: usize,
    /// Events in arrival order, at most `max_events`
    events: VecDeque<Value>,
    /// Seen ids in insertion order (for trimming) and as a set (for lookup)
    seen_order: VecDeque<String>,
    seen: HashSet<String>,
    /// pre_tool_use timestamp by toolUseId, until the matching post_tool_use
    pending_tool_uses: HashMap<String, Value>,
}

impl EventStore {
    pub fn new(max_events: usize) -> Self {
        Self {
            max_events,
            events: VecDeque::new(),
            seen_order: VecDeque::new(),
            seen: HashSet::new(),
            pending_tool_uses: HashMap::new(),
        }
    }

    /// Add an event. Returns it (post_tool_use gets `duration` from its
    /// pre_tool_use), or None if its id was already seen.
    pub fn add(&mut self, mut event: Value) -> Option<&Value> {
        let id = key_of(event.get("id"));
        if !self.seen.insert(id.clone()) {
            return None;
        }
        self.seen_order.push_back(id);

        // Bound the id set: keep the newest max_events once it passes twice that
        if self.seen_order.len() > self.max_events * 2 {
            while self.seen_order.len() > self.max_events {
                if let Some(old) = self.seen_order.pop_front() {
                    self.seen.remove(&old);
                }
            }
        }

        match event.get("type").and_then(Value::as_str) {
            Some("pre_tool_use") => {
                let tool_use_id = key_of(event.get("toolUseId"));
                let timestamp = event.get("timestamp").cloned().unwrap_or(Value::Null);
                self.pending_tool_uses.insert(tool_use_id, timestamp);
            }
            Some("post_tool_use") => {
                let tool_use_id = key_of(event.get("toolUseId"));
                if let Some(start) = self.pending_tool_uses.remove(&tool_use_id) {
                    let duration = subtract(event.get("timestamp"), Some(&start));
                    if let Some(obj) = event.as_object_mut() {
                        obj.insert("duration".to_string(), duration);
                    }
                }
            }
            _ => {}
        }

        self.events.push_back(event);
        while self.events.len() > self.max_events {
            self.events.pop_front();
        }
        self.events.back()
    }

    pub fn len(&self) -> usize {
        self.events.len()
    }

    pub fn is_empty(&self) -> bool {
        self.events.is_empty()
    }

    pub fn events(&self) -> impl DoubleEndedIterator<Item = &Value> + ExactSizeIterator {
        self.events.iter()
    }

    /// History for a newly connected client: the last `limit` events at or
    /// after `cutoff_timestamp` (older ones belong to sessions long gone)
    pub fn initial_history(&self, cutoff_timestamp: f64, limit: usize) -> Vec<&Value> {
        let matching: Vec<&Value> = self
            .events
            .iter()
            .filter(|e| {
                e.get("timestamp")
                    .and_then(Value::as_f64)
                    .is_some_and(|t| t >= cutoff_timestamp)
            })
            .collect();
        let skip = matching.len().saturating_sub(limit);
        matching.into_iter().skip(skip).collect()
    }

    /// Session of the newest event, or "unknown"
    pub fn last_session_id(&self) -> &str {
        self.events
            .back()
            .and_then(|e| e.get("sessionId"))
            .and_then(Value::as_str)
            .unwrap_or("unknown")
    }
}

/// `a - b` with JS number semantics: exact for integers, NaN (null) otherwise
fn subtract(a: Option<&Value>, b: Option<&Value>) -> Value {
    let (Some(Value::Number(a)), Some(Value::Number(b))) = (a, b) else {
        return Value::Null;
    };
    if let (Some(a), Some(b)) = (a.as_i64(), b.as_i64())
        && let Some(d) = a.checked_sub(b)
    {
        return Value::Number(d.into());
    }
    match (a.as_f64(), b.as_f64()) {
        (Some(a), Some(b)) => Number::from_f64(a - b).map_or(Value::Null, Value::Number),
        _ => Value::Null,
    }
}

/// Splits appended bytes into complete lines, holding back a trailing
/// partial line. Works on bytes so a read that cuts a multibyte character in
/// half doesn't corrupt it.
#[derive(Default)]
pub struct LineSplitter {
    remainder: Vec<u8>,
}

impl LineSplitter {
    pub fn new() -> Self {
        Self::default()
    }

    /// Feed new bytes; returns the complete, non-empty lines they finish
    pub fn push(&mut self, bytes: &[u8]) -> Vec<String> {
        self.remainder.extend_from_slice(bytes);
        let mut lines = Vec::new();
        let mut start = 0;
        while let Some(offset) = self.remainder[start..].iter().position(|&b| b == b'\n') {
            let end = start + offset;
            if end > start {
                lines.push(String::from_utf8_lossy(&self.remainder[start..end]).into_owned());
            }
            start = end + 1;
        }
        self.remainder.drain(..start);
        lines
    }

    pub fn reset(&mut self) {
        self.remainder.clear();
    }
}
