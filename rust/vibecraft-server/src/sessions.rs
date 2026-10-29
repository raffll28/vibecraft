//! Managed Claude Code sessions in tmux: creation and the /sessions/:id
//! actions, permission prompt and token polling, health checks and the
//! working timeout. Port of the session code in server/index.ts.
//!
//! tmux runs without the state lock held: read what's needed, unlock, run
//! the command, lock again to apply the result.

use std::process::Command;
use std::thread;
use std::time::Duration;

use serde_json::{Value, json};
use vibecraft_core::tmux_parsing::{
    detect_bypass_warning, detect_permission_prompt, parse_tokens_from_output,
};
use vibecraft_core::validation::{validate_directory_path, validate_tmux_session};

use crate::git;
use crate::http::{Body, Response};
use crate::routes::{exec_path, is_truthy, now_ms, send_to_tmux, uuid_v4};
use crate::state::{Shared, State, TokenCount, lock};

const POLL_INTERVAL: Duration = Duration::from_secs(1);
/// Idle sessions are polled every Nth tick: prompts and tokens only change while working
const IDLE_POLL_EVERY: u64 = 5;
const HEALTH_INTERVAL: Duration = Duration::from_secs(5);
const WORKING_CHECK_INTERVAL: Duration = Duration::from_secs(10);
/// A "working" session with no activity for this long goes idle (missed stop events)
const WORKING_TIMEOUT_MS: u64 = 120_000;

/// Run tmux with the extended PATH; stdout, or Node-style "Command failed" text
pub fn tmux(args: &[&str]) -> Result<String, String> {
    let output = Command::new("tmux")
        .args(args)
        .env("PATH", exec_path())
        .output()
        .map_err(|e| e.to_string())?;
    if output.status.success() {
        Ok(String::from_utf8_lossy(&output.stdout).into_owned())
    } else {
        Err(format!(
            "Command failed: tmux {}\n{}",
            args.join(" "),
            String::from_utf8_lossy(&output.stderr).trim()
        ))
    }
}

fn too_large() -> Response {
    Response::json(413, &json!({ "error": "Request body too large" }))
}

/// The body as JSON: Ok(None) when it isn't valid JSON, Err(413) when too large
fn parse(body: &Body) -> Result<Option<Value>, Response> {
    match body {
        Body::TooLarge => Err(too_large()),
        Body::Bytes(bytes) => Ok(serde_json::from_slice(bytes).ok()),
    }
}

fn not_found() -> Response {
    Response::json(404, &json!({ "ok": false, "error": "Session not found" }))
}

fn invalid_json() -> Response {
    Response::json(400, &json!({ "ok": false, "error": "Invalid JSON" }))
}

fn str_of<'a>(v: &'a Value, key: &str) -> &'a str {
    v.get(key).and_then(Value::as_str).unwrap_or_default()
}

/// `tmux new-session` running claude in `cwd` (through tmux's shell, with the
/// extended PATH in front, like the Node server)
fn spawn_claude(tmux_name: &str, cwd: &str, claude_args: &[&str]) -> Result<String, String> {
    let claude = if claude_args.is_empty() {
        "claude".to_string()
    } else {
        format!("claude {}", claude_args.join(" "))
    };
    tmux(&[
        "new-session",
        "-d",
        "-s",
        tmux_name,
        "-c",
        cwd,
        &format!("PATH={} {claude}", exec_path()),
    ])
    .map(|_| claude)
}

