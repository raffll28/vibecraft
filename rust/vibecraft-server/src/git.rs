//! Git status per session directory. Port of server/GitStatusManager.ts:
//! the same git commands and parsing, run without holding the state lock.

use std::io::Read;
use std::process::{Command, Stdio};
use std::thread;
use std::time::{Duration, Instant};

use serde_json::{Value, json};

use crate::routes::now_ms;
use crate::state::{Shared, lock};

const POLL_INTERVAL: Duration = Duration::from_secs(5);
/// Every Nth poll checks every session, to catch changes made outside Claude
const FULL_POLL_EVERY: u64 = 12;
const EXEC_TIMEOUT: Duration = Duration::from_secs(5);
/// Fields whose change triggers a sessions broadcast
const COMPARED: [&str; 7] = [
    "branch",
    "ahead",
    "behind",
    "totalFiles",
    "linesAdded",
    "linesRemoved",
    "lastCommitTime",
];

/// Run git with a timeout; stdout on success
fn git(args: &[&str], dir: &str) -> Option<String> {
    let mut child = Command::new("git")
        .args(args)
        .current_dir(dir)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .ok()?;
    let mut stdout = child.stdout.take()?;
    let reader = thread::spawn(move || {
        let mut out = Vec::new();
        let _ = stdout.read_to_end(&mut out);
        out
    });
    let deadline = Instant::now() + EXEC_TIMEOUT;
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break status,
            Ok(None) if Instant::now() < deadline => thread::sleep(Duration::from_millis(5)),
            _ => {
                let _ = child.kill();
                let _ = child.wait();
                return None;
            }
        }
    };
    let out = reader.join().ok()?;
    status
        .success()
        .then(|| String::from_utf8_lossy(&out).into_owned())
}

/// JS `/(\d+) <word>/i`: the number right before the first "<n> <word>"
fn number_before(output: &str, word: &str) -> Option<u64> {
    let lower = output.to_ascii_lowercase();
    let needle = format!(" {word}");
    let mut from = 0;
    while let Some(pos) = lower[from..].find(&needle) {
        let at = from + pos;
        let digits_start = lower[..at]
            .rfind(|c: char| !c.is_ascii_digit())
            .map_or(0, |i| i + 1);
        if digits_start < at {
            return lower[digits_start..at].parse().ok();
        }
        from = at + 1;
    }
    None
}

