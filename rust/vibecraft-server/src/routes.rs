//! HTTP routes. Mirrors handleHttpRequest in server/index.ts: the same exact
//! URL matching (query strings included), status codes and messages.

use std::fs;
use std::path::Path;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde_json::{Map, Value, json};
use vibecraft_core::validation::{is_origin_allowed, resolve, validate_tmux_session};

use crate::http::{Body, Request, Response};
use crate::sessions;
use crate::state::{Config, Shared, lock, save_json};

pub fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

pub fn handle(req: &Request, shared: &Shared, config: &Config) -> Response {
    let origin = req.header("origin");
    let mut res = route(req, shared, config);
    if let Some(origin) = origin.filter(|o| is_origin_allowed(Some(o))) {
        res.headers
            .push(("Access-Control-Allow-Origin", origin.to_string()));
        res.headers.push((
            "Access-Control-Allow-Methods",
            "GET, POST, PATCH, DELETE, OPTIONS".to_string(),
        ));
        res.headers
            .push(("Access-Control-Allow-Headers", "Content-Type".to_string()));
    }
    res
}

fn error(status: u16, message: &str) -> Response {
    Response::json(status, &json!({ "error": message }))
}

fn too_large() -> Response {
    error(413, "Request body too large")
}

/// The body parsed as JSON, or the response to send instead
fn json_body(req: &Request) -> Result<Option<Value>, Response> {
    match &req.body {
        Body::TooLarge => Err(too_large()),
        Body::Bytes(bytes) => Ok(serde_json::from_slice(bytes).ok()),
    }
}

fn route(req: &Request, shared: &Shared, config: &Config) -> Response {
    let method = req.method.as_str();
    let url = req.url.as_str();

    if method == "OPTIONS" {
        let allowed = req
            .header("origin")
            .is_some_and(|o| is_origin_allowed(Some(o)));
        return Response::empty(if allowed { 204 } else { 403 });
    }

    match (method, url) {
        ("POST", "/event") => post_event(req, shared),
        ("GET", "/health") => {
            let state = lock(shared);
            Response::json(
                200,
                &json!({
                    "ok": true,
                    // The compiled Node server reports "unknown" too; a real version
                    // would turn on the client's update check against upstream
                    "version": "unknown",
                    "clients": state.clients.len(),
                    "events": state.events.len(),
                    "voiceEnabled": false,
                }),
            )
        }
        ("GET", "/config") => {
            let username = ["USER", "USERNAME"]
                .iter()
                .filter_map(|k| std::env::var(k).ok())
                .find(|v| !v.is_empty())
                .unwrap_or_else(|| "claude-user".to_string());
            Response::json(
                200,
                &json!({
                    "username": username,
                    "hostname": hostname(),
                    "tmuxSession": config.tmux_session,
                }),
            )
        }
        ("GET", "/stats") => stats(shared),
        ("POST", "/prompt") => post_prompt(req, config),
        ("GET", "/prompt") => match fs::read_to_string(&config.prompt_file) {
            Ok(prompt) => Response::json(
                200,
                &json!({ "prompt": prompt, "file": config.prompt_file }),
            ),
            Err(_) => Response::json(200, &json!({ "prompt": null })),
        },
        ("DELETE", "/prompt") => {
            let _ = fs::remove_file(&config.prompt_file);
            Response::json(200, &json!({ "ok": true }))
        }
        ("GET", "/info") => {
            let cwd = std::env::current_dir().unwrap_or_default();
            Response::json(200, &json!({ "ok": true, "cwd": cwd }))
        }
        ("GET", "/sessions") => {
            let state = lock(shared);
            Response::json(
                200,
                &json!({ "ok": true, "sessions": state.sessions_payload() }),
            )
        }
        ("POST", "/sessions/refresh") => {
            // The health check runs in the background; answer with what's known now
            let s = shared.clone();
            std::thread::spawn(move || sessions::check_health(&s));
            let state = lock(shared);
            Response::json(
                200,
                &json!({ "ok": true, "sessions": state.sessions_payload() }),
            )
        }
        ("POST", "/sessions") => sessions::create(shared, &req.body),
        ("GET", "/projects") => {
            let state = lock(shared);
            Response::json(
                200,
                &json!({ "ok": true, "projects": state.projects_sorted() }),
            )
        }
        ("GET", "/tiles") => {
            let state = lock(shared);
            Response::json(200, &json!({ "ok": true, "tiles": state.tiles }))
        }
        ("POST", "/tiles") => post_tile(req, shared, config),
        _ if method == "GET" && url.starts_with("/projects/autocomplete") => {
            let query = query_param(url, "q").unwrap_or_default();
            let results = lock(shared).autocomplete(&query);
            Response::json(200, &json!({ "ok": true, "results": results }))
        }
        _ if method == "DELETE" && url.starts_with("/projects/") => {
            match decode_uri_component(&url["/projects/".len()..]) {
                Some(path) => {
                    lock(shared).remove_project(&path);
                    Response::json(200, &json!({ "ok": true }))
                }
                None => Response::json(400, &json!({ "ok": false, "error": "Invalid path" })),
            }
        }
        _ => {
            if let Some((id, action)) = sessions::parse_path(url)
                && let Some(res) = sessions::route(shared, method, id, action, &req.body)
            {
                return res;
            }
            // JS: /^\/tiles\/([^/?]+)/
            if let Some(id) = url
                .strip_prefix("/tiles/")
                .map(|rest| rest.split(['/', '?']).next().unwrap_or(""))
                && !id.is_empty()
                && (method == "PUT" || method == "DELETE")
            {
                return tile_by_id(req, id, shared, config);
            }
            static_file(url, config)
        }
    }
}

