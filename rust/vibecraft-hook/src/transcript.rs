//! Transcript tail reading and text extraction.
//!
//! Mirrors `tail -n N transcript | jq` from the bash hook. The jq versions run
//! inside `try ... catch ""`, so any shape jq would choke on (a non-object entry,
//! a non-array `content`) makes the whole result "", and so does it here.

use std::fs::File;
use std::io::{Read, Seek, SeekFrom};

use serde_json::Value;

static NULL: Value = Value::Null;

/// The last `lines` lines of the file, parsed as JSON (unparseable lines skipped)
pub fn tail_entries(path: Option<&str>, lines: usize) -> Vec<Value> {
    let Some(bytes) = path.and_then(|p| tail(p, lines).ok()) else {
        return Vec::new();
    };
    bytes
        .split(|&b| b == b'\n')
        .filter(|line| !line.is_empty())
        .filter_map(|line| serde_json::from_slice(line).ok())
        .collect()
}

/// Like `tail -n lines`: read backwards in chunks until enough newlines are found
fn tail(path: &str, lines: usize) -> std::io::Result<Vec<u8>> {
    const CHUNK: u64 = 64 * 1024;
    let mut file = File::open(path)?;
    let len = file.seek(SeekFrom::End(0))?;

    let mut buf: Vec<u8> = Vec::new();
    let mut pos = len;
    while pos > 0 {
        let start = pos.saturating_sub(CHUNK);
        let mut chunk = vec![0; (pos - start) as usize];
        file.seek(SeekFrom::Start(start))?;
        file.read_exact(&mut chunk)?;
        chunk.extend_from_slice(&buf);
        buf = chunk;
        pos = start;

        // A trailing newline ends the last line rather than starting a new one
        let body = buf.strip_suffix(b"\n").unwrap_or(&buf);
        if let Some(cut) = nth_newline_from_end(body, lines) {
            return Ok(buf[cut + 1..].to_vec());
        }
    }
    Ok(buf)
}

fn nth_newline_from_end(bytes: &[u8], n: usize) -> Option<usize> {
    if n == 0 {
        return Some(bytes.len().saturating_sub(1));
    }
    bytes
        .iter()
        .enumerate()
        .rev()
        .filter(|&(_, &b)| b == b'\n')
        .map(|(i, _)| i)
        .nth(n - 1)
}

/// jq's `.key` on a value: objects index, null gives null, anything else errors
fn field<'a>(value: &'a Value, key: &str) -> Result<&'a Value, ()> {
    match value {
        Value::Object(map) => Ok(map.get(key).unwrap_or(&NULL)),
        Value::Null => Ok(&NULL),
        _ => Err(()),
    }
}

fn is_type(entry: &Value, wanted: &str) -> Result<bool, ()> {
    Ok(field(entry, "type")?.as_str() == Some(wanted))
}

/// `.message.content | map(select(.type == "text")) | map(.text)`
fn texts(entry: &Value) -> Result<Vec<&Value>, ()> {
    let content = field(field(entry, "message")?, "content")?;
    let Value::Array(items) = content else {
        return Err(());
    };
    let mut out = Vec::new();
    for item in items {
        if is_type(item, "text")? {
            out.push(field(item, "text")?);
        }
    }
    Ok(out)
}

/// jq's `join("\n")`
fn join(values: &[&Value]) -> String {
    values
        .iter()
        .map(|v| match v {
            Value::Null => String::new(),
            Value::String(s) => s.clone(),
            other => other.to_string(),
        })
        .collect::<Vec<_>>()
        .join("\n")
}

/// Assistant text that came after the last user message (before this tool call)
pub fn assistant_text(entries: &[Value]) -> String {
    let result = (|| -> Result<String, ()> {
        let mut last_user = None;
        for (i, entry) in entries.iter().enumerate() {
            if is_type(entry, "user")? {
                last_user = Some(i);
            }
        }
        let start = last_user.map_or(0, |i| i + 1);
        let mut all = Vec::new();
        for entry in &entries[start..] {
            if is_type(entry, "assistant")? {
                all.extend(texts(entry)?);
            }
        }
        Ok(join(&all))
    })();
    result.unwrap_or_default()
}

/// Latest assistant message that has text
pub fn last_response(entries: &[Value]) -> String {
    let result = (|| -> Result<String, ()> {
        let mut last = None;
        for entry in entries {
            if is_type(entry, "assistant")? {
                let t = texts(entry)?;
                if !t.is_empty() {
                    last = Some(t);
                }
            }
        }
        // jq: `last` of an empty list is null, and iterating null errors → ""
        last.map(|t| join(&t)).ok_or(())
    })();
    result.unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::io::Write;

    fn tail_str(content: &str, n: usize) -> String {
        let dir = std::env::temp_dir().join(format!(
            "vibecraft-hook-test-{}-{n}-{}",
            std::process::id(),
            content.len()
        ));
        let mut f = File::create(&dir).unwrap();
        f.write_all(content.as_bytes()).unwrap();
        let out = String::from_utf8(tail(dir.to_str().unwrap(), n).unwrap()).unwrap();
        std::fs::remove_file(&dir).unwrap();
        out
    }

    #[test]
    fn tail_matches_coreutils() {
        assert_eq!(tail_str("a\nb\nc\n", 2), "b\nc\n");
        assert_eq!(tail_str("a\nb\nc", 2), "b\nc");
        assert_eq!(tail_str("a\nb\n", 5), "a\nb\n");
        assert_eq!(tail_str("", 3), "");
        assert_eq!(tail_str("\n\n\n", 2), "\n\n");
    }

    #[test]
    fn tail_across_chunks() {
        let line = "x".repeat(1000);
        let content: String = (0..300).map(|i| format!("{i}{line}\n")).collect();
        let out = tail_str(&content, 3);
        assert_eq!(out.lines().count(), 3);
        assert!(out.starts_with("297"));
    }

    #[test]
    fn non_array_content_gives_empty_text() {
        let entries = vec![json!({"type": "assistant", "message": {"content": "plain"}})];
        assert_eq!(assistant_text(&entries), "");
        assert_eq!(last_response(&entries), "");
    }

    #[test]
    fn non_object_entry_poisons_like_jq() {
        let entries = vec![
            json!({"type": "assistant", "message": {"content": [{"type": "text", "text": "hi"}]}}),
            json!(5),
        ];
        assert_eq!(assistant_text(&entries), "");
        assert_eq!(last_response(&entries), "");
    }
}
