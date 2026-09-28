import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "@playwright/test";

test("onboards a model and portable profile, then exposes editable settings and an agent-neutral prompt", async ({
  page,
}) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Make this assistant yours." })).toBeVisible();
  await expect(page.getByRole("status")).toContainText("Connected. Choose a model");
  await page.screenshot({ path: "test-results/onboarding.png", fullPage: true });
  await page.getByLabel("Model", { exact: true }).fill("unsupported-model");
  await page.getByRole("button", { name: "Validate & save model" }).click();
  await expect(page.getByRole("alert")).toContainText("Model validation failed");
  await page.getByLabel("Model", { exact: true }).fill("test-model");
  await page.getByRole("button", { name: "Validate & save model" }).click();
  await page.getByLabel("Preferred name").fill("Alex");
  await page.getByLabel("Role", { exact: true }).fill("Product lead");
  await page.getByLabel("Important company context").fill("We build internal developer tools.");
  await page.getByLabel("Your team", { exact: true }).fill("Developer Experience");
  await page.getByLabel("Purpose of your team").fill("Make development easier.");
  await expect(page.getByLabel("Current projects and priorities")).toHaveCount(0);
  await page.getByRole("button", { name: "Create profile", exact: true }).click();
  await expect(page.getByLabel("Agent enrichment prompt")).toContainText(
    "Only access sources I authorize",
  );
  await page.getByRole("button", { name: "Open my assistant" }).click();
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page
    .getByRole("navigation", { name: "Settings sections" })
    .getByRole("button", { name: "Model", exact: true })
    .click();
  await page.getByRole("button", { name: "Edit model connection" }).click();
  await expect(page.getByLabel("Model", { exact: true })).toHaveValue("test-model");
  await expect(
    page.getByText("Environment variable: OPENAI_API_KEY", { exact: true }),
  ).toBeVisible();
  await expect(page.getByLabel("API key", { exact: true })).toHaveCount(0);
  await page.reload();
  await expect(page.getByRole("heading", { name: "A clearer day." })).toBeVisible();
});

test("clarifies a demo over two rounds, preserving saved answers across reloads", async ({
  page,
  request,
}) => {
  await page.goto("/");
  await page.getByLabel("What’s on your mind?").fill("Plan the demo with Benjamin");
  await page.getByRole("button", { name: "Capture", exact: true }).click();
  await page.getByRole("button", { name: "Inbox", exact: true }).click();
  await page.getByRole("button", { name: /^Plan the demo with Benjamin/ }).click();
  const project = page.getByLabel("1. Which project is this demo for?", { exact: true });
  await project.fill("Portal");
  await page.getByRole("button", { name: "Save answers", exact: true }).click();
  await expect(page.getByRole("button", { name: "Save answers", exact: true })).toBeDisabled();
  await page.reload();
  await page.getByRole("button", { name: "Inbox", exact: true }).click();
  await page.getByRole("button", { name: /^Plan the demo with Benjamin/ }).click();
  await expect(project).toHaveValue("Portal");
  await page.getByRole("button", { name: "Refine with answers", exact: true }).click();
  await expect(page.getByLabel("1. Which Benjamin do you mean?", { exact: true })).toBeVisible();
  await expect(project).toHaveCount(0);
  await page.getByText("Previous answers", { exact: true }).click();
  await expect(page.getByText("Portal", { exact: true })).toBeVisible();
  await page
    .getByLabel("1. Which Benjamin do you mean?", { exact: true })
    .fill("Benjamin from Design");
  await page.setViewportSize({ width: 390, height: 844 });
  await page.locator(".clarification-interview").scrollIntoViewIfNeeded();
  await page.screenshot({ path: "test-results/clarification-interview-mobile.png" });
  expect(
    await page
      .getByRole("dialog")
      .evaluate((element) => element.scrollWidth <= element.clientWidth),
  ).toBe(true);
  await page.getByRole("button", { name: "Refine with answers", exact: true }).click();
  await expect(page.getByLabel("Prompt", { exact: true })).toHaveValue(
    "Plan the Portal demo with Benjamin from Design.",
  );
  await expect(page.getByRole("region", { name: "Clarification questions" })).toHaveCount(0);
  const items = await (await request.get("/api/items")).json();
  const item = items.find(
    (entry: { original: string }) => entry.original === "Plan the demo with Benjamin",
  );
  expect(item.processing).toBe("ready");
  expect(item.clarifications.map((entry: { answer: string }) => entry.answer)).toEqual([
    "Portal",
    "Benjamin from Design",
  ]);
  await page.getByRole("button", { name: "Close item", exact: true }).click();
  await page.getByRole("button", { name: "Notebook", exact: true }).click();
  await expect(page.getByRole("button", { name: /^Plan the demo with Benjamin/ })).toBeVisible();
});

test("quick capture preserves dismissed drafts and sends only on explicit save", async ({
  page,
  request,
}) => {
  await page.goto("/#capture");
  const draft = page.getByRole("textbox", { name: "Quick capture" });
  await draft.fill("A thought from another application");
  await page.reload();
  await expect(draft).toHaveValue("A thought from another application");
  await page.getByRole("button", { name: "Capture", exact: true }).click();
  await expect(page.getByRole("status")).toContainText("Saved to your inbox.");
  await expect(draft).toHaveValue("");
  const items = await (await request.get("/api/items")).json();
  expect(
    items.filter(
      (item: { original: string }) => item.original === "A thought from another application",
    ),
  ).toHaveLength(1);
});

