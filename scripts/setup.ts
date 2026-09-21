import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { config } from "../server/config.js";
import { Store } from "../server/store.js";

mkdirSync(config.dataDir, { recursive: true });
new Store(join(config.dataDir, "assistant.sqlite")).db.close();
console.log(`Local database: ${config.dataDir}`);
console.log(
  "Open the app to connect a model and create or connect your independent profile repository.",
);