fn post_event(req: &Request, shared: &Shared) -> Response {
    let event = match json_body(req) {
        Err(res) => return res,
        Ok(Some(event @ Value::Object(_))) => event,
        Ok(_) => return error(400, "Invalid JSON"),
    };
    lock(shared).add_event(event);
    Response::json(200, &json!({ "ok": true }))
}

fn stats(shared: &Shared) -> Response {
    let state = lock(shared);
    let mut counts: Map<String, Value> = Map::new();
    let mut durations: Vec<(String, f64, u64)> = Vec::new();
    for event in state.events.events() {
        if event.get("type").and_then(Value::as_str) != Some("post_tool_use") {
            continue;
        }
        let tool = match event.get("tool") {
            Some(Value::String(s)) => s.clone(),
            Some(other) => other.to_string(),
            None => "undefined".to_string(),
        };
        let count = counts.get(&tool).and_then(Value::as_u64).unwrap_or(0);
        counts.insert(tool.clone(), json!(count + 1));
        if let Some(d) = event.get("duration").and_then(Value::as_f64) {
            match durations.iter_mut().find(|(t, _, _)| *t == tool) {
                Some((_, sum, n)) => {
                    *sum += d;
                    *n += 1;
                }
                None => durations.push((tool, d, 1)),
            }
        }
    }
    let mut avg: Map<String, Value> = Map::new();
    for (tool, sum, n) in durations {
        // Math.round
        avg.insert(tool, json!((sum / n as f64 + 0.5).floor() as i64));
    }
    Response::json(
        200,
        &json!({
            "totalEvents": state.events.len(),
            "toolCounts": counts,
            "avgDurations": avg,
            "tokens": state.tokens.iter()
                .map(|(name, t)| (name.clone(), json!({ "current": t.last_seen, "cumulative": t.cumulative })))
                .collect::<Map<String, Value>>(),
        }),
    )
}

fn post_prompt(req: &Request, config: &Config) -> Response {
    let data = match json_body(req) {
        Err(res) => return res,
        Ok(Some(data @ Value::Object(_))) => data,
        // Destructuring null/undefined throws in JS, reported as invalid JSON
        Ok(Some(Value::Null)) | Ok(None) => return error(400, "Invalid JSON"),
        Ok(Some(_)) => Value::Object(Map::new()),
    };
    let Some(prompt) = data
        .get("prompt")
        .and_then(Value::as_str)
        .filter(|p| !p.is_empty())
    else {
        return error(400, "Prompt is required");
    };

    if let Some(dir) = config.prompt_file.parent() {
        let _ = fs::create_dir_all(dir);
    }
    if fs::write(&config.prompt_file, prompt).is_err() {
        return error(400, "Invalid JSON");
    }

    let send = data.get("send").is_some_and(is_truthy);
    if !send {
        return Response::json(200, &json!({ "ok": true, "saved": config.prompt_file }));
    }
    match send_to_tmux(&config.tmux_session, prompt) {
        Ok(()) => Response::json(
            200,
            &json!({ "ok": true, "saved": config.prompt_file, "sent": true }),
        ),
        Err(message) => Response::json(
            200,
            &json!({ "ok": true, "saved": config.prompt_file, "sent": false, "tmuxError": message }),
        ),
    }
}

pub fn is_truthy(v: &Value) -> bool {
    match v {
        Value::Null => false,
        Value::Bool(b) => *b,
        Value::Number(n) => n.as_f64().is_some_and(|f| f != 0.0),
        Value::String(s) => !s.is_empty(),
        _ => true,
    }
}

