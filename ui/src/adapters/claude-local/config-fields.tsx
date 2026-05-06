import type { AdapterConfigFieldsProps } from "../types";
import {
  Field,
  ToggleField,
  DraftInput,
  DraftNumberInput,
  help,
} from "../../components/agent-config-primitives";
import { ChoosePathButton } from "../../components/PathInstructionsModal";
import { LocalWorkspaceRuntimeFields } from "../local-workspace-runtime-fields";

const inputClass =
  "w-full rounded-md border border-border px-2.5 py-1.5 bg-transparent outline-none text-sm font-mono placeholder:text-muted-foreground/40";

const instructionsFileHint =
  "Absolute path to a markdown file (e.g. AGENTS.md) that defines this agent's behavior. Injected into the system prompt at runtime.";

export function ClaudeLocalConfigFields({
  mode,
  isCreate,
  adapterType,
  values,
  set,
  config,
  eff,
  mark,
  models,
  hideInstructionsFile,
}: AdapterConfigFieldsProps) {
  return (
    <>
      {!hideInstructionsFile && (
        <Field label="Agent instructions file" hint={instructionsFileHint}>
          <div className="flex items-center gap-2">
            <DraftInput
              value={
                isCreate
                  ? values!.instructionsFilePath ?? ""
                  : eff(
                      "adapterConfig",
                      "instructionsFilePath",
                      String(config.instructionsFilePath ?? ""),
                    )
              }
              onCommit={(v) =>
                isCreate
                  ? set!({ instructionsFilePath: v })
                  : mark("adapterConfig", "instructionsFilePath", v || undefined)
              }
              immediate
              className={inputClass}
              placeholder="/absolute/path/to/AGENTS.md"
            />
            <ChoosePathButton />
          </div>
        </Field>
      )}
      <LocalWorkspaceRuntimeFields
        isCreate={isCreate}
        values={values}
        set={set}
        config={config}
        mark={mark}
        eff={eff}
        mode={mode}
        adapterType={adapterType}
        models={models}
      />
    </>
  );
}

export function ClaudeLocalAdvancedFields({
  isCreate,
  values,
  set,
  config,
  eff,
  mark,
}: AdapterConfigFieldsProps) {
  return (
    <>
      <ToggleField
        label="Enable Chrome"
        hint={help.chrome}
        checked={
          isCreate
            ? values!.chrome
            : eff("adapterConfig", "chrome", config.chrome === true)
        }
        onChange={(v) =>
          isCreate
            ? set!({ chrome: v })
            : mark("adapterConfig", "chrome", v)
        }
      />
      <ToggleField
        label="Skip permissions"
        hint={help.dangerouslySkipPermissions}
        checked={
          isCreate
            ? values!.dangerouslySkipPermissions
            : eff(
                "adapterConfig",
                "dangerouslySkipPermissions",
                config.dangerouslySkipPermissions !== false,
              )
        }
        onChange={(v) =>
          isCreate
            ? set!({ dangerouslySkipPermissions: v })
            : mark("adapterConfig", "dangerouslySkipPermissions", v)
        }
      />
      <Field label="Max turns per run" hint={help.maxTurnsPerRun}>
        {isCreate ? (
          <input
            type="number"
            className={inputClass}
            value={values!.maxTurnsPerRun}
            onChange={(e) => set!({ maxTurnsPerRun: Number(e.target.value) })}
          />
        ) : (
          <DraftNumberInput
            value={eff(
              "adapterConfig",
              "maxTurnsPerRun",
              Number(config.maxTurnsPerRun ?? 300),
            )}
            onCommit={(v) => mark("adapterConfig", "maxTurnsPerRun", v || 300)}
            immediate
            className={inputClass}
          />
        )}
      </Field>
      <Field label="Fallback model" hint={help.fallbackModel}>
        <DraftInput
          value={
            isCreate
              ? values!.fallbackModel ?? ""
              : eff("adapterConfig", "fallbackModel", String(config.fallbackModel ?? ""))
          }
          onCommit={(v) =>
            isCreate
              ? set!({ fallbackModel: v })
              : mark("adapterConfig", "fallbackModel", v || undefined)
          }
          immediate
          className={inputClass}
          placeholder="claude-opus-4-7"
        />
      </Field>
      <Field label="Max budget per run (USD)" hint={help.maxBudgetUsd}>
        {isCreate ? (
          <input
            type="number"
            step="0.01"
            min="0"
            className={inputClass}
            value={values!.maxBudgetUsd ?? 0}
            onChange={(e) => set!({ maxBudgetUsd: Number(e.target.value) })}
          />
        ) : (
          <DraftNumberInput
            value={eff("adapterConfig", "maxBudgetUsd", Number(config.maxBudgetUsd ?? 0))}
            onCommit={(v) => mark("adapterConfig", "maxBudgetUsd", v || 0)}
            immediate
            className={inputClass}
          />
        )}
      </Field>
      <ToggleField
        label="Include hook events in stream"
        hint={help.includeHookEvents}
        checked={
          isCreate
            ? values!.includeHookEvents ?? false
            : eff("adapterConfig", "includeHookEvents", config.includeHookEvents === true)
        }
        onChange={(v) =>
          isCreate
            ? set!({ includeHookEvents: v })
            : mark("adapterConfig", "includeHookEvents", v)
        }
      />
      <Field label="Debug log file" hint={help.debugFile}>
        <DraftInput
          value={
            isCreate
              ? values!.debugFile ?? ""
              : eff("adapterConfig", "debugFile", String(config.debugFile ?? ""))
          }
          onCommit={(v) =>
            isCreate
              ? set!({ debugFile: v })
              : mark("adapterConfig", "debugFile", v || undefined)
          }
          immediate
          className={inputClass}
          placeholder="/absolute/path/to/claude-debug.log"
        />
      </Field>
      <Field label="Input format" hint={help.inputFormat}>
        <select
          className={inputClass}
          value={
            isCreate
              ? values!.inputFormat ?? "text"
              : eff("adapterConfig", "inputFormat", String(config.inputFormat ?? "text"))
          }
          onChange={(e) =>
            isCreate
              ? set!({ inputFormat: e.target.value })
              : mark("adapterConfig", "inputFormat", e.target.value === "text" ? undefined : e.target.value)
          }
        >
          <option value="text">text</option>
          <option value="stream-json">stream-json</option>
        </select>
      </Field>
    </>
  );
}
