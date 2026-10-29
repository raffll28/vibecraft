//! Differential testing oracle: reads `{"fn": ..., "input": ...}` lines on
//! stdin and prints one JSON result per line, so tests/differential can
//! compare this crate with the TypeScript implementation on random inputs.

use std::io::{BufRead, BufWriter, Write};

use serde_json::{Value, json};
use vibecraft_core::tmux_parsing::{
    detect_bypass_warning, detect_permission_prompt, parse_tokens_from_output,
};
use vibecraft_core::validation::{expand_home, is_origin_allowed, validate_tmux_session};

fn run(func: &str, input: &Value) -> Value {
    let s = input.as_str().unwrap_or_default();
    match func {
        "parseTokensFromOutput" => json!(parse_tokens_from_output(s)),
        "detectBypassWarning" => json!(detect_bypass_warning(s)),
        "detectPermissionPrompt" => json!(detect_permission_prompt(s).map(|p| json!({
            "tool": p.tool,
            "context": p.context,
            "options": p.options.iter()
                .map(|o| json!({ "number": o.number, "label": o.label }))
                .collect::<Vec<_>>(),
        }))),
        "isOriginAllowed" => json!(is_origin_allowed(input.as_str())),
        "validateTmuxSession" => json!(validate_tmux_session(s).is_ok()),
        "expandHome" => json!(expand_home(s)),
        other => json!({ "error": format!("unknown fn {other}") }),
    }
}

fn main() {
    let stdin = std::io::stdin();
    let mut out = BufWriter::new(std::io::stdout());
    for line in stdin.lock().lines() {
        let Ok(line) = line else { break };
        let req: Value = serde_json::from_str(&line).unwrap_or(Value::Null);
        let result = run(req["fn"].as_str().unwrap_or_default(), &req["input"]);
        writeln!(out, "{result}").unwrap();
        // The caller may wait on these results before sending more
        out.flush().unwrap();
    }
}
