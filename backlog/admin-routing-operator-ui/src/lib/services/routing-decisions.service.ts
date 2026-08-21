/**
 * Service: routing-decisions
 *
 * Read-only queries against the pcli operational database tables for the
 * operator-facing decision drilldown UI (TIZA-589).
 *
 * All data comes from the pcli_* tables in the paperclip database.
 * No UI-side inference — we return raw structured payloads only.
 */

import { pcliPool } from "@/lib/pcli-db";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface AgentSummary {
  agentId: string;
  agentName: string;
  /** Current adapter from the latest decision's after_config */
  currentAdapter: string | null;
  currentModel: string | null;
  /** Latest decision timestamp */
  lastSwitchAt: string | null;
  lastSwitchReason: string | null;
  previousAdapter: string | null;
  /** Whether the last evaluation was shadow-mode */
  shadowMode: boolean;
  cooldown: CooldownState | null;
}

export interface CooldownState {
  suppressedAdapter: string | null;
  returnSuppressedUntil: string;
  remainingMs: number;
  lastSwitchReason: string | null;
  lastSwitchAt: string | null;
}

export interface DecisionEvent {
  id: number;
  sweepId: string;
  decisionType: string;
  action: string;
  beforeAdapter: string | null;
  beforeModel: string | null;
  afterAdapter: string | null;
  afterModel: string | null;
  reason: string | null;
  confidence: number | null;
  triggerType: string | null;
  shadowMode: boolean;
  candidateCount: number;
  evaluationId: number | null;
  createdAt: string;
}

export interface CandidateScore {
  id: number;
  adapterName: string;
  modelId: string | null;
  allowed: boolean;
  excludedReason: string | null;
  availabilityScore: number;
  healthPenalty: number;
  recentFailurePenalty: number;
  rateLimitPenalty: number;
  cooldownPenalty: number;
  totalScore: number;
  selected: boolean;
}

export interface CandidateScoreBreakdown {
  evaluationId: number;
  sweepId: string;
  agentName: string;
  triggerType: string | null;
  reason: string | null;
  createdAt: string;
  candidates: CandidateScore[];
}

