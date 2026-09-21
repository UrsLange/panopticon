import { spawn } from "node:child_process";
import { closeSync, mkdirSync, openSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { setTimeout } from "node:timers/promises";

export type DesktopConfig = {
  projectDir: string;
  nodePath: string;
  serverURL: string;
  dataDir: string;
  shortcut: string;
};

export async function ensureServer(config: DesktopConfig) {
  const ready = async () => {
    try {
      const response = await fetch(`${config.serverURL}/api/settings`, {
        signal: AbortSignal.timeout(800),
      });
      if (!response.ok) return false;
      const result = await response.json();
      return typeof result.profilePath === "string";
    } catch {
      return false;
    }
  };
  if (await ready()) return;
  mkdirSync(config.dataDir, { recursive: true });
  const log = openSync(join(config.dataDir, "server.log"), "a", 0o600);
  const child = spawn(config.nodePath, [join(config.projectDir, "dist/server/server/main.js")], {
    cwd: config.projectDir,
    detached: true,
    stdio: ["ignore", log, log],
    env: {
      ...process.env,
      PATH: `${dirname(config.nodePath)}:${homedir()}/.local/bin:${process.env.PATH ?? "/usr/bin:/bin"}`,
    },
  });
  closeSync(log);
  let failure: Error | undefined;
  child.on("error", (error) => {
    failure = error;
  });
  child.unref();
  for (let attempt = 0; attempt < 60; attempt++) {
    if (failure) throw failure;
    if (await ready()) return;
    await setTimeout(250);
  }
  throw new Error(
    `The local assistant could not start. Check ${join(config.dataDir, "server.log")}.`,
  );
}
