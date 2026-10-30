//! Contract tests for the hook binary: Claude Code hook JSON in → vibecraft
//! event out (appended to the events file, optionally POSTed to the server).

use std::io::{BufRead, BufReader, Read, Write};
use std::net::TcpListener;
use std::path::PathBuf;
use std::sync::mpsc;
use std::thread;
use std::time::Duration;

use serde_json::{Value, json};
use vibecraft_testkit::{HookResult, TestEnv, run_hook, strip_volatile};

const HOOK: &str = env!("CARGO_BIN_EXE_vibecraft-hook");

fn run(env: &TestEnv, input: &Value, extra_env: &[(&str, &str)]) -> HookResult {
    run_hook(
        HOOK,
        env,
        &env.events_file,
        input.to_string().as_bytes(),
        extra_env,
    )
}

/// Run in a fresh env and return the single event written, minus id/timestamp
fn single(input: Value) -> Value {
    single_with(input, &[])
}

fn single_with(input: Value, extra_env: &[(&str, &str)]) -> Value {
    let env = TestEnv::new();
    let result = run(&env, &input, extra_env);
    assert_eq!(result.code, Some(0), "{}", result.stderr);
    assert_eq!(
        result.events.len(),
        1,
        "expected one event, got lines: {:?}",
        result.lines
    );
    strip_volatile(&result.events[0])
}

/// Write a transcript (one JSON object per line) into `env` and return its path
fn write_transcript(env: &TestEnv, entries: &[Value], trailing: &str) -> String {
    let path = env.home.join("transcript.jsonl");
    let mut text: String = entries.iter().map(|e| format!("{e}\n")).collect();
    text.push_str(trailing);
    std::fs::write(&path, text).unwrap();
    path.to_string_lossy().into_owned()
}

fn user(text: &str) -> Value {
    json!({ "type": "user", "message": { "content": [{ "type": "text", "text": text }] } })
}

fn assistant(texts: &[&str]) -> Value {
    let content: Vec<Value> = texts
        .iter()
        .map(|t| json!({ "type": "text", "text": t }))
        .collect();
    json!({ "type": "assistant", "message": { "content": content } })
}

fn assistant_tool_use() -> Value {
    json!({ "type": "assistant", "message": { "content": [{ "type": "tool_use", "name": "Read" }] } })
}

// ============================================================================
// Event mapping
// ============================================================================

#[test]
fn user_prompt_submit_keeps_the_prompt_verbatim() {
    let prompt = "olá \"aspas\" \\ barra\nnova linha\t🚀";
    assert_eq!(
        single(
            json!({ "hook_event_name": "UserPromptSubmit", "session_id": "s1", "cwd": "/w", "prompt": prompt })
        ),
        json!({ "type": "user_prompt_submit", "sessionId": "s1", "cwd": "/w", "prompt": prompt })
    );
}

#[test]
fn session_start_defaults_source_to_startup() {
    assert_eq!(
        single(json!({ "hook_event_name": "SessionStart", "session_id": "s1", "cwd": "/w" })),
        json!({ "type": "session_start", "sessionId": "s1", "cwd": "/w", "source": "startup" })
    );
    assert_eq!(
        single(
            json!({ "hook_event_name": "SessionStart", "session_id": "s1", "cwd": "/w", "source": "resume" })
        ),
        json!({ "type": "session_start", "sessionId": "s1", "cwd": "/w", "source": "resume" })
    );
}

#[test]
fn session_end_defaults_reason_to_other() {
    assert_eq!(
        single(json!({ "hook_event_name": "SessionEnd", "session_id": "s1", "cwd": "/w" })),
        json!({ "type": "session_end", "sessionId": "s1", "cwd": "/w", "reason": "other" })
    );
}

#[test]
fn notification_carries_message_and_type() {
    assert_eq!(
        single(json!({
            "hook_event_name": "Notification", "session_id": "s1", "cwd": "/w",
            "message": "Claude needs your permission", "notification_type": "permission_prompt",
        })),
        json!({
            "type": "notification", "sessionId": "s1", "cwd": "/w",
            "message": "Claude needs your permission", "notificationType": "permission_prompt",
        })
    );
}

#[test]
fn notification_defaults() {
    assert_eq!(
        single(json!({ "hook_event_name": "Notification", "session_id": "s1", "cwd": "/w" })),
        json!({ "type": "notification", "sessionId": "s1", "cwd": "/w", "message": "", "notificationType": "unknown" })
    );
}

#[test]
fn pre_compact_carries_trigger_and_instructions() {
    assert_eq!(
        single(json!({ "hook_event_name": "PreCompact", "session_id": "s1", "cwd": "/w" })),
        json!({ "type": "pre_compact", "sessionId": "s1", "cwd": "/w", "trigger": "manual", "customInstructions": "" })
    );
}

#[test]
fn unknown_hook_names_keep_the_raw_input() {
    let input = json!({ "hook_event_name": "SomethingNew", "session_id": "s1", "cwd": "/w", "extra": [1, 2] });
    assert_eq!(
        single(input.clone()),
        json!({ "type": "unknown", "sessionId": "s1", "cwd": "/w", "raw": input })
    );
}

