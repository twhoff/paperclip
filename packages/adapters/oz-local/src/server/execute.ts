import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type { AdapterExecutionContext, AdapterExecutionResult } from '@paperclipai/adapter-utils'
import {
  asBoolean,
  asNumber,
  asString,
  asStringArray,
  buildPaperclipEnv,
  finalizeLocalAdapterEnv,
  ensureAbsoluteDirectory,
  ensurePaperclipSkillSymlink,
  ensureCommandResolvable,
  ensurePathInEnv,
  joinPromptSections,
  listPaperclipSkillEntries,
  parseObject,
  readInstalledSkillTargets,
  redactEnvForLogs,
  renderTemplate,
  runLocalAdapterChildProcess
} from '@paperclipai/adapter-utils/server-utils'
import { DEFAULT_OZ_MODEL } from '../index.js'
import { isOzUnknownConversationError, parseOzOutput } from './parse.js'
import { resolveProfileByName } from './profiles.js'

const __moduleDir = path.dirname(fileURLToPath(import.meta.url))

// Note injected into every prompt to steer the agent away from `curl` (which
// is blocked by the Paperclip profile denylist) toward `pcurl`, a thin wrapper
// injected into PATH that calls curl with auth headers pre-set and compresses
// JSON responses to TOON format for token efficiency.
const PCURL_NOTE = `
## Paperclip API Access

IMPORTANT: Do NOT use \`curl\` to call the Paperclip API — it is blocked by the agent profile denylist.

Use \`pcurl\` instead. It is available in your PATH and:
- Automatically injects \`Authorization: Bearer $PAPERCLIP_API_KEY\` and \`X-Paperclip-Run-Id: $PAPERCLIP_RUN_ID\`
- Resolves the base URL automatically (no need to reference \`$PAPERCLIP_API_URL\` manually)
- Compresses JSON responses to TOON format (60-70% fewer tokens)
- Supports \`--raw\` flag for plain JSON when you need to pipe to \`jq\`

Examples:
  pcurl /api/agents/me
  pcurl /api/agents/me/inbox-lite
  pcurl /api/companies/{companyId}/issues?status=todo
  pcurl -X PATCH -H 'Content-Type: application/json' -d '{"status":"done"}' /api/issues/{issueId}
  pcurl --raw /api/companies/{companyId}/issues | jq '.[0].id'

When using psql directly, always set PAGER=cat to avoid the interactive pager:
  PAGER=cat psql -h 127.0.0.1 -p 54329 -U paperclip -d paperclip -c "SELECT ..."
`.trim()

