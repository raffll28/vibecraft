//! Server contract: event ingestion (HTTP + events file), dedupe, durations,
//! WebSocket broadcast and history.

use std::thread;
use std::time::Duration;

use serde_json::{Value, json};
use vibecraft_testkit::{TestEnv, TestServer, make_event, now_ms, wait_for};

const SERVER: &str = env!("CARGO_BIN_EXE_vibecraft-server");

fn start(env: &TestEnv) -> TestServer {
    TestServer::start(SERVER, env, &[])
}

fn events_count(server: &TestServer) -> u64 {
    server.health()["events"].as_u64().unwrap()
}

// ============================================================================
// POST /event
// ============================================================================

#[test]
fn accepts_an_event_and_counts_it_in_health() {
    let env = TestEnv::new();
    let server = start(&env);
    assert_eq!(events_count(&server), 0);
    assert_eq!(
        server.post_event(&make_event(json!({}))),
        (200, json!({ "ok": true }))
    );
    assert_eq!(events_count(&server), 1);
}

#[test]
fn rejects_invalid_json_with_400() {
    let env = TestEnv::new();
    let server = start(&env);
    assert_eq!(
        server.send_json("POST", "/event", b"{nope"),
        (400, json!({ "error": "Invalid JSON" }))
    );
}

#[test]
fn rejects_json_that_is_not_an_event_object_with_400() {
    let env = TestEnv::new();
    let server = start(&env);
    for body in ["5", "\"x\"", "null", "[1,2]"] {
        assert_eq!(
            server.send_json("POST", "/event", body.as_bytes()),
            (400, json!({ "error": "Invalid JSON" })),
            "{body}"
        );
    }
    assert_eq!(events_count(&server), 0);
}

#[test]
fn rejects_bodies_over_1_mib_with_413() {
    let env = TestEnv::new();
    let server = start(&env);
    let event = make_event(json!({ "prompt": "z".repeat(1024 * 1024 + 10) }));
    assert_eq!(server.post_event(&event).0, 413);
}

#[test]
fn ignores_duplicate_ids() {
    let env = TestEnv::new();
    let server = start(&env);
    let event = make_event(json!({}));
    server.post_event(&event);
    server.post_event(&event);
    assert_eq!(events_count(&server), 1);
}

#[test]
fn broadcasts_new_events_to_websocket_clients() {
    let env = TestEnv::new();
    let server = start(&env);
    let mut client = server.connect();
    client.next("history");
    let event = make_event(json!({}));
    server.post_event(&event);
    assert_eq!(client.next("event")["payload"], event);
}

#[test]
fn adds_duration_to_post_tool_use_from_the_matching_pre_tool_use() {
    let env = TestEnv::new();
    let server = start(&env);
    let mut client = server.connect();
    client.next("history");
    let t0 = now_ms();
    let base = json!({ "sessionId": "s1", "tool": "Read", "toolUseId": "tu-1", "toolInput": {} });
    let with = |extra: Value| {
        let mut fields = base.clone();
        fields
            .as_object_mut()
            .unwrap()
            .extend(extra.as_object().unwrap().clone());
        make_event(fields)
    };
    server.post_event(&with(json!({ "type": "pre_tool_use", "timestamp": t0 })));
    server.post_event(&with(
        json!({ "type": "post_tool_use", "timestamp": t0 + 250, "success": true }),
    ));
    client.next("event");
    assert_eq!(client.next("event")["payload"]["duration"], 250);
}

#[test]
fn keeps_at_most_max_events_in_memory() {
    let env = TestEnv::new();
    let server = TestServer::start(SERVER, &env, &[("VIBECRAFT_MAX_EVENTS", "5")]);
    for _ in 0..8 {
        server.post_event(&make_event(json!({})));
    }
    assert_eq!(events_count(&server), 5);
}

// ============================================================================
// Events file
// ============================================================================

#[test]
fn loads_existing_events_at_startup_skipping_blank_and_broken_lines() {
    let env = TestEnv::new();
    env.seed_events(&[
        make_event(json!({})),
        json!(""),
        json!("{broken"),
        make_event(json!({})),
        json!(""),
    ]);
    let server = start(&env);
    assert_eq!(events_count(&server), 2);
}

#[test]
fn loads_only_the_newest_max_events_at_startup() {
    let env = TestEnv::new();
    env.seed_events(&(0..10).map(|_| make_event(json!({}))).collect::<Vec<_>>());
    let server = TestServer::start(SERVER, &env, &[("VIBECRAFT_MAX_EVENTS", "4")]);
    assert_eq!(events_count(&server), 4);
}

#[test]
fn picks_up_lines_appended_to_the_file_and_broadcasts_them() {
    let env = TestEnv::new();
    let server = start(&env);
    let mut client = server.connect();
    client.next("history");
    let event = make_event(json!({}));
    env.append_events_file(format!("{event}\n").as_bytes());
    assert_eq!(
        client.next_within("event", Duration::from_secs(5))["payload"],
        event
    );
}

#[test]
fn waits_for_a_partial_line_to_be_completed() {
    let env = TestEnv::new();
    let server = start(&env);
    let mut client = server.connect();
    client.next("history");
    let line = make_event(json!({})).to_string();
    env.append_events_file(&line.as_bytes()[..20]);
    thread::sleep(Duration::from_millis(400));
    assert!(!client.types().iter().any(|t| t == "event"));
    env.append_events_file(format!("{}\n", &line[20..]).as_bytes());
    assert_eq!(
        client.next_within("event", Duration::from_secs(5))["payload"],
        serde_json::from_str::<Value>(&line).unwrap()
    );
}