/// POST /sessions
pub fn create(shared: &Shared, body: &Body) -> Response {
    let fail = |message: String| Response::json(500, &json!({ "ok": false, "error": message }));
    // JS: `options = body ? JSON.parse(body) : {}`; null makes options.name throw
    let options = match body {
        Body::TooLarge => return too_large(),
        Body::Bytes(bytes) if bytes.is_empty() => json!({}),
        Body::Bytes(bytes) => match serde_json::from_slice::<Value>(bytes) {
            Ok(Value::Null) => {
                return fail("Cannot read properties of null (reading 'name')".into());
            }
            Ok(o) => o,
            Err(e) => return fail(e.to_string()),
        },
    };

    let id = uuid_v4();
    let counter = {
        let mut state = lock(shared);
        state.session_counter += 1;
        state.session_counter
    };
    let name = match options.get("name") {
        Some(n) if is_truthy(n) => n.clone(),
        _ => json!(format!("Claude {counter}")),
    };
    let tmux_name = format!("vibecraft-{}", &uuid_v4()[..8]);

    let cwd_input = match options.get("cwd") {
        Some(c) if is_truthy(c) => match c.as_str() {
            Some(s) => s.to_string(),
            None => return fail("The \"path\" argument must be of type string".into()),
        },
        _ => std::env::current_dir()
            .unwrap_or_default()
            .to_string_lossy()
            .into_owned(),
    };
    let cwd = match validate_directory_path(&cwd_input) {
        Ok(p) => p.to_string_lossy().into_owned(),
        Err(e) => return fail(e.to_string()),
    };

    let flags = options
        .get("flags")
        .filter(|f| is_truthy(f))
        .cloned()
        .unwrap_or(json!({}));
    let mut args = Vec::new();
    if flags.get("continue") != Some(&json!(false)) {
        args.push("-c");
    }
    if flags.get("skipPermissions") != Some(&json!(false)) {
        args.push("--permission-mode=bypassPermissions");
        args.push("--dangerously-skip-permissions");
    }
    if flags.get("chrome").is_some_and(is_truthy) {
        args.push("--chrome");
    }

    let claude = match spawn_claude(&tmux_name, &cwd, &args) {
        Ok(c) => c,
        Err(e) => return fail(format!("Failed to spawn session: {e}")),
    };

    let now = now_ms();
    let session = json!({
        "id": id,
        "name": name,
        "tmuxSession": tmux_name,
        "status": "idle",
        "createdAt": now,
        "lastActivity": now,
        "cwd": cwd,
    });
    println!("[vibecraft] Created session: {name} -> tmux:{tmux_name} cmd:'{claude}'");
    {
        let mut state = lock(shared);
        state.sessions.push(session.clone());
        let project_name = name
            .as_str()
            .map(str::to_string)
            .unwrap_or_else(|| name.to_string());
        state.add_project(&cwd, &project_name);
        state.broadcast_sessions();
        state.save_sessions();
    }
    git::track(shared, &id, &cwd);
    Response::json(201, &json!({ "ok": true, "session": session }))
}

/// /sessions/:id and /sessions/:id/<action>
pub fn route(
    shared: &Shared,
    method: &str,
    id: &str,
    action: Option<&str>,
    body: &Body,
) -> Option<Response> {
    let res = match (method, action) {
        ("GET", None) => {
            let state = lock(shared);
            match state.session_index(id) {
                Some(i) => {
                    Response::json(200, &json!({ "ok": true, "session": state.sessions[i] }))
                }
                None => not_found(),
            }
        }
        ("PATCH", None) => update(shared, id, body),
        ("DELETE", None) => delete(shared, id),
        ("POST", Some("prompt")) => prompt(shared, id, body),
        ("POST", Some("cancel")) => cancel(shared, id),
        ("POST", Some("permission")) => permission(shared, id, body),
        ("POST", Some("restart")) => restart(shared, id),
        ("POST", Some("link")) => link(shared, id, body),
        _ => return None,
    };
    Some(res)
}

fn update(shared: &Shared, id: &str, body: &Body) -> Response {
    // Node parses first (bad JSON is 400 even for unknown sessions), then
    // looks the session up, then reads fields (null throws: 400)
    let body = match parse(body) {
        Err(res) => return res,
        Ok(None) => return invalid_json(),
        Ok(Some(b)) => b,
    };
    let mut state = lock(shared);
    let Some(i) = state.session_index(id) else {
        return not_found();
    };
    if body.is_null() {
        return invalid_json();
    }
    let updates = body;
    if let Some(session) = state.sessions[i].as_object_mut() {
        for key in ["name", "zonePosition"] {
            if let Some(v) = updates.get(key).filter(|v| is_truthy(v)) {
                session.insert(key.into(), v.clone());
            }
        }
    }
    state.broadcast_sessions();
    state.save_sessions();
    Response::json(200, &json!({ "ok": true, "session": state.sessions[i] }))
}

