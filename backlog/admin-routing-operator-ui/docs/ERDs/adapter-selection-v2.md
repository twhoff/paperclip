# Adapter Selection V2 — Entity Relationship Diagram

> Generated from the V2 PRD and adjusted to fit the actual pcli and Paperclip schema. Legend: `[NEW]` = new table, `[EXTEND]` = existing table with new columns, `[EXISTS]` = already present in the current system.

## Grouped Overview

```mermaid
flowchart LR

    subgraph Catalog["Catalog: Static routing options and reusable presets"]
        AD["ADAPTER"]
        MO["MODEL"]
        AMS["ADAPTER_MODEL_SUPPORT"]
        AT["ADAPTER_TEMPLATE"]
    end

    subgraph Health["Health: Adapter evidence and agent health state"]
        AHR["ADAPTER_HEALTH_RUN"]
        AHS["AGENT_HEALTH_STATE"]
    end

    subgraph Runtime["Runtime: Live agent config, routing memory, and run snapshots"]
        AG["AGENT"]
        ARS["AGENT_ROUTING_STATE"]
        RHR["RUN_HEARTBEAT_RUNS"]
        RPM["RUN_PCLI_METRICS"]
    end

    subgraph Decisioning["Decisioning: Policy, evaluation, candidate scoring, and apply result"]
        OP["OPTIMISER_POLICY"]
        PB["POLICY_BINDING"]
        OE["OPTIMISER_EVALUATION"]
        OCS["OPTIMISER_CANDIDATE_SCORE"]
        OAA["OPTIMISER_ACTION_APPLY"]
        ACR["AGENT_CONFIG_REVISION"]
    end

    AD --> AMS
    MO --> AMS
    AD --> AT
    MO --> AT
    AD --> AHR
    MO --> AHR

    AT -. optional lock .-> AG
    AG --> ARS
    AG --> RHR
    RHR --> RPM

    OP --> PB
    AG --> OE
    AMS --> OE
    AHR --> OE
    AHS --> OE
    ARS --> OE
    RPM --> OE
    PB --> OE
    OE --> OCS
    OE --> OAA
    OAA --> ACR

    classDef box fill:#ffffff,stroke:#1f2937,stroke-width:1.5px,color:#111827;
    class AD,MO,AMS,AT,AHR,AHS,AG,ARS,RHR,RPM,OP,PB,OE,OCS,OAA,ACR box;

    style Catalog fill:#eef6ff,stroke:#4a78c2,stroke-width:2px,color:#1f2937
    style Health fill:#eefcf3,stroke:#3d8b5a,stroke-width:2px,color:#1f2937
    style Runtime fill:#fff7e8,stroke:#b7791f,stroke-width:2px,color:#1f2937
    style Decisioning fill:#f7efff,stroke:#7a4bb7,stroke-width:2px,color:#1f2937
```

### What The Groups Mean

| Group       | Purpose                                                                                                            |
| ----------- | ------------------------------------------------------------------------------------------------------------------ |
| Catalog     | Defines adapters, models, per-adapter model support, and reusable templates.                                       |
| Health      | Stores adapter probe evidence and the separate agent health state machine already present in pcli.                 |
| Runtime     | Stores the live agent config, routing hysteresis memory, and run snapshots.                                        |
| Decisioning | Stores policy constraints, evaluation intent, candidate scoring, apply results, and config revision audit records. |

## Ownership Rules

| Concern                  | Rule                                                                                                                                                                                                 |
| ------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Adapter availability     | `manual_override_status` is authoritative when set. Otherwise `availability_status` is a cached interpretation derived from the latest trusted health evidence.                                      |
| Health vs routing memory | `AGENT_HEALTH_STATE` owns the general health state machine. `AGENT_ROUTING_STATE` owns only routing hysteresis and short-term switch memory.                                                         |
| Evaluation vs apply      | `OPTIMISER_EVALUATION` records decision intent and rationale. `OPTIMISER_ACTION_APPLY` records the outcome of trying to apply that decision. Persisted config diffs live in `AGENT_CONFIG_REVISION`. |
| Run metrics scope        | `RUN_PCLI_METRICS` stores run evidence plus the config snapshot needed for per-config performance analysis. It does not carry optimiser switch rationale.                                            |

## Source of Truth Rules

