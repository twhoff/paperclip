-- pcli-b9o: collapse legacy effort fields into single `effort` key.
--
-- Before this migration:
--   - claude_local adapters store the canonical effort under adapter_config->>'effort'
--   - codex_local adapters store it under adapter_config->>'modelReasoningEffort'
--   - copilot_cli adapters store it under adapter_config->>'reasoningEffort'
-- All three are now expected to use adapter_config->>'effort' as the single source
-- of truth. Adapter execute paths fall back to the legacy keys read-only during
-- the migration window; this script removes the legacy keys after coalescing
-- their values into `effort` (preferring an explicit `effort` value if already
-- set on the row).

UPDATE "agents"
SET "adapter_config" = jsonb_strip_nulls(
  ("adapter_config" - 'modelReasoningEffort' - 'reasoningEffort')
  || jsonb_build_object(
    'effort',
    COALESCE(
      NULLIF("adapter_config"->>'effort', ''),
      NULLIF("adapter_config"->>'modelReasoningEffort', ''),
      NULLIF("adapter_config"->>'reasoningEffort', '')
    )
  )
)
WHERE
  -- Only touch rows that actually carry one of the legacy keys OR an existing
  -- `effort` value, so we don't write nulls onto adapters that have no effort
  -- field at all.
  ("adapter_config" ? 'modelReasoningEffort')
  OR ("adapter_config" ? 'reasoningEffort')
  OR ("adapter_config" ? 'effort');
