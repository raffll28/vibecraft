#!/bin/bash
# Vibecraft Hook - Captures Claude Code events for 3D visualization
#
# This script is called by Claude Code hooks and:
# 1. Reads the hook input from stdin
# 2. Transforms it into our event format
# 3. Appends to the events JSONL file
# 4. Optionally notifies the WebSocket server
#
# Installed to: ~/.vibecraft/hooks/vibecraft-hook.sh
# Run `npx vibecraft setup` to install/update this hook.
#
# Hooks run synchronously on every tool call, so this script keeps process
# spawns to a minimum: one jq call builds the whole event (plus one tail when
# the transcript is needed, and a backgrounded curl).

# =============================================================================
# Cross-Platform PATH Setup
# Hooks may run with a minimal PATH. Add common tool locations defensively.
# =============================================================================

KNOWN_PATHS=(
  "/opt/homebrew/bin"      # macOS Apple Silicon Homebrew
  "/usr/local/bin"         # macOS Intel Homebrew / Linux local
  "$HOME/.local/bin"       # User local bin
  "/usr/bin"               # System binaries
  "/bin"                   # Core binaries
)

for dir in "${KNOWN_PATHS[@]}"; do
  [ -d "$dir" ] && export PATH="$dir:$PATH"
done

# =============================================================================
# Tool Discovery
# Find required tools, searching known locations if not in PATH
# =============================================================================

find_tool() {
  local name="$1"

  # Check PATH first
  local found=$(command -v "$name" 2>/dev/null)
  if [ -n "$found" ]; then
    echo "$found"
    return 0
  fi

  # Check known locations
  for dir in "${KNOWN_PATHS[@]}"; do
    if [ -x "$dir/$name" ]; then
      echo "$dir/$name"
      return 0
    fi
  done

  return 1
}

# Find required tools
JQ=$(find_tool "jq") || {
  echo "vibecraft-hook: ERROR - jq not found. Install it:" >&2
  echo "  macOS: brew install jq" >&2
  echo "  Linux: apt install jq (or yum install jq)" >&2
  exit 1
}

CURL=$(find_tool "curl") || {
  # curl is optional - just disable notifications if not found
  CURL=""
}

# =============================================================================
# Configuration
# =============================================================================

# IMPORTANT: Use ~/.vibecraft/ as the data directory to ensure consistent
# location regardless of how vibecraft was installed (npx, global npm, local dev).
VIBECRAFT_DATA_DIR="${VIBECRAFT_DATA_DIR:-$HOME/.vibecraft/data}"
EVENTS_FILE="${VIBECRAFT_EVENTS_FILE:-$VIBECRAFT_DATA_DIR/events.jsonl}"
WS_NOTIFY_URL="${VIBECRAFT_WS_NOTIFY:-http://localhost:4003/event}"
ENABLE_WS_NOTIFY="${VIBECRAFT_ENABLE_WS_NOTIFY:-true}"

# Longer strings inside toolResponse are truncated. The feed only previews the
# first few hundred characters, and full Read/Bash outputs bloat events.jsonl.
MAX_RESPONSE_CHARS="${VIBECRAFT_MAX_RESPONSE_CHARS:-4096}"

# Ensure data directory exists
events_dir="${EVENTS_FILE%/*}"
[ -d "$events_dir" ] || mkdir -p "$events_dir"

# =============================================================================
# Read Input
# =============================================================================

# cat, not $(</dev/stdin): Node gives hooks a socket for stdin, and opening
# /dev/stdin on a socket fails on Linux (ENXIO), which left input empty.
input=$(cat)

# Generate timestamp (ms) and a unique ID suffix
if [ -n "$EPOCHREALTIME" ]; then
  # bash 5+: no process spawn. Strip the radix char, which is locale-dependent.
  now_us=${EPOCHREALTIME//[!0-9]/}
  timestamp=$((now_us / 1000))
  printf -v id_suffix '%s%03d' "$now_us" $((RANDOM % 1000))
elif command -v perl &> /dev/null; then
  # bash 3.2 (macOS default)
  timestamp=$(perl -MTime::HiRes=time -e 'printf "%.0f", time * 1000')
  id_suffix="${timestamp}-${RANDOM}"
elif command -v python3 &> /dev/null; then
  timestamp=$(python3 -c 'import time; print(int(time.time() * 1000))')
  id_suffix="${timestamp}-${RANDOM}"
else
  timestamp=$(($(date +%s) * 1000 + RANDOM % 1000))
  id_suffix="${timestamp}-${RANDOM}"
fi

# Only PreToolUse and Stop/SubagentStop read the transcript. Peek at the hook
# name and transcript path with bash regexes so we don't spend a jq call on it.
# (Quotes inside tool_input strings are escaped, so these can't match there.)
transcript_lines=0
name_re='"hook_event_name"[[:space:]]*:[[:space:]]*"([A-Za-z]+)"'
if [[ $input =~ $name_re ]]; then
  case "${BASH_REMATCH[1]}" in
    PreToolUse)        transcript_lines=30 ;;
    Stop|SubagentStop) transcript_lines=200 ;;
  esac