fn delete(shared: &Shared, id: &str) -> Response {
    let tmux_name = {
        let state = lock(shared);
        match state.session_index(id) {
            Some(i) => str_of(&state.sessions[i], "tmuxSession").to_string(),
            None => return not_found(),
        }
    };
    if validate_tmux_session(&tmux_name).is_err() {
        return not_found();
    }
    let _ = tmux(&["kill-session", "-t", &tmux_name]);

    let mut state = lock(shared);
    let Some(i) = state.session_index(id) else {
        return not_found();
    };
    state.sessions.remove(i);
    state.git_dirs.retain(|(s, _)| s != id);
    state.git_cache.remove(id);
    state.git_dirty.remove(id);
    state.unlink_managed(id);
    state.broadcast_sessions();
    state.save_sessions();
    Response::json(200, &json!({ "ok": true }))
}

fn prompt(shared: &Shared, id: &str, body: &Body) -> Response {
    let prompt = match parse(body) {
        Err(res) => return res,
        Ok(Some(Value::Null)) | Ok(None) => return invalid_json(),
        Ok(Some(b)) => b.get("prompt").cloned().unwrap_or(Value::Null),
    };
    if !is_truthy(&prompt) {
        return Response::json(400, &json!({ "ok": false, "error": "Prompt is required" }));
    }
    let tmux_name = {
        let state = lock(shared);
        match state.session_index(id) {
            Some(i) => str_of(&state.sessions[i], "tmuxSession").to_string(),
            None => return not_found(),
        }
    };
    let text = match &prompt {
        Value::String(s) => s.clone(),
        other => other.to_string(),
    };
    match send_to_tmux(&tmux_name, &text) {
        Ok(()) => {
            let mut state = lock(shared);
            if let Some(i) = state.session_index(id) {
                state.sessions[i]["lastActivity"] = json!(now_ms());
            }
            Response::json(200, &json!({ "ok": true }))
        }
        // The Node server answers every failure here with 404
        Err(e) => Response::json(404, &json!({ "ok": false, "error": e })),
    }
}

fn session_tmux(shared: &Shared, id: &str) -> Result<String, Response> {
    let state = lock(shared);
    let i = state.session_index(id).ok_or_else(not_found)?;
    let name = str_of(&state.sessions[i], "tmuxSession").to_string();
    validate_tmux_session(&name).map_err(|_| {
        Response::json(
            400,
            &json!({ "ok": false, "error": "Invalid tmux session name" }),
        )
    })?;
    Ok(name)
}

fn cancel(shared: &Shared, id: &str) -> Response {
    let tmux_name = match session_tmux(shared, id) {
        Ok(n) => n,
        Err(res) => return res,
    };
    match tmux(&["send-keys", "-t", &tmux_name, "C-c"]) {
        Ok(_) => Response::json(200, &json!({ "ok": true })),
        Err(e) => Response::json(200, &json!({ "ok": false, "error": e })),
    }
}

fn permission(shared: &Shared, id: &str, body: &Body) -> Response {
    if lock(shared).session_index(id).is_none() {
        return not_found();
    }
    let response = match parse(body) {
        Err(res) => return res,
        Ok(Some(Value::Null)) | Ok(None) => return invalid_json(),
        Ok(Some(b)) => b.get("response").cloned().unwrap_or(Value::Null),
    };
    if !is_truthy(&response) {
        return Response::json(
            400,
            &json!({ "ok": false, "error": "Missing response field" }),
        );
    }
    let option = match &response {
        Value::String(s) => s.clone(),
        other => other.to_string(),
    };
    send_permission_response(shared, id, &option);
    Response::json(200, &json!({ "ok": true }))
}

