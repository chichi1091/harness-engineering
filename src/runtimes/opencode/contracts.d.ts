import type { OpenCodeCommand } from "../../adapters/opencode/contracts.js";

export type OverwritePolicy = "error" | "overwrite";

export interface OpenCodeExecutorOptions {
  projectRoot: string;
  command: OpenCodeCommand;
  overwritePolicy?: OverwritePolicy;
}

export interface PlacementResult {
  path: string;
  action: "created" | "overwritten";
}

export declare function placeOpenCodeCommand(
  options: OpenCodeExecutorOptions
): Promise<PlacementResult>;