/// PATH with the usual user/Homebrew locations, like EXEC_OPTIONS in Node
pub fn exec_path() -> String {
    let home = std::env::var("HOME").unwrap_or_default();
    let path = std::env::var("PATH").unwrap_or_default();
    format!("{home}/.local/bin:/opt/homebrew/bin:/usr/local/bin:{path}")
}

/// Paste text into a tmux session via a buffer (never through a shell)
pub fn send_to_tmux(session: &str, text: &str) -> Result<(), String> {
    validate_tmux_session(session).map_err(|e| e.to_string())?;
    let temp = std::env::temp_dir().join(format!(
        "vibecraft-prompt-{}-{}.txt",
        now_ms(),
        random_hex(16)
    ));
    fs::write(&temp, text).map_err(|e| e.to_string())?;
    let temp_str = temp.to_string_lossy().to_string();
    let result = (|| {
        sessions::tmux(&["load-buffer", &temp_str])?;
        sessions::tmux(&["paste-buffer", "-t", session])?;
        std::thread::sleep(Duration::from_millis(100));
        sessions::tmux(&["send-keys", "-t", session, "Enter"]).map(|_| ())
    })();
    let _ = fs::remove_file(&temp);
    result
}

pub fn random_bytes<const N: usize>() -> [u8; N] {
    let mut buf = [0u8; N];
    if let Ok(mut f) = fs::File::open("/dev/urandom") {
        let _ = std::io::Read::read_exact(&mut f, &mut buf);
    }
    buf
}

fn random_hex(len: usize) -> String {
    random_bytes::<32>()[..len]
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect()
}

/// RFC 4122 version 4 UUID, like crypto.randomUUID()
pub fn uuid_v4() -> String {
    let mut b = random_bytes::<16>();
    b[6] = (b[6] & 0x0f) | 0x40;
    b[8] = (b[8] & 0x3f) | 0x80;
    let h: String = b.iter().map(|x| format!("{x:02x}")).collect();
    format!(
        "{}-{}-{}-{}-{}",
        &h[0..8],
        &h[8..12],
        &h[12..16],
        &h[16..20],
        &h[20..32]
    )
}

fn hostname() -> String {
    fs::read_to_string("/proc/sys/kernel/hostname")
        .map(|h| h.trim().to_string())
        .unwrap_or_default()
}

fn post_tile(req: &Request, shared: &Shared, config: &Config) -> Response {
    let invalid = || Response::json(400, &json!({ "ok": false, "error": "Invalid JSON" }));
    let data = match json_body(req) {
        Err(res) => return res,
        Ok(None) | Ok(Some(Value::Null)) => return invalid(),
        Ok(Some(data)) => data,
    };
    let text = data.get("text").cloned().unwrap_or(Value::Null);
    let position = data.get("position").cloned().unwrap_or(Value::Null);
    if !is_truthy(&text) || !is_truthy(&position) {
        return Response::json(
            400,
            &json!({ "ok": false, "error": "Missing text or position" }),
        );
    }

    let mut tile = Map::new();
    tile.insert("id".into(), json!(uuid_v4()));
    tile.insert("text".into(), text);
    tile.insert("position".into(), position);
    if let Some(color) = data.get("color") {
        tile.insert("color".into(), color.clone());
    }
    tile.insert("createdAt".into(), json!(now_ms()));
    let tile = Value::Object(tile);

    let mut state = lock(shared);
    state.tiles.push(tile.clone());
    save_json(&config.tiles_file, &Value::Array(state.tiles.clone()));
    let message = state.tiles_message();
    state.broadcast(&message);
    Response::json(201, &json!({ "ok": true, "tile": tile }))
}

fn tile_by_id(req: &Request, id: &str, shared: &Shared, config: &Config) -> Response {
    let mut state = lock(shared);
    let Some(index) = state
        .tiles
        .iter()
        .position(|t| t.get("id").and_then(Value::as_str) == Some(id))
    else {
        return Response::json(404, &json!({ "ok": false, "error": "Tile not found" }));
    };

    if req.method == "DELETE" {
        state.tiles.remove(index);
    } else {
        let data = match json_body(req) {
            Err(res) => return res,
            Ok(None) | Ok(Some(Value::Null)) => {
                return Response::json(400, &json!({ "ok": false, "error": "Invalid JSON" }));
            }
            Ok(Some(data)) => data,
        };
        if let Some(tile) = state.tiles[index].as_object_mut() {
            for key in ["text", "position", "color"] {
                if let Some(value) = data.get(key) {
                    tile.insert(key.to_string(), value.clone());
                }
            }
        }
    }

    save_json(&config.tiles_file, &Value::Array(state.tiles.clone()));
    let message = state.tiles_message();
    state.broadcast(&message);
    if req.method == "DELETE" {
        Response::json(200, &json!({ "ok": true }))
    } else {
        Response::json(200, &json!({ "ok": true, "tile": state.tiles[index] }))
    }
}