#[test]
fn missing_session_id_and_cwd_fall_back() {
    assert_eq!(
        single(json!({ "hook_event_name": "SessionEnd" })),
        json!({ "type": "session_end", "sessionId": "unknown", "cwd": "", "reason": "other" })
    );
}

#[test]
fn non_string_fields_are_stringified() {
    assert_eq!(
        single(
            json!({ "hook_event_name": "UserPromptSubmit", "session_id": 42, "cwd": "/w", "prompt": 7 })
        ),
        json!({ "type": "user_prompt_submit", "sessionId": "42", "cwd": "/w", "prompt": "7" })
    );
}

// ============================================================================
// Tool events
// ============================================================================

#[test]
fn pre_tool_use_includes_the_assistant_text_since_the_last_user_message() {
    let env = TestEnv::new();
    let transcript = write_transcript(
        &env,
        &[
            user("first"),
            assistant(&["old reply"]),
            user("second"),
            assistant(&["Let me look.", "Reading now."]),
            assistant_tool_use(),
        ],
        "",
    );
    let result = run(
        &env,
        &json!({
            "hook_event_name": "PreToolUse", "session_id": "s1", "cwd": "/w", "transcript_path": transcript,
            "tool_name": "Read", "tool_input": { "file_path": "/w/a.ts" }, "tool_use_id": "tu1",
        }),
        &[],
    );
    assert_eq!(
        strip_volatile(&result.events[0]),
        json!({
            "type": "pre_tool_use", "sessionId": "s1", "cwd": "/w",
            "tool": "Read", "toolInput": { "file_path": "/w/a.ts" }, "toolUseId": "tu1",
            "assistantText": "Let me look.\nReading now.",
        })
    );
}

#[test]
fn pre_tool_use_tolerates_a_missing_transcript_and_a_partial_last_line() {
    let event = single(json!({
        "hook_event_name": "PreToolUse", "session_id": "s1", "cwd": "/w", "tool_name": "Bash",
        "transcript_path": "/nonexistent/transcript.jsonl",
    }));
    assert_eq!(event["assistantText"], "");

    let env = TestEnv::new();
    let transcript = write_transcript(
        &env,
        &[user("q"), assistant(&["answer"])],
        r#"{"type":"assistant","mess"#,
    );
    let result = run(
        &env,
        &json!({ "hook_event_name": "PreToolUse", "session_id": "s1", "cwd": "/w", "tool_name": "Bash", "transcript_path": transcript }),
        &[],
    );
    assert_eq!(result.events[0]["assistantText"], "answer");
}

#[test]
fn pre_tool_use_defaults() {
    assert_eq!(
        single(json!({ "hook_event_name": "PreToolUse", "session_id": "s1", "cwd": "/w" })),
        json!({
            "type": "pre_tool_use", "sessionId": "s1", "cwd": "/w",
            "tool": "unknown", "toolInput": {}, "toolUseId": "", "assistantText": "",
        })
    );
}

#[test]
fn post_tool_use_reports_success_unless_tool_response_success_is_false() {
    let base = || json!({ "hook_event_name": "PostToolUse", "session_id": "s1", "cwd": "/w", "tool_name": "Bash", "tool_use_id": "tu1" });
    let with_response = |response: Value| {
        let mut input = base();
        input["tool_response"] = response;
        single(input)["success"].clone()
    };
    assert_eq!(with_response(json!({ "stdout": "ok" })), true);
    assert_eq!(with_response(json!({ "success": false })), false);
    assert_eq!(with_response(json!("plain string")), true);
    assert_eq!(
        single(base()),
        json!({
            "type": "post_tool_use", "sessionId": "s1", "cwd": "/w",
            "tool": "Bash", "toolInput": {}, "toolResponse": {}, "toolUseId": "tu1", "success": true,
        })
    );
}

#[test]
fn post_tool_use_truncates_long_strings_anywhere_in_tool_response() {
    let long = "x".repeat(5000);
    let event = single(json!({
        "hook_event_name": "PostToolUse", "session_id": "s1", "cwd": "/w", "tool_name": "Read",
        "tool_input": { "file_path": long },
        "tool_response": { "stdout": long, "nested": [{ "deep": long }], "short": "kept", "n": 3 },
    }));
    let truncated = format!("{}…[truncated]", "x".repeat(4096));
    assert_eq!(
        event["toolResponse"],
        json!({ "stdout": truncated, "nested": [{ "deep": truncated }], "short": "kept", "n": 3 })
    );
    // tool_input is passed through untouched
    assert_eq!(event["toolInput"], json!({ "file_path": long }));
}

#[test]
fn max_response_chars_controls_truncation() {
    let event = single_with(
        json!({ "hook_event_name": "PostToolUse", "session_id": "s1", "cwd": "/w", "tool_response": { "stdout": "abcdef" } }),
        &[("VIBECRAFT_MAX_RESPONSE_CHARS", "3")],
    );
    assert_eq!(
        event["toolResponse"],
        json!({ "stdout": "abc…[truncated]" })
    );
}