export interface PolicyBinding {
  policyId: number;
  policyName: string;
  policyType: string;
  appliesTo: string;
  active: boolean;
  bound: boolean;
  bindingPriority: number | null;
  config: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function isShadowDecision(action: string, decisionType: string): boolean {
  return action === "shadow" || decisionType === "shadow" || action === "no_change_shadow";
}

// ---------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------

/**
 * Returns one summary row per agent that has at least one routing decision,
 * including active cooldown state.
 */
export async function getAgentSummaries(): Promise<AgentSummary[]> {
  const client = await pcliPool.connect();
  try {
    // Latest decision per agent
    const decisionsRes = await client.query<{
      agent_id: string;
      agent_name: string;
      action: string;
      decision_type: string;
      before_config: { adapter?: string; model?: string } | null;
      after_config: { adapter?: string; model?: string } | null;
      reason: string | null;
      created_at: Date;
      trigger_type: string | null;
      selected_candidate_id: number | null;
    }>(
      `SELECT DISTINCT ON (agent_id)
         agent_id, agent_name, action, decision_type,
         before_config, after_config, reason, created_at,
         trigger_type, selected_candidate_id
       FROM pcli_optimiser_decisions
       ORDER BY agent_id, created_at DESC`
    );

    // Active cooldowns
    const cooldownRes = await client.query<{
      agent_id: string;
      last_switch_reason: string | null;
      last_switch_at: Date | null;
      return_suppressed_until: Date | null;
      previous_adapter_name: string | null;
    }>(
      `SELECT agent_id, last_switch_reason, last_switch_at,
              return_suppressed_until, previous_adapter_name
       FROM pcli_agent_routing_state
       WHERE return_suppressed_until > NOW()`
    );

    const cooldownByAgent = new Map(cooldownRes.rows.map((r) => [r.agent_id, r]));

    return decisionsRes.rows.map((row) => {
      const cd = cooldownByAgent.get(row.agent_id);
      let cooldown: CooldownState | null = null;
      if (cd?.return_suppressed_until) {
        const until = new Date(cd.return_suppressed_until);
        cooldown = {
          suppressedAdapter: cd.previous_adapter_name,
          returnSuppressedUntil: until.toISOString(),
          remainingMs: Math.max(0, until.getTime() - Date.now()),
          lastSwitchReason: cd.last_switch_reason,
          lastSwitchAt: cd.last_switch_at?.toISOString() ?? null,
        };
      }

      return {
        agentId: row.agent_id,
        agentName: row.agent_name,
        currentAdapter: row.after_config?.adapter ?? null,
        currentModel: row.after_config?.model ?? null,
        lastSwitchAt: row.created_at.toISOString(),
        lastSwitchReason: row.reason,
        previousAdapter: row.before_config?.adapter ?? null,
        shadowMode: isShadowDecision(row.action, row.decision_type),
        cooldown,
      };
    });
  } finally {
    client.release();
  }
}

/**
 * Returns the full decision timeline for a single agent, newest first.
 * Omits no_change decisions to reduce noise per wireframe spec.
 */
export async function getAgentTimeline(agentId: string, limit = 50): Promise<DecisionEvent[]> {
  const client = await pcliPool.connect();
  try {
    const res = await client.query<{
      id: number;
      sweep_id: string;
      decision_type: string;
      action: string;
      before_config: { adapter?: string; model?: string } | null;
      after_config: { adapter?: string; model?: string } | null;
      reason: string | null;
      confidence: string | null;
      trigger_type: string | null;
      selected_candidate_id: number | null;
      created_at: Date;
      candidate_count: number | null;
      evaluation_id: number | null;
    }>(
      `SELECT
         d.id, d.sweep_id, d.decision_type, d.action,
         d.before_config, d.after_config, d.reason, d.confidence,
         d.trigger_type, d.selected_candidate_id, d.created_at,
         e.candidate_count,
         e.id AS evaluation_id
       FROM pcli_optimiser_decisions d
       LEFT JOIN pcli_optimiser_candidate_scores cs
         ON cs.id = d.selected_candidate_id
       LEFT JOIN pcli_optimiser_evaluations e
         ON e.id = cs.evaluation_id
       WHERE d.agent_id = $1
         AND d.action NOT IN ('no_change', 'no_change_shadow')
       ORDER BY d.created_at DESC
       LIMIT $2`,
      [agentId, limit]
    );

    return res.rows.map((row) => ({
      id: row.id,
      sweepId: row.sweep_id,
      decisionType: row.decision_type,
      action: row.action,
      beforeAdapter: row.before_config?.adapter ?? null,
      beforeModel: row.before_config?.model ?? null,
      afterAdapter: row.after_config?.adapter ?? null,
      afterModel: row.after_config?.model ?? null,
      reason: row.reason,
      confidence: row.confidence != null ? parseFloat(row.confidence) : null,
      triggerType: row.trigger_type,
      shadowMode: isShadowDecision(row.action, row.decision_type),
      candidateCount: row.candidate_count ?? 0,
      evaluationId: row.evaluation_id ?? null,
      createdAt: row.created_at.toISOString(),
    }));
  } finally {
    client.release();
  }
}

/**
 * Returns candidate score breakdown for a specific evaluation.
 */
export async function getEvaluationScores(
  evaluationId: number
): Promise<CandidateScoreBreakdown | null> {
  const client = await pcliPool.connect();
  try {
    const evalRes = await client.query<{
      id: number;
      sweep_id: string;
      agent_name: string;
      trigger_type: string | null;
      reason: string | null;
      created_at: Date;
    }>(
      `SELECT id, sweep_id, agent_name, trigger_type, reason, created_at
       FROM pcli_optimiser_evaluations
       WHERE id = $1`,
      [evaluationId]
    );

    if (evalRes.rows.length === 0) return null;
    const ev = evalRes.rows[0];
    if (!ev) return null;

    const scoresRes = await client.query<{
      id: number;
      adapter_name: string;
      model_id: string | null;
      allowed: boolean;
      excluded_reason: string | null;
      availability_score: string;
      health_penalty: string;
      recent_failure_penalty: string;
      rate_limit_penalty: string;
      cooldown_penalty: string;
      total_score: string;
      selected: boolean;
    }>(
      `SELECT id, adapter_name, model_id, allowed, excluded_reason,
              availability_score, health_penalty, recent_failure_penalty,
              rate_limit_penalty, cooldown_penalty, total_score, selected
       FROM pcli_optimiser_candidate_scores
       WHERE evaluation_id = $1
       ORDER BY total_score DESC`,
      [evaluationId]
    );

    return {
      evaluationId: ev.id,
      sweepId: ev.sweep_id,
      agentName: ev.agent_name,
      triggerType: ev.trigger_type,
      reason: ev.reason,
      createdAt: ev.created_at.toISOString(),
      candidates: scoresRes.rows.map((r) => ({
        id: r.id,
        adapterName: r.adapter_name,
        modelId: r.model_id,
        allowed: r.allowed,
        excludedReason: r.excluded_reason,
        availabilityScore: parseFloat(r.availability_score),
        healthPenalty: parseFloat(r.health_penalty),
        recentFailurePenalty: parseFloat(r.recent_failure_penalty),
        rateLimitPenalty: parseFloat(r.rate_limit_penalty),
        cooldownPenalty: parseFloat(r.cooldown_penalty),
        totalScore: parseFloat(r.total_score),
        selected: r.selected,
      })),
    };
  } finally {
    client.release();
  }
}

/**
 * Returns active cooldown detail for an agent.
 * Returns null if no active cooldown.
 */
export async function getAgentCooldown(agentId: string): Promise<CooldownState | null> {
  const client = await pcliPool.connect();
  try {
    const res = await client.query<{
      last_switch_reason: string | null;
      last_switch_at: Date | null;
      return_suppressed_until: Date | null;
      previous_adapter_name: string | null;
    }>(
      `SELECT last_switch_reason, last_switch_at,
              return_suppressed_until, previous_adapter_name
       FROM pcli_agent_routing_state
       WHERE agent_id = $1
         AND return_suppressed_until > NOW()`,
      [agentId]
    );

    if (res.rows.length === 0) return null;
    const row = res.rows[0];
    if (!row?.return_suppressed_until) return null;
    const until = new Date(row.return_suppressed_until);
    return {
      suppressedAdapter: row.previous_adapter_name,
      returnSuppressedUntil: until.toISOString(),
      remainingMs: Math.max(0, until.getTime() - Date.now()),
      lastSwitchReason: row.last_switch_reason,
      lastSwitchAt: row.last_switch_at?.toISOString() ?? null,
    };
  } finally {
    client.release();
  }
}

/**
 * Returns all policies and their binding state for a specific agent.
 */
export async function getAgentPolicyBindings(agentId: string): Promise<PolicyBinding[]> {
  const client = await pcliPool.connect();
  try {
    const res = await client.query<{
      policy_id: number;
      policy_name: string;
      policy_type: string;
      applies_to_scope: string;
      active: boolean;
      bound: boolean;
      priority: number | null;
      config_json: Record<string, unknown> | null;
    }>(
      `SELECT
         p.id AS policy_id,
         p.name AS policy_name,
         p.policy_type,
         p.applies_to_scope,
         p.active,
         p.config_json,
         (pb.id IS NOT NULL) AS bound,
         pb.priority
       FROM pcli_optimiser_policies p
       LEFT JOIN pcli_policy_bindings pb
         ON pb.policy_id = p.id
        AND (pb.agent_id = $1 OR pb.agent_id IS NULL)
       WHERE p.active = TRUE
       ORDER BY p.name`,
      [agentId]
    );

    return res.rows.map((r) => ({
      policyId: r.policy_id,
      policyName: r.policy_name,
      policyType: r.policy_type,
      appliesTo: r.applies_to_scope,
      active: r.active,
      bound: r.bound,
      bindingPriority: r.priority,
      config: r.config_json ?? {},
    }));
  } finally {
    client.release();
  }
}
