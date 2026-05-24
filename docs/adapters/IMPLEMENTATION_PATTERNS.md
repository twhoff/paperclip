# Paperclip Adapter Implementation Patterns

Practical patterns and code examples derived from existing adapters.

---

## 1. Output Parsing Pattern

### Two-Phase Parsing

1. **Server-side parse** — Extract structured data for execution result
2. **UI-side parse** — Line-by-line for real-time transcript display

### Server Parse Pattern (parse.ts)

```typescript
// Define helper functions for your adapter's output format
export function parseYourAdapterStreamJson(stdout: string) {
  let sessionId: string | null = null
  let model = ''
  let summary = ''
  const usage: UsageSummary = { inputTokens: 0, outputTokens: 0 }

  for (const rawLine of stdout.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line) continue

    // Parse JSON line defensively
    const event = parseJson(line) // returns Record<string, unknown> | null
    if (!event) continue

    const type = asString(event.type, '')

    // Handle initialization
    if (type === 'init') {
      sessionId = asString(event.session_id, sessionId ?? '') || sessionId
      model = asString(event.model, model)
      continue
    }

    // Handle messages/output
    if (type === 'message') {
      const content = asString(event.content, '')
      if (content) summary += content + '\n'
      continue
    }

    // Handle final result
    if (type === 'result') {
      const usageObj = parseObject(event.usage)
      usage.inputTokens = asNumber(usageObj.input_tokens, usage.inputTokens)
      usage.outputTokens = asNumber(usageObj.output_tokens, usage.outputTokens)
      continue
    }
  }

  return {
    sessionId,
    model,
    summary: summary.trim(),
    usage: usage.inputTokens > 0 || usage.outputTokens > 0 ? usage : null
  }
}

// Error detection helpers
export function isYourAdapterUnknownSessionError(parsed: Record<string, unknown>): boolean {
  const resultText = asString(parsed.result, '').trim()
  const allMessages = [resultText].join(' ')
  return /session.*not found|unknown session|no session/i.test(allMessages)
}

export function describeYourAdapterFailure(parsed: Record<string, unknown>): string | null {
  const resultText = asString(parsed.result, '').trim()
  const subtype = asString(parsed.subtype, '')
  if (!resultText) return null
  return subtype ? `${subtype}: ${resultText}` : resultText
}
```

### UI Parse Pattern (ui/parse-stdout.ts)

```typescript
export function parseYourAdapterStdoutLine(line: string, ts: string): TranscriptEntry[] {
  // Defensive JSON parsing
  const parsed = asRecord(safeJsonParse(line))
  if (!parsed) {
    return [{ kind: 'stdout', ts, text: line }]
  }

  const type = typeof parsed.type === 'string' ? parsed.type : ''

  // Initialization
  if (type === 'init') {
    return [
      {
        kind: 'init',
        ts,
        model: typeof parsed.model === 'string' ? parsed.model : 'unknown',
        sessionId: typeof parsed.session_id === 'string' ? parsed.session_id : ''
      }
    ]
  }

  // Message output
  if (type === 'message') {
    const content = typeof parsed.content === 'string' ? parsed.content : ''
    if (!content) return [{ kind: 'stdout', ts, text: line }]
    return [{ kind: 'assistant', ts, text: content }]
  }

  // Tool usage
  if (type === 'tool_call') {
    return [
      {
        kind: 'tool_call',
        ts,
        name: typeof parsed.name === 'string' ? parsed.name : 'unknown',
        input: parsed.input ?? {}
      }
    ]
  }

  // Tool results
  if (type === 'tool_result') {
    return [
      {
        kind: 'tool_result',
        ts,
        toolUseId: typeof parsed.tool_use_id === 'string' ? parsed.tool_use_id : '',
        content: typeof parsed.content === 'string' ? parsed.content : '',
        isError: parsed.is_error === true
      }
    ]
  }

  // Final result
  if (type === 'result') {
    const usage = asRecord(parsed.usage) ?? {}
    return [
      {
        kind: 'result',
        ts,
        text: typeof parsed.result === 'string' ? parsed.result : '',
        inputTokens: asNumber(usage.input_tokens),
        outputTokens: asNumber(usage.output_tokens),
        costUsd: asNumber(parsed.cost_usd),
        isError: parsed.is_error === true
      }
    ]
  }

  // Unknown line
  return [{ kind: 'stdout', ts, text: line }]
}

// Helper functions
function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null
  return value as Record<string, unknown>
}

function asNumber(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

function safeJsonParse(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}
```