// ============================================================================
// Stop events
// ============================================================================

#[test]
fn stop_captures_the_latest_assistant_message_that_has_text() {
    let env = TestEnv::new();
    let transcript = write_transcript(
        &env,
        &[
            user("q"),
            assistant(&["first part"]),
            assistant(&["Final", "answer"]),
            assistant_tool_use(),
        ],
        "",
    );
    let result = run(
        &env,
        &json!({ "hook_event_name": "Stop", "session_id": "s1", "cwd": "/w", "transcript_path": transcript, "stop_hook_active": true }),
        &[],
    );
    assert_eq!(
        strip_volatile(&result.events[0]),
        json!({ "type": "stop", "sessionId": "s1", "cwd": "/w", "stopHookActive": true, "response": "Final\nanswer" })
    );
}

#[test]
fn subagent_stop_uses_the_same_shape() {
    assert_eq!(
        single(json!({ "hook_event_name": "SubagentStop", "session_id": "s1", "cwd": "/w" })),
        json!({ "type": "subagent_stop", "sessionId": "s1", "cwd": "/w", "stopHookActive": false, "response": "" })
    );
}

// ============================================================================
// Robustness
// ============================================================================

#[test]
fn malformed_input_writes_nothing_and_exits_0() {
    let env = TestEnv::new();
    let result = run_hook(HOOK, &env, &env.events_file, b"{not json", &[]);
    assert_eq!(result.code, Some(0));
    assert!(result.lines.is_empty());
}

#[test]
fn empty_input_writes_nothing_and_exits_0() {
    let env = TestEnv::new();
    let result = run_hook(HOOK, &env, &env.events_file, b"", &[]);
    assert_eq!(result.code, Some(0));
    assert!(result.lines.iter().all(String::is_empty));
}

#[test]
fn each_event_is_one_compact_json_line_appended() {
    let env = TestEnv::new();
    run(
        &env,
        &json!({ "hook_event_name": "SessionStart", "session_id": "s1", "cwd": "/w" }),
        &[],
    );
    let result = run(
        &env,
        &json!({ "hook_event_name": "UserPromptSubmit", "session_id": "s1", "cwd": "/w", "prompt": "a\nb" }),
        &[],
    );
    assert_eq!(result.lines.len(), 2);
    let types: Vec<&str> = result
        .events
        .iter()
        .map(|e| e["type"].as_str().unwrap())
        .collect();
    assert_eq!(types, ["session_start", "user_prompt_submit"]);
}

#[test]
fn ids_are_unique_per_event() {
    let env = TestEnv::new();
    let input = json!({ "hook_event_name": "SessionStart", "session_id": "s1", "cwd": "/w" });
    for _ in 0..5 {
        run(&env, &input, &[]);
    }
    let result = run(&env, &input, &[]);
    let ids: std::collections::HashSet<&str> = result
        .events
        .iter()
        .map(|e| e["id"].as_str().unwrap())
        .collect();
    assert_eq!(ids.len(), 6);
}

#[test]
fn creates_the_events_directory_if_missing() {
    let env = TestEnv::new();
    let events_file: PathBuf = env.home.join("nested/dir/events.jsonl");
    let input = json!({ "hook_event_name": "SessionEnd", "session_id": "s1" });
    let result = run_hook(HOOK, &env, &events_file, input.to_string().as_bytes(), &[]);
    assert_eq!(result.events.len(), 1);
}

// ============================================================================
// Server notification
// ============================================================================

#[test]
fn posts_the_same_event_to_the_server_including_bodies_over_128_kib() {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let url = format!(
        "http://127.0.0.1:{}/event",
        listener.local_addr().unwrap().port()
    );
    let (tx, rx) = mpsc::channel::<Vec<u8>>();
    thread::spawn(move || {
        let (stream, _) = listener.accept().unwrap();
        let mut reader = BufReader::new(stream.try_clone().unwrap());
        let mut length = 0;
        loop {
            let mut line = String::new();
            reader.read_line(&mut line).unwrap();
            if line == "\r\n" {
                break;
            }
            if let Some(v) = line.to_ascii_lowercase().strip_prefix("content-length:") {
                length = v.trim().parse().unwrap();
            }
        }
        let mut body = vec![0; length];
        reader.read_exact(&mut body).unwrap();
        let _ = (&stream).write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 11\r\n\r\n{\"ok\":true}");
        tx.send(body).unwrap();
    });

    let env = TestEnv::new();
    let big = "y".repeat(200 * 1024);
    let result = run(
        &env,
        &json!({ "hook_event_name": "UserPromptSubmit", "session_id": "s1", "cwd": "/w", "prompt": big }),
        &[
            ("VIBECRAFT_ENABLE_WS_NOTIFY", "true"),
            ("VIBECRAFT_WS_NOTIFY", &url),
        ],
    );

    // The notify may land after the hook exits
    let body = rx
        .recv_timeout(Duration::from_secs(3))
        .expect("hook POSTed the event");
    assert_eq!(
        serde_json::from_slice::<Value>(&body).unwrap(),
        result.events[0]
    );
}
