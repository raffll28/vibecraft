//! Hook input → vibecraft event, with only what the frontend uses: the
//! session, the tool and a summary of its input, success, and the
//! notification type. Prompts, responses, tool output and file contents are
//! never recorded.

use serde_json::{Map, Value, json};

/// The value as a string (non-strings JSON-encoded), or `default` when
/// missing, null or false
fn str_or(value: Option<&Value>, default: &str) -> String {
    match value {
        None | Some(Value::Null) | Some(Value::Bool(false)) => default.to_string(),
        Some(Value::String(s)) => s.clone(),
        Some(other) => other.to_string(),
    }
}

/// The first `max_chars` codepoints of `s`, marked when cut
fn truncate(s: &str, max_chars: usize) -> String {
    match s.char_indices().nth(max_chars) {
        Some((byte_index, _)) => format!("{}…", &s[..byte_index]),
        None => s.to_string(),
    }
}

/// Short text fields the frontend shows (file name, command, pattern...)
const INPUT_TEXT_KEYS: [&str; 7] = [
    "file_path",
    "notebook_path",
    "command",
    "pattern",
    "url",
    "query",
    "description",
];

/// Long text fields the frontend only counts lines of: (input key, event key)
const INPUT_LINE_KEYS: [(&str, &str); 3] = [
    ("old_string", "old_lines"),
    ("new_string", "new_lines"),
    ("content", "content_lines"),
];

/// Longest text kept per field
const MAX_TEXT_CHARS: usize = 300;

/// Only what the frontend uses from a tool's input: short text fields
/// (truncated), line counts instead of file contents, and the number of todos.
/// Keeps prompts, file contents and edits out of the events file.
fn summarize_input(input: Option<&Value>) -> Value {
    let mut out = Map::new();
    let Some(input) = input.and_then(Value::as_object) else {
        return Value::Object(out);
    };
    for key in INPUT_TEXT_KEYS {
        if let Some(Value::String(text)) = input.get(key) {
            out.insert(key.into(), json!(truncate(text, MAX_TEXT_CHARS)));
        }
    }
    for (key, lines_key) in INPUT_LINE_KEYS {
        if let Some(Value::String(text)) = input.get(key)
            && !text.is_empty()
        {
            out.insert(lines_key.into(), json!(text.matches('\n').count() + 1));
        }
    }
    if let Some(Value::Array(todos)) = input.get("todos") {
        out.insert("todo_count".into(), json!(todos.len()));
    }
    Value::Object(out)
}

fn event_type(hook_event_name: Option<&Value>) -> Option<&'static str> {
    Some(match hook_event_name.and_then(Value::as_str)? {
        "PreToolUse" => "pre_tool_use",
        "PostToolUse" => "post_tool_use",
        "Stop" => "stop",
        "SubagentStop" => "subagent_stop",
        "SessionStart" => "session_start",
        "SessionEnd" => "session_end",
        "UserPromptSubmit" => "user_prompt_submit",
        "Notification" => "notification",
        "PreCompact" => "pre_compact",
        _ => return None,
    })
}

/// Build the event, or None for input that isn't an object or for a hook
/// event vibecraft doesn't use
pub fn build(hook: &Value, now_us: u128) -> Option<Value> {
    let h = hook.as_object()?;
    let get = |key: &str| h.get(key);

    let event_type = event_type(get("hook_event_name"))?;
    let session_id = str_or(get("session_id"), "unknown");

    let mut event = Map::new();
    event.insert(
        "id".into(),
        json!(format!("{session_id}-{now_us}{:03}", random_suffix(now_us))),
    );
    event.insert("timestamp".into(), json!((now_us / 1000) as u64));
    event.insert("type".into(), json!(event_type));
    event.insert("sessionId".into(), json!(session_id));
    event.insert("cwd".into(), json!(str_or(get("cwd"), "")));

    match event_type {
        "pre_tool_use" | "post_tool_use" => {
            event.insert("tool".into(), json!(str_or(get("tool_name"), "unknown")));
            event.insert("toolInput".into(), summarize_input(get("tool_input")));
            event.insert("toolUseId".into(), json!(str_or(get("tool_use_id"), "")));
            if event_type == "post_tool_use" {
                // Failed only when tool_response.success is false
                let success = !matches!(
                    get("tool_response")
                        .and_then(Value::as_object)
                        .and_then(|r| r.get("success")),
                    Some(Value::Bool(false))
                );
                event.insert("success".into(), json!(success));
            }
        }
        "notification" => {
            event.insert(
                "notificationType".into(),
                json!(str_or(get("notification_type"), "unknown")),
            );
        }
        _ => {}
    }

    Some(Value::Object(event))
}

/// 0-999, distinct between hooks fired in the same microsecond
fn random_suffix(now_us: u128) -> u32 {
    // Mix the pid with the clock (splitmix64 finalizer); no RNG crate needed
    let mut x = (now_us as u64) ^ ((std::process::id() as u64) << 32);
    x = (x ^ (x >> 30)).wrapping_mul(0xbf58476d1ce4e5b9);
    x = (x ^ (x >> 27)).wrapping_mul(0x94d049bb133111eb);
    ((x ^ (x >> 31)) % 1000) as u32
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn truncates_by_codepoint() {
        assert_eq!(truncate("çãé🚀x", 4), "çãé🚀…");
        assert_eq!(truncate("abc", 4), "abc");
    }

    #[test]
    fn false_falls_back() {
        assert_eq!(str_or(Some(&json!(false)), "d"), "d");
        assert_eq!(str_or(Some(&json!(true)), "d"), "true");
        assert_eq!(str_or(Some(&json!({"a": 1})), "d"), r#"{"a":1}"#);
    }

    #[test]
    fn rejects_non_object_and_unknown_input() {
        assert!(build(&json!(5), 0).is_none());
        assert!(build(&json!("x"), 0).is_none());
        assert!(build(&Value::Null, 0).is_none());
        assert!(build(&json!({ "hook_event_name": "SomethingNew" }), 0).is_none());
    }
}