/// Type an option number into a permission prompt; false if not sent
pub fn send_permission_response(shared: &Shared, id: &str, option: &str) -> bool {
    if option.is_empty() || !option.bytes().all(|b| b.is_ascii_digit()) {
        return false;
    }
    let tmux_name = {
        let state = lock(shared);
        let Some(i) = state.session_index(id) else {
            return false;
        };
        str_of(&state.sessions[i], "tmuxSession").to_string()
    };
    if validate_tmux_session(&tmux_name).is_err()
        || tmux(&["send-keys", "-t", &tmux_name, option]).is_err()
    {
        return false;
    }
    let mut state = lock(shared);
    state.pending_permissions.remove(id);
    if let Some(session) = state
        .session_index(id)
        .and_then(|i| state.sessions[i].as_object_mut())
    {
        session.insert("status".into(), json!("working"));
        session.remove("currentTool");
    }
    state.broadcast_sessions();
    true
}

fn restart(shared: &Shared, id: &str) -> Response {
    let tmux_name = match session_tmux(shared, id) {
        Ok(n) => n,
        Err(res) => return res,
    };
    let cwd_input = {
        let state = lock(shared);
        let i = match state.session_index(id) {
            Some(i) => i,
            None => return not_found(),
        };
        match state.sessions[i]
            .get("cwd")
            .and_then(Value::as_str)
            .filter(|c| !c.is_empty())
        {
            Some(c) => c.to_string(),
            None => std::env::current_dir()
                .unwrap_or_default()
                .to_string_lossy()
                .into_owned(),
        }
    };
    let cwd = match validate_directory_path(&cwd_input) {
        Ok(p) => p.to_string_lossy().into_owned(),
        Err(e) => {
            return Response::json(
                400,
                &json!({ "ok": false, "error": format!("Invalid directory: {e}") }),
            );
        }
    };

    let _ = tmux(&["kill-session", "-t", &tmux_name]);
    let args = [
        "-c",
        "--permission-mode=bypassPermissions",
        "--dangerously-skip-permissions",
    ];
    if let Err(e) = spawn_claude(&tmux_name, &cwd, &args) {
        return Response::json(
            500,
            &json!({ "ok": false, "error": format!("Failed to restart: {e}") }),
        );
    }

    let mut state = lock(shared);
    let Some(i) = state.session_index(id) else {
        return not_found();
    };
    if let Some(session) = state.sessions[i].as_object_mut() {
        session.insert("status".into(), json!("idle"));
        session.insert("lastActivity".into(), json!(now_ms()));
        session.remove("claudeSessionId");
        session.remove("currentTool");
    }
    state.unlink_managed(id);
    state.broadcast_sessions();
    state.save_sessions();
    Response::json(200, &json!({ "ok": true, "session": state.sessions[i] }))
}

fn link(shared: &Shared, id: &str, body: &Body) -> Response {
    let claude_id = match parse(body) {
        Err(res) => return res,
        Ok(Some(Value::Null)) | Ok(None) => return invalid_json(),
        Ok(Some(b)) => b.get("claudeSessionId").cloned().unwrap_or(Value::Null),
    };
    if !is_truthy(&claude_id) {
        return Response::json(
            400,
            &json!({ "ok": false, "error": "claudeSessionId is required" }),
        );
    }
    let mut state = lock(shared);
    let Some(i) = state.session_index(id) else {
        return not_found();
    };
    let key = match &claude_id {
        Value::String(s) => s.clone(),
        other => other.to_string(),
    };
    state.link(&key, id);
    state.sessions[i]["claudeSessionId"] = claude_id;
    state.broadcast_sessions();
    state.save_sessions();
    Response::json(200, &json!({ "ok": true, "session": state.sessions[i] }))
}