/// URLSearchParams.get: the first value for `name` in the query string
/// ('+' is a space; malformed escapes stay as they are)
fn query_param(url: &str, name: &str) -> Option<String> {
    let decode = |s: &str| {
        let bytes = s.as_bytes();
        let mut out = Vec::with_capacity(bytes.len());
        let mut i = 0;
        while i < bytes.len() {
            let escaped = (bytes[i] == b'%')
                .then(|| {
                    s.get(i + 1..i + 3)
                        .and_then(|h| u8::from_str_radix(h, 16).ok())
                })
                .flatten();
            match (bytes[i], escaped) {
                (_, Some(byte)) => {
                    out.push(byte);
                    i += 3;
                }
                (b'+', None) => {
                    out.push(b' ');
                    i += 1;
                }
                (b, None) => {
                    out.push(b);
                    i += 1;
                }
            }
        }
        String::from_utf8_lossy(&out).into_owned()
    };
    let query = url.split_once('?')?.1;
    query.split('&').find_map(|pair| {
        let (key, value) = pair.split_once('=').unwrap_or((pair, ""));
        (decode(key) == name).then(|| decode(value))
    })
}

/// decodeURIComponent: strict %XX decoding into valid UTF-8
fn decode_uri_component(s: &str) -> Option<String> {
    let bytes = s.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' {
            let hex = s.get(i + 1..i + 3)?;
            out.push(u8::from_str_radix(hex, 16).ok()?);
            i += 3;
        } else {
            out.push(bytes[i]);
            i += 1;
        }
    }
    String::from_utf8(out).ok()
}

fn mime_type(path: &Path) -> &'static str {
    match path
        .extension()
        .and_then(|e| e.to_str())
        .map(str::to_ascii_lowercase)
        .as_deref()
    {
        Some("html") => "text/html",
        Some("js") => "application/javascript",
        Some("css") => "text/css",
        Some("json") => "application/json",
        Some("svg") => "image/svg+xml",
        Some("png") => "image/png",
        Some("ico") => "image/x-icon",
        _ => "application/octet-stream",
    }
}

fn static_file(url: &str, config: &Config) -> Response {
    let dist = &config.dist_dir;
    let mut path = url.split('?').next().unwrap_or("/");
    if path == "/" {
        path = "/index.html";
    }
    let Some(decoded) = decode_uri_component(path) else {
        return Response::new(400, None, "Bad request");
    };

    let file = resolve(&format!("{}/.{decoded}", dist.display()));
    if !file.starts_with(dist) {
        return Response::new(403, None, "Forbidden");
    }

    if file.is_file()
        && let Ok(content) = fs::read(&file)
    {
        return Response::new(200, Some(mime_type(&file)), content);
    }

    // SPA fallback for non-API routes
    let index = dist.join("index.html");
    if !decoded.starts_with("/api")
        && let Ok(content) = fs::read(&index)
    {
        return Response::new(200, Some("text/html"), content);
    }
    Response::new(404, None, "Not found")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn decodes_like_decode_uri_component() {
        assert_eq!(decode_uri_component("/a%20b"), Some("/a b".into()));
        assert_eq!(decode_uri_component("/%2e%2e/x"), Some("/../x".into()));
        assert_eq!(decode_uri_component("/%C3%A7"), Some("/ç".into()));
        assert_eq!(decode_uri_component("/%E0%A4%A"), None);
        assert_eq!(decode_uri_component("/%C3"), None);
        assert_eq!(decode_uri_component("/%zz"), None);
    }

    #[test]
    fn query_params_like_url_search_params() {
        assert_eq!(query_param("/p?q=~%2Fcode%2F", "q"), Some("~/code/".into()));
        assert_eq!(query_param("/p?a=1&q=a+b", "q"), Some("a b".into()));
        assert_eq!(query_param("/p?q=%zz%4", "q"), Some("%zz%4".into()));
        assert_eq!(query_param("/p?q", "q"), Some("".into()));
        assert_eq!(query_param("/p?x=1", "q"), None);
        assert_eq!(query_param("/p", "q"), None);
    }

    #[test]
    fn uuid_shape() {
        let id = uuid_v4();
        assert_eq!(id.len(), 36);
        assert_eq!(&id[14..15], "4");
        assert!("89ab".contains(&id[19..20]));
    }
}
