//! Helpers for the black-box tests and benchmarks of the vibecraft binaries.
//!
//! Every test gets its own temp HOME ([`TestEnv`]), so nothing touches the
//! real `~/.vibecraft/`. The server and the hook run as child processes and
//! are only talked to like Claude Code and the browser do: hook JSON on a
//! socket stdin, HTTP and WebSocket.

use std::fs;
use std::io::{BufRead, BufReader, Read, Write};
use std::net::{Shutdown, TcpStream};
use std::os::fd::OwnedFd;
use std::os::unix::net::UnixStream;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicU16, AtomicU64, Ordering};
use std::sync::{Arc, Condvar, Mutex};
use std::thread;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use serde_json::{Value, json};

pub const ALLOWED_ORIGIN: &str = "http://localhost:4002";

static COUNTER: AtomicU64 = AtomicU64::new(0);

/// A unique suffix for temp dirs and event ids
fn unique() -> String {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.subsec_nanos())
        .unwrap_or(0);
    format!(
        "{}-{}-{nanos:x}",
        std::process::id(),
        COUNTER.fetch_add(1, Ordering::Relaxed)
    )
}

pub fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// Poll until `check` returns Some, or panic after `timeout`
pub fn wait_for<T>(timeout: Duration, label: &str, mut check: impl FnMut() -> Option<T>) -> T {
    let deadline = Instant::now() + timeout;
    loop {
        if let Some(value) = check() {
            return value;
        }
        if Instant::now() > deadline {
            panic!("timed out waiting for {label}");
        }
        thread::sleep(Duration::from_millis(5));
    }
}

// ============================================================================
// Isolated environment
// ============================================================================

/// A temp HOME, removed on drop
pub struct TestEnv {
    pub home: PathBuf,
    pub data_dir: PathBuf,
    pub events_file: PathBuf,
}

impl TestEnv {
    pub fn new() -> Self {
        let home = std::env::temp_dir().join(format!("vibecraft-test-{}", unique()));
        fs::create_dir_all(&home).expect("create temp HOME");
        let data_dir = home.join(".vibecraft/data");
        Self {
            events_file: data_dir.join("events.jsonl"),
            data_dir,
            home,
        }
    }

    /// Write events (or raw lines) to the events file
    pub fn seed_events(&self, lines: &[Value]) {
        fs::create_dir_all(&self.data_dir).unwrap();
        let mut text = String::new();
        for line in lines {
            match line {
                Value::String(raw) => text.push_str(raw),
                event => text.push_str(&event.to_string()),
            }
            text.push('\n');
        }
        fs::write(&self.events_file, text).unwrap();
    }

    pub fn append_events_file(&self, bytes: &[u8]) {
        fs::OpenOptions::new()
            .append(true)
            .create(true)
            .open(&self.events_file)
            .and_then(|mut f| f.write_all(bytes))
            .unwrap();
    }
}

impl Default for TestEnv {
    fn default() -> Self {
        Self::new()
    }
}

impl Drop for TestEnv {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.home);
    }
}

/// A minimal valid event; `overrides` (an object) replaces its fields
pub fn make_event(overrides: Value) -> Value {
    let session_id = overrides
        .get("sessionId")
        .and_then(Value::as_str)
        .unwrap_or("test-session")
        .to_string();
    let mut event = json!({
        "id": format!("{session_id}-{}", unique()),
        "timestamp": now_ms(),
        "type": "user_prompt_submit",
        "sessionId": session_id,
        "cwd": "/tmp/project",
        "prompt": "hello",
    });
    if let (Some(event), Value::Object(overrides)) = (event.as_object_mut(), overrides) {
        event.extend(overrides);
    }
    event
}

// ============================================================================
// Hook
// ============================================================================

pub struct HookResult {
    pub code: Option<i32>,
    pub stdout: String,
    pub stderr: String,
    /// Raw lines of the events file after the run
    pub lines: Vec<String>,
    /// Those lines parsed
    pub events: Vec<Value>,
}

