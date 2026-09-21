import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { config } from "../server/config.js";

if (process.platform !== "darwin") throw new Error("The background schedule requires macOS.");
const label = "local.personal-assistant.project-scan";
const directory = join(homedir(), "Library/LaunchAgents");
const path = join(directory, `${label}.plist`);
const domain = `gui/${process.getuid?.()}`;
if (existsSync(path)) {
  const current = execFileSync("/usr/bin/plutil", ["-extract", "Label", "raw", "-o", "-", path], {
    encoding: "utf8",
  }).trim();
  if (current !== label) throw new Error("Refusing to replace an unrelated launch agent.");
}
mkdirSync(directory, { recursive: true });
mkdirSync(config.dataDir, { recursive: true });
const definition = {
  Label: label,
  ProgramArguments: [process.execPath, resolve("dist/server/scripts/project-scan.js")],
  WorkingDirectory: process.cwd(),
  RunAtLoad: true,
  StartCalendarInterval: { Hour: 8, Minute: 0 },
  StartInterval: 900,
  StandardOutPath: join(config.dataDir, "project-schedule.log"),
  StandardErrorPath: join(config.dataDir, "project-schedule.log"),
};
const loaded =
  spawnSync("/bin/launchctl", ["print", `${domain}/${label}`], { stdio: "ignore" }).status === 0;
if (loaded) execFileSync("/bin/launchctl", ["bootout", `${domain}/${label}`]);
execFileSync("/usr/bin/plutil", ["-convert", "xml1", "-o", path, "-"], {
  input: JSON.stringify(definition),
});
execFileSync("/bin/launchctl", ["bootstrap", domain, path]);
console.log(`Installed project discovery schedule: ${path}`);
