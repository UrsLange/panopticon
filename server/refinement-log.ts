import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { config } from "./config.js";

export const refinementLog = {
  debug(record: Record<string, unknown>) {
    try {
      mkdirSync(config.dataDir, { recursive: true });
      appendFileSync(
        join(config.dataDir, "refinement.debug.jsonl"),
        `${JSON.stringify({ ...record, level: "debug" })}\n`,
        { mode: 0o600 },
      );
    } catch {
      console.error("Could not write refinement debug log.");
    }
  },
};