test("creates aliases through the profile editor and shows persisted capture annotations", async ({
  page,
  request,
}) => {
  const response = await request.post("/api/profile", {
    data: { title: "GitHub Access Management", type: "Project", body: "Manage repository access." },
  });
  const project = await response.json();
  await page.goto("/");
  await page.getByRole("button", { name: "Your context", exact: true }).click();
  await page.getByRole("button", { name: "Add aliases", exact: true }).click();
  await expect(page.getByLabel("Document type")).toHaveValue("Aliases");
  await page
    .getByLabel("Content", { exact: true })
    .fill(`| Alias | Kind | Target |\n| --- | --- | --- |\n| gham | project | ${project.path} |`);
  await page.getByRole("button", { name: "Save document" }).click();
  await expect(page.getByText("Saved and committed to your repository.")).toBeVisible();
  await page.getByLabel("What’s on your mind?").fill("Ask about ghma");
  await page.getByRole("button", { name: "Capture", exact: true }).click();
  await page.getByRole("button", { name: "Notebook", exact: true }).click();
  await page.getByRole("button", { name: /Ask about ghma/ }).click();
  await expect(
    page.getByText("Ask about ghma [GitHub Access Management]", { exact: true }),
  ).toBeVisible();
  await page.getByLabel("User input", { exact: true }).fill("Ask about ghma tomorrow");
  await page.getByRole("button", { name: "Save and refine" }).click();
  await expect(page.getByLabel("Prompt", { exact: true })).toHaveValue(
    "Implement: Ask about ghma tomorrow",
  );
  await page.reload();
  await page.getByRole("button", { name: "Notebook", exact: true }).click();
  await page.getByRole("button", { name: /Ask about ghma/ }).click();
  await expect(
    page.getByText("Ask about ghma [GitHub Access Management] tomorrow", { exact: true }),
  ).toBeVisible();
  await expect(page.getByLabel("Prompt", { exact: true })).toHaveValue(
    "Implement: Ask about ghma tomorrow",
  );
  await page.getByText("Original capture & sources").click();
  await expect(page.locator("pre").filter({ hasText: /^Ask about ghma$/ })).toBeVisible();
});

