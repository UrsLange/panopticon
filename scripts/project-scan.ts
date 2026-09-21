import { ensureServer } from "../desktop/runtime.js";
import { config } from "../server/config.js";

const serverURL = `http://127.0.0.1:${config.port}`;
await ensureServer({
  projectDir: process.cwd(),
  nodePath: process.execPath,
  serverURL,
  dataDir: config.dataDir,
  shortcut: "",
});
const response = await fetch(`${serverURL}/api/projects/scan`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ scheduled: !process.argv.includes("--now") }),
  signal: AbortSignal.timeout(10000),
});
if (!response.ok) throw new Error(`Project scan request failed (${response.status}).`);
console.log("Project scan requested. View progress and errors in Settings.");
