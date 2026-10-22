// Adapters the UI no longer offers for new or edited agents and will not run.
// They stay in the adapter registry so existing agents' configuration and run
// transcripts still render.
const DISABLED_ADAPTER_TYPES: ReadonlySet<string> = new Set(["copilot_cli"]);

export function isAdapterTypeDisabled(type: string): boolean {
  return DISABLED_ADAPTER_TYPES.has(type);
}