test("capture, organize, correct, complete, and retain an idea across reloads", async ({
  page,
  request,
}) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "A clearer day." })).toBeVisible();
  await page.getByLabel("What’s on your mind?").fill("Send the revised proposal to Anna");
  await page.getByRole("button", { name: "Capture", exact: true }).click();
  await expect(page.getByRole("status")).toContainText(/Captured\.|added to Notebook/);
  await page.getByRole("button", { name: "Notebook", exact: true }).click();
  await page.getByRole("button", { name: /Send the revised proposal/ }).click();
  await expect(page.getByLabel("Prompt", { exact: true })).toHaveValue(
    "Implement: Send the revised proposal to Anna",
  );
  const inputBounds = await page.getByLabel("User input", { exact: true }).boundingBox();
  const promptBounds = await page.getByLabel("Prompt", { exact: true }).boundingBox();
  if (!inputBounds || !promptBounds) throw new Error("Missing input or prompt field");
  expect(inputBounds.y + inputBounds.height).toBeLessThan(promptBounds.y);
  await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
  await page.getByRole("button", { name: "Copy prompt", exact: true }).click();
  await expect(page.getByRole("button", { name: "Prompt copied", exact: true })).toBeVisible();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(
    "Implement: Send the revised proposal to Anna",
  );
  await page.screenshot({ path: "test-results/refined-capture.png", fullPage: true });
  await page
    .getByLabel("Prompt", { exact: true })
    .fill("Send Anna the proposal after reviewing its acceptance criteria.");
  await page.getByText("More actions", { exact: true }).click();
  await expect(page.getByRole("button", { name: "Refine again", exact: true })).toBeDisabled();
  await page.locator(".capture-details summary").click();
  await page.getByLabel("Kind", { exact: true }).selectOption("commitment");
  const today = (await (await request.get("/api/today")).json()).date;
  await page.getByLabel("Due date").fill(today);
  await page.getByLabel("Project", { exact: true }).fill("Website redesign");
  await page.getByRole("button", { name: "Save changes" }).click();
  await expect(page.getByText("All changes saved", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Close item" }).click();
  await expect(page.getByRole("dialog")).not.toBeVisible();
  await page.getByRole("button", { name: "Today", exact: true }).click();
  await expect(page.getByRole("button", { name: /^Send the revised proposal/ })).toBeVisible();
  await page.getByRole("button", { name: /^Send the revised proposal/ }).click();
  await expect(page.getByLabel("Prompt", { exact: true })).toHaveValue(
    "Send Anna the proposal after reviewing its acceptance criteria.",
  );
  await page.getByRole("button", { name: "Close item" }).click();
  await page.getByRole("button", { name: "Complete Send the revised proposal to Anna" }).click();
  await expect(page.getByText("No deadlines in your way")).toBeVisible();

  await page
    .getByLabel("What’s on your mind?")
    .fill("Perhaps onboarding could include an invitation for a colleague");
  await page.getByRole("button", { name: "Capture", exact: true }).click();
  await page.getByRole("button", { name: "Notebook", exact: true }).click();
  await page.getByRole("button", { name: /Perhaps onboarding/ }).click();
  await page.locator(".capture-details summary").click();
  await page.getByLabel("Kind", { exact: true }).selectOption("idea");
  await page.getByLabel("Title", { exact: true }).fill("Invite a colleague during onboarding");
  await page.getByRole("button", { name: "Save changes" }).click();
  await expect(page.getByText("All changes saved", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Close item" }).click();
  await page.getByRole("button", { name: "Notebook", exact: true }).click();
  await expect(page.getByRole("button", { name: /Invite a colleague/ })).toBeVisible();
  await page.reload();
  await page.getByRole("button", { name: "Notebook", exact: true }).click();
  await page.getByRole("button", { name: /Invite a colleague/ }).click();
  await page.getByText("Original capture & sources").click();
  await expect(page.locator("pre").filter({ hasText: "Perhaps onboarding" })).toBeVisible();
  await page.getByRole("button", { name: "Close item" }).click();
});

test("incorporates explicit profile notes automatically and waits for approval on implicit notes", async ({
  page,
  request,
}) => {
  const explicit = "note: I prefer browser-tested atomic commits.";
  const implicit = "My browser-test review preference is a short summary.";
  await page.goto("/");
  await page.getByLabel("What’s on your mind?").fill(explicit);
  await page.getByRole("button", { name: "Capture", exact: true }).click();
  await expect
    .poll(async () => {
      const items = await (await request.get("/api/items")).json();
      return items.find((item: { original: string }) => item.original === explicit)?.status;
    })
    .toBe("done");
  await page.getByRole("button", { name: /^Inbox/ }).click();
  await expect(page.getByRole("button", { name: /note: I prefer browser-tested/ })).toHaveCount(0);
  await page.getByRole("button", { name: "Your context", exact: true }).click();
  await page.getByRole("button", { name: /Browser test preferences/ }).click();
  await expect(page.getByLabel("Markdown document")).toHaveValue(
    /note: I prefer browser-tested atomic commits\./,
  );

  await page.getByLabel("What’s on your mind?").fill(implicit);
  await page.getByRole("button", { name: "Capture", exact: true }).click();
  await expect
    .poll(async () => {
      const items = await (await request.get("/api/items")).json();
      return items.find((item: { original: string }) => item.original === implicit)?.kind;
    })
    .toBe("note");
  const before = await (await request.get("/api/profile")).json();
  expect(
    before.find((doc: { path: string }) => doc.path === "browser-test-preferences.md").content,
  ).not.toContain(implicit);
  await page.getByRole("button", { name: /^Inbox/ }).click();
  await page.getByRole("button", { name: /My browser-test review preference/ }).click();
  await expect(
    page.getByLabel("Status", { exact: true }).locator('option[value="done"]'),
  ).toHaveJSProperty("disabled", true);
  await page.getByRole("button", { name: "Add to profile", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "browser-test-preferences.md", exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "browser-test-preferences.md", exact: true }).click();
  await expect(page.getByLabel("Markdown document")).toHaveValue(
    /My browser-test review preference is a short summary\./,
  );
  await page.reload();
  await page.getByRole("button", { name: /^Inbox/ }).click();
  await expect(page.getByRole("button", { name: /My browser-test review preference/ })).toHaveCount(
    0,
  );
  await page.getByRole("button", { name: "Notebook", exact: true }).click();
  await expect(page.getByRole("button", { name: /My browser-test review preference/ })).toHaveCount(
    0,
  );
});

test("edits independent profile documents and adds project context", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Your context", exact: true }).click();
  await expect(page.getByText("Independent Git repository", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "About me Profile" }).click();
  const editor = page.getByLabel("Markdown document");
  const original = await editor.inputValue();
  await editor.fill(original.replace("Product lead", "I lead the customer experience team."));
  await page.getByRole("button", { name: "Save document" }).click();
  await expect(page.getByText("Saved and committed to your repository.")).toBeVisible();
  await page.getByRole("button", { name: "Add context" }).click();
  await page.getByLabel("Document title").fill("Customer onboarding");
  await page
    .getByLabel("Content", { exact: true })
    .fill("Also called Activation. I sponsor it; Anna leads delivery. Search Jira ACT.");
  await page.getByRole("button", { name: "Save document" }).click();
  await expect(page.getByRole("button", { name: "Customer onboarding Project" })).toBeVisible();
});

test("brings the context editor into view when selecting files from a long list", async ({
  page,
}) => {
  const documents = Array.from({ length: 40 }, (_, index) => ({
    path: `context-${index}.md`,
    title: `Context ${index}`,
    type: "Project",
    description: "",
    content: `# Context ${index}\n\nDocument ${index} contents.`,
    hash: `${index}`,
  }));
  await page.route("**/api/profile", (route) => route.fulfill({ json: documents }));
  await page.goto("/");
  await page.getByRole("button", { name: "Your context", exact: true }).click();
  await page.getByRole("button", { name: "Context 0 Project", exact: true }).click();
  const editor = page.getByLabel("Markdown document");
  const lastDocument = page.getByRole("button", { name: "Context 39 Project", exact: true });
  await lastDocument.scrollIntoViewIfNeeded();
  await expect(editor).not.toBeInViewport();
  await lastDocument.click();
  await expect(editor).toHaveValue(documents[39].content);
  await expect(editor).toBeInViewport();
  await expect(page.getByRole("heading", { name: "Context 39", exact: true })).toBeInViewport();
  await page.getByRole("button", { name: "Add context", exact: true }).click();
  await expect(page.getByLabel("Document title")).toBeInViewport();
  await page.getByLabel("Document title").fill("Unsaved context");
  page.once("dialog", (dialog) => dialog.dismiss());
  await lastDocument.click();
  await expect(page.getByLabel("Document title")).toHaveValue("Unsaved context");
  await expect(page.getByLabel("Document title")).not.toBeInViewport();
});

test("shows editable model settings on a narrow screen", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/");
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page
    .getByRole("navigation", { name: "Settings sections" })
    .getByRole("button", { name: "Model", exact: true })
    .click();
  await page.getByRole("button", { name: "Edit model connection" }).click();
  await expect(page.getByLabel("Model", { exact: true })).toHaveValue("test-model");
  await page.screenshot({ path: "test-results/settings-mobile.png", fullPage: true });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
});

