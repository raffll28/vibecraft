//! HTTP routes: events from the hook, health, and the built frontend. URLs
//! match exactly, query strings included. No CORS: the only browser client
//! is the page this server serves.

use std::fs;
use std::path::Path;
use std::time::{SystemTime, UNIX_EPOCH};

use serde_json::{Value, json};
use vibecraft_core::validation::{is_origin_allowed, resolve};

use crate::http::{Body, Request, Response};
use crate::state::{Config, Shared, lock};

pub fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
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

pub fn handle(req: &Request, shared: &Shared, config: &Config) -> Response {
    // CSRF: other sites can still send requests here (forms, no-cors fetch),
    // and browsers mark them with their Origin. The hook sends none.
    if let Some(origin) = req.header("origin")
        && !is_origin_allowed(Some(origin))
    {
        return error(403, "Origin not allowed");
    }
    match (req.method.as_str(), req.url.as_str()) {
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
        (_, url) => static_file(url, config),
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
}
