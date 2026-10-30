//! Hook latency: how long each Claude Code tool call waits on the hook.
//!
//! Spawns the release hook (next to this example in target/release) with
//! realistic inputs, like Claude Code does, and reports wall time per call.
//!
//!   cargo run --release --example hook_bench [runs]
//!   BENCH_NOTIFY_URL=http://127.0.0.1:4003/event cargo run --release --example hook_bench
//!     (also POST each event to a running server, as in real use)

use std::time::Instant;

use serde_json::json;
use vibecraft_testkit::{TestEnv, elapsed_ms, example_sibling, print_table, run_hook, summarize};

fn main() {
    let runs: usize = std::env::args()
        .nth(1)
        .and_then(|r| r.parse().ok())
        .unwrap_or(200);
    let notify_url = std::env::var("BENCH_NOTIFY_URL").ok();
    let mut hook_env = Vec::new();
    if let Some(url) = &notify_url {
        hook_env.push(("VIBECRAFT_ENABLE_WS_NOTIFY", "true"));
        hook_env.push(("VIBECRAFT_WS_NOTIFY", url.as_str()));
    }
    let hook = example_sibling("vibecraft-hook");
    let env = TestEnv::new();

    // A transcript like a real session's: alternating prompts, replies and tool calls
    let transcript = env.home.join("transcript.jsonl");
    let lines: String = (0..400)
        .map(|i| {
            let entry = if i % 4 == 0 {
                json!({ "type": "user", "message": { "content": [{ "type": "text", "text": format!("prompt {i} ").repeat(20) }] } })
            } else {
                json!({ "type": "assistant", "message": { "content": [
                    { "type": "text", "text": format!("reply {i} ").repeat(60) },
                    { "type": "tool_use", "name": "Read", "input": { "file_path": "/x" } },
                ] } })
            };
            format!("{entry}\n")
        })
        .collect();
    std::fs::write(&transcript, lines).unwrap();

    let base = json!({ "session_id": "bench-session", "cwd": "/home/user/project", "transcript_path": transcript });
    let case = |extra: serde_json::Value| {
        let mut input = base.clone();
        input
            .as_object_mut()
            .unwrap()
            .extend(extra.as_object().unwrap().clone());
        input.to_string()
    };
    let cases = [
        (
            "PreToolUse",
            case(
                json!({ "hook_event_name": "PreToolUse", "tool_name": "Bash", "tool_input": { "command": "ls -la" }, "tool_use_id": "tu" }),
            ),
        ),
        (
            "PostToolUse",
            case(
                json!({ "hook_event_name": "PostToolUse", "tool_name": "Read", "tool_input": { "file_path": "/x" }, "tool_response": { "content": "line\n".repeat(4000) }, "tool_use_id": "tu" }),
            ),
        ),
        ("Stop", case(json!({ "hook_event_name": "Stop" }))),
        (
            "UserPromptSubmit",
            case(json!({ "hook_event_name": "UserPromptSubmit", "prompt": "do the thing" })),
        ),
    ];

    println!("Hook: {}", hook.display());
    println!(
        "{runs} runs per event type (server notify: {})\n",
        notify_url.as_deref().unwrap_or("disabled")
    );

    let hook = hook.to_str().unwrap();
    let mut rows = Vec::new();
    for (name, input) in &cases {
        for _ in 0..5 {
            run_hook(hook, &env, &env.events_file, input.as_bytes(), &hook_env); // warm up caches
        }
        let mut times = Vec::with_capacity(runs);
        for _ in 0..runs {
            // Keep the events file at one event, so reading it back stays cheap
            let _ = std::fs::remove_file(&env.events_file);
            let start = Instant::now();
            let result = run_hook(hook, &env, &env.events_file, input.as_bytes(), &hook_env);
            times.push(elapsed_ms(start));
            assert_eq!(result.code, Some(0), "hook failed: {}", result.stderr);
        }
        rows.push((*name, summarize(&times)));
    }
    print_table(&rows, "ms");
}
