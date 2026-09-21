import { cpSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { _electron as electron, expect, test } from "@playwright/test";
import { serviceDefinition, shellQuote } from "../../scripts/macos-service.js";

test("macOS service preserves selected text, including shell syntax and Unicode", async ({
  baseURL,
  request,
}) => {
  test.skip(process.platform !== "darwin", "macOS service");
  const root = mkdtempSync(join(tmpdir(), "pa-service-test-"));
  const configuration = join(root, "config.json");
  writeFileSync(
    configuration,
    JSON.stringify({
      projectDir: process.cwd(),
      nodePath: process.execPath,
      serverURL: baseURL,
      dataDir: root,
      shortcut: "Control+Alt+Shift+F12",
    }),
  );
  const command = `exec ${shellQuote(process.execPath)} ${shellQuote(resolve("dist/desktop/service.js"))} ${shellQuote(configuration)}`;
  const workflow = join(root, "capture.wflow");
  execFileSync("/usr/bin/plutil", ["-convert", "xml1", "-o", workflow, "-"], {
    input: JSON.stringify(serviceDefinition(command).workflow),
  });
  const selection =
    "Service verification: café, 'quotes', $(echo literal), `literal`\nSecond line remains intact.";
  await new Promise<void>((resolve, reject) => {
    const child = execFile(
      "/usr/bin/automator",
      ["-i", "-", workflow],
      { timeout: 15000 },
      (error) => (error ? reject(error) : resolve()),
    );
    child.stdin?.end(selection);
  });
  const items = await (await request.get("/api/items")).json();
  expect(items.filter((item: { original: string }) => item.original === selection)).toHaveLength(1);
});

test("desktop companion registers the global shortcut and hides only after capture succeeds", async ({
  baseURL,
  request,
}) => {
  test.skip(process.platform !== "darwin", "macOS companion");
  const root = mkdtempSync(join(tmpdir(), "pa-desktop-test-"));
  for (const file of ["main.js", "preload.cjs", "runtime.js"])
    cpSync(resolve("dist/desktop", file), join(root, file));
  writeFileSync(
    join(root, "package.json"),
    JSON.stringify({ name: "my-mind-test", main: "main.js", type: "module" }),
  );
  writeFileSync(
    join(root, "desktop-config.json"),
    JSON.stringify({
      projectDir: process.cwd(),
      nodePath: process.execPath,
      serverURL: baseURL,
      dataDir: root,
      shortcut: "Control+Alt+Shift+F12",
    }),
  );
  const companion = await electron.launch({ args: [root] });
  try {
    const page = await companion.firstWindow();
    await expect(page.getByRole("textbox", { name: "Quick capture" })).toBeVisible();
    expect(
      await companion.evaluate(({ globalShortcut }) =>
        globalShortcut.isRegistered("Control+Alt+Shift+F12"),
      ),
    ).toBe(true);
    await page.getByRole("textbox", { name: "Quick capture" }).fill("Desktop integration capture");
    await page.keyboard.press("Meta+Enter");
    await expect
      .poll(() =>
        companion.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isVisible()),
      )
      .toBe(false);
    const items = await (await request.get("/api/items")).json();
    expect(
      items.filter((item: { original: string }) => item.original === "Desktop integration capture"),
    ).toHaveLength(1);
    await companion.evaluate(({ app }) => app.emit("second-instance", {}, [], "", {}));
    await expect(page.getByRole("textbox", { name: "Quick capture" })).toHaveValue("");
    await page.getByRole("textbox", { name: "Quick capture" }).fill("A draft to keep");
    await page.keyboard.press("Escape");
    await expect
      .poll(() =>
        companion.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isVisible()),
      )
      .toBe(false);
    await companion.evaluate(({ app }) => app.emit("second-instance", {}, [], "", {}));
    await expect(page.getByRole("textbox", { name: "Quick capture" })).toHaveValue(
      "A draft to keep",
    );
  } finally {
    const closed = companion.waitForEvent("close");
    await companion.evaluate(({ app }) => {
      setImmediate(() => app.quit());
    });
    await closed;
  }
});

import { execFile, execFileSync } from "node:child_process";