test("allows manual tenant entry when detection fails or finishes after an edit", async ({
  page,
}) => {
  await page.route("**/api/settings/entra/tenant", (route) =>
    route.fulfill({ json: { tenantId: null } }),
  );
  await page.goto("/");
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page
    .getByRole("navigation", { name: "Settings sections" })
    .getByRole("button", { name: "People", exact: true })
    .click();
  await expect(page.getByText("Could not detect a tenant.", { exact: false })).toBeVisible();
  const tenant = page.getByLabel("Entra tenant ID");
  await tenant.fill("33333333-3333-4333-8333-333333333333");
  await page.unroute("**/api/settings/entra/tenant");
  let release = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let requested = () => {};
  const requestStarted = new Promise<void>((resolve) => {
    requested = resolve;
  });
  await page.route("**/api/settings/entra/tenant", async (route) => {
    requested();
    await gate;
    await route.fulfill({ json: { tenantId: "11111111-1111-4111-8111-111111111111" } });
  });
  await tenant.fill("");
  await requestStarted;
  await tenant.fill("44444444-4444-4444-8444-444444444444");
  const response = page.waitForResponse("**/api/settings/entra/tenant");
  release();
  await response;
  await expect(tenant).toHaveValue("44444444-4444-4444-8444-444444444444");
});

test("configures project roots and discovers project knowledge without onboarding interviews", async ({
  page,
  request,
}) => {
  const root = mkdtempSync(join(tmpdir(), "pa-discovery-ui-"));
  const repo = join(root, "example-project");
  mkdirSync(repo);
  execFileSync("git", ["init", repo], { stdio: "ignore" });
  writeFileSync(join(repo, "README.md"), "# Team onboarding\nA local app. Run mise run check.");
  await page.goto("/");
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page
    .getByRole("navigation", { name: "Settings sections" })
    .getByRole("button", { name: "Projects", exact: true })
    .click();
  await page.getByRole("button", { name: "Enter path manually" }).click();
  await page.getByLabel("Directory 1", { exact: true }).fill(root);
  await page.getByRole("button", { name: "Save project directories" }).click();
  await expect(page.getByRole("status")).toContainText("Project directories saved");
  await page.getByRole("button", { name: "Scan now", exact: true }).click();
  await expect(page.getByRole("table").getByText("Updated", { exact: true })).toBeVisible({
    timeout: 15000,
  });
  const docs = await (await request.get("/api/profile")).json();
  const project = docs.find((doc: { title: string }) => doc.title === "example-project");
  expect(project.content).toContain("repository_fingerprint:");
  expect(project.content).toContain("updated_at:");
  expect(project.content).not.toContain("last_scanned");
  expect(
    (
      await request.post("/api/projects/scan", { data: { projectIds: ["unknown-project"] } })
    ).status(),
  ).toBe(400);
  await page.getByRole("button", { name: "Details for example-project" }).click();
  await page.getByRole("button", { name: "Open document", exact: true }).click();
  await expect(
    page.getByRole("region", { name: "Profile document: example-project" }),
  ).toContainText("A project for team onboarding");
  await page.getByRole("button", { name: "Close document" }).click();
  await page.getByText("Diagnostics", { exact: true }).click();
  await expect(page.getByText("resp_edit_7", { exact: true })).toBeVisible();
  await page.getByLabel("Project status").selectOption("attention");
  await expect(page.getByText("No projects match your search and filter.")).toBeVisible();
  await page.getByLabel("Project status").selectOption("all");
  await page.screenshot({ path: "test-results/project-settings.png", fullPage: true });
  await page.reload();
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page
    .getByRole("navigation", { name: "Settings sections" })
    .getByRole("button", { name: "Projects", exact: true })
    .click();
  await page.getByRole("button", { name: "Edit directories" }).click();
  await expect(page.getByLabel("Directory 1", { exact: true })).toHaveValue(/pa-discovery-ui-/);
});

