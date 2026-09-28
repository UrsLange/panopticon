import type { createProfileLearning } from "./application/profile-learning.js";

export function startProfileLearningScheduler(learning: ReturnType<typeof createProfileLearning>) {
  const check = () => {
    void learning.run(true).catch(() => {});
  };
  check();
  const timer = setInterval(check, 60000);
  timer.unref();
  return () => clearInterval(timer);
}