/// Run the hook like Claude Code does: input on a socket stdin (Claude Code
/// is Node, which gives children a socket on Linux; this guards the
/// /dev/stdin regression)
pub fn run_hook(
    hook: &str,
    env: &TestEnv,
    events_file: &Path,
    input: &[u8],
    extra_env: &[(&str, &str)],
) -> HookResult {
    let (mut ours, theirs) = UnixStream::pair().unwrap();
    let mut command = Command::new(hook);
    command
        .env("HOME", &env.home)
        .env("VIBECRAFT_EVENTS_FILE", events_file)
        .env("VIBECRAFT_ENABLE_WS_NOTIFY", "false")
        .stdin(Stdio::from(OwnedFd::from(theirs)))
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    for (key, value) in extra_env {
        command.env(key, value);
    }
    let child = command.spawn().expect("spawn hook");
    let _ = ours.write_all(input);
    let _ = ours.shutdown(Shutdown::Both);
    drop(ours);
    let output = child.wait_with_output().unwrap();

    let content = fs::read_to_string(events_file).unwrap_or_default();
    let lines: Vec<String> = match content.strip_suffix('\n').unwrap_or(&content) {
        "" => Vec::new(),
        text => text.split('\n').map(str::to_string).collect(),
    };
    let events = lines
        .iter()
        .filter(|l| !l.is_empty())
        .map(|l| serde_json::from_str(l).expect("event line is JSON"))
        .collect();
    HookResult {
        code: output.status.code(),
        stdout: String::from_utf8_lossy(&output.stdout).into_owned(),
        stderr: String::from_utf8_lossy(&output.stderr).into_owned(),
        lines,
        events,
    }
}

/// Drop the fields that vary between runs (id, timestamp) after checking
/// their shape
pub fn strip_volatile(event: &Value) -> Value {
    let mut rest = event.as_object().expect("event is an object").clone();
    let session = event["sessionId"].as_str().unwrap_or_default();
    let id = rest.remove("id");
    assert!(
        id.as_ref()
            .and_then(Value::as_str)
            .is_some_and(|id| id.starts_with(&format!("{session}-"))),
        "unexpected event id: {id:?}"
    );
    let timestamp = rest.remove("timestamp");
    assert!(
        timestamp
            .as_ref()
            .and_then(Value::as_u64)
            .is_some_and(|t| t.abs_diff(now_ms()) < 60_000),
        "unexpected event timestamp: {timestamp:?}"
    );
    Value::Object(rest)
}

// ============================================================================
// Server
// ============================================================================

/// A port no other test in this process has been given, below the
/// ephemeral range so client sockets never take it. Not probed with a bind:
/// a listener opened here would leak, for an instant, into the servers other
/// tests are spawning (fork before exec) and make their port look busy
fn next_port() -> u16 {
    static NEXT: AtomicU16 = AtomicU16::new(0);
    let base = 20_000 + (std::process::id() % 1000) as u16 * 10;
    base + NEXT.fetch_add(1, Ordering::Relaxed) % 10_000
}

/// The server running on a free port in a [`TestEnv`]; killed on drop
pub struct TestServer {
    pub port: u16,
    child: Child,
    log: PathBuf,
}

impl TestServer {
    /// Start `server` and wait until /health answers (on another port if
    /// the one it got is taken)
    pub fn start(server: &str, env: &TestEnv, extra_env: &[(&str, &str)]) -> Self {
        for _ in 0..20 {
            if let Some(server) = Self::try_start(server, env, extra_env) {
                return server;
            }
        }
        panic!("no free port for the server");
    }