/// Mark sessions whose tmux session is gone as offline, and revive live ones
pub fn check_health(shared: &Shared) {
    let alive = tmux(&["list-sessions", "-F", "#{session_name}"]);
    let mut state = lock(shared);
    let Ok(alive) = alive else {
        // No tmux server: everything is offline (the Node server doesn't broadcast this)
        for session in &mut state.sessions {
            session["status"] = json!("offline");
        }
        return;
    };
    let alive: Vec<&str> = alive.trim().split('\n').collect();
    let mut changed = false;
    for session in &mut state.sessions {
        let status = session["status"].clone();
        let new_status = if alive.contains(&str_of(session, "tmuxSession")) {
            if status == "offline" {
                json!("idle")
            } else {
                status.clone()
            }
        } else {
            json!("offline")
        };
        if new_status != status {
            session["status"] = new_status;
            changed = true;
        }
    }
    if changed {
        state.broadcast_sessions();
        state.save_sessions();
    }
}

/// Failsafe for missed stop events
fn check_working_timeout(state: &mut State) {
    let now = now_ms();
    let mut changed = false;
    for session in &mut state.sessions {
        let last = session
            .get("lastActivity")
            .and_then(Value::as_u64)
            .unwrap_or(now);
        if session["status"] == "working" && now.saturating_sub(last) > WORKING_TIMEOUT_MS {
            if let Some(obj) = session.as_object_mut() {
                obj.insert("status".into(), json!("idle"));
                obj.remove("currentTool");
            }
            changed = true;
        }
    }
    if changed {
        state.broadcast_sessions();
        state.save_sessions();
    }
}

/// Last 50 lines of a pane, and whether its tail changed since the last capture
fn capture(shared: &Shared, tmux_name: &str) -> Option<(String, bool)> {
    validate_tmux_session(tmux_name).ok()?;
    let output = tmux(&["capture-pane", "-t", tmux_name, "-p", "-S", "-50"]).ok()?;
    let tail: String = {
        let chars: Vec<char> = output.chars().collect();
        chars[chars.len().saturating_sub(500)..].iter().collect()
    };
    let mut state = lock(shared);
    let changed = state.last_pane_tail.get(tmux_name) != Some(&tail);
    state.last_pane_tail.insert(tmux_name.to_string(), tail);
    Some((output, changed))
}

fn handle_tokens(state: &mut State, tmux_name: &str, output: &str) {
    let Some(tokens) = parse_tokens_from_output(output) else {
        return;
    };
    let index = match state.tokens.iter().position(|(name, _)| name == tmux_name) {
        Some(i) => i,
        None => {
            state.tokens.push((
                tmux_name.to_string(),
                TokenCount {
                    last_seen: 0,
                    cumulative: 0,
                },
            ));
            state.tokens.len() - 1
        }
    };
    let count = &mut state.tokens[index].1;
    if tokens > count.last_seen {
        count.cumulative += tokens - count.last_seen;
        count.last_seen = tokens;
        let message = json!({
            "type": "tokens",
            "payload": { "session": tmux_name, "current": tokens, "cumulative": count.cumulative },
        });
        state.broadcast(&message);
    } else if tokens < count.last_seen && tokens > 0 {
        // Dropped: likely a new conversation
        count.last_seen = tokens;
    }
}

/// Returns true when the bypass warning must be accepted (by typing "2")
fn handle_permission(state: &mut State, id: &str, output: &str) -> bool {
    if detect_bypass_warning(output) && !state.bypass_handled.contains(id) {
        state.bypass_handled.insert(id.to_string());
        return true;
    }
    let prompt = detect_permission_prompt(output);
    let existing = state.pending_permissions.contains(id);
    match prompt {
        Some(prompt) if !existing => {
            state.pending_permissions.insert(id.to_string());
            let options: Vec<Value> = prompt
                .options
                .iter()
                .map(|o| json!({ "number": o.number, "label": o.label }))
                .collect();
            state.broadcast(&json!({
                "type": "permission_prompt",
                "payload": { "sessionId": id, "tool": prompt.tool, "context": prompt.context, "options": options },
            }));
            if let Some(session) = state
                .session_index(id)
                .and_then(|i| state.sessions[i].as_object_mut())
            {
                session.insert("status".into(), json!("waiting"));
                session.insert("currentTool".into(), json!(prompt.tool));
                state.broadcast_sessions();
            }
        }
        None if existing => {
            // Answered elsewhere (e.g. in the terminal)
            state.pending_permissions.remove(id);
            state.broadcast(
                &json!({ "type": "permission_resolved", "payload": { "sessionId": id } }),
            );
            if let Some(session) = state
                .session_index(id)
                .and_then(|i| state.sessions[i].as_object_mut())
                && session.get("status") == Some(&json!("waiting"))
            {
                session.insert("status".into(), json!("working"));
                session.remove("currentTool");
                state.broadcast_sessions();
            }
        }
        _ => {}
    }
    false
}