export async function execute(ctx: AdapterExecutionContext): Promise<AdapterExecutionResult> {
  const { runId, agent, runtime, config, context, onLog, onMeta, onSpawn, authToken } = ctx

  // -------------------------------------------------------------------------
  // 1. Extract & validate config
  // -------------------------------------------------------------------------
  const command = asString(config.command, 'oz')
  const model = asString(config.model, DEFAULT_OZ_MODEL).trim()
  const profileId = asString(config.profile, '').trim()
  const profileName = asString(config.profileName, 'Paperclip').trim()
  const debug = asBoolean(config.debug, false)
  const mcpSpec = asString(config.mcp, '').trim()
  const skillSpec = asString(config.skill, '').trim()
  const agentName = asString(config.name, '').trim()
  const extraArgs = (() => {
    const fromExtraArgs = asStringArray(config.extraArgs)
    if (fromExtraArgs.length > 0) return fromExtraArgs
    return asStringArray(config.args)
  })()

  const workspaceContext = parseObject(context.paperclipWorkspace)
  const workspaceCwd = asString(workspaceContext.cwd, '')
  const workspaceSource = asString(workspaceContext.source, '')
  const workspaceId = asString(workspaceContext.workspaceId, '')
  const workspaceRepoUrl = asString(workspaceContext.repoUrl, '')
  const workspaceRepoRef = asString(workspaceContext.repoRef, '')
  const agentHome = asString(workspaceContext.agentHome, '')
  const workspaceHints = Array.isArray(context.paperclipWorkspaces)
    ? context.paperclipWorkspaces.filter(
        (value): value is Record<string, unknown> => typeof value === 'object' && value !== null
      )
    : []

  const configuredCwd = asString(config.cwd, '')
  const useConfiguredInsteadOfAgentHome =
    workspaceSource === 'agent_home' && configuredCwd.length > 0
  const effectiveWorkspaceCwd = useConfiguredInsteadOfAgentHome ? '' : workspaceCwd
  const cwd = effectiveWorkspaceCwd || configuredCwd || process.cwd()
  await ensureAbsoluteDirectory(cwd, { createIfMissing: true })

  const timeoutSec = asNumber(config.timeoutSec, 0)
  const graceSec = asNumber(config.graceSec, 20)

  // -------------------------------------------------------------------------
  // 2. Build environment
  // -------------------------------------------------------------------------
  const envConfig = parseObject(config.env)
  const hasExplicitApiKey =
    typeof envConfig.PAPERCLIP_API_KEY === 'string' && envConfig.PAPERCLIP_API_KEY.trim().length > 0

  const env: Record<string, string> = { ...buildPaperclipEnv(agent) }
  env.PAPERCLIP_RUN_ID = runId

  // Context env vars
  const wakeTaskId =
    (typeof context.taskId === 'string' &&
      context.taskId.trim().length > 0 &&
      context.taskId.trim()) ||
    (typeof context.issueId === 'string' &&
      context.issueId.trim().length > 0 &&
      context.issueId.trim()) ||
    null
  const wakeReason =
    typeof context.wakeReason === 'string' && context.wakeReason.trim().length > 0
      ? context.wakeReason.trim()
      : null
  const wakeCommentId =
    (typeof context.wakeCommentId === 'string' &&
      context.wakeCommentId.trim().length > 0 &&
      context.wakeCommentId.trim()) ||
    (typeof context.commentId === 'string' &&
      context.commentId.trim().length > 0 &&
      context.commentId.trim()) ||
    null
  const approvalId =
    typeof context.approvalId === 'string' && context.approvalId.trim().length > 0
      ? context.approvalId.trim()
      : null
  const approvalStatus =
    typeof context.approvalStatus === 'string' && context.approvalStatus.trim().length > 0
      ? context.approvalStatus.trim()
      : null
  const linkedIssueIds = Array.isArray(context.issueIds)
    ? context.issueIds.filter(
        (value): value is string => typeof value === 'string' && value.trim().length > 0
      )
    : []

  if (wakeTaskId) env.PAPERCLIP_TASK_ID = wakeTaskId
  if (wakeReason) env.PAPERCLIP_WAKE_REASON = wakeReason
  if (wakeCommentId) env.PAPERCLIP_WAKE_COMMENT_ID = wakeCommentId
  if (approvalId) env.PAPERCLIP_APPROVAL_ID = approvalId
  if (approvalStatus) env.PAPERCLIP_APPROVAL_STATUS = approvalStatus
  if (linkedIssueIds.length > 0) env.PAPERCLIP_LINKED_ISSUE_IDS = linkedIssueIds.join(',')
  if (effectiveWorkspaceCwd) env.PAPERCLIP_WORKSPACE_CWD = effectiveWorkspaceCwd
  if (workspaceSource) env.PAPERCLIP_WORKSPACE_SOURCE = workspaceSource
  if (workspaceId) env.PAPERCLIP_WORKSPACE_ID = workspaceId
  if (workspaceRepoUrl) env.PAPERCLIP_WORKSPACE_REPO_URL = workspaceRepoUrl
  if (workspaceRepoRef) env.PAPERCLIP_WORKSPACE_REPO_REF = workspaceRepoRef
  if (agentHome) env.AGENT_HOME = agentHome
  if (workspaceHints.length > 0) env.PAPERCLIP_WORKSPACES_JSON = JSON.stringify(workspaceHints)

  // User-provided env overrides
  for (const [key, value] of Object.entries(envConfig)) {
    if (typeof value === 'string') env[key] = value
  }
  finalizeLocalAdapterEnv(agent, env, envConfig)

  // Inject Paperclip API key so pcurl can authenticate back to the Paperclip server.
  // WARP_API_KEY is intentionally NOT injected here: Oz authenticates to the Warp cloud
  // via its own stored session (from `oz login`). Injecting the Paperclip API key as
  // WARP_API_KEY causes Oz to use it for Warp cloud auth, which fails with 401.
  if (!hasExplicitApiKey && authToken) {
    env.PAPERCLIP_API_KEY = authToken
  }

  const effectiveEnv = Object.fromEntries(
    Object.entries({ ...process.env, ...env }).filter(
      (entry): entry is [string, string] => typeof entry[1] === 'string'
    )
  )
  // Inject scripts/context-mode/ into PATH so pcurl and json2toon are
  // discoverable by the Oz agent without triggering the curl denylist.
  const scriptsModeDir = path.resolve(
    path.dirname(new URL(import.meta.url).pathname),
    '../../../../../scripts/context-mode'
  )
  const envWithScripts = {
    ...effectiveEnv,
    PATH: `${scriptsModeDir}:${effectiveEnv.PATH ?? process.env.PATH ?? ''}`
  }
  const runtimeEnv = ensurePathInEnv(envWithScripts)
  await ensureCommandResolvable(command, cwd, runtimeEnv)

  // -------------------------------------------------------------------------
  // 2b. Auto-sync Paperclip skills to ~/.warp/skills/
  // -------------------------------------------------------------------------
  const ozSkillsHome = path.join(env.HOME ?? process.env.HOME ?? os.homedir(), '.warp', 'skills')
  let autoSkillSpec: string | null = null
  try {
    const availableSkills = await listPaperclipSkillEntries(__moduleDir)
    if (availableSkills.length > 0) {
      await fs.mkdir(ozSkillsHome, { recursive: true })
      const installed = await readInstalledSkillTargets(ozSkillsHome)
      for (const skill of availableSkills) {
        const target = path.join(ozSkillsHome, skill.runtimeName)
        await ensurePaperclipSkillSymlink(skill.source, target)
        await onLog('stdout', `[paperclip] Skill synced: ${skill.runtimeName} → ${target}\n`)
      }
      // Use the first required skill (typically "paperclip") as the default --skill spec
      const requiredSkill = availableSkills.find((s) => s.required) ?? availableSkills[0]
      if (requiredSkill && !skillSpec) {
        autoSkillSpec = requiredSkill.runtimeName
      }
      void installed // used for future stale-link cleanup
    }
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err)
    await onLog(
      'stdout',
      `[paperclip] Warning: could not sync skills to ${ozSkillsHome}: ${reason}\n`
    )
  }

  // -------------------------------------------------------------------------
  // 2c. Resolve agent profile
  // -------------------------------------------------------------------------
  let profile = profileId
  if (!profile && profileName) {
    try {
      const resolved = await resolveProfileByName(profileName, command, envWithScripts)
      if (resolved) {
        profile = resolved.id
        await onLog(
          'stdout',
          `[paperclip] Resolved Oz profile "${resolved.name}" → ${resolved.id}\n`
        )
      } else {
        await onLog(
          'stdout',
          `[paperclip] Warning: Oz profile "${profileName}" not found. Run will proceed without a profile.\n`
        )
      }
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err)
      await onLog(
        'stdout',
        `[paperclip] Warning: could not resolve Oz profile "${profileName}": ${reason}\n`
      )
    }
  }

  // -------------------------------------------------------------------------
  // 3. Resolve session (conversation ID)
  // -------------------------------------------------------------------------
  const runtimeSessionParams = parseObject(runtime.sessionParams)
  const runtimeConversationId = asString(
    runtimeSessionParams.conversationId,
    runtime.sessionId ?? ''
  )
  const runtimeSessionCwd = asString(runtimeSessionParams.cwd, '')
  const canResumeSession =
    runtimeConversationId.length > 0 &&
    (runtimeSessionCwd.length === 0 || path.resolve(runtimeSessionCwd) === path.resolve(cwd))
  const conversationId = canResumeSession ? runtimeConversationId : null

  if (runtimeConversationId && !canResumeSession) {
    await onLog(
      'stdout',
      `[paperclip] Oz conversation "${runtimeConversationId}" was saved for cwd "${runtimeSessionCwd}" and will not be resumed in "${cwd}".\n`
    )
  }

  // -------------------------------------------------------------------------
  // 4. Load agent instructions file
  // -------------------------------------------------------------------------
  const instructionsFilePath = asString(config.instructionsFilePath, '').trim()
  const instructionsDir = instructionsFilePath ? `${path.dirname(instructionsFilePath)}/` : ''
  let instructionsPrefix = ''
  if (instructionsFilePath) {
    try {
      const instructionsContents = await fs.readFile(instructionsFilePath, 'utf8')
      instructionsPrefix =
        `${instructionsContents}\n\n` +
        `The above agent instructions were loaded from ${instructionsFilePath}. ` +
        `Resolve any relative file references from ${instructionsDir}.\n\n`
      await onLog('stdout', `[paperclip] Loaded agent instructions file: ${instructionsFilePath}\n`)
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err)
      await onLog(
        'stdout',
        `[paperclip] Warning: could not read agent instructions file "${instructionsFilePath}": ${reason}\n`
      )
    }
  }

  // -------------------------------------------------------------------------
  // 5. Render prompt
  // -------------------------------------------------------------------------
  const promptTemplate = asString(
    config.promptTemplate,
    'You are Paperclip-native agent {{agent.id}} ({{agent.name}}). Continue your Paperclip work.'
  )
  const bootstrapPromptTemplate = asString(config.bootstrapPromptTemplate, '')
  const templateData = {
    agentId: agent.id,
    companyId: agent.companyId,
    runId,
    company: { id: agent.companyId },
    agent,
    run: { id: runId, source: 'on_demand' },
    context
  }
  const renderedPrompt = renderTemplate(promptTemplate, templateData)
  const renderedBootstrapPrompt =
    !conversationId && bootstrapPromptTemplate.trim().length > 0
      ? renderTemplate(bootstrapPromptTemplate, templateData).trim()
      : ''
  const sessionHandoffNote = asString(context.paperclipSessionHandoffMarkdown, '').trim()
  const prompt = joinPromptSections([
    instructionsPrefix,
    PCURL_NOTE,
    renderedBootstrapPrompt,
    sessionHandoffNote,
    renderedPrompt
  ])

  // -------------------------------------------------------------------------
  // 6. Build args and run
  // -------------------------------------------------------------------------
  const buildArgs = (resumeConversationId: string | null): string[] => {
    const args = ['agent', 'run']
    // Structured JSON output for proper event parsing
    args.push('--output-format', 'json')
    // Prompt or conversation resume
    if (resumeConversationId) {
      args.push('--conversation', resumeConversationId)
      args.push('--prompt', prompt)
    } else {
      args.push('--prompt', prompt)
    }
    // Model
    if (model && model !== DEFAULT_OZ_MODEL) {
      args.push('--model', model)
    }
    // Working directory
    args.push('--cwd', cwd)
    // Profile (permissions)
    if (profile) args.push('--profile', profile)
    // MCP servers
    if (mcpSpec) args.push('--mcp', mcpSpec)
    // Skill — use explicit config value, fall back to auto-resolved required skill
    const effectiveSkillSpec = skillSpec || autoSkillSpec || ''
    if (effectiveSkillSpec) args.push('--skill', effectiveSkillSpec)
    // Name for traceability
    if (agentName) {
      args.push('--name', agentName)
    } else {
      args.push('--name', `paperclip-run-${runId.slice(0, 8)}`)
    }
    // Debug logging
    if (debug) args.push('--debug')
    // Extra args
    if (extraArgs.length > 0) args.push(...extraArgs)
    return args
  }

  const commandNotes = [
    'Prompt is passed via --prompt for non-interactive execution.',
    ...(conversationId
      ? [`Resuming conversation: ${conversationId}`]
      : ['Starting a new conversation.']),
    ...(mcpSpec ? [`MCP spec: ${mcpSpec}`] : []),
    ...(skillSpec || autoSkillSpec ? [`Skill: ${skillSpec || autoSkillSpec}`] : []),
    ...(instructionsFilePath && instructionsPrefix
      ? [`Loaded agent instructions from ${instructionsFilePath}`]
      : [])
  ]

  const runAttempt = async (resumeConversationId: string | null) => {
    const args = buildArgs(resumeConversationId)
    await onMeta?.({
      adapterType: 'oz_local',
      command,
      cwd,
      commandNotes,
      commandArgs: args.map((value, index) =>
        index === args.length - 1 && value === prompt ? `<prompt ${prompt.length} chars>` : value
      ),
      env: redactEnvForLogs(env),
      prompt,
      promptMetrics: {
        promptChars: prompt.length,
        instructionsChars: instructionsPrefix.length,
        bootstrapPromptChars: renderedBootstrapPrompt.length,
        sessionHandoffChars: sessionHandoffNote.length,
        heartbeatPromptChars: renderedPrompt.length
      },
      context
    })

    const proc = await runLocalAdapterChildProcess(agent, runId, command, args, {
      cwd,
      env: envWithScripts,
      timeoutSec,
      graceSec,
      onSpawn,
      onLog
    })
    return proc
  }

  // -------------------------------------------------------------------------
  // 7. Execute (with session retry on stale conversation)
  // -------------------------------------------------------------------------
  const initial = await runAttempt(conversationId)
  const initialParsed = parseOzOutput(initial.stdout, initial.stderr)

  if (
    conversationId &&
    !initial.timedOut &&
    (initial.exitCode ?? 0) !== 0 &&
    isOzUnknownConversationError(initial.stdout, initial.stderr)
  ) {
    await onLog(
      'stdout',
      `[paperclip] Oz conversation "${conversationId}" is unavailable; retrying with a fresh conversation.\n`
    )
    const retry = await runAttempt(null)
    const retryParsed = parseOzOutput(retry.stdout, retry.stderr)
    const retryCredits = await fetchOzRunCredits(command, retryParsed.runId, envWithScripts)
    return toResult(
      retry,
      retryParsed,
      cwd,
      model,
      workspaceId,
      workspaceRepoUrl,
      workspaceRepoRef,
      timeoutSec,
      true,
      true,
      retryCredits
    )
  }

  const initialCredits = await fetchOzRunCredits(command, initialParsed.runId, envWithScripts)
  return toResult(
    initial,
    initialParsed,
    cwd,
    model,
    workspaceId,
    workspaceRepoUrl,
    workspaceRepoRef,
    timeoutSec,
    false,
    false,
    initialCredits
  )
}

