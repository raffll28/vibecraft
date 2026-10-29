//! vibecraft server: receives Claude Code events from the hook (HTTP and the
//! events file) and streams them to the 3D monitor over WebSocket.
//!
//! One thread per connection (vibecraft has a handful of local clients), a
//! shared state behind a mutex, one writer thread per WebSocket client fed
//! by a channel, and inotify on the events file instead of polling.

mod http;
mod inotify;
mod routes;
mod setup;
mod sha1;
mod state;
mod ws;

use std::fs::{self, File, OpenOptions};
use std::io::{BufReader, Read, Seek, SeekFrom, Write};
use std::net::{Shutdown, TcpListener, TcpStream};
use std::path::Path;
use std::sync::mpsc;
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::Duration;

use serde_json::{Value, json};
use vibecraft_core::validation::is_origin_allowed;

use crate::http::{ReadError, read_request};
use crate::state::{CLIENT_QUEUE_FRAMES, Client, Config, Frame, Shared, State, lock};

const MAX_BODY_SIZE: usize = 1024 * 1024;
/// Compact the events file at startup once it grows past this
const EVENTS_FILE_COMPACT_BYTES: usize = 10 * 1024 * 1024;
/// Idle keep-alive connections are closed after this
const KEEP_ALIVE_TIMEOUT: Duration = Duration::from_secs(5);
/// New clients get the history of sessions with events newer than this
const SESSION_HISTORY_MAX_AGE_MS: u64 = 30 * 60 * 1000;

fn main() {
    match std::env::args().nth(1).as_deref() {
        None => {}
        Some("setup") => return exit_on_error(setup::setup()),
        Some("uninstall") => return exit_on_error(setup::uninstall()),
        Some(_) => {
            println!("Usage: vibecraft-server [setup | uninstall]");
            println!("  (no argument)  run the server (VIBECRAFT_PORT, default 4003)");
            println!(
                "  setup          install the hook and register it in ~/.claude/settings.json"
            );
            println!("  uninstall      remove the hook (keeps ~/.vibecraft/data)");
            return;
        }
    }

    let config = Arc::new(Config::from_env());
    let mut state = State::new(&config);
    load_events(&config, &mut state);
    let shared: Shared = Arc::new(Mutex::new(state));

    {
        let (shared, config) = (shared.clone(), config.clone());
        thread::spawn(move || watch_events_file(&config, &shared));
    }

    let listener = match TcpListener::bind((config.host.as_str(), config.port)) {
        Ok(l) => l,
        Err(e) => {
            eprintln!("Failed to listen on {}:{}: {e}", config.host, config.port);
            std::process::exit(1);
        }
    };
    println!(
        "[vibecraft] Server running on {}:{}",
        config.host, config.port
    );

    for stream in listener.incoming().flatten() {
        let (shared, config) = (shared.clone(), config.clone());
        thread::spawn(move || handle_connection(stream, &shared, &config));
    }
}

fn exit_on_error(result: Result<(), String>) {
    if let Err(e) = result {
        eprintln!("Error: {e}");
        std::process::exit(1);
    }
}

/// Load the newest events from the file, compacting it when it's large
fn load_events(config: &Config, state: &mut State) {
    let Ok(bytes) = fs::read(&config.events_file) else {
        return;
    };
    let content = String::from_utf8_lossy(&bytes);
    let all_lines: Vec<&str> = content.split('\n').filter(|l| !l.is_empty()).collect();
    let lines = &all_lines[all_lines.len().saturating_sub(config.max_events)..];
    for line in lines {
        if let Ok(event @ Value::Object(_)) = serde_json::from_str::<Value>(line) {
            state.events.add(event);
        }
    }
    if bytes.len() > EVENTS_FILE_COMPACT_BYTES {
        let _ = fs::write(&config.events_file, lines.join("\n") + "\n");
        println!(
            "[vibecraft] Compacted events file: kept last {} of {} events",
            lines.len(),
            all_lines.len()
        );
    }
    state.events_file_offset = fs::metadata(&config.events_file)
        .map(|m| m.len())
        .unwrap_or(0);
    println!("[vibecraft] Loaded {} events from file", state.events.len());
}

/// Read only the bytes appended since the last read
fn read_new_events(path: &Path, shared: &Shared) {
    let mut state = lock(shared);
    let Ok(size) = fs::metadata(path).map(|m| m.len()) else {
        return;
    };
    if size < state.events_file_offset {
        // Truncated or replaced: start over
        state.events_file_offset = 0;
        state.events_file_lines.reset();
    }
    if size == state.events_file_offset {
        return;
    }
    let Ok(mut file) = File::open(path) else {
        return;
    };
    let mut buf = Vec::with_capacity((size - state.events_file_offset) as usize);
    if file
        .seek(SeekFrom::Start(state.events_file_offset))
        .is_err()
        || Read::by_ref(&mut file)
            .take(size - state.events_file_offset)
            .read_to_end(&mut buf)
            .is_err()
    {
        return;
    }
    state.events_file_offset += buf.len() as u64;
    for line in state.events_file_lines.push(&buf) {
        if let Ok(event @ Value::Object(_)) = serde_json::from_str::<Value>(&line) {
            state.add_event(event);
        }
    }
}