### CLI Format Pattern (cli/format-event.ts)

```typescript
import pc from 'picocolors'

export function printYourAdapterStreamEvent(raw: string, debug: boolean): void {
  let event: Record<string, unknown>
  try {
    event = JSON.parse(raw)
  } catch {
    if (debug) console.log(pc.gray(raw))
    return
  }

  const type = typeof event.type === 'string' ? event.type : ''

  switch (type) {
    case 'init': {
      const model = typeof event.model === 'string' ? event.model : 'unknown'
      console.log(pc.blue(`[init] model=${model}`))
      break
    }
    case 'message': {
      const content = typeof event.content === 'string' ? event.content : ''
      console.log(pc.green(content))
      break
    }
    case 'tool_call': {
      const name = typeof event.name === 'string' ? event.name : 'unknown'
      console.log(pc.yellow(`→ ${name}`))
      break
    }
    case 'result': {
      const code = typeof event.exit_code === 'number' ? event.exit_code : -1
      const color = code === 0 ? pc.green : pc.red
      console.log(color(`[result] exit=${code}`))
      break
    }
    default:
      if (debug) console.log(pc.gray(raw))
  }
}
```

---

## 2. Config Building Pattern

### Form-to-Config Flow

```typescript
import type { CreateConfigValues } from '@paperclipai/adapter-utils'

// Parse helper functions
function parseCommaArgs(value: string): string[] {
  return value
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean)
}

function parseEnvVars(text: string): Record<string, string> {
  const env: Record<string, string> = {}
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const eq = trimmed.indexOf('=')
    if (eq <= 0) continue
    const key = trimmed.slice(0, eq).trim()
    const value = trimmed.slice(eq + 1)
    // Validate env var name
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue
    env[key] = value
  }
  return env
}

// Build adapter config from form values
export function buildYourAdapterConfig(v: CreateConfigValues): Record<string, unknown> {
  const ac: Record<string, unknown> = {}

  // Simple string fields
  if (v.cwd) ac.cwd = v.cwd
  if (v.model) ac.model = v.model
  if (v.promptTemplate) ac.promptTemplate = v.promptTemplate

  // Boolean fields
  if (v.debug) ac.debug = true

  // Number fields with defaults
  ac.timeoutSec = 0 // 0 = no timeout
  ac.graceSec = 15 // SIGTERM grace period

  // Parsed fields
  if (v.extraArgs) {
    ac.extraArgs = parseCommaArgs(v.extraArgs)
  }

  // Environment variables (as Record<string, string>)
  const env = parseEnvVars(v.envVars)
  if (Object.keys(env).length > 0) {
    ac.env = env
  }

  // Optional complex objects
  if (v.workspaceStrategyType === 'git_worktree') {
    ac.workspaceStrategy = {
      type: 'git_worktree',
      ...(v.workspaceBaseRef ? { baseRef: v.workspaceBaseRef } : {})
    }
  }

  return ac
}
```

---

## 3. Adapter Execution Pattern

### Core Execute Function Structure