/**
 * After a run completes, fetch credit usage from the Warp REST API.
 *
 * Calls: GET https://oz.warp.dev/api/v1/agent/runs/<ozRunId>
 * Requires WARP_API_KEY in env (a real Warp API key, not the Paperclip agent key).
 *
 * Note: `oz run get --output-format json` is broken in the current CLI version —
 * it ignores the flag and always outputs the TUI pretty format. The REST API is
 * the only reliable way to obtain cost data.
 *
 * Returns inference_cost from request_usage, or null if unavailable.
 */
async function fetchOzRunCredits(
  _command: string,
  runId: string | null,
  env: Record<string, string>
): Promise<number | null> {
  if (!runId) return null
  const warpApiKey = env.WARP_API_KEY
  if (!warpApiKey) return null
  try {
    const res = await fetch(`https://oz.warp.dev/api/v1/agent/runs/${encodeURIComponent(runId)}`, {
      headers: { Authorization: `Bearer ${warpApiKey}` },
      signal: AbortSignal.timeout(15_000)
    })
    if (!res.ok) return null
    const data = (await res.json()) as Record<string, unknown>
    const usage = data.request_usage as Record<string, unknown> | null | undefined
    if (!usage) return null
    const inference = typeof usage.inference_cost === 'number' ? usage.inference_cost : 0
    const compute = typeof usage.compute_cost === 'number' ? usage.compute_cost : 0
    const total = inference + compute
    return total > 0 ? total : null
  } catch {
    return null
  }
}