    fn try_start(server: &str, env: &TestEnv, extra_env: &[(&str, &str)]) -> Option<Self> {
        let port = next_port();
        let log = env.home.join(format!("server-{port}.log"));
        let out = fs::File::create(&log).unwrap();
        let mut command = Command::new(server);
        command
            .env("HOME", &env.home)
            .env("VIBECRAFT_PORT", port.to_string())
            .env("VIBECRAFT_HOST", "127.0.0.1")
            .env("VIBECRAFT_EVENTS_FILE", &env.events_file)
            .stdin(Stdio::null())
            .stdout(out.try_clone().unwrap())
            .stderr(out);
        for (key, value) in extra_env {
            command.env(key, value);
        }
        die_with_parent(&mut command);
        let mut server = Self {
            port,
            child: command.spawn().expect("spawn server"),
            log,
        };

        let deadline = Instant::now() + Duration::from_secs(15);
        loop {
            if let Ok(Some(status)) = server.child.try_wait() {
                let output = server.output();
                if output.contains("Address already in use") {
                    return None;
                }
                panic!("server exited early ({status}):\n{output}");
            }
            // Only our server: something else on the port would make ours exit
            if TcpStream::connect(("127.0.0.1", port)).is_ok()
                && server.request("GET", "/health", None, &[]).status == 200
                && matches!(server.child.try_wait(), Ok(None))
            {
                return Some(server);
            }
            if Instant::now() > deadline {
                panic!("server did not become healthy:\n{}", server.output());
            }
            thread::sleep(Duration::from_millis(5));
        }
    }

    pub fn pid(&self) -> u32 {
        self.child.id()
    }

    /// Wait for the server to exit on its own; returns its exit code
    pub fn wait_exit(&mut self) -> Option<i32> {
        let child = &mut self.child;
        wait_for(Duration::from_secs(3), "server exit", || {
            child.try_wait().ok().flatten().map(|status| status.code())
        })
    }

    /// Server stdout + stderr, for debugging failures
    pub fn output(&self) -> String {
        fs::read_to_string(&self.log).unwrap_or_default()
    }

    pub fn stop(mut self) {
        self.kill();
    }

    fn kill(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }

    /// One HTTP/1.1 request on its own connection. The path is sent as is
    /// (unnormalized), so traversal attempts reach the server
    pub fn request(
        &self,
        method: &str,
        path: &str,
        body: Option<&[u8]>,
        headers: &[(&str, &str)],
    ) -> HttpResponse {
        http_request(self.port, method, path, body, headers)
    }

    pub fn get_json(&self, path: &str) -> (u16, Value) {
        let res = self.request("GET", path, None, &[]);
        (res.status, res.json())
    }

    /// POST raw bytes as JSON; returns status and the parsed body (or the
    /// text as a JSON string when it isn't JSON)
    pub fn send_json(&self, method: &str, path: &str, body: &[u8]) -> (u16, Value) {
        let res = self.request(
            method,
            path,
            Some(body),
            &[("Content-Type", "application/json")],
        );
        (res.status, res.json())
    }

    pub fn post_event(&self, event: &Value) -> (u16, Value) {
        self.send_json("POST", "/event", event.to_string().as_bytes())
    }

    pub fn health(&self) -> Value {
        self.get_json("/health").1
    }

    pub fn connect(&self) -> WsClient {
        WsClient::connect(self.port, Some(ALLOWED_ORIGIN))
    }

    pub fn connect_with_origin(&self, origin: Option<&str>) -> WsClient {
        WsClient::connect(self.port, origin)
    }
}

/// Kill the child when the test process dies, even if it aborts before
/// [`TestServer`]'s drop runs (Linux `PR_SET_PDEATHSIG`). It fires when the
/// spawning *thread* exits, so a server must not outlive the thread that
/// started it
fn die_with_parent(command: &mut Command) {
    use std::os::unix::process::CommandExt;
    unsafe extern "C" {
        fn prctl(option: i32, arg2: u64, ...) -> i32;
    }
    const PR_SET_PDEATHSIG: i32 = 1;
    const SIGKILL: u64 = 9;
    // SAFETY: prctl is async-signal-safe, as pre_exec requires
    unsafe {
        command.pre_exec(|| {
            prctl(PR_SET_PDEATHSIG, SIGKILL);
            Ok(())
        });
    }
}