```typescript
import type {
  AdapterExecutionContext,
  AdapterExecutionResult,
  AdapterInvocationMeta
} from '@paperclipai/adapter-utils'
import {
  asString,
  asNumber,
  asBoolean,
  parseObject,
  buildPaperclipEnv,
  redactEnvForLogs,
  renderTemplate,
  runChildProcess
} from '@paperclipai/adapter-utils/server-utils'

export async function execute(ctx: AdapterExecutionContext): Promise<AdapterExecutionResult> {
  try {
    // 1. Extract & validate config
    const cwd = asString(ctx.config.cwd, process.cwd())
    const model = asString(ctx.config.model, 'default-model')
    const timeoutSec = asNumber(ctx.config.timeoutSec, 300)
    const graceSec = asNumber(ctx.config.graceSec, 15)
    const envOverrides = parseObject(ctx.config.env)

    // 2. Build environment
    const env: Record<string, string> = { ...buildPaperclipEnv(ctx.agent) }
    env.PAPERCLIP_RUN_ID = ctx.runId

    // Inject context variables
    if (typeof ctx.context.taskId === 'string') {
      env.PAPERCLIP_TASK_ID = ctx.context.taskId
    }

    // Apply user-provided env overrides
    for (const [key, value] of Object.entries(envOverrides)) {
      if (typeof value === 'string') {
        env[key] = value
      }
    }

    // 3. Resolve session (for resumption)
    const runtimeSessionId = asString(ctx.runtime.sessionParams?.sessionId, '')
    const canResumeSession = runtimeSessionId.length > 0
    const sessionId = canResumeSession ? runtimeSessionId : null

    // 4. Render prompt from template
    const promptTemplate = asString(
      ctx.config.promptTemplate,
      'You are agent {{agent.id}}. Continue your work.'
    )
    const prompt = renderTemplate(promptTemplate, {
      agent: ctx.agent,
      run: { id: ctx.runId },
      runtime: ctx.runtime,
      context: ctx.context
    })

    // 5. Emit metadata before execution
    const args = ['--model', model, ...(sessionId ? ['--session', sessionId] : [])]
    await ctx.onMeta?.({
      adapterType: 'your_adapter',
      command: 'your-command',
      commandArgs: args,
      cwd,
      env: redactEnvForLogs(env), // Masks API keys, tokens, etc.
      prompt,
      promptMetrics: { wordCount: prompt.split(/\s+/).length }
    })

    // 6. Spawn the process
    const proc = await runChildProcess(ctx.runId, 'your-command', args, {
      cwd,
      env,
      timeout: timeoutSec,
      gracePeriod: graceSec,
      onLog: ctx.onLog // Streams output to real-time viewer
    })

    // 7. Parse output
    const parsed = parseYourAdapterStreamJson(proc.stdout)

    // 8. Handle session errors with retry
    if (sessionId && !proc.timedOut && proc.exitCode !== 0) {
      if (isYourAdapterUnknownSessionError(parseJson(proc.stdout) ?? {})) {
        // Session stale — retry fresh
        const freshProc = await runChildProcess(
          ctx.runId,
          'your-command',
          args.filter((a) => a !== sessionId),
          {
            cwd,
            env,
            timeout: timeoutSec,
            gracePeriod: graceSec,
            onLog: ctx.onLog
          }
        )
        const freshParsed = parseYourAdapterStreamJson(freshProc.stdout)
        return {
          exitCode: freshProc.exitCode,
          signal: freshProc.signal,
          timedOut: freshProc.timedOut,
          sessionParams: freshParsed.sessionId ? { sessionId: freshParsed.sessionId } : null,
          sessionDisplayId: freshParsed.sessionId,
          summary: freshParsed.summary,
          usage: freshParsed.usage,
          model,
          clearSession: true // Wipe the stale session
        }
      }
    }

    // 9. Return result
    return {
      exitCode: proc.exitCode,
      signal: proc.signal,
      timedOut: proc.timedOut,
      sessionParams: parsed.sessionId ? { sessionId: parsed.sessionId } : null,
      sessionDisplayId: parsed.sessionId,
      summary: parsed.summary,
      usage: parsed.usage,
      model,
      provider: 'your-provider',
      costUsd: parsed.costUsd ?? null,
      errorMessage: proc.exitCode !== 0 ? 'Process exited with error' : null
    }
  } catch (error) {
    // Unexpected error
    return {
      exitCode: 1,
      signal: null,
      timedOut: false,
      errorMessage: error instanceof Error ? error.message : 'Unknown error',
      summary: null
    }
  }
}
```

