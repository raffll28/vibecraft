//! HTTP routes: events from the hook, text tiles, config for the HUD, health,
//! and the built frontend. URLs match exactly, query strings included.

use std::fs;
use std::path::Path;
use std::time::{SystemTime, UNIX_EPOCH};

use serde_json::{Map, Value, json};
use vibecraft_core::validation::{is_origin_allowed, resolve};

use crate::http::{Body, Request, Response};
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
                    "version": env!("CARGO_PKG_VERSION"),
                    "clients": state.clients.len(),
                    "events": state.events.len(),
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
                &json!({ "username": username, "hostname": hostname() }),
            )
        }
        ("GET", "/tiles") => {
            let state = lock(shared);
            Response::json(200, &json!({ "ok": true, "tiles": state.tiles }))
        }
        ("POST", "/tiles") => post_tile(req, shared, config),
        _ => {
            // /tiles/:id (the id ends at the next '/' or '?')
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

fn is_truthy(v: &Value) -> bool {
    match v {
        Value::Null => false,
        Value::Bool(b) => *b,
        Value::Number(n) => n.as_f64().is_some_and(|f| f != 0.0),
        Value::String(s) => !s.is_empty(),
        _ => true,
    }
}

fn random_bytes<const N: usize>() -> [u8; N] {
    let mut buf = [0u8; N];
    if let Ok(mut f) = fs::File::open("/dev/urandom") {
        let _ = std::io::Read::read_exact(&mut f, &mut buf);
    }
    buf
}

/// RFC 4122 version 4 UUID, like crypto.randomUUID()
fn uuid_v4() -> String {
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
    fn uuid_shape() {
        let id = uuid_v4();
        assert_eq!(id.len(), 36);
        assert_eq!(&id[14..15], "4");
        assert!("89ab".contains(&id[19..20]));
    }
}