pub fn git_status(dir: &str) -> Value {
    let mut status = json!({
        "branch": "",
        "ahead": 0,
        "behind": 0,
        "staged": { "added": 0, "modified": 0, "deleted": 0 },
        "unstaged": { "added": 0, "modified": 0, "deleted": 0 },
        "untracked": 0,
        "totalFiles": 0,
        "linesAdded": 0,
        "linesRemoved": 0,
        "lastCommitTime": null,
        "lastCommitMessage": null,
        "isRepo": false,
        "lastChecked": now_ms(),
    });
    if git(&["rev-parse", "--git-dir"], dir).is_none() {
        return status;
    }
    status["isRepo"] = json!(true);

    let run = |args: &[&str]| git(args, dir).unwrap_or_default();
    status["branch"] = json!(run(&["rev-parse", "--abbrev-ref", "HEAD"]).trim());

    if let Some(ab) = git(
        &["rev-list", "--left-right", "--count", "@{upstream}...HEAD"],
        dir,
    ) {
        let mut parts = ab.split_whitespace().map(|n| n.parse::<u64>().unwrap_or(0));
        status["behind"] = json!(parts.next().unwrap_or(0));
        status["ahead"] = json!(parts.next().unwrap_or(0));
    }

    let (mut staged, mut unstaged, mut untracked) = ([0u64; 3], [0u64; 2], 0u64);
    // trimEnd, not trim: the leading space of " M file" is the staged column
    for line in run(&["status", "--porcelain"])
        .trim_end()
        .split('\n')
        .filter(|l| !l.is_empty())
    {
        let mut chars = line.chars();
        let (x, y) = (chars.next(), chars.next());
        match x {
            Some('A') => staged[0] += 1,
            Some('M') => staged[1] += 1,
            Some('D') => staged[2] += 1,
            _ => {}
        }
        match y {
            Some('M') => unstaged[0] += 1,
            Some('D') => unstaged[1] += 1,
            _ => {}
        }
        if x == Some('?') && y == Some('?') {
            untracked += 1;
        }
    }
    status["staged"] = json!({ "added": staged[0], "modified": staged[1], "deleted": staged[2] });
    status["unstaged"] = json!({ "added": 0, "modified": unstaged[0], "deleted": unstaged[1] });
    status["untracked"] = json!(untracked);
    status["totalFiles"] =
        json!(staged.iter().sum::<u64>() + unstaged.iter().sum::<u64>() + untracked);

    let diff = |args: &[&str]| {
        let out = run(args);
        (
            number_before(&out, "insertion").unwrap_or(0),
            number_before(&out, "deletion").unwrap_or(0),
        )
    };
    let (staged_add, staged_del) = diff(&["diff", "--cached", "--shortstat"]);
    let (unstaged_add, unstaged_del) = diff(&["diff", "--shortstat"]);
    status["linesAdded"] = json!(staged_add + unstaged_add);
    status["linesRemoved"] = json!(staged_del + unstaged_del);

    let log = run(&["log", "-1", "--format=%ct|||%s"]);
    if !log.is_empty() {
        let mut parts = log.trim().split("|||");
        let time = parts
            .next()
            .and_then(|t| t.parse::<u64>().ok())
            .filter(|&t| t != 0);
        let message = parts.next().filter(|m| !m.is_empty());
        status["lastCommitTime"] = json!(time);
        status["lastCommitMessage"] = json!(message);
    }
    status
}

/// Fetch one session's status and broadcast sessions if it changed
pub fn refresh(shared: &Shared, session_id: &str, dir: &str) {
    let status = git_status(dir);
    let mut state = lock(shared);
    // Untracked (deleted) meanwhile: drop the result
    if !state.git_dirs.iter().any(|(id, _)| id == session_id) {
        return;
    }
    let changed = state
        .git_cache
        .get(session_id)
        .is_none_or(|old| COMPARED.iter().any(|k| old[k] != status[k]));
    state.git_cache.insert(session_id.to_string(), status);
    if changed && state.session_index(session_id).is_some() {
        state.broadcast_sessions();
    }
}

/// Start tracking a session's directory and fetch its status in the background
pub fn track(shared: &Shared, session_id: &str, dir: &str) {
    {
        let mut state = lock(shared);
        state.git_dirs.retain(|(id, _)| id != session_id);
        state
            .git_dirs
            .push((session_id.to_string(), dir.to_string()));
    }
    let (shared, id, dir) = (shared.clone(), session_id.to_string(), dir.to_string());
    thread::spawn(move || refresh(&shared, &id, &dir));
}

/// Poll dirty sessions every 5 s, and all of them every minute
pub fn poll_loop(shared: &Shared) {
    let mut count = 0u64;
    loop {
        let entries: Vec<(String, String)> = {
            let mut state = lock(shared);
            let full = count.is_multiple_of(FULL_POLL_EVERY);
            count += 1;
            let entries = state
                .git_dirs
                .iter()
                .filter(|(id, _)| full || state.git_dirty.contains(id))
                .cloned()
                .collect();
            state.git_dirty.clear();
            entries
        };
        for (id, dir) in entries {
            refresh(shared, &id, &dir);
        }
        thread::sleep(POLL_INTERVAL);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn shortstat_numbers() {
        let out = " 2 files changed, 12 insertions(+), 3 deletions(-)";
        assert_eq!(number_before(out, "insertion"), Some(12));
        assert_eq!(number_before(out, "deletion"), Some(3));
        assert_eq!(
            number_before(" 1 file changed, 1 deletion(-)", "insertion"),
            None
        );
        assert_eq!(
            number_before(" 1 file changed, 1 deletion(-)", "deletion"),
            Some(1)
        );
    }
}
