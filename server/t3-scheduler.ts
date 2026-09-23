import type { createT3 } from "./application/t3.js";

export function startT3Scheduler(t3: ReturnType<typeof createT3>) {
  const check = () => {
    void t3.refreshActive().catch(() => {});
  };
  check();
  const timer = setInterval(check, 30000);
  timer.unref();
  return () => clearInterval(timer);
}
