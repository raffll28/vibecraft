//! Parsers for captured tmux pane output (Claude Code's terminal UI).
//!
//! Port of `server/tmuxParsing.ts`. Each function notes the JS regex it
//! replaces; the hand-written matchers accept exactly the same inputs.

use crate::js::{
    contains_ci, ends_with_ci, is_line_terminator, is_space, is_word, skip_space, strip_prefix_ci,
    trim,
};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PermissionOption {
    pub number: String,
    pub label: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PermissionPrompt {
    pub tool: String,
    pub context: String,
    pub options: Vec<PermissionOption>,
}

/// `tokens?` with `/i`: returns the rest after "token" or "tokens"
fn strip_tokens_word(s: &str) -> Option<&str> {
    let rest = strip_prefix_ci(s, "token")?;
    Some(strip_prefix_ci(rest, "s").unwrap_or(rest))
}

/// Largest token count in Claude Code output, e.g. `↓ 879 tokens`,
/// `↓ 1,234 tokens`, `↓ 12.5k tokens`. None when there is none above zero.
///
/// JS: `/↓\s*([0-9,]+)\s*tokens?/gi` and `/↓\s*([0-9.]+)k\s*tokens?/gi`.
/// Matches can only start at `↓` and never contain one, so trying every `↓`
/// finds the same matches as the global regex scan.
pub fn parse_tokens_from_output(output: &str) -> Option<u64> {
    let mut max = 0.0_f64;
    for (i, _) in output.match_indices('↓') {
        let after = skip_space(&output[i + '↓'.len_utf8()..]);

        // Plain: digits and commas
        let plain_len = after
            .find(|c: char| !(c.is_ascii_digit() || c == ','))
            .unwrap_or(after.len());
        if plain_len > 0 && strip_tokens_word(skip_space(&after[plain_len..])).is_some() {
            // parseInt of the digits; a run of only commas is NaN and never wins
            let digits: String = after[..plain_len].chars().filter(|&c| c != ',').collect();
            if let Ok(n) = digits.parse::<f64>() {
                max = max.max(n);
            }
        }

        // Thousands: digits and dots, then k
        let k_len = after
            .find(|c: char| !(c.is_ascii_digit() || c == '.'))
            .unwrap_or(after.len());
        if k_len > 0
            && let Some(rest) = strip_prefix_ci(&after[k_len..], "k")
            && strip_tokens_word(skip_space(rest)).is_some()
            && let Some(n) = parse_float_prefix(&after[..k_len])
        {
            // Math.round rounds halves up
            max = max.max((n * 1000.0 + 0.5).floor());
        }
    }
    (max > 0.0).then(|| max.min(u64::MAX as f64) as u64)
}

/// `parseFloat` on a string of digits and dots: the longest `\d*(\.\d*)?`
/// prefix with at least one digit
fn parse_float_prefix(s: &str) -> Option<f64> {
    let int_len = s.find(|c: char| !c.is_ascii_digit()).unwrap_or(s.len());
    let mut end = int_len;
    if s[int_len..].starts_with('.') {
        let frac = &s[int_len + 1..];
        end = int_len
            + 1
            + frac
                .find(|c: char| !c.is_ascii_digit())
                .unwrap_or(frac.len());
    }
    let number = &s[..end];
    if !number.bytes().any(|b| b.is_ascii_digit()) {
        return None;
    }
    // Rust's parser rejects a bare leading or trailing dot ("5.", ".5"); pad them
    let padded = format!(
        "{}{number}{}",
        if number.starts_with('.') { "0" } else { "" },
        if number.ends_with('.') { "0" } else { "" }
    );
    padded.parse().ok()
}

/// The bypass permissions warning shown on first use of
/// `--dangerously-skip-permissions`
pub fn detect_bypass_warning(output: &str) -> bool {
    output.contains("WARNING") && output.contains("Bypass Permissions mode")
}

/// JS: `/^\s*[❯>]?\s*(\d+)\.\s+(.+)$/` on one line
fn match_option(line: &str) -> Option<PermissionOption> {
    let mut rest = skip_space(line);
    if let Some(r) = rest.strip_prefix('❯').or_else(|| rest.strip_prefix('>')) {
        rest = skip_space(r);
    }
    let digits_len = rest
        .find(|c: char| !c.is_ascii_digit())
        .unwrap_or(rest.len());
    if digits_len == 0 {
        return None;
    }
    let number = &rest[..digits_len];
    let after_dot = rest[digits_len..].strip_prefix('.')?;

    // `\s+(.+)$`: \s+ is greedy, so the label is the longest suffix that
    // follows at least one whitespace char, is non-empty and has no line
    // terminator (`.` doesn't match them, `$` needs the end of the line)
    let ws_end = after_dot
        .find(|c: char| !is_space(c))
        .unwrap_or(after_dot.len());
    let ws_starts: Vec<usize> = after_dot[..ws_end].char_indices().map(|(i, _)| i).collect();
    if ws_starts.is_empty() {
        return None;
    }
    // Candidate label starts: after k whitespace chars, k from all down to 1
    let mut candidates = vec![ws_end];
    candidates.extend(ws_starts.iter().skip(1).rev().copied());
    for start in candidates {
        let label = &after_dot[start..];
        if !label.is_empty() && !label.chars().any(is_line_terminator) {
            return Some(PermissionOption {
                number: number.to_string(),
                label: trim(label).to_string(),
            });
        }
    }
    None
}

/// JS: `/[●◐·]\s*(\w+)\s*\(/` anywhere in the line, leftmost match
fn match_tool_header(line: &str) -> Option<&str> {
    for (i, c) in line.char_indices() {
        if !matches!(c, '●' | '◐' | '·') {
            continue;
        }
        let after = skip_space(&line[i + c.len_utf8()..]);
        let word_len = after.find(|c: char| !is_word(c)).unwrap_or(after.len());
        if word_len > 0 && skip_space(&after[word_len..]).starts_with('(') {
            return Some(&after[..word_len]);
        }
    }
    None
}

/// JS: `/^\s*(Bash|Read|Write|Edit|Grep|Glob|Task|WebFetch|WebSearch)\s+\w+/i`
fn match_tool_command(line: &str) -> Option<&str> {
    const TOOLS: [&str; 9] = [
        "Bash",
        "Read",
        "Write",
        "Edit",
        "Grep",
        "Glob",
        "Task",
        "WebFetch",
        "WebSearch",
    ];
    let start = skip_space(line);
    for tool in TOOLS {
        let Some(rest) = strip_prefix_ci(start, tool) else {
            continue;
        };
        let after_ws = skip_space(rest);
        if after_ws.len() < rest.len() && after_ws.starts_with(is_word) {
            // The capture keeps the line's own casing
            return Some(&start[..tool.len()]);
        }
    }
    None
}

/// `/(Do you want|Would you like) to proceed\?/i`. Anchored on `?`, which
/// most lines don't contain (found with memchr), instead of scanning for
/// the phrases at every position.
fn has_proceed_question(line: &str) -> bool {
    line.match_indices('?').any(|(i, _)| {
        let before = &line[..i];
        ends_with_ci(before, "do you want to proceed")
            || ends_with_ci(before, "would you like to proceed")
    })
}

/// Detect a Claude Code permission prompt ("Do you want to proceed?" with
/// numbered options) near the end of the captured output.
pub fn detect_permission_prompt(output: &str) -> Option<PermissionPrompt> {
    // Fast exit: the question needs a '?' in the last 30 lines, and most
    // captures have none. One memchr over that tail instead of per-line work.
    let mut tail_start = output.len();
    for _ in 0..30 {
        match output[..tail_start].rfind('\n') {
            Some(i) => tail_start = i,
            None => {
                tail_start = 0;
                break;
            }
        }
    }
    if !output[tail_start..].contains('?') {
        return None;
    }

    // Everything below looks at most 50 lines back from the end: the question
    // is in the last 30, the tool header up to 20 above it. So only the last
    // 51 lines are split, from the end; indexes stay equivalent.
    let mut lines: Vec<&str> = output.rsplit('\n').take(51).collect();
    lines.reverse();
    let n = lines.len();

    // JS: /(Do you want|Would you like) to proceed\?/i in the last 30 lines
    let proceed = (n.saturating_sub(30)..n)
        .rev()
        .find(|&i| has_proceed_question(lines[i]))?;

    // A real prompt has the footer or the ❯ selector below the question
    let mut has_footer = false;
    let mut has_selector = false;
    for line in &lines[proceed + 1..n.min(proceed + 15)] {
        if contains_ci(line, "esc to cancel") || contains_ci(line, "ctrl-g to edit") {
            has_footer = true;
            break;
        }
        if skip_space(line).starts_with('❯') {
            has_selector = true;
        }
    }
    if !has_footer && !has_selector {
        return None;
    }

    let mut options = Vec::new();
    for line in &lines[proceed + 1..n.min(proceed + 10)] {
        if contains_ci(line, "esc to cancel") {
            break;
        }
        if let Some(option) = match_option(line) {
            options.push(option);
        }
    }
    if options.len() < 2 {
        return None;
    }

    let mut tool = "Unknown";
    for i in (proceed.saturating_sub(20)..=proceed).rev() {
        if let Some(t) = match_tool_header(lines[i]).or_else(|| match_tool_command(lines[i])) {
            tool = t;
            break;
        }
    }

    let context_start = proceed.saturating_sub(10);
    let context_end = n.min(proceed + 1 + options.len());
    let context = trim(&lines[context_start..context_end].join("\n")).to_string();

    Some(PermissionPrompt {
        tool: tool.to_string(),
        context,
        options,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn option_edge_cases_follow_js_backtracking() {
        let opt = |l: &str| match_option(l).map(|o| (o.number, o.label));
        assert_eq!(opt("❯ 1. Yes"), Some(("1".into(), "Yes".into())));
        assert_eq!(
            opt("> 12.  Two  spaces "),
            Some(("12".into(), "Two  spaces".into()))
        );
        // all-whitespace label: \s+ gives one char back to (.+), trimmed to ""
        assert_eq!(opt("1.   "), Some(("1".into(), "".into())));
        assert_eq!(opt("1. "), None);
        assert_eq!(opt("1.x"), None);
        // CRLF: `.` can't match \r and `$` needs the end
        assert_eq!(opt("1. Yes\r"), None);
        assert_eq!(opt("❯❯ 1. x"), None);
    }

    #[test]
    fn tool_matchers() {
        assert_eq!(match_tool_header("  ● Bash(ls)"), Some("Bash"));
        assert_eq!(match_tool_header("x · Read (a)"), Some("Read"));
        assert_eq!(match_tool_header("● (x) ◐ Edit("), Some("Edit"));
        assert_eq!(match_tool_header("● Bash"), None);
        assert_eq!(match_tool_command("  bash command"), Some("bash"));
        assert_eq!(match_tool_command("WebFetch url"), Some("WebFetch"));
        assert_eq!(match_tool_command("Bashful x"), None);
        assert_eq!(match_tool_command("Read"), None);
    }

    #[test]
    fn float_prefix_like_parse_float() {
        assert_eq!(parse_float_prefix("12.5"), Some(12.5));
        assert_eq!(parse_float_prefix("12"), Some(12.0));
        assert_eq!(parse_float_prefix("1.2.3"), Some(1.2));
        assert_eq!(parse_float_prefix(".5"), Some(0.5));
        assert_eq!(parse_float_prefix("5."), Some(5.0));
        assert_eq!(parse_float_prefix("."), None);
        assert_eq!(parse_float_prefix("..5"), None);
    }
}