fi

transcript_path=""
path_re='"transcript_path"[[:space:]]*:[[:space:]]*"([^"]+)"'
if [ "$transcript_lines" -gt 0 ] && [[ $input =~ $path_re ]]; then
  transcript_path="${BASH_REMATCH[1]}"
fi

# =============================================================================
# Build Event JSON
# =============================================================================

# The transcript tail is passed as raw text and parsed line by line inside jq,
# so a partially written last line can't break the whole event.
read_transcript() {
  [ -n "$transcript_path" ] && [ -f "$transcript_path" ] &&
    tail -n "$transcript_lines" "$transcript_path"
  return 0
}

event=$("$JQ" -c \
  --arg idSuffix "$id_suffix" \
  --argjson timestamp "$timestamp" \
  --argjson maxChars "$MAX_RESPONSE_CHARS" \
  --rawfile transcript <(read_transcript) \
  '
  def str($default): (. // $default | tostring);

  def transcript_entries:
    $transcript | split("\n") | map(select(length > 0) | (try fromjson catch empty));

  # Assistant text that came after the last user message (before this tool call)
  def assistant_text:
    try (
      transcript_entries
      | (to_entries | map(select(.value.type == "user")) | last | .key) as $last_user
      | to_entries | map(select(.key > ($last_user // -1))) | map(.value)
      | map(select(.type == "assistant"))
      | map(.message.content | map(select(.type == "text")) | map(.text))
      | flatten | join("\n")
    ) catch "";

  # Latest assistant message that has text
  def last_response:
    try (
      [transcript_entries[]
        | select(.type == "assistant")
        | select(.message.content | map(select(.type == "text")) | length > 0)]
      | last | .message.content | map(select(.type == "text")) | map(.text) | join("\n")
    ) catch "";

  def truncate_strings:
    walk(if type == "string" and length > $maxChars
         then .[:$maxChars] + "…[truncated]"
         else . end);

  . as $h
  | ({
      PreToolUse: "pre_tool_use",
      PostToolUse: "post_tool_use",
      Stop: "stop",
      SubagentStop: "subagent_stop",
      SessionStart: "session_start",
      SessionEnd: "session_end",
      UserPromptSubmit: "user_prompt_submit",
      Notification: "notification",
      PreCompact: "pre_compact"
    }[$h.hook_event_name | tostring] // "unknown") as $type
  | ($h.session_id | str("unknown")) as $sessionId
  | {
      id: ($sessionId + "-" + $idSuffix),
      timestamp: $timestamp,
      type: $type,
      sessionId: $sessionId,
      cwd: ($h.cwd | str(""))
    }
  + if $type == "pre_tool_use" then {
      tool: ($h.tool_name | str("unknown")),
      toolInput: ($h.tool_input // {}),
      toolUseId: ($h.tool_use_id | str("")),
      assistantText: assistant_text
    }
    elif $type == "post_tool_use" then {
      tool: ($h.tool_name | str("unknown")),
      toolInput: ($h.tool_input // {}),
      toolResponse: ($h.tool_response // {} | truncate_strings),
      toolUseId: ($h.tool_use_id | str("")),
      success: ((try $h.tool_response.success catch null) != false)
    }
    elif $type == "stop" or $type == "subagent_stop" then {
      stopHookActive: ($h.stop_hook_active // false),
      response: last_response
    }
    elif $type == "session_start" then { source: ($h.source | str("startup")) }
    elif $type == "session_end" then { reason: ($h.reason | str("other")) }
    elif $type == "user_prompt_submit" then { prompt: ($h.prompt | str("")) }
    elif $type == "notification" then {
      message: ($h.message | str("")),
      notificationType: ($h.notification_type | str("unknown"))
    }
    elif $type == "pre_compact" then {
      trigger: ($h.trigger | str("manual")),
      customInstructions: ($h.custom_instructions | str(""))
    }
    else { raw: $h }
    end
  ' <<<"$input") || exit 0  # Never disturb Claude over a malformed event

# =============================================================================
# Output Event
# =============================================================================

# Append event to JSONL file
printf '%s\n' "$event" >> "$EVENTS_FILE"

# Notify WebSocket server (fire and forget, don't block Claude).
# The body goes through stdin: as a single argv entry it would fail past
# Linux's 128 KiB per-argument limit.
if [ "$ENABLE_WS_NOTIFY" = "true" ] && [ -n "$CURL" ]; then
  "$CURL" -s -X POST "$WS_NOTIFY_URL" \
    -H "Content-Type: application/json" \
    --data-binary @- \
    --connect-timeout 1 \
    --max-time 2 \
    >/dev/null 2>&1 <<<"$event" &
fi

exit 0
