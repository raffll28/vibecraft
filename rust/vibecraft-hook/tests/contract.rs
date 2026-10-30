//! Contract tests for the hook binary: Claude Code hook JSON in → vibecraft
//! event out (appended to the events file, optionally POSTed to the server).
//! Events carry only what the frontend uses: never prompts, responses, tool
//! output or file contents.

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

// ============================================================================
// Event mapping
// ============================================================================

#[test]
fn lifecycle_events_carry_only_the_session() {
    for (hook_name, event_type) in [
        ("UserPromptSubmit", "user_prompt_submit"),
        ("Stop", "stop"),
        ("SubagentStop", "subagent_stop"),
        ("SessionStart", "session_start"),
        ("SessionEnd", "session_end"),
        ("PreCompact", "pre_compact"),
    ] {
        assert_eq!(
            single(json!({
                "hook_event_name": hook_name, "session_id": "s1", "cwd": "/w",
                "prompt": "my secret prompt", "transcript_path": "/t.jsonl",
                "stop_hook_active": true, "source": "resume", "reason": "clear",
                "trigger": "auto", "custom_instructions": "x",
            })),
            json!({ "type": event_type, "sessionId": "s1", "cwd": "/w" }),
            "{hook_name}"
        );
    }
}

#[test]
fn notification_keeps_only_its_type() {
    assert_eq!(
        single(json!({
            "hook_event_name": "Notification", "session_id": "s1", "cwd": "/w",
            "message": "Claude needs your permission", "notification_type": "permission_prompt",
        })),
        json!({ "type": "notification", "sessionId": "s1", "cwd": "/w", "notificationType": "permission_prompt" })
    );
    assert_eq!(
        single(json!({ "hook_event_name": "Notification", "session_id": "s1", "cwd": "/w" }))["notificationType"],
        "unknown"
    );
}

#[test]
fn unknown_hook_names_are_not_recorded() {
    let env = TestEnv::new();
    let result = run(
        &env,
        &json!({ "hook_event_name": "SomethingNew", "session_id": "s1" }),
        &[],
    );
    assert_eq!(result.code, Some(0));
    assert!(result.lines.is_empty());
}

#[test]
fn missing_session_id_and_cwd_fall_back() {
    assert_eq!(
        single(json!({ "hook_event_name": "SessionEnd" })),
        json!({ "type": "session_end", "sessionId": "unknown", "cwd": "" })
    );
}

#[test]
fn non_string_fields_are_stringified() {
    assert_eq!(
        single(json!({ "hook_event_name": "SessionEnd", "session_id": 42, "cwd": "/w" })),
        json!({ "type": "session_end", "sessionId": "42", "cwd": "/w" })
    );
}

// ============================================================================
// Tool events
// ============================================================================

#[test]
fn tool_input_keeps_short_fields_and_line_counts_only() {
    let input = json!({
        "file_path": "/w/a.ts", "notebook_path": "/w/n.ipynb", "command": "ls -la",
        "pattern": "fn main", "url": "https://example.com", "query": "rust", "description": "Explore",
        "old_string": "a\nb", "new_string": "a\nb\nc\nd", "content": "x\ny\nz",
        "todos": [{ "content": "one" }, { "content": "two" }],
        "timeout": 5000, "replace_all": true,
    });
    assert_eq!(
        single(json!({
            "hook_event_name": "PreToolUse", "session_id": "s1", "cwd": "/w",
            "tool_name": "Edit", "tool_input": input, "tool_use_id": "tu1",
        })),
        json!({
            "type": "pre_tool_use", "sessionId": "s1", "cwd": "/w", "tool": "Edit", "toolUseId": "tu1",
            "toolInput": {
                "file_path": "/w/a.ts", "notebook_path": "/w/n.ipynb", "command": "ls -la",
                "pattern": "fn main", "url": "https://example.com", "query": "rust", "description": "Explore",
                "old_lines": 2, "new_lines": 4, "content_lines": 3, "todo_count": 2,
            },
        })
    );
}

#[test]
fn empty_contents_have_no_line_count() {
    let event = single(json!({
        "hook_event_name": "PreToolUse", "session_id": "s1", "cwd": "/w", "tool_name": "Write",
        "tool_input": { "file_path": "/w/a", "content": "" },
    }));
    assert_eq!(event["toolInput"], json!({ "file_path": "/w/a" }));
}

#[test]
fn long_text_fields_are_truncated_to_300_characters() {
    let command = "ç".repeat(500);
    let event = single(json!({
        "hook_event_name": "PreToolUse", "session_id": "s1", "cwd": "/w", "tool_name": "Bash",
        "tool_input": { "command": command },
    }));
    assert_eq!(
        event["toolInput"]["command"],
        format!("{}…", "ç".repeat(300))
    );
}

#[test]
fn pre_tool_use_defaults() {
    assert_eq!(
        single(json!({ "hook_event_name": "PreToolUse", "session_id": "s1", "cwd": "/w" })),
        json!({
            "type": "pre_tool_use", "sessionId": "s1", "cwd": "/w",
            "tool": "unknown", "toolInput": {}, "toolUseId": "",
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
    // The tool's output is never recorded
    let mut input = base();
    input["tool_response"] = json!({ "stdout": "secret output" });
    assert_eq!(
        single(input),
        json!({
            "type": "post_tool_use", "sessionId": "s1", "cwd": "/w",
            "tool": "Bash", "toolInput": {}, "toolUseId": "tu1", "success": true,
        })
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
        &json!({ "hook_event_name": "UserPromptSubmit", "session_id": "s1", "cwd": "/w" }),
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
fn posts_the_same_event_to_the_server() {
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
    let result = run(
        &env,
        &json!({ "hook_event_name": "PreToolUse", "session_id": "s1", "cwd": "/w", "tool_name": "Read", "tool_input": { "file_path": "/w/a" } }),
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
