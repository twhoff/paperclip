#!/usr/bin/env bash
# SessionStart hook wrapper
# Calls context-mode sessionstart, then injects a Paperclip API exception
# into the additionalContext so agents know curl to localhost is allowed.

set -euo pipefail

PAPERCLIP_EXCEPTION='\\n  <paperclip_api_exception>\\n    <critical>Bash curl to localhost/127.0.0.1 is ALLOWED and REQUIRED for Paperclip API calls.</critical>\\n    <reason>PAPERCLIP_* env vars (PAPERCLIP_API_KEY, PAPERCLIP_API_URL, etc.) exist ONLY in the Bash shell. They do NOT exist in context-mode sandboxes (ctx_execute, ctx_batch_execute).</reason>\\n    <rule>You MUST use the Bash tool with curl for ALL Paperclip API calls. Do NOT use ctx_execute or ctx_batch_execute for these.</rule>\\n    <example>curl -s -H \"Authorization: Bearer $PAPERCLIP_API_KEY\" -H \"X-Paperclip-Run-Id: $PAPERCLIP_RUN_ID\" \"$PAPERCLIP_API_URL/api/agents/me\"</example>\\n  </paperclip_api_exception>'

# Pipe stdin through context-mode, then inject exception before closing tag
context-mode hook claude-code sessionstart | sed "s|</context_window_protection>|${PAPERCLIP_EXCEPTION}\\n</context_window_protection>|g"