impl Drop for TestServer {
    fn drop(&mut self) {
        let status = self.child.try_wait();
        self.kill();
        if thread::panicking() {
            eprintln!(
                "server on port {} ({status:?} before the kill) logged:\n{}",
                self.port,
                self.output()
            );
        }
    }
}

// ============================================================================
// HTTP client
// ============================================================================

pub struct HttpResponse {
    pub status: u16,
    /// Header names in lowercase
    pub headers: Vec<(String, String)>,
    pub body: Vec<u8>,
}

impl HttpResponse {
    pub fn header(&self, name: &str) -> Option<&str> {
        self.headers
            .iter()
            .find(|(k, _)| k == name)
            .map(|(_, v)| v.as_str())
    }

    pub fn text(&self) -> String {
        String::from_utf8_lossy(&self.body).into_owned()
    }

    pub fn json(&self) -> Value {
        serde_json::from_slice(&self.body).unwrap_or_else(|_| Value::String(self.text()))
    }
}

pub fn http_request(
    port: u16,
    method: &str,
    path: &str,
    body: Option<&[u8]>,
    headers: &[(&str, &str)],
) -> HttpResponse {
    let mut stream = TcpStream::connect(("127.0.0.1", port)).expect("connect");
    stream.set_read_timeout(Some(Duration::from_secs(10))).ok();
    let mut head = format!("{method} {path} HTTP/1.1\r\nConnection: close\r\n");
    if !headers.iter().any(|(key, _)| key.eq_ignore_ascii_case("host")) {
        head.push_str(&format!("Host: 127.0.0.1:{port}\r\n"));
    }
    for (key, value) in headers {
        head.push_str(&format!("{key}: {value}\r\n"));
    }
    if let Some(body) = body {
        head.push_str(&format!("Content-Length: {}\r\n", body.len()));
    }
    head.push_str("\r\n");
    // The server may answer (413) before reading everything: ignore write errors
    let _ = stream.write_all(head.as_bytes());
    if let Some(body) = body {
        let _ = stream.write_all(body);
    }

    let mut reader = BufReader::new(stream);
    let mut status_line = String::new();
    reader.read_line(&mut status_line).expect("status line");
    let status = status_line
        .split_whitespace()
        .nth(1)
        .and_then(|s| s.parse().ok())
        .unwrap_or_else(|| panic!("bad status line: {status_line:?}"));
    let mut headers = Vec::new();
    loop {
        let mut line = String::new();
        if reader.read_line(&mut line).unwrap_or(0) == 0 || line == "\r\n" {
            break;
        }
        if let Some((k, v)) = line.split_once(':') {
            headers.push((k.trim().to_ascii_lowercase(), v.trim().to_string()));
        }
    }
    let length = headers
        .iter()
        .find(|(k, _)| k == "content-length")
        .and_then(|(_, v)| v.parse::<usize>().ok());
    let mut body = Vec::new();
    match length {
        Some(n) => {
            body.resize(n, 0);
            reader.read_exact(&mut body).expect("response body");
        }
        None => {
            let _ = reader.read_to_end(&mut body);
        }
    }
    HttpResponse {
        status,
        headers,
        body,
    }
}

// ============================================================================
// WebSocket client
// ============================================================================

#[derive(Default)]
struct WsInbox {
    messages: Vec<Value>,
    close_code: Option<u16>,
    closed: bool,
}

/// Messages so far, and a signal for each new one
type SharedInbox = Arc<(Mutex<WsInbox>, Condvar)>;

/// A WebSocket client that records every message it receives
pub struct WsClient {
    stream: TcpStream,
    inbox: SharedInbox,
    consumed: usize,
}

