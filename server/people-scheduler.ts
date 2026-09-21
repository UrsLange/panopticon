import type { PeopleSync } from "./application/people-sync.js";

export function startPeopleScheduler(sync: PeopleSync) {
  const check = () => {
    void sync.run(true).catch(() => {});
  };
  check();
  const timer = setInterval(check, 60000);
  timer.unref();
  return () => clearInterval(timer);
}