fn watch_events_file(config: &Config, shared: &Shared) {
    let path = &config.events_file;
    let dir = path.parent().unwrap_or(Path::new("/"));
    let _ = fs::create_dir_all(dir);
    let _ = OpenOptions::new().create(true).append(true).open(path);
    let name = path
        .file_name()
        .map(|n| n.as_encoded_bytes().to_vec())
        .unwrap_or_default();

    // Watch the directory, not the file, so replacing the file is noticed too
    let mask =
        inotify::IN_MODIFY | inotify::IN_CLOSE_WRITE | inotify::IN_MOVED_TO | inotify::IN_CREATE;
    match inotify::Inotify::watch_dir(dir, mask) {
        Ok(mut watcher) => loop {
            // Read once in case lines landed before the watch was set up
            read_new_events(path, shared);
            match watcher.read_events() {
                Ok(events) if events.iter().any(|e| e.name == name) => {}
                Ok(_) => continue,
                Err(_) => break,
            }
        },
        Err(e) => eprintln!("[vibecraft] inotify unavailable ({e}), polling the events file"),
    }
    loop {
        read_new_events(path, shared);
        thread::sleep(Duration::from_secs(1));
    }
}

fn handle_connection(stream: TcpStream, shared: &Shared, config: &Config) {
    let _ = stream.set_nodelay(true);
    let _ = stream.set_read_timeout(Some(KEEP_ALIVE_TIMEOUT));
    let Ok(mut writer) = stream.try_clone() else {
        return;
    };
    let mut reader = BufReader::new(stream);

    loop {
        let req = match read_request(&mut reader, MAX_BODY_SIZE) {
            Ok(req) => req,
            Err(ReadError::Closed) | Err(ReadError::Io) => return,
            Err(ReadError::Malformed) => {
                let _ = http::Response::new(400, None, "Bad request").write_to(&mut writer, false);
                return;
            }
        };

        if ws::is_upgrade(&req) {
            let _ = reader.get_ref().set_read_timeout(None);
            return websocket(req, reader, writer, shared);
        }

        let res = routes::handle(&req, shared, config);
        let keep_alive = req.keep_alive && !matches!(req.body, http::Body::TooLarge);
        if res.write_to(&mut writer, keep_alive).is_err() || !keep_alive {
            let _ = writer.shutdown(Shutdown::Both);
            return;
        }
    }
}

fn websocket(
    req: http::Request,
    mut reader: BufReader<TcpStream>,
    mut writer: TcpStream,
    shared: &Shared,
) {
    if ws::write_handshake(&mut writer, &ws::handshake_response(&req)).is_err() {
        return;
    }

    // CSRF protection: only browsers on allowed origins
    if !is_origin_allowed(req.header("origin")) {
        let _ = writer.write_all(&ws::close_frame(1008, "Origin not allowed"));
        let _ = writer.shutdown(Shutdown::Write);
        return;
    }

    let Ok(control) = writer.try_clone() else {
        return;
    };
    // Writer thread: the only one that writes to this socket
    let (tx, rx) = mpsc::sync_channel::<Frame>(CLIENT_QUEUE_FRAMES);
    let client = Client {
        tx,
        stream: control,
    };
    let mut socket = writer;
    let writer_thread = thread::spawn(move || {
        for frame in rx {
            if socket.write_all(&frame).is_err() {
                break;
            }
        }
        let _ = socket.shutdown(Shutdown::Both);
    });

    // Register and queue the greeting under one lock, so no broadcast can
    // slip in before it: connected, text_tiles, then history
    let client_id = {
        let mut state = lock(shared);
        let id = state.next_client_id;
        state.next_client_id += 1;
        let cutoff = routes::now_ms().saturating_sub(SESSION_HISTORY_MAX_AGE_MS) as f64;
        let history = state.events.initial_history(cutoff, 50);
        let greeting = [
            json!({ "type": "connected", "payload": { "sessionId": state.events.last_session_id() } }),
            state.tiles_message(),
            json!({ "type": "history", "payload": history }),
        ];
        for message in greeting {
            client.send(Arc::new(ws::text_frame(&message.to_string())));
        }
        let Ok(stream) = client.stream.try_clone() else {
            return;
        };
        state.clients.insert(
            id,
            Client {
                tx: client.tx.clone(),
                stream,
            },
        );
        id
    };

    loop {
        let message = ws::read_message(&mut reader, |payload| {
            client.send(Arc::new(ws::pong_frame(&payload)));
        });
        match message {
            // The monitor only receives; anything clients send is ignored
            Ok(ws::Message::Data) => {}
            Ok(ws::Message::Close) => {
                client.send(Arc::new(ws::close_frame(1000, "")));
                break;
            }
            Err(_) => break,
        }
    }

    lock(shared).clients.remove(&client_id);
    drop(client);
    let _ = writer_thread.join();
}