/// Poll panes for permission prompts and token counts; busy sessions every
/// second, idle ones every 5 s, and the default session when none is managed
fn poll_loop(shared: &Shared) {
    let mut tick: u64 = 0;
    loop {
        thread::sleep(POLL_INTERVAL);
        tick += 1;
        let (targets, default_session): (Vec<(String, String)>, Option<String>) = {
            let state = lock(shared);
            let targets = state
                .sessions
                .iter()
                .filter(|s| s["status"] != "offline")
                .filter(|s| s["status"] != "idle" || tick.is_multiple_of(IDLE_POLL_EVERY))
                .map(|s| {
                    (
                        str_of(s, "id").to_string(),
                        str_of(s, "tmuxSession").to_string(),
                    )
                })
                .collect();
            let default = (state.sessions.is_empty() && tick.is_multiple_of(2))
                .then(|| state.config.tmux_session.clone());
            (targets, default)
        };
        for (id, tmux_name) in targets {
            let Some((output, changed)) = capture(shared, &tmux_name) else {
                continue;
            };
            let accept_bypass = {
                let mut state = lock(shared);
                let accept = handle_permission(&mut state, &id, &output);
                if changed && !accept {
                    handle_tokens(&mut state, &tmux_name, &output);
                }
                accept
            };
            if accept_bypass {
                let _ = tmux(&["send-keys", "-t", &tmux_name, "2"]);
            }
        }
        if let Some(name) = default_session
            && let Some((output, true)) = capture(shared, &name)
        {
            handle_tokens(&mut lock(shared), &name, &output);
        }
    }
}

/// Start the background loops: pane polling, health checks, working timeout
pub fn start(shared: &Shared) {
    let s = shared.clone();
    thread::spawn(move || poll_loop(&s));
    let s = shared.clone();
    thread::spawn(move || {
        loop {
            check_health(&s);
            thread::sleep(HEALTH_INTERVAL);
        }
    });
    let s = shared.clone();
    thread::spawn(move || {
        loop {
            thread::sleep(WORKING_CHECK_INTERVAL);
            check_working_timeout(&mut lock(&s));
        }
    });
    let s = shared.clone();
    thread::spawn(move || git::poll_loop(&s));
}

/// Parse `/sessions/:id[/action]` like the JS regex `^\/sessions\/([a-f0-9-]+)(?:\/(.+))?$`
pub fn parse_path(url: &str) -> Option<(&str, Option<&str>)> {
    let rest = url.strip_prefix("/sessions/")?;
    let id_len = rest
        .find(|c: char| !(c.is_ascii_digit() || ('a'..='f').contains(&c) || c == '-'))
        .unwrap_or(rest.len());
    if id_len == 0 {
        return None;
    }
    let (id, tail) = rest.split_at(id_len);
    match tail {
        "" => Some((id, None)),
        // (.+) can't contain line terminators; request targets never do
        t => t
            .strip_prefix('/')
            .filter(|a| !a.is_empty())
            .map(|a| (id, Some(a))),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn session_paths() {
        assert_eq!(parse_path("/sessions/abc-12"), Some(("abc-12", None)));
        assert_eq!(
            parse_path("/sessions/abc/prompt"),
            Some(("abc", Some("prompt")))
        );
        assert_eq!(parse_path("/sessions/abc/a/b"), Some(("abc", Some("a/b"))));
        assert_eq!(parse_path("/sessions/abc/"), None);
        assert_eq!(parse_path("/sessions/ABC"), None);
        assert_eq!(parse_path("/sessions/abc?x=1"), None);
        assert_eq!(parse_path("/sessions/refresh"), None);
    }
}
