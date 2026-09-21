import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { type DesktopConfig, ensureServer } from "./runtime.js";

const configuration = JSON.parse(readFileSync(process.argv[2], "utf8")) as DesktopConfig;
let input = "";
for await (const chunk of process.stdin) {
  input += chunk.toString();
  if (input.length > 30000) throw new Error("Select at most 30,000 characters to capture.");
}
const text = input.trim();
if (!text) throw new Error("Select some text first, then choose Add to My Mind.");
await ensureServer(configuration);
const response = await fetch(`${configuration.serverURL}/api/captures`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ text }),
  signal: AbortSignal.timeout(15000),
});
if (!response.ok) throw new Error("The selection was not saved. Open the assistant and try again.");
execFileSync("/usr/bin/osascript", [
  "-e",
  'display notification "Selected text saved to your inbox." with title "My Mind"',
]);