test("shows provider diagnostics and current progress separately from previous errors", async ({
  page,
  request,
  context,
}) => {
  const status = await (await request.get("/api/projects")).json();
  const project = status.projects[0];
  project.error = "The model provider returned HTTP 503. Check provider availability and access.";
  project.outcome = "failed";
  project.diagnostic = { category: "provider", message: project.error, statusCode: 503 };
  status.error = "One project could not be updated.";
  await page.route("**/api/projects", (route) => route.fulfill({ json: status }));
  let selected: string[] = [];
  await page.route("**/api/projects/scan", async (route) => {
    selected = route.request().postDataJSON().projectIds;
    project.previousError = project.error;
    project.error = null;
    project.outcome = undefined;
    project.diagnostic = undefined;
    project.responseId = "resp_retry";
    project.phase = "reading";
    project.startedAt = new Date().toISOString();
    project.finishedAt = undefined;
    project.filesRead = 4;
    status.running = true;
    status.phase = "reviewing";
    status.completed = 0;
    status.error = null;
    status.lastAttempt = project.startedAt;
    await route.fulfill({ json: status });
  });
  await page.goto("/");
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page
    .getByRole("navigation", { name: "Settings sections" })
    .getByRole("button", { name: "Projects", exact: true })
    .click();
  const menu = page.locator(".project-settings");
  await menu.getByRole("button", { name: "Details for example-project" }).click();
  await menu.getByText("Diagnostics", { exact: true }).click();
  await expect(menu.getByText("HTTP 503", { exact: true })).toBeVisible();
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await menu.getByRole("button", { name: "Copy diagnostics" }).click();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toContain('"statusCode": 503');
  await menu.getByRole("button", { name: "Retry project", exact: true }).click();
  expect(selected).toEqual([project.id]);
  await expect(menu.getByText("0 of 1 projects reviewed", { exact: true })).toBeVisible();
  await expect(menu.getByText(/^Previous attempt:/)).toContainText("HTTP 503");
  await expect(menu.getByText("4 files read", { exact: true })).toBeVisible();
  await menu.screenshot({ path: "test-results/project-progress.png" });
  project.phase = "done";
  project.outcome = "updated";
  project.previousError = null;
  project.diagnostic = undefined;
  project.finishedAt = new Date().toISOString();
  status.running = false;
  status.completed = 1;
  await expect(menu.getByRole("table").getByText("Updated", { exact: true })).toBeVisible({
    timeout: 10000,
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await menu.screenshot({ path: "test-results/project-settings-mobile.png" });
  expect(await menu.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
});

test("configures Entra, syncs the directory outside the profile, and keeps client secrets private", async ({
  page,
  request,
}) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page
    .getByRole("navigation", { name: "Settings sections" })
    .getByRole("button", { name: "People", exact: true })
    .click();
  await page.getByLabel("Automatic people sync").selectOption("true");
  await expect(page.getByLabel("Entra tenant ID")).toHaveValue(
    "11111111-1111-4111-8111-111111111111",
  );
  await page.getByLabel("Entra tenant ID").fill("33333333-3333-4333-8333-333333333333");
  await page.getByLabel("Your directory email").fill("alex@example.com");
  await expect(
    page.getByText("Teams may attach directly to a subdivision", { exact: false }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Save Entra settings" }).click();
  await expect(page.getByText("Entra settings saved.", { exact: false })).toBeVisible();
  await page.getByRole("button", { name: "Sync people now" }).click();
  await expect(
    page.getByText("2 people imported; 0 accounts skipped", { exact: false }),
  ).toBeVisible({ timeout: 15000 });
  const documents = await (await request.get("/api/profile")).json();
  const people = documents.find((doc: { path: string }) => doc.path === "people.md");
  expect(people).toBeUndefined();
  const enrichment = await (await request.get("/api/profile/enrichment")).json();
  expect(enrichment.prompt).not.toContain("people.md");
  await page.getByRole("button", { name: "Your context", exact: true }).click();
  await expect(page.getByRole("button", { name: "People People directory" })).toHaveCount(0);
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page
    .getByRole("navigation", { name: "Settings sections" })
    .getByRole("button", { name: "People", exact: true })
    .click();
  await page.getByRole("button", { name: "Edit people connection" }).click();
  await page.getByLabel("Automatic people sync").selectOption("false");
  await expect(page.getByLabel("Entra tenant ID")).toHaveValue(
    "33333333-3333-4333-8333-333333333333",
  );
  await page.getByLabel("Entra authentication").selectOption("client-secret");
  await page.getByLabel("Entra client ID").fill("22222222-2222-4222-8222-222222222222");
  await page.getByLabel("Entra client secret").fill("browser-fixture-secret");
  await page.getByRole("button", { name: "Save Entra settings" }).click();
  await page.getByRole("button", { name: "Edit people connection" }).click();
  await expect(page.getByLabel("Entra client secret")).toHaveValue("");
  expect(await (await request.get("/api/settings")).text()).not.toContain("browser-fixture-secret");
  await page.reload();
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page
    .getByRole("navigation", { name: "Settings sections" })
    .getByRole("button", { name: "People", exact: true })
    .click();
  await page.getByRole("button", { name: "Edit people connection" }).click();
  await expect(page.getByLabel("Entra client secret")).toHaveValue("");
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: "test-results/people-settings-mobile.png", fullPage: true });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
});

test("connects T3 Code and implements a saved commitment with recoverable handoff", async ({
  page,
  request,
}) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page
    .getByRole("navigation", { name: "Settings sections" })
    .getByRole("button", { name: "T3 Code", exact: true })
    .click();
  await page.getByLabel("T3 Code endpoint", { exact: true }).fill("http://127.0.0.1:4321");
  await page.getByLabel("T3 Code pairing token", { exact: true }).fill("wrong-token");
  await page.getByLabel("T3 Code default model", { exact: true }).fill("fixture-model");
  await page.getByRole("button", { name: "Connect T3 Code", exact: true }).click();
  await expect(page.getByText(/T3 Code rejected access/)).toBeVisible();
  await page.getByLabel("T3 Code pairing token", { exact: true }).fill("fixture-pairing");
  await page.getByRole("button", { name: "Connect T3 Code", exact: true }).click();
  await expect(page.getByText("T3 Code connected and saved.", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Edit T3 Code connection" }).click();
  await expect(page.getByLabel("T3 Code pairing token", { exact: true })).toHaveValue("");
  expect(await (await request.get("/api/settings/t3")).text()).not.toContain("fixture-t3-secret");
  await page.getByRole("button", { name: "Test T3 Code connection", exact: true }).click();
  await expect(page.getByText("T3 Code is reachable.", { exact: true })).toBeVisible();
  await page.screenshot({ path: "test-results/t3-settings.png", fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.locator(".t3-settings").screenshot({ path: "test-results/t3-settings-mobile.png" });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
  await page.setViewportSize({ width: 1280, height: 900 });

  await page.getByRole("button", { name: "Today", exact: true }).click();
  await page.getByLabel("What’s on your mind?").fill("Implement project search in T3 Code");
  await page.getByRole("button", { name: "Capture", exact: true }).click();
  await page.getByRole("button", { name: "Notebook", exact: true }).click();
  await page.getByRole("button", { name: /Implement project search in T3 Code/ }).click();
  await expect(page.getByLabel("Prompt", { exact: true })).toHaveValue(
    "Implement: Implement project search in T3 Code",
  );
  await page.locator(".capture-details summary").click();
  await page.getByLabel("Kind", { exact: true }).selectOption("commitment");
  await page.getByRole("button", { name: "Save changes", exact: true }).click();
  await expect(page.getByText("All changes saved", { exact: true })).toBeVisible();
  const projects = await (await request.get("/api/projects")).json();
  execFileSync(
    "git",
    [
      "-C",
      projects.projects[0].path,
      "-c",
      "user.name=Test",
      "-c",
      "user.email=test@example.com",
      "commit",
      "--allow-empty",
      "-m",
      "test: initialize implementation workspace",
    ],
    { stdio: "ignore" },
  );
  await expect(page.getByLabel("Implementation repository", { exact: true })).toHaveValue(
    projects.projects[0].id,
  );
  await expect(page.getByRole("button", { name: "Start in T3 Code", exact: true })).toBeEnabled();
  const items = await (await request.get("/api/items")).json();
  const commitment = items.find(
    (item: { title: string }) => item.title === "Implement project search in T3 Code",
  );
  expect(commitment.repositoryId).toBe(projects.projects[0].id);
  await request.patch(`/api/items/${commitment.id}`, {
    data: { revision: commitment.revision, project: "Unresolved project" },
  });
  await expect(page.getByLabel("Implementation repository", { exact: true })).toBeVisible({
    timeout: 10000,
  });
  await expect(page.getByRole("button", { name: "Choose repository", exact: true })).toBeVisible();
  await request.patch(`/api/items/${commitment.id}`, {
    data: { revision: commitment.revision + 1, project: "example-project" },
  });
  await expect(page.getByLabel("Implementation repository", { exact: true })).toHaveValue(
    projects.projects[0].id,
    { timeout: 10000 },
  );
  await expect(page.getByRole("button", { name: "Start in T3 Code", exact: true })).toBeEnabled();
  await page.getByLabel("Prompt", { exact: true }).fill("Unsaved implementation change");
  await expect(
    page.getByRole("button", { name: "Save and start in T3 Code", exact: true }),
  ).toBeEnabled();
  await page
    .getByLabel("Prompt", { exact: true })
    .fill("Implement: Implement project search in T3 Code");
  await page.getByRole("button", { name: "Start in T3 Code", exact: true }).click();
  await expect(page.getByRole("button", { name: "Retry handoff", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Retry handoff", exact: true }).click();
  await expect(
    page.getByRole("link", { name: "Continue in T3 Code", exact: true }),
  ).toHaveAttribute("href", /http:\/\/127\.0\.0\.1:4321\/fixture\//);
  await expect(page.getByLabel("Status", { exact: true })).toHaveValue("in_progress");
  let commands = await (await request.get("http://127.0.0.1:4321/test/commands")).json();
  expect(
    commands.filter((command: { type: string }) => command.type === "project.create"),
  ).toHaveLength(1);
  expect(
    commands.filter((command: { type: string }) => command.type === "thread.turn.start"),
  ).toHaveLength(1);
  await page.screenshot({ path: "test-results/t3-implementation.png", fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await page
    .locator(".implementation")
    .screenshot({ path: "test-results/t3-implementation-mobile.png" });
  expect(
    await page
      .locator(".capture-editor")
      .evaluate((element) => element.scrollWidth <= element.clientWidth),
  ).toBe(true);
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.getByText("More actions", { exact: true }).click();
  await page.getByRole("button", { name: "Start another implementation", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Start another implementation", exact: true }),
  ).toBeEnabled();
  commands = await (await request.get("http://127.0.0.1:4321/test/commands")).json();
  expect(
    commands.filter((command: { type: string }) => command.type === "project.create"),
  ).toHaveLength(1);
  expect(
    commands.filter((command: { type: string }) => command.type === "thread.turn.start"),
  ).toHaveLength(2);
  await page.getByRole("button", { name: "Close item", exact: true }).click();
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page
    .getByRole("navigation", { name: "Settings sections" })
    .getByRole("button", { name: "T3 Code", exact: true })
    .click();
  await page.getByRole("button", { name: "Disconnect T3 Code", exact: true }).click();
  await expect(page.getByText("T3 Code disconnected.", { exact: false })).toBeVisible();
});

test("keeps settings drafts across navigation and cancels without saving", async ({
  page,
  request,
}) => {
  const saved = await (await request.get("/api/settings")).json();
  await page.goto("/");
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  const navigation = page.getByRole("navigation", { name: "Settings sections" });
  await expect(navigation.getByRole("button", { name: "General", exact: true })).toHaveAttribute(
    "aria-current",
    "page",
  );
  await page.getByRole("button", { name: "Edit profile & timezone" }).click();
  await page.getByLabel("Timezone", { exact: true }).fill("America/New_York");
  await expect(page.getByText("Unsaved changes", { exact: true })).toBeVisible();
  await navigation.getByRole("button", { name: "Projects", exact: true }).click();
  await expect(page.getByLabel("Timezone", { exact: true })).not.toBeVisible();
  await navigation.getByRole("button", { name: "General", exact: true }).click();
  await expect(page.getByLabel("Timezone", { exact: true })).toHaveValue("America/New_York");
  await page.getByRole("button", { name: "Today", exact: true }).click();
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await expect(page.getByLabel("Timezone", { exact: true })).toHaveValue("America/New_York");
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  await page.getByRole("button", { name: "Edit profile & timezone" }).click();
  await expect(page.getByLabel("Timezone", { exact: true })).toHaveValue(saved.timezone);
  expect((await (await request.get("/api/settings")).json()).timezone).toBe(saved.timezone);
  await page.getByRole("button", { name: "Your context", exact: true }).click();
  await expect(page.getByRole("button", { name: "Prepare agent prompt" })).toBeVisible();
});

test("learns profile context from activity and shows the committed result", async ({
  page,
  request,
}) => {
  const response = await request.post("/api/captures", {
    data: { text: "My team now owns partner enablement." },
  });
  expect(response.ok()).toBe(true);
  const item = await response.json();
  await expect
    .poll(async () => {
      const items = await (await request.get("/api/items")).json();
      return items.find((entry: { id: string }) => entry.id === item.id).refinement;
    })
    .not.toBe("running");
  await page.goto("/");
  await page.getByRole("button", { name: "Your context", exact: true }).click();
  const learning = page.getByRole("region", { name: "Daily profile learning" });
  await learning.getByRole("button", { name: "Learn from recent activity" }).click();
  await expect(
    learning.getByText("Recorded the team's partner enablement responsibility."),
  ).toBeVisible({ timeout: 15000 });
  const documents = await (await request.get("/api/profile")).json();
  expect(
    documents.find((doc: { path: string }) => doc.path === "partner-enablement.md").content,
  ).toContain("My team now owns partner enablement.");
  const settings = await (await request.get("/api/settings")).json();
  expect(
    execFileSync("git", ["-C", settings.profilePath, "log", "-1", "--format=%s"], {
      encoding: "utf8",
    }).trim(),
  ).toBe("docs(profile): consolidate daily activity");
  await page.screenshot({ path: "test-results/profile-learning.png", fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: "test-results/profile-learning-mobile.png", fullPage: true });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
});

test("chooses project directories, handles cancellation and failure, and saves only explicitly", async ({
  page,
  request,
}) => {
  const saved = await (await request.get("/api/settings")).json();
  const chosen = mkdtempSync(join(tmpdir(), "pa chosen directory-"));
  let pickerResult: string | null = null;
  let pickerError = false;
  await page.route("**/api/settings/directory", (route) =>
    route.fulfill({
      status: pickerError ? 503 : 200,
      json: pickerError ? { error: "Could not open the folder chooser." } : { path: pickerResult },
    }),
  );
  await page.goto("/");
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page
    .getByRole("navigation", { name: "Settings sections" })
    .getByRole("button", { name: "Projects", exact: true })
    .click();
  await page.getByRole("button", { name: "Edit directories" }).click();
  const rows = page.locator(".directory-row");
  await page.getByRole("button", { name: "Choose directory…" }).click();
  await expect(rows).toHaveCount(saved.projectRoots.length);
  pickerResult = chosen;
  await page.getByRole("button", { name: "Choose directory…" }).click();
  await expect(rows).toHaveCount(saved.projectRoots.length + 1);
  await expect(
    page.getByLabel(`Directory ${saved.projectRoots.length + 1}`, { exact: true }),
  ).toHaveValue(chosen);
  expect((await (await request.get("/api/settings")).json()).projectRoots).toEqual(
    saved.projectRoots,
  );
  await page.getByRole("button", { name: "Save project directories" }).click();
  await expect(page.getByText("Project directories saved.", { exact: false })).toBeVisible();
  expect((await (await request.get("/api/settings")).json()).projectRoots).toEqual([
    ...saved.projectRoots,
    realpathSync(chosen),
  ]);
  await page.getByRole("button", { name: "Edit directories" }).click();
  pickerError = true;
  await page.getByRole("button", { name: "Browse directory 1", exact: true }).click();
  await expect(page.getByRole("alert")).toHaveText("Could not open the folder chooser.");
  await page.getByLabel("Directory 1", { exact: true }).fill("/unsaved/path");
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({
    path: "test-results/project-directory-picker-mobile.png",
    fullPage: true,
  });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  await page.getByRole("button", { name: "Edit directories" }).click();
  await expect(page.getByLabel("Directory 1", { exact: true })).toHaveValue(saved.projectRoots[0]);
});

test("explains file credentials, requires keys for other endpoints, and preserves drafts after validation failure", async ({
  page,
  request,
}) => {
  const saved = await (await request.get("/api/settings")).json();
  const endpoint = "https://models.example/v1";
  const fixture = {
    ...saved,
    baseURL: endpoint,
    credentialSources: [{ source: "file", endpoint, path: "/fixture/provider.key" }],
  };
  await page.route("**/api/settings", (route) => route.fulfill({ json: fixture }));
  await page.goto("/");
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page
    .getByRole("navigation", { name: "Settings sections" })
    .getByRole("button", { name: "Model", exact: true })
    .click();
  await page.getByRole("button", { name: "Edit model connection" }).click();
  await expect(page.getByText("Local key file", { exact: true })).toBeVisible();
  await expect(page.getByText("/fixture/provider.key", { exact: true })).toBeVisible();
  await expect(page.getByLabel("API key", { exact: true })).toHaveCount(0);
  await page.getByLabel("API endpoint", { exact: true }).fill("https://other.example/v1");
  await expect(
    page.getByText("No credential available for this endpoint", { exact: true }),
  ).toBeVisible();
  await expect(page.getByRole("button", { name: "Validate & save model" })).toBeDisabled();
  await page.getByLabel("Credential source").selectOption("new");
  await expect(page.getByRole("button", { name: "Validate & save model" })).toBeDisabled();
  await page.getByLabel("API key", { exact: true }).fill("fixture-key");
  let submitted: unknown;
  await page.route("**/api/settings/connection", (route) => {
    submitted = route.request().postDataJSON();
    return route.fulfill({
      status: 400,
      json: { error: "Model validation failed. Your previous settings are unchanged." },
    });
  });
  await page.getByRole("button", { name: "Validate & save model" }).click();
  await expect(page.getByRole("alert")).toContainText("Model validation failed");
  await expect(page.getByLabel("API key", { exact: true })).toHaveValue("fixture-key");
  expect(submitted).toEqual({
    baseURL: "https://other.example/v1",
    model: saved.model,
    apiKey: "fixture-key",
  });
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  await page.getByRole("button", { name: "Edit model connection" }).click();
  await expect(page.getByLabel("API endpoint", { exact: true })).toHaveValue(endpoint);
  await expect(page.getByLabel("API key", { exact: true })).toHaveCount(0);
  await page.screenshot({ path: "test-results/model-credential-source.png", fullPage: true });
});

test("repairs a saved model with missing credentials through connection testing and validation", async ({
  page,
  request,
}) => {
  const saved = await (await request.get("/api/settings")).json();
  let settings = { ...saved, aiConfigured: false, credentialSources: [] };
  await page.route("**/api/settings", (route) => route.fulfill({ json: settings }));
  await page.route("**/api/settings/connection", async (route) => {
    const response = await route.fetch();
    expect(response.ok()).toBe(true);
    settings = await response.json();
    await route.fulfill({ response });
  });
  await page.goto("/");
  await expect(page.getByText("Capture mode", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page
    .getByRole("navigation", { name: "Settings sections" })
    .getByRole("button", { name: "Model", exact: true })
    .click();
  await expect(page.getByText("Credential required", { exact: true })).toBeVisible();
  await expect(page.getByText(/No API key is available for the saved endpoint/)).toBeVisible();
  await page.getByRole("button", { name: "Edit model connection" }).click();
  await expect(page.getByLabel("Credential source")).toHaveValue("new");
  await expect(page.getByText("Unsaved changes", { exact: true })).toHaveCount(0);
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  await page.getByRole("button", { name: "Edit model connection" }).click();
  await expect(page.getByLabel("Credential source")).toHaveValue("new");
  await page.getByLabel("API key", { exact: true }).fill("test-key");
  await page.getByLabel("Model", { exact: true }).fill("");
  await page.getByRole("button", { name: "Test connection & load models" }).click();
  await expect(
    page.getByText("Connected. Choose a model to validate.", { exact: true }),
  ).toBeVisible();
  await expect(page.locator("#available-models option")).toHaveCount(2);
  await page.getByLabel("Model", { exact: true }).fill("test-model");
  await page.getByRole("button", { name: "Validate & save model" }).click();
  await expect(page.getByText("Model validated and saved.", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Today", exact: true }).click();
  await expect(page.getByText("Assistant connected", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await expect(page.getByText("Credential required", { exact: true })).toHaveCount(0);
  await page.getByRole("button", { name: "Edit model connection" }).click();
  await expect(page.getByLabel("Credential source")).toHaveValue("existing");
  await expect(page.getByLabel("API key", { exact: true })).toHaveCount(0);
});
