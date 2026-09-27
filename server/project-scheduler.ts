import type { createProjectWorkspace } from "./application/project-workspace.js";
import type { ProjectScanner } from "./application/projects.js";

export function startWorkspaceScheduler(workspace: ReturnType<typeof createProjectWorkspace>) {
  const check = () => {
    void workspace.list();
  };
  check();
  const timer = setInterval(check, 15000);
  timer.unref();
  return () => clearInterval(timer);
}

export function startProjectScheduler(scanner: ProjectScanner) {
  const check = () => {
    void scanner.run(true);
  };
  check();
  const timer = setInterval(check, 60000);
  timer.unref();
  return () => clearInterval(timer);
}