---

## 4. Environment Testing Pattern

### Preflight Checks

```typescript
import type {
  AdapterEnvironmentTestContext,
  AdapterEnvironmentTestResult,
  AdapterEnvironmentCheck
} from '@paperclipai/adapter-utils'

export async function testEnvironment(
  ctx: AdapterEnvironmentTestContext
): Promise<AdapterEnvironmentTestResult> {
  const checks: AdapterEnvironmentCheck[] = []

  // Check 1: Required command in PATH
  const commandCheck = await checkCommandInPath('your-command')
  checks.push({
    code: 'command-available',
    level: commandCheck ? 'info' : 'error',
    message: commandCheck ? 'your-command found in PATH' : 'your-command not found in PATH',
    hint: !commandCheck ? 'Install your-command or add it to PATH' : undefined
  })

  // Check 2: Config validation
  const cwd = asString(ctx.config.cwd, '')
  if (cwd) {
    try {
      await fs.stat(cwd)
      checks.push({
        code: 'cwd-exists',
        level: 'info',
        message: `Working directory exists: ${cwd}`
      })
    } catch {
      checks.push({
        code: 'cwd-missing',
        level: 'error',
        message: `Working directory not found: ${cwd}`,
        hint: 'Create the directory or update the path'
      })
    }
  }

  // Check 3: Authentication/API keys
  const hasApiKey = process.env.YOUR_API_KEY?.trim().length ?? 0 > 0
  checks.push({
    code: 'api-key',
    level: hasApiKey ? 'info' : 'warn',
    message: hasApiKey ? 'API key configured' : 'API key not found in environment',
    detail: hasApiKey ? 'Will use provided API key' : 'Will attempt fallback auth method'
  })

  // Check 4: Feature support
  const model = asString(ctx.config.model, '')
  checks.push({
    code: 'model-support',
    level: model ? 'info' : 'warn',
    message: model ? `Model configured: ${model}` : 'No specific model configured',
    detail: 'Will use adapter default'
  })

  // Determine overall status
  const hasErrors = checks.some((c) => c.level === 'error')
  const hasWarnings = checks.some((c) => c.level === 'warn')
  const status = hasErrors ? 'fail' : hasWarnings ? 'warn' : 'pass'

  return {
    adapterType: ctx.adapterType,
    status,
    checks,
    testedAt: new Date().toISOString()
  }
}

async function checkCommandInPath(command: string): Promise<boolean> {
  try {
    await execFile('which', [command])
    return true
  } catch {
    return false
  }
}
```

---

## 5. Session Codec Pattern

### State Serialization

```typescript
import type { AdapterSessionCodec } from '@paperclipai/adapter-utils'

function readNonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null
}

export const sessionCodec: AdapterSessionCodec = {
  /**
   * Deserialize stored session params to runtime params.
   * Return null if the input is invalid or not a session.
   */
  deserialize(raw: unknown) {
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
      return null
    }

    const record = raw as Record<string, unknown>

    // Extract session ID (try multiple field names for flexibility)
    const sessionId = readNonEmptyString(record.sessionId) ?? readNonEmptyString(record.session_id)
    if (!sessionId) return null

    // Extract working directory (try multiple field names)
    const cwd =
      readNonEmptyString(record.cwd) ??
      readNonEmptyString(record.workdir) ??
      readNonEmptyString(record.folder)

    // Build typed params object
    return {
      sessionId,
      ...(cwd ? { cwd } : {})
    }
  },

  /**
   * Serialize runtime params to DB-storable format.
   * Return null if params can't be serialized.
   */
  serialize(params: Record<string, unknown> | null) {
    if (!params) return null

    const sessionId = readNonEmptyString(params.sessionId)
    if (!sessionId) return null

    const cwd = readNonEmptyString(params.cwd)

    return {
      sessionId,
      ...(cwd ? { cwd } : {})
    }
  },

  /**
   * Extract a human-readable session display ID for the UI.
   */
  getDisplayId(params: Record<string, unknown> | null) {
    if (!params) return null
    return readNonEmptyString(params.sessionId)
  }
}
```