function toResult(
  proc: {
    exitCode: number | null
    signal: string | null
    timedOut: boolean
    stdout: string
    stderr: string
  },
  parsed: ReturnType<typeof parseOzOutput>,
  cwd: string,
  model: string,
  workspaceId: string,
  workspaceRepoUrl: string,
  workspaceRepoRef: string,
  timeoutSec: number,
  clearSessionOnMissingConversation: boolean,
  isRetry: boolean,
  costCredits: number | null = null
): AdapterExecutionResult {
  if (proc.timedOut) {
    return {
      exitCode: proc.exitCode,
      signal: proc.signal,
      timedOut: true,
      errorMessage: `Timed out after ${timeoutSec}s`,
      errorCode: parsed.requiresAuth ? 'oz_auth_required' : null,
      clearSession: clearSessionOnMissingConversation
    }
  }

  // On retry, don't fall back to old conversation ID — the old one was stale
  const resolvedConversationId = parsed.conversationId ?? (isRetry ? null : null)
  const resolvedSessionParams = resolvedConversationId
    ? ({
        conversationId: resolvedConversationId,
        cwd,
        ...(workspaceId ? { workspaceId } : {}),
        ...(workspaceRepoUrl ? { repoUrl: workspaceRepoUrl } : {}),
        ...(workspaceRepoRef ? { repoRef: workspaceRepoRef } : {})
      } as Record<string, unknown>)
    : null

  const exitOk = (proc.exitCode ?? 0) === 0
  const errorMessage = exitOk
    ? null
    : (parsed.errorMessage ?? `Oz exited with code ${proc.exitCode ?? -1}`)

  return {
    exitCode: proc.exitCode,
    signal: proc.signal,
    timedOut: false,
    errorMessage,
    errorCode: !exitOk && parsed.requiresAuth ? 'oz_auth_required' : null,
    sessionParams: resolvedSessionParams,
    sessionId: resolvedConversationId,
    sessionDisplayId: resolvedConversationId,
    provider: 'warp',
    biller: 'warp',
    billingType: 'credits',
    model,
    // Report raw Warp credits; the server converts to USD via biller_unit_prices.
    ...(costCredits !== null ? { costRawUnits: costCredits, costRawUnitType: 'credits' } : {}),
    resultJson: {
      stdout: proc.stdout,
      stderr: proc.stderr,
      ...(parsed.runId ? { ozRunId: parsed.runId, ozRunUrl: parsed.runUrl } : {})
    },
    summary: parsed.summary,
    clearSession: clearSessionOnMissingConversation && !resolvedConversationId
  }
}
