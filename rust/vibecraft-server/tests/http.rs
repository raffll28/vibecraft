//! Server contract: HTTP endpoints (health, browser checks, static files).

use std::fs;
use std::path::PathBuf;

use vibecraft_testkit::{ALLOWED_ORIGIN, TestEnv, TestServer, make_event};

const SERVER: &str = env!("CARGO_BIN_EXE_vibecraft-server");

const INDEX_HTML: &str = "<!doctype html><title>test</title>\n";

#[test]
fn health() {
    let env = TestEnv::new();
    let server = TestServer::start(SERVER, &env, &[]);
    let (status, body) = server.get_json("/health");
    assert_eq!(status, 200);
    let mut keys: Vec<&String> = body.as_object().unwrap().keys().collect();
    keys.sort();
    assert_eq!(keys, ["clients", "events", "ok", "version"]);
    assert_eq!(body["ok"], true);
    assert!(body["version"].is_string());
}

#[test]
fn no_cors_and_no_config_endpoint() {
    // Only the page this server serves talks to it: no other site may read it
    let env = TestEnv::new();
    let server = TestServer::start(SERVER, &env, &[]);
    let res = server.request("GET", "/health", None, &[("Origin", ALLOWED_ORIGIN)]);
    assert!(
        res.headers
            .iter()
            .all(|(k, _)| !k.starts_with("access-control-"))
    );
    let preflight = server.request(
        "OPTIONS",
        "/event",
        None,
        &[("Origin", "http://evil.example")],
    );
    assert!(preflight.header("access-control-allow-origin").is_none());
    assert_ne!(
        server
            .request("GET", "/config", None, &[])
            .header("content-type"),
        Some("application/json")
    );
}

// ============================================================================
// Browser checks: other sites can send requests to localhost too
// ============================================================================

#[test]
fn refuses_hosts_other_than_localhost() {
    // DNS rebinding: a site's own domain pointed at 127.0.0.1
    let env = TestEnv::new();
    let server = TestServer::start(SERVER, &env, &[]);
    let event = serde_json::to_vec(&make_event(serde_json::json!({}))).unwrap();
    for host in ["evil.example", "evil.example:4003", "192.168.0.17:4003"] {
        let get = server.request("GET", "/health", None, &[("Host", host)]);
        assert_eq!(get.status, 403, "GET with Host {host}");
        let post = server.request("POST", "/event", Some(&event), &[("Host", host)]);
        assert_eq!(post.status, 403, "POST with Host {host}");
        let upgrade = server.request(
            "GET",
            "/",
            None,
            &[
                ("Host", host),
                ("Origin", ALLOWED_ORIGIN),
                ("Upgrade", "websocket"),
                ("Connection", "Upgrade"),
                ("Sec-WebSocket-Key", "dGhlIHNhbXBsZSBub25jZQ=="),
                ("Sec-WebSocket-Version", "13"),
            ],
        );
        assert_eq!(upgrade.status, 403, "WebSocket with Host {host}");
    }
    for host in ["localhost", &format!("localhost:{}", server.port)] {
        let res = server.request("GET", "/health", None, &[("Host", host)]);
        assert_eq!(res.status, 200, "Host {host}");
    }
    assert_eq!(server.health()["events"], 0);
}

#[test]
fn refuses_requests_from_other_sites() {
    // CSRF: a page elsewhere posting fake events (text/plain needs no preflight)
    let env = TestEnv::new();
    let server = TestServer::start(SERVER, &env, &[]);
    let event = serde_json::to_vec(&make_event(serde_json::json!({}))).unwrap();
    for origin in ["http://evil.example", "null", "https://localhost.evil.example"] {
        let res = server.request(
            "POST",
            "/event",
            Some(&event),
            &[("Origin", origin), ("Content-Type", "text/plain")],
        );
        assert_eq!(res.status, 403, "origin {origin}");
    }
    assert_eq!(server.health()["events"], 0);

    // The hook sends no Origin; the page sends its own
    let res = server.request("POST", "/event", Some(&event), &[]);
    assert_eq!(res.status, 200);
    let res = server.request("GET", "/health", None, &[("Origin", ALLOWED_ORIGIN)]);
    assert_eq!(res.status, 200);
}

// ============================================================================
// Static files (from a fake dist/ in the temp HOME)
// ============================================================================

/// A server whose VIBECRAFT_DIST_DIR is a small fake build, with a file
/// outside it to try to reach
fn static_server(env: &TestEnv) -> TestServer {
    let dist: PathBuf = env.home.join("app/dist");
    fs::create_dir_all(dist.join("assets")).unwrap();
    fs::write(dist.join("index.html"), INDEX_HTML).unwrap();
    fs::write(dist.join("assets/app.js"), "console.log(1)").unwrap();
    fs::write(env.home.join("app/secret.json"), "{}").unwrap();
    TestServer::start(
        SERVER,
        env,
        &[("VIBECRAFT_DIST_DIR", dist.to_str().unwrap())],
    )
}

#[test]
fn serves_index_html_at_root_and_for_unknown_routes() {
    let env = TestEnv::new();
    let server = static_server(&env);
    for path in ["/", "/some/client/route"] {
        let res = server.request("GET", path, None, &[]);
        assert_eq!(res.status, 200, "{path}");
        assert_eq!(res.header("content-type"), Some("text/html"));
        assert_eq!(res.text(), INDEX_HTML);
    }
}

#[test]
fn unknown_api_paths_are_404() {
    let env = TestEnv::new();
    let server = static_server(&env);
    assert_eq!(server.request("GET", "/api/nothing", None, &[]).status, 404);
}

#[test]
fn blocks_path_traversal() {
    let env = TestEnv::new();
    let server = static_server(&env);
    assert_eq!(
        server
            .request("GET", "/%2e%2e/secret.json", None, &[])
            .status,
        403
    );
    assert_eq!(
        server.request("GET", "/..%2fsecret.json", None, &[]).status,
        403
    );
}

#[test]
fn serves_the_spa_for_a_directory_instead_of_crashing() {
    let env = TestEnv::new();
    let server = static_server(&env);
    let res = server.request("GET", "/assets", None, &[]);
    assert_eq!(res.status, 200);
    assert_eq!(res.text(), INDEX_HTML);
    assert_eq!(server.get_json("/health").0, 200);
}

#[test]
fn serves_real_files_with_their_mime_type() {
    let env = TestEnv::new();
    let server = static_server(&env);
    let res = server.request("GET", "/assets/app.js", None, &[]);
    assert_eq!(res.status, 200);
    assert_eq!(res.header("content-type"), Some("application/javascript"));
    assert_eq!(res.text(), "console.log(1)");
}

#[test]
fn invalid_url_encoding_is_400() {
    let env = TestEnv::new();
    let server = static_server(&env);
    assert_eq!(server.request("GET", "/%E0%A4%A", None, &[]).status, 400);
}
