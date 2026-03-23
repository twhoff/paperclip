#!/usr/bin/env bash
# Pre-tool-use wrapper for context-mode hooks.
# Allows curl/wget to localhost (Paperclip API) while delegating
# all other commands to context-mode's routing logic.
set -euo pipefail

INPUT=$(cat)

TOOL_NAME=$(echo "$INPUT" | python3 -c "import sys,json; print(json.load(sys.stdin).get('tool_name',''))" 2>/dev/null || echo "")

if [ "$TOOL_NAME" = "Bash" ]; then
  COMMAND=$(echo "$INPUT" | python3 -c "import sys,json; print(json.load(sys.stdin).get('tool_input',{}).get('command',''))" 2>/dev/null || echo "")

  # Allow curl/wget to localhost (Paperclip API at 127.0.0.1:3100)
  # Match literal localhost addresses OR Paperclip env var references
  if echo "$COMMAND" | grep -qiE '(curl|wget)\s' && \
     echo "$COMMAND" | grep -qiE '(localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\]|\$PAPERCLIP_API_URL|\$\{PAPERCLIP_API_URL)'; then
    exit 0  # empty output = passthrough
  fi
fi

# Delegate everything else to context-mode
echo "$INPUT" | context-mode hook claude-code pretooluse