impl WsClient {
    pub fn connect(port: u16, origin: Option<&str>) -> Self {
        let mut stream = TcpStream::connect(("127.0.0.1", port)).expect("connect");
        let mut request = format!(
            "GET / HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\
             Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n"
        );
        if let Some(origin) = origin {
            request.push_str(&format!("Origin: {origin}\r\n"));
        }
        request.push_str("\r\n");
        stream.write_all(request.as_bytes()).unwrap();

        let mut reader = BufReader::new(stream.try_clone().unwrap());
        let mut status = String::new();
        reader.read_line(&mut status).unwrap();
        assert!(status.contains(" 101 "), "handshake failed: {status:?}");
        loop {
            let mut line = String::new();
            if reader.read_line(&mut line).unwrap_or(0) == 0 || line == "\r\n" {
                break;
            }
        }

        let inbox: SharedInbox = Arc::default();
        let shared = inbox.clone();
        thread::spawn(move || {
            let (lock, signal) = &*shared;
            while let Some((opcode, payload)) = read_frame(&mut reader) {
                let mut inbox = lock.lock().unwrap();
                match opcode {
                    0x1 => inbox
                        .messages
                        .push(serde_json::from_slice(&payload).expect("message is JSON")),
                    0x8 => {
                        inbox.close_code =
                            payload.get(..2).map(|c| u16::from_be_bytes([c[0], c[1]]));
                        break;
                    }
                    _ => {}
                }
                signal.notify_all();
            }
            lock.lock().unwrap().closed = true;
            signal.notify_all();
        });
        Self {
            stream,
            inbox,
            consumed: 0,
        }
    }

    /// Types of every message received so far
    pub fn types(&self) -> Vec<String> {
        self.messages()
            .iter()
            .map(|m| m["type"].as_str().unwrap_or_default().to_string())
            .collect()
    }

    pub fn messages(&self) -> Vec<Value> {
        self.inbox.0.lock().unwrap().messages.clone()
    }

    /// Wait until `check` returns Some for the inbox, or panic after `timeout`
    fn wait_inbox<T>(
        &self,
        timeout: Duration,
        label: &str,
        mut check: impl FnMut(&WsInbox) -> Option<T>,
    ) -> T {
        let (lock, signal) = &*self.inbox;
        let deadline = Instant::now() + timeout;
        let mut inbox = lock.lock().unwrap();
        loop {
            if let Some(value) = check(&inbox) {
                return value;
            }
            let left = deadline.saturating_duration_since(Instant::now());
            if left.is_zero() {
                panic!("timed out waiting for {label}");
            }
            inbox = signal.wait_timeout(inbox, left).unwrap().0;
        }
    }

    /// Wait for the next message of this type (searching already received
    /// ones first)
    pub fn next(&mut self, kind: &str) -> Value {
        self.next_within(kind, Duration::from_secs(3))
    }

    pub fn next_within(&mut self, kind: &str, timeout: Duration) -> Value {
        self.next_matching(timeout, &format!("WebSocket message {kind:?}"), |m| {
            m["type"] == kind
        })
    }

    /// Wait for the next message `matches` accepts
    pub fn next_matching(
        &mut self,
        timeout: Duration,
        label: &str,
        matches: impl Fn(&Value) -> bool,
    ) -> Value {
        let consumed = self.consumed;
        let (index, message) = self.wait_inbox(timeout, label, |inbox| {
            inbox
                .messages
                .iter()
                .enumerate()
                .skip(consumed)
                .find(|(_, m)| matches(m))
                .map(|(i, m)| (i, m.clone()))
        });
        self.consumed = index + 1;
        message
    }

    /// Wait for the server to close the connection; returns its close code
    pub fn wait_close(&self) -> Option<u16> {
        self.wait_inbox(Duration::from_secs(3), "WebSocket close", |inbox| {
            inbox.closed.then_some(inbox.close_code)
        })
    }