---

## 6. Helpers & Utilities

### Type-Safe Config Extraction

```typescript
import {
  asString,
  asNumber,
  asBoolean,
  asStringArray,
  parseObject
} from '@paperclipai/adapter-utils/server-utils'

// String with fallback
const cwd = asString(config.cwd, '/default/path')

// Number with validation
const timeoutSec = asNumber(config.timeoutSec, 300)

// Boolean flag
const debug = asBoolean(config.debug, false)

// String array (comma-separated)
const extraArgs = asStringArray(config.extraArgs)

// Object/record extraction
const env = parseObject(config.env)
```

### Environment Redaction

```typescript
import { redactEnvForLogs } from '@paperclipai/adapter-utils/server-utils'

const env = {
  ANTHROPIC_API_KEY: 'sk-ant-...',
  MY_SECRET_TOKEN: 'token-...',
  DEBUG: 'true'
}

const redacted = redactEnvForLogs(env)
// Redacted keys matching /(key|token|secret|password|authorization|cookie)/i
// Result: { ANTHROPIC_API_KEY: "***", MY_SECRET_TOKEN: "***", DEBUG: "true" }
```

### Template Rendering

```typescript
import { renderTemplate } from '@paperclipai/adapter-utils/server-utils'

const template = `
You are Paperclip-native agent {{agent.id}} ({{agent.name}}).
Your run ID is {{run.id}}.
Task: {{context.taskId}}
`

const rendered = renderTemplate(template, {
  agent: { id: 'agent-123', name: 'Claude Analyst' },
  run: { id: 'run-456' },
  context: { taskId: 'issue-789' }
})
```

---

## 7. CI/CD Patterns

### Testing the Adapter

```typescript
// packages/adapters/your-adapter/src/__tests__/your-adapter.test.ts

import { describe, it, expect } from 'vitest'
import { parseYourAdapterStreamJson } from '../server/parse'
import { buildYourAdapterConfig } from '../ui/build-config'
import { sessionCodec } from '../server/index'

describe('your adapter', () => {
  describe('output parsing', () => {
    it('parses init event', () => {
      const stdout = JSON.stringify({
        type: 'init',
        model: 'model-a',
        session_id: 'sess-123'
      })
      const result = parseYourAdapterStreamJson(stdout)
      expect(result.sessionId).toBe('sess-123')
      expect(result.model).toBe('model-a')
    })

    it('parses message content', () => {
      const stdout = JSON.stringify({
        type: 'message',
        content: 'Hello world'
      })
      const result = parseYourAdapterStreamJson(stdout)
      expect(result.summary).toContain('Hello world')
    })

    it('detects unknown session error', () => {
      const parsed = { result: 'Error: unknown session xyz' }
      expect(isYourAdapterUnknownSessionError(parsed)).toBe(true)
    })
  })

  describe('config building', () => {
    it('builds config from form values', () => {
      const values = {
        cwd: '/path/to/project',
        model: 'model-a',
        extraArgs: 'arg1, arg2'
      }
      const config = buildYourAdapterConfig(values)
      expect(config.cwd).toBe('/path/to/project')
      expect(config.model).toBe('model-a')
      expect(config.extraArgs).toEqual(['arg1', 'arg2'])
    })
  })

  describe('session codec', () => {
    it('round-trips session params', () => {
      const original = { sessionId: 'sess-123', cwd: '/project' }
      const serialized = sessionCodec.serialize(original)
      const deserialized = sessionCodec.deserialize(serialized)
      expect(deserialized).toEqual(original)
    })

    it('rejects invalid sessions', () => {
      expect(sessionCodec.deserialize({})).toBeNull()
      expect(sessionCodec.deserialize(null)).toBeNull()
      expect(sessionCodec.deserialize('not-an-object')).toBeNull()
    })
  })
})
```

