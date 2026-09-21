import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { packager } from "@electron/packager";
import type { DesktopConfig } from "../desktop/runtime.js";
import { config } from "../server/config.js";
import { serviceDefinition, shellQuote } from "./macos-service.js";

if (process.platform !== "darwin") throw new Error("The desktop companion requires macOS.");
const applicationId = "local.personal-assistant.capture";
const appPath = join(homedir(), "Applications/My Mind.app");
const servicePath = join(homedir(), "Library/Services/Add to My Mind.workflow");
for (const [path, id] of [
  [appPath, applicationId],
  [servicePath, "local.personal-assistant.capture-service"],
]) {
  if (existsSync(path)) {
    const current = execFileSync(
      "/usr/bin/plutil",
      ["-extract", "CFBundleIdentifier", "raw", "-o", "-", join(path, "Contents/Info.plist")],
      { encoding: "utf8" },
    ).trim();
    if (current !== id)
      throw new Error(`Refusing to replace an unrelated application or service: ${path}`);
  }
}
const output = resolve("dist/desktop");
const desktop: DesktopConfig = {
  projectDir: process.cwd(),
  nodePath: process.execPath,
  serverURL: `http://127.0.0.1:${config.port}`,
  dataDir: config.dataDir,
  shortcut: process.env.PA_CAPTURE_SHORTCUT || "Command+Shift+Space",
};
writeFileSync(join(output, "desktop-config.json"), JSON.stringify(desktop, null, 2));
writeFileSync(
  join(output, "package.json"),
  JSON.stringify({
    name: "my-mind",
    productName: "My Mind",
    version: "0.1.0",
    type: "module",
    main: "main.js",
  }),
);
const dependencies = JSON.parse(readFileSync("package.json", "utf8"));
const [built] = await packager({
  dir: output,
  name: "My Mind",
  platform: "darwin",
  arch: process.arch as "arm64" | "x64",
  electronVersion: dependencies.devDependencies.electron,
  appBundleId: applicationId,
  out: resolve(".data/macos-build"),
  overwrite: true,
  prune: false,
  asar: false,
  extendInfo: { LSUIElement: true },
});
mkdirSync(dirname(appPath), { recursive: true });
execFileSync("/usr/bin/ditto", [join(built, "My Mind.app"), appPath]);
execFileSync("/usr/bin/plutil", ["-lint", join(appPath, "Contents/Info.plist")]);
const command = `exec ${shellQuote(desktop.nodePath)} ${shellQuote(join(appPath, "Contents/Resources/app/service.js"))} ${shellQuote(join(appPath, "Contents/Resources/app/desktop-config.json"))}`;
const definition = serviceDefinition(command);
mkdirSync(join(servicePath, "Contents"), { recursive: true });
for (const [file, data] of [
  ["Info.plist", definition.info],
  ["document.wflow", definition.workflow],
] as const) {
  execFileSync(
    "/usr/bin/plutil",
    ["-convert", "xml1", "-o", join(servicePath, "Contents", file), "-"],
    { input: JSON.stringify(data) },
  );
}
execFileSync("/System/Library/CoreServices/pbs", ["-update"]);
console.log(
  `Installed ${appPath}\nInstalled ${servicePath}\nShortcut: ${desktop.shortcut}\nLaunch with: open '${appPath}'`,
);