| Concern                     | Source of truth          | Notes                                                                                                                                  |
| --------------------------- | ------------------------ | -------------------------------------------------------------------------------------------------------------------------------------- |
| Current agent config        | `AGENT`                  | In the current system this is the `agents` table, primarily `adapter_type`, `adapter_config`, and `runtime_config`.                    |
| Routing memory              | `AGENT_ROUTING_STATE`    | Owns cooldowns, settle windows, return suppression, and previous-switch memory only.                                                   |
| Health-state machine        | `AGENT_HEALTH_STATE`     | In the current system this maps to `pcli_agent_health_state`.                                                                          |
| Decision intent             | `OPTIMISER_EVALUATION`   | Owns the selected candidate, rationale, and structured evaluation payload.                                                             |
| Apply result                | `OPTIMISER_ACTION_APPLY` | Owns whether the chosen decision was actually applied, failed, or was recorded in shadow mode.                                         |
| Persisted config revision   | `AGENT_CONFIG_REVISION`  | In the current system this maps to `agent_config_revisions`, which owns the actual before/after config diff audit trail.               |
| Adapter availability status | `ADAPTER`                | `manual_override_status` wins when present; otherwise `availability_status` is the cached status derived from trusted health evidence. |

## Detailed Grouped Schema

```mermaid
flowchart LR

    subgraph Catalog2["Catalog: Static entities that define routing options"]
        AD2["ADAPTER"]
        MO2["MODEL"]
        AMS2["ADAPTER_MODEL_SUPPORT"]
        AT2["ADAPTER_TEMPLATE"]
    end

    subgraph Health2["Health: Probe evidence and the agent health state machine"]
        AHR2["ADAPTER_HEALTH_RUN"]
        AHS2["AGENT_HEALTH_STATE"]
    end

    subgraph Runtime2["Runtime: Agent config, routing memory, and observed runs"]
        AG2["AGENT"]
        ARS2["AGENT_ROUTING_STATE"]
        RHR2["RUN_HEARTBEAT_RUNS"]
        RPM2["RUN_PCLI_METRICS"]
    end

    subgraph Decision2["Decisioning: Filters, candidate scoring, apply outcome, and audit"]
        OP2["OPTIMISER_POLICY"]
        PB2["POLICY_BINDING"]
        OE2["OPTIMISER_EVALUATION"]
        OCS2["OPTIMISER_CANDIDATE_SCORE"]
        OAA2["OPTIMISER_ACTION_APPLY"]
        ACR2["AGENT_CONFIG_REVISION"]
    end

    AD2 -->|supports models via| AMS2
    MO2 -->|is available through| AMS2
    AD2 -->|probe target| AHR2
    MO2 -->|probe model| AHR2
    AD2 -->|template adapter| AT2
    MO2 -->|template model| AT2

    AT2 -. template lock .-> AG2
    AG2 -->|routing memory| ARS2
    AG2 -->|has runs| RHR2
    RHR2 -->|metrics row| RPM2

    OP2 -->|binds through| PB2
    PB2 -->|policy constraint| OE2
    AG2 -->|evaluated agent| OE2
    AMS2 -->|candidate space| OE2
    AHR2 -->|adapter health signal| OE2
    AHS2 -->|agent health signal| OE2
    ARS2 -->|cooldown and return suppression| OE2
    RPM2 -->|recent run evidence| OE2
    OE2 -->|candidate rows| OCS2
    OE2 -->|apply attempt| OAA2
    OAA2 -->|optional persisted diff| ACR2

    classDef box fill:#ffffff,stroke:#1f2937,stroke-width:1.5px,color:#111827;
    class AD2,MO2,AMS2,AT2,AHR2,AHS2,AG2,ARS2,RHR2,RPM2,OP2,PB2,OE2,OCS2,OAA2,ACR2 box;

    style Catalog2 fill:#eef6ff,stroke:#4a78c2,stroke-width:2px,color:#1f2937
    style Health2 fill:#eefcf3,stroke:#3d8b5a,stroke-width:2px,color:#1f2937
    style Runtime2 fill:#fff7e8,stroke:#b7791f,stroke-width:2px,color:#1f2937
    style Decision2 fill:#f7efff,stroke:#7a4bb7,stroke-width:2px,color:#1f2937
```

## Entity Details

### Catalog

