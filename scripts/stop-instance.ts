import { execFileSync, spawnSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { setTimeout } from "node:timers/promises";
import { config } from "../server/config.js";

const listeners = spawnSync("lsof", ["-nP", `-iTCP:${config.port}`, "-sTCP:LISTEN", "-t"], {
  encoding: "utf8",
});
if (listeners.error || (listeners.status !== 0 && listeners.status !== 1))
  throw new Error("Could not inspect the running backend with lsof.");
const pids = [...new Set(listeners.stdout.trim().split(/\s+/).filter(Boolean).map(Number))];
const workspace = realpathSync(process.cwd());
const command = (pid: number) =>
  execFileSync("ps", ["-ww", "-p", String(pid), "-o", "command="], { encoding: "utf8" }).trim();
const inWorkspace = (pid: number) => {
  const cwd = execFileSync("lsof", ["-a", "-p", String(pid), "-d", "cwd", "-Fn"], {
    encoding: "utf8",
  })
    .split("\n")
    .find((line) => line.startsWith("n"))
    ?.slice(1);
  return cwd && realpathSync(cwd) === workspace;
};

for (const pid of pids) {
  if (
    !inWorkspace(pid) ||
    !/(?:^|\s)(?:\S*\/)?(?:dist\/server\/server\/main\.js|server\/main\.ts)(?:\s|$)/.test(
      command(pid),
    )
  )
    throw new Error(`Port ${config.port} belongs to another process (${pid}); leaving it running.`);
}

for (const pid of pids) {
  let target = pid;
  let parent = pid;
  // Stop the dev supervisor too, so its watcher cannot bring the old backend back.
  while (parent > 1) {
    parent = Number(
      execFileSync("ps", ["-p", String(parent), "-o", "ppid="], { encoding: "utf8" }).trim(),
    );
    if (parent <= 1 || !inWorkspace(parent)) break;
    if (
      /(?:^|\s)\S+\/(?:concurrently(?:\/dist\/bin\/concurrently\.js)?|tsx(?:\/dist\/cli\.mjs)?)(?:\s|$)/.test(
        command(parent),
      )
    )
      target = parent;
  }
  console.log(`Stopping the assistant on port ${config.port} (process ${target})…`);
  const descendants = new Set([pid]);
  collectDescendants(descendants);
  process.kill(target, "SIGTERM");
  const interruptAt = Date.now() + 5000;
  const deadline = Date.now() + 30000;
  let interrupted = false;
  while (true) {
    try {
      process.kill(pid, 0);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ESRCH") {
        for (const child of descendants) {
          if (child === pid) continue;
          try {
            process.kill(child, "SIGTERM");
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
          }
        }
        break;
      }
      throw error;
    }
    if (!interrupted && Date.now() >= interruptAt) {
      console.log("Stopping remaining assistant background work…");
      collectDescendants(descendants);
      // The backend's first signal drains active scans; a second stops that drain.
      for (const child of descendants) {
        try {
          process.kill(child, "SIGTERM");
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
        }
      }
      interrupted = true;
    }
    if (Date.now() >= deadline)
      throw new Error(
        "The previous assistant is still shutting down. Wait for active work to finish, then run mise run dev again.",
      );
    await setTimeout(200);
  }
}

function collectDescendants(descendants: Set<number>) {
  const processes = execFileSync("ps", ["-axo", "pid=,ppid="], { encoding: "utf8" })
    .trim()
    .split("\n")
    .map((line) => line.trim().split(/\s+/).map(Number));
  let size = 0;
  while (size !== descendants.size) {
    size = descendants.size;
    for (const [child, parent] of processes) if (descendants.has(parent)) descendants.add(child);
  }
}
