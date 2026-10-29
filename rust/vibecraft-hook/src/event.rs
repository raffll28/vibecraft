//! Hook input → vibecraft event, matching the jq program in hooks/vibecraft-hook.sh.
//!
//! jq semantics worth keeping in mind:
//! - `x // default` replaces both null and false
//! - `tostring` leaves strings alone and JSON-encodes everything else
//! - string length and slicing count codepoints, not bytes

use serde_json::{Map, Value, json};

use crate::transcript;

/// `. // $default | tostring`
fn str_or(value: Option<&Value>, default: &str) -> String {
    match value {
        None | Some(Value::Null) | Some(Value::Bool(false)) => default.to_string(),
        Some(Value::String(s)) => s.clone(),
        Some(other) => other.to_string(),
    }
}

/// `. // $default`
fn or_default(value: Option<&Value>, default: Value) -> Value {
    match value {
        None | Some(Value::Null) | Some(Value::Bool(false)) => default,
        Some(v) => v.clone(),
    }
}

/// `walk(if type == "string" and length > $max then .[:$max] + "…[truncated]" else . end)`
fn truncate_strings(value: &mut Value, max_chars: usize) {
    match value {
        Value::String(s) => {
            if let Some((byte_index, _)) = s.char_indices().nth(max_chars) {
                s.truncate(byte_index);
                s.push_str("…[truncated]");
            }
        }
        Value::Array(items) => items
            .iter_mut()
            .for_each(|v| truncate_strings(v, max_chars)),
        Value::Object(map) => map
            .values_mut()
            .for_each(|v| truncate_strings(v, max_chars)),
        _ => {}
    }
}

fn event_type(hook_event_name: Option<&Value>) -> &'static str {
    match hook_event_name.and_then(Value::as_str) {
        Some("PreToolUse") => "pre_tool_use",
        Some("PostToolUse") => "post_tool_use",
        Some("Stop") => "stop",
        Some("SubagentStop") => "subagent_stop",
        Some("SessionStart") => "session_start",
        Some("SessionEnd") => "session_end",
        Some("UserPromptSubmit") => "user_prompt_submit",
        Some("Notification") => "notification",
        Some("PreCompact") => "pre_compact",
        _ => "unknown",
    }
}

/// Build the event, or None for input jq would reject (non-object, non-null)
pub fn build(hook: &Value, now_us: u128, max_chars: usize) -> Option<Value> {
    let h = match hook {
        Value::Object(map) => map,
        Value::Null => &Map::new(),
        _ => return None,
    };
    let get = |key: &str| h.get(key);

    let event_type = event_type(get("hook_event_name"));
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

    let transcript_path = get("transcript_path").and_then(Value::as_str);

    match event_type {
        "pre_tool_use" => {
            let entries = transcript::tail_entries(transcript_path, 30);
            event.insert("tool".into(), json!(str_or(get("tool_name"), "unknown")));
            event.insert("toolInput".into(), or_default(get("tool_input"), json!({})));
            event.insert("toolUseId".into(), json!(str_or(get("tool_use_id"), "")));
            event.insert(
                "assistantText".into(),
                json!(transcript::assistant_text(&entries)),
            );
        }
        "post_tool_use" => {
            let mut response = or_default(get("tool_response"), json!({}));
            truncate_strings(&mut response, max_chars);
            // `(try $h.tool_response.success catch null) != false`
            let success = !matches!(
                get("tool_response")
                    .and_then(Value::as_object)
                    .and_then(|r| r.get("success")),
                Some(Value::Bool(false))
            );
            event.insert("tool".into(), json!(str_or(get("tool_name"), "unknown")));
            event.insert("toolInput".into(), or_default(get("tool_input"), json!({})));
            event.insert("toolResponse".into(), response);
            event.insert("toolUseId".into(), json!(str_or(get("tool_use_id"), "")));
            event.insert("success".into(), json!(success));
        }
        "stop" | "subagent_stop" => {
            let entries = transcript::tail_entries(transcript_path, 200);
            event.insert(
                "stopHookActive".into(),
                or_default(get("stop_hook_active"), json!(false)),
            );
            event.insert(
                "response".into(),
                json!(transcript::last_response(&entries)),
            );
        }
        "session_start" => {
            event.insert("source".into(), json!(str_or(get("source"), "startup")));
        }
        "session_end" => {
            event.insert("reason".into(), json!(str_or(get("reason"), "other")));
        }
        "user_prompt_submit" => {
            event.insert("prompt".into(), json!(str_or(get("prompt"), "")));
        }
        "notification" => {
            event.insert("message".into(), json!(str_or(get("message"), "")));
            event.insert(
                "notificationType".into(),
                json!(str_or(get("notification_type"), "unknown")),
            );
        }
        "pre_compact" => {
            event.insert("trigger".into(), json!(str_or(get("trigger"), "manual")));
            event.insert(
                "customInstructions".into(),
                json!(str_or(get("custom_instructions"), "")),
            );
        }
        _ => {
            event.insert("raw".into(), hook.clone());
        }
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
        let mut v = json!({ "a": "çãé🚀x", "b": ["abc"] });
        truncate_strings(&mut v, 4);
        assert_eq!(v, json!({ "a": "çãé🚀…[truncated]", "b": ["abc"] }));
    }

    #[test]
    fn false_falls_back_like_jq() {
        assert_eq!(str_or(Some(&json!(false)), "d"), "d");
        assert_eq!(str_or(Some(&json!(true)), "d"), "true");
        assert_eq!(str_or(Some(&json!({"a": 1})), "d"), r#"{"a":1}"#);
    }

    #[test]
    fn rejects_non_object_input() {
        assert!(build(&json!(5), 0, 10).is_none());
        assert!(build(&json!("x"), 0, 10).is_none());
        assert_eq!(build(&Value::Null, 0, 10).unwrap()["type"], "unknown");
    }
}