| Entity                | Key Fields                                                                                                                                                     |
| --------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| ADAPTER               | `[NEW]` `name` PK, `display_label`, `priority`, `availability_status`, `health_source`, `last_health_check_at`, `last_health_run_id`, `manual_override_status` |
| MODEL                 | `[NEW]` `id` PK, `name` UK, `family`, `active`                                                                                                                 |
| ADAPTER_MODEL_SUPPORT | `[NEW]` `adapter_name` PK/FK, `model_id` PK/FK, `active`, `canonical_model_name`, `priority_within_adapter`, `supports_editing`, `supports_streaming`          |
| ADAPTER_TEMPLATE      | `[NEW]` `id` PK, `name` UK, `adapter_name` FK, `model_id` FK, `effort`, `config_json`, `active`, `created_at`                                                  |

### Health

| Entity             | Key Fields                                                                                                                                                                                                                                       |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| ADAPTER_HEALTH_RUN | `[NEW]` `id` PK, `adapter_name` FK, `probe_agent_id` nullable FK, `probe_agent_name` snapshot, `model_id` FK, `started_at`, `finished_at`, `outcome`, `failure_reason`, `latency_ms`, `trusted_for_status`                                       |
| AGENT_HEALTH_STATE | `[EXISTS]` Maps to `pcli_agent_health_state`: `agent_id` PK/FK, `agent_name`, `state`, `reason_code`, `reason_detail`, `constraints`, `entered_at`, `expires_at`, `recovery_criteria`, `escalation_level`, `successful_runs_since`, `updated_at` |

### Runtime

| Entity              | Key Fields                                                                                                                                                                                                                                                                             |
| ------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| AGENT               | `[EXISTS]` `id` PK, `company_id`, `name`, `role`, `title`, `status`, `adapter_type`, `adapter_config`, `runtime_config`, `budget_monthly_cents`, `routing_mode`, `template_id` nullable                                                                                                |
| AGENT_ROUTING_STATE | `[NEW]` `agent_id` PK/FK, `last_switch_at`, `last_switch_reason`, `previous_adapter_name`, `previous_model_id`, `return_suppressed_until`, `settle_until`, `blocked_until`, `notes_json`                                                                                               |
| RUN_HEARTBEAT_RUNS  | `[EXISTS]` `id` PK, `agent_id` FK, `status`, `started_at`, `finished_at`, `error`                                                                                                                                                                                                      |
| RUN_PCLI_METRICS    | `[EXISTS]` Maps to `pcli_run_metrics`: `run_id` PK/FK, `agent_id` FK, `agent_name`, `agent_role`, `duration_ms`, `estimated_cost_cents`, `quality_signal`, `work_type`, `config_adapter`, `config_model`, `config_effort`, `config_interval_ms`, `hit_rate_limit`, `issues_progressed` |

### Decisioning

| Entity                    | Key Fields                                                                                                                                                                                                                                                                                                                                                              |
| ------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| OPTIMISER_POLICY          | `[NEW]` `id` PK, `name`, `applies_to_scope`, `policy_type`, `config_json`, `active`                                                                                                                                                                                                                                                                                     |
| POLICY_BINDING            | `[NEW]` `id` PK, `policy_id` FK, `agent_id` nullable, `adapter_name` nullable, `template_id` nullable, `priority`                                                                                                                                                                                                                                                       |
| OPTIMISER_EVALUATION      | `[EXTEND]` Extends `pcli_optimiser_decisions`: `id` PK, `sweep_id`, `agent_id` FK, `agent_name` snapshot, `decision_type`, `action`, `before_config`, `after_config`, `reason`, `confidence`, `created_at`, `trigger_type`, `current_adapter_name`, `current_model_id`, `selected_candidate_id` nullable, `evaluation_summary_json`                                     |
| OPTIMISER_CANDIDATE_SCORE | `[NEW]` `id` PK, `evaluation_id` FK, `adapter_name` FK, `model_id` FK, `template_id` nullable, `allowed`, `excluded_reason`, `availability_score`, `health_penalty`, `recent_failure_penalty`, `rate_limit_penalty`, `cooldown_penalty`, `static_priority_score`, `total_score`, `selected`. Here `template_id` means the candidate came from a template-backed config. |
| OPTIMISER_ACTION_APPLY    | `[NEW]` `id` PK, `evaluation_id` FK, `config_revision_id` nullable FK, `applied_at`, `apply_status`, `apply_error`, `apply_summary_json`                                                                                                                                                                                                                                |
| AGENT_CONFIG_REVISION     | `[EXISTS]` Maps to `agent_config_revisions`: `id` PK, `agent_id` FK, `company_id`, `source`, `changed_keys`, `before_config`, `after_config`, `created_at`                                                                                                                                                                                                              |
