import type { ProjectScanner } from "./application/projects.js";

export function startProjectScheduler(scanner: ProjectScanner) {
  const check = () => {
    void scanner.run(true);
  };
  check();
  const timer = setInterval(check, 60000);
  timer.unref();
  return () => clearInterval(timer);
}
