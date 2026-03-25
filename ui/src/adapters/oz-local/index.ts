import type { UIAdapterModule } from "../types";
import { parseOzStdoutLine } from "@paperclipai/adapter-oz-local/ui";
import { OzLocalConfigFields } from "./config-fields";
import { buildOzLocalConfig } from "@paperclipai/adapter-oz-local/ui";

export const ozLocalUIAdapter: UIAdapterModule = {
  type: "oz_local",
  label: "Oz (local)",
  parseStdoutLine: parseOzStdoutLine,
  ConfigFields: OzLocalConfigFields,
  buildAdapterConfig: buildOzLocalConfig,
};