    /// Send a text frame (masked, as clients must)
    pub fn send_text(&mut self, text: &str) {
        let payload = text.as_bytes();
        let mask = [0x12, 0x34, 0x56, 0x78];
        let mut frame = vec![0x81];
        match payload.len() {
            n if n < 126 => frame.push(0x80 | n as u8),
            n if n <= 0xffff => {
                frame.push(0x80 | 126);
                frame.extend_from_slice(&(n as u16).to_be_bytes());
            }
            n => {
                frame.push(0x80 | 127);
                frame.extend_from_slice(&(n as u64).to_be_bytes());
            }
        }
        frame.extend_from_slice(&mask);
        frame.extend(payload.iter().enumerate().map(|(i, b)| b ^ mask[i % 4]));
        self.stream.write_all(&frame).unwrap();
    }
}

impl Drop for WsClient {
    fn drop(&mut self) {
        let _ = self.stream.shutdown(Shutdown::Both);
    }
}

/// One unmasked server frame: (opcode, payload); None when the stream ends
fn read_frame(reader: &mut impl Read) -> Option<(u8, Vec<u8>)> {
    let mut head = [0u8; 2];
    reader.read_exact(&mut head).ok()?;
    let len = match head[1] & 0x7f {
        126 => {
            let mut b = [0u8; 2];
            reader.read_exact(&mut b).ok()?;
            u16::from_be_bytes(b) as usize
        }
        127 => {
            let mut b = [0u8; 8];
            reader.read_exact(&mut b).ok()?;
            u64::from_be_bytes(b) as usize
        }
        n => n as usize,
    };
    let mut payload = vec![0u8; len];
    reader.read_exact(&mut payload).ok()?;
    Some((head[0] & 0x0f, payload))
}

// ============================================================================
// Benchmark statistics
// ============================================================================

pub struct Summary {
    pub mean: f64,
    pub p50: f64,
    pub p95: f64,
    pub p99: f64,
    pub min: f64,
    pub max: f64,
}

pub fn summarize(values: &[f64]) -> Summary {
    let mut sorted = values.to_vec();
    sorted.sort_by(f64::total_cmp);
    let pick = |q: f64| sorted[((q * sorted.len() as f64) as usize).min(sorted.len() - 1)];
    Summary {
        mean: values.iter().sum::<f64>() / values.len() as f64,
        p50: pick(0.5),
        p95: pick(0.95),
        p99: pick(0.99),
        min: sorted[0],
        max: sorted[sorted.len() - 1],
    }
}

pub fn print_table(rows: &[(&str, Summary)], unit: &str) {
    print!("{:<22}", "case");
    for h in ["mean", "p50", "p95", "p99", "min", "max"] {
        print!("{h:>9}");
    }
    println!("  ({unit})");
    for (name, s) in rows {
        print!("{name:<22}");
        for v in [s.mean, s.p50, s.p95, s.p99, s.min, s.max] {
            print!("{v:>9.2}");
        }
        println!();
    }
}

/// Resident memory of a process in MiB (Linux), or NaN if unavailable
pub fn rss_mib(pid: u32) -> f64 {
    fs::read_to_string(format!("/proc/{pid}/status"))
        .ok()
        .and_then(|s| {
            s.lines()
                .find_map(|l| l.strip_prefix("VmRSS:"))
                .and_then(|v| v.trim().trim_end_matches("kB").trim().parse::<f64>().ok())
        })
        .map_or(f64::NAN, |kb| kb / 1024.0)
}

/// A binary built in the same profile as the running example
/// (target/<profile>/examples/x → target/<profile>/<name>)
pub fn example_sibling(name: &str) -> PathBuf {
    let exe = std::env::current_exe().unwrap();
    let path = exe.parent().and_then(|d| d.parent()).unwrap().join(name);
    assert!(
        path.exists(),
        "{} not found: run cargo build --release first",
        path.display()
    );
    path
}

/// Milliseconds since `start`
pub fn elapsed_ms(start: Instant) -> f64 {
    start.elapsed().as_secs_f64() * 1000.0
}