#[test]
fn keeps_multibyte_characters_intact_when_a_write_splits_them() {
    let env = TestEnv::new();
    let server = start(&env);
    let mut client = server.connect();
    client.next("history");
    let event = make_event(json!({ "prompt": "ação 🚀 çã" }));
    let bytes = format!("{event}\n").into_bytes();
    let rocket = "🚀".as_bytes();
    let cut = bytes
        .windows(rocket.len())
        .position(|w| w == rocket)
        .unwrap()
        + 2; // mid-emoji
    env.append_events_file(&bytes[..cut]);
    thread::sleep(Duration::from_millis(1300)); // let the server read the first half on its own
    env.append_events_file(&bytes[cut..]);
    assert_eq!(
        client.next_within("event", Duration::from_secs(5))["payload"],
        event
    );
}

#[test]
fn ignores_a_post_of_an_event_already_loaded_from_the_file_at_startup() {
    let env = TestEnv::new();
    let event = make_event(json!({}));
    env.seed_events(std::slice::from_ref(&event));
    let server = start(&env);
    server.post_event(&event);
    assert_eq!(events_count(&server), 1);
}

#[test]
fn does_not_double_count_events_seen_via_both_file_and_http() {
    let env = TestEnv::new();
    let server = start(&env);
    let event = make_event(json!({}));
    server.post_event(&event);
    env.append_events_file(format!("{event}\n").as_bytes());
    thread::sleep(Duration::from_millis(500));
    assert_eq!(events_count(&server), 1);
}

#[test]
fn creates_the_events_file_if_it_does_not_exist() {
    let env = TestEnv::new();
    let _server = start(&env);
    wait_for(Duration::from_secs(3), "events file", || {
        std::fs::read_to_string(&env.events_file)
            .ok()
            .filter(String::is_empty)
    });
}

// ============================================================================
// WebSocket
// ============================================================================

#[test]
fn rejects_connections_without_an_allowed_origin() {
    let env = TestEnv::new();
    let server = start(&env);
    for origin in [
        None,
        Some("http://evil.example"),
        Some("http://vibecraft.sh"),
    ] {
        let client = server.connect_with_origin(origin);
        assert_eq!(client.wait_close(), Some(1008), "origin {origin:?}");
    }
}

#[test]
fn accepts_localhost_127_0_0_1_and_vibecraft_sh_origins() {
    let env = TestEnv::new();
    let server = start(&env);
    for origin in [
        "http://localhost:1234",
        "http://127.0.0.1",
        "https://vibecraft.sh",
    ] {
        let mut client = server.connect_with_origin(Some(origin));
        client.next("history");
    }
}

#[test]
fn sends_connected_then_history_on_connect() {
    let env = TestEnv::new();
    env.seed_events(&[make_event(json!({ "sessionId": "last-session" }))]);
    let server = start(&env);
    let mut client = server.connect();
    client.next("history");
    assert_eq!(client.types(), ["connected", "history"]);
    assert_eq!(
        client.messages()[0]["payload"],
        json!({ "sessionId": "last-session" })
    );
}

#[test]
fn connected_reports_unknown_when_there_are_no_events() {
    let env = TestEnv::new();
    let server = start(&env);
    let mut client = server.connect();
    assert_eq!(
        client.next("connected")["payload"],
        json!({ "sessionId": "unknown" })
    );
}

#[test]
fn initial_history_has_only_recent_events_at_most_50() {
    let env = TestEnv::new();
    let old = now_ms() - 31 * 60 * 1000;
    let mut events = vec![make_event(json!({ "id": "old", "timestamp": old }))];
    events.extend((0..60).map(|i| make_event(json!({ "id": format!("recent-{i}") }))));
    env.seed_events(&events);
    let server = start(&env);
    let mut client = server.connect();
    let history = client.next("history")["payload"].clone();
    let ids: Vec<&str> = history
        .as_array()
        .unwrap()
        .iter()
        .map(|e| e["id"].as_str().unwrap())
        .collect();
    let expected: Vec<String> = (10..60).map(|i| format!("recent-{i}")).collect();
    assert_eq!(ids, expected);
}

#[test]
fn ignores_whatever_clients_send_malformed_or_not() {
    let env = TestEnv::new();
    let server = start(&env);
    let mut client = server.connect();
    client.next("history");
    client.send_text("{garbage");
    client.send_text(r#"{"type":"definitely_unknown"}"#);
    client.send_text(r#"{"type":"ping"}"#);
    thread::sleep(Duration::from_millis(100));
    let event = make_event(json!({}));
    server.post_event(&event);
    assert_eq!(client.next("event")["payload"], event);
    assert_eq!(server.health()["clients"], 1);
}

#[test]
fn health_counts_connected_clients() {
    let env = TestEnv::new();
    let server = start(&env);
    let mut a = server.connect();
    let mut b = server.connect();
    a.next("history");
    b.next("history");
    assert_eq!(server.health()["clients"], 2);
    drop(a);
    wait_for(Duration::from_secs(3), "client count", || {
        (server.health()["clients"] == 1).then_some(())
    });
}