---

## 8. Registration Checklist

### Server (`server/src/adapters/registry.ts`)

```typescript
import {
  execute as yourExecute,
  testEnvironment as yourTestEnvironment,
  sessionCodec as yourSessionCodec,
} from "@paperclipai/adapter-your-adapter/server";
import {
  type as yourType,
  label as yourLabel,
  models as yourModels,
  agentConfigurationDoc as yourDoc,
} from "@paperclipai/adapter-your-adapter";

const yourAdapterModule: ServerAdapterModule = {
  type: yourType,
  execute: yourExecute,
  testEnvironment: yourTestEnvironment,
  sessionCodec: yourSessionCodec,
  models: yourModels,
  supportsLocalAgentJwt: true,  // if it supports JWT-based auth
  agentConfigurationDoc: yourDoc,
};

// Add to map
const adaptersByType = new Map<string, ServerAdapterModule>(
  [..., yourAdapterModule].map((a) => [a.type, a]),
);
```

### UI (`ui/src/adapters/registry.ts`)

```typescript
import { yourAdapterUIAdapter } from "./your-adapter";

const uiAdapters: UIAdapterModule[] = [
  ...,
  yourAdapterUIAdapter,
];

const adaptersByType = new Map<string, UIAdapterModule>(
  uiAdapters.map((a) => [a.type, a]),
);
```

### CLI (`cli/src/adapters/registry.ts`)

```typescript
import { printYourAdapterStreamEvent } from "@paperclipai/adapter-your-adapter/cli";

const yourAdapterCLIAdapter: CLIAdapterModule = {
  type: "your_adapter",
  formatStdoutEvent: printYourAdapterStreamEvent,
};

const adaptersByType = new Map<string, CLIAdapterModule>(
  [
    ...,
    yourAdapterCLIAdapter,
  ].map((a) => [a.type, a]),
);
```

---

## 9. Defensive Parsing Tips

### Safe JSON Extraction

```typescript
// Parse JSON defensively
function parseJson(text: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(text)
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      return null
    }
    return parsed as Record<string, unknown>
  } catch {
    return null
  }
}

// Extract string values safely
function asString(value: unknown, fallback: string): string {
  return typeof value === 'string' ? value : fallback
}

// Extract number values safely
function asNumber(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

// Extract nested objects safely
function parseObject(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return {}
  }
  return value as Record<string, unknown>
}

// Extract arrays safely
function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value.filter((item): item is string => typeof item === 'string')
}
```

### Avoiding Common Pitfalls

```typescript
// ❌ DON'T: Trust agent output directly
const dangerousCode = event.code // Could contain malicious input
eval(dangerousCode) // NEVER

// ✅ DO: Extract and record, don't execute
const resultJson = parseJson(output)
return { resultJson, summary: 'Agent completed task' }

// ❌ DON'T: Inline secrets in prompts
const prompt = `API key: ${apiKey}. Do work...`

// ✅ DO: Inject secrets as environment variables
const env = { MY_API_KEY: apiKey }
// Agent reads from $MY_API_KEY

// ❌ DON'T: Trust file paths from output
const filePath = event.output_file
await fs.readFile(filePath) // Could read /etc/passwd

// ✅ DO: Validate paths are within expected directories
const filePath = event.output_file
const normalized = path.normalize(filePath)
if (!normalized.startsWith(projectRoot)) {
  throw new Error('Path escapes project root')
}
```

---

## References

- **Claude-Local**: Most complete reference implementation
- **Codex-Local**: Session-heavy, multi-turn focus
- **Process**: Minimal example for shell command spawning
- **HTTP**: Minimal example for API calls
