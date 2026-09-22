import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { ApplicationError } from "./application/errors.js";

const execute = promisify(execFile);
let choosing = false;

export async function chooseDirectory() {
  if (process.platform !== "darwin")
    throw new ApplicationError(
      "unavailable",
      "The folder chooser requires macOS. Enter an absolute directory path instead.",
    );
  if (choosing)
    throw new ApplicationError(
      "conflict",
      "A folder chooser is already open. Select a folder or cancel it first.",
    );
  choosing = true;
  try {
    const { stdout } = await execute(
      "/usr/bin/osascript",
      [
        "-e",
        "activate",
        "-e",
        'POSIX path of (choose folder with prompt "Choose a project group directory for Panopticon")',
      ],
      { timeout: 120000 },
    );
    return stdout.trim();
  } catch (error) {
    if ((error as { stderr?: string }).stderr?.includes("(-128)")) return null;
    throw new ApplicationError(
      "unavailable",
      "Could not open the folder chooser. Try again or enter an absolute directory path.",
    );
  } finally {
    choosing = false;
  }
}
