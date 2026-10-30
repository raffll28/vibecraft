//! Vibecraft hook - captures Claude Code events for the 3D visualization.
//!
//! 1. Reads the hook input (JSON) from stdin
//! 2. Transforms it into a vibecraft event
//! 3. Appends it to the events JSONL file
//! 4. POSTs it to the vibecraft server
//!
//! It runs synchronously on every tool call, so it does as little as possible:
//! no runtime dependencies, no transcript reading, and it never fails in a
//! way that would disturb Claude (it always exits 0).

mod event;
mod notify;

use std::env;
use std::fs::{self, OpenOptions};
use std::io::{Read, Write};
use std::path::PathBuf;
use std::time::{SystemTime, UNIX_EPOCH};

fn main() {
    let mut input = Vec::new();
    if std::io::stdin().read_to_end(&mut input).is_err() {
        return;
    }
    // Never disturb Claude over a malformed event
    let Ok(hook) = serde_json::from_slice::<serde_json::Value>(&input) else {
        return;
    };

    let now_us = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_micros())
        .unwrap_or(0);

    let Some(event) = event::build(&hook, now_us) else {
        return;
    };
    let Ok(mut line) = serde_json::to_string(&event) else {
        return;
    };
    line.push('\n');

    append_event(&line);

    if env::var("VIBECRAFT_ENABLE_WS_NOTIFY").map_or(true, |v| v == "true") {
        let url = env::var("VIBECRAFT_WS_NOTIFY")
            .unwrap_or_else(|_| "http://localhost:4003/event".to_string());
        notify::post(&url, line.trim_end().as_bytes());
    }
}

/// Events file: $VIBECRAFT_EVENTS_FILE, else $VIBECRAFT_DATA_DIR/events.jsonl,
/// else ~/.vibecraft/data/events.jsonl
fn events_file() -> PathBuf {
    if let Ok(file) = env::var("VIBECRAFT_EVENTS_FILE") {
        return PathBuf::from(file);
    }
    let data_dir = env::var("VIBECRAFT_DATA_DIR")
        .map(PathBuf::from)
        .unwrap_or_else(|_| {
            PathBuf::from(env::var("HOME").unwrap_or_default()).join(".vibecraft/data")
        });
    data_dir.join("events.jsonl")
}

/// Append one line with a single O_APPEND write, so concurrent hooks don't interleave
fn append_event(line: &str) {
    let path = events_file();
    if let Some(dir) = path.parent() {
        let _ = fs::create_dir_all(dir);
    }
    if let Ok(mut file) = OpenOptions::new().create(true).append(true).open(&path) {
        let _ = file.write_all(line.as_bytes());
    }
}
