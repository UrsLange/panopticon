import { expect, type Page, test } from "@playwright/test";
import { capturedItem } from "../../server/application/items";
import { defaultEntra } from "../../shared/people";
import type { Capture, Settings } from "../../shared/schema";
import type { ImplementationOptions } from "../../shared/t3";

async function capturePage(page: Page, changes: Partial<Capture> = {}) {
  let item: Capture = {
    ...capturedItem("Add Kiana to GitHub", "capture-test", "2026-09-23T09:00:00.000Z"),
    kind: "commitment",
    prompt: "Add the specified access and verify it.",
    processing: "ready",
    refinement: "ready",
    ...changes,
  };
  const settings: Settings = {
    aiConfigured: true,
    modelReady: true,
    profileReady: true,
    model: "test-model",
    provider: "http://127.0.0.1:4320",
    baseURL: "http://127.0.0.1:4320/v1",
    credentialSources: [{ source: "environment", endpoint: "http://127.0.0.1:4320/v1" }],
    profilePath: "/test/profile",
    profileGit: true,
    projectRoots: [],
    timezone: "Europe/Berlin",
    ctxAvailable: false,
    entra: defaultEntra,
  };
  const options: ImplementationOptions = {
    configured: true,
    repositories: [{ id: "access", name: "GitHub access", path: "/repos/access" }],
    suggestedRepositoryId: "access",
    latest: null,
  };
  const launches: { revision: number; repositoryId: string }[] = [];
  let saves = 0;
  let refinements = 0;
  await page.route("**/api/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === "/api/settings") return route.fulfill({ json: settings });
    if (path === "/api/profile") return route.fulfill({ json: [] });
    if (path === "/api/items") return route.fulfill({ json: [item] });
    if (path === "/api/today")
      return route.fulfill({
        json: {
          date: "2026-09-23",
          due: [],
          suggested: item.status === "open" ? [item] : [],
          waiting: [],
        },
      });
    if (path.endsWith("/implementation")) {
      if (route.request().method() === "POST") {
        launches.push(route.request().postDataJSON());
        options.latest = {
          id: "thread-test",
          revision: item.revision,
          repositoryId: "access",
          workspaceRoot: "/repos/access",
          createdAt: item.updatedAt,
          state: "submitted",
          error: null,
          url: "http://localhost:4321/environment/thread-test",
          taskChanged: false,
        };
        item = { ...item, status: "in_progress", revision: item.revision + 1 };
        return route.fulfill({ json: options.latest });
      }
      return route.fulfill({ json: options });
    }
    if (path.endsWith("/implementation/refresh")) {
      const progress = options.latest?.progress;
      if (progress?.localMerge?.merged)
        item = { ...item, status: "done", revision: item.revision + 1 };
      else if (progress?.turnState === "completed")
        item = { ...item, status: "in_review", revision: item.revision + 1 };
      return route.fulfill({ json: options });
    }
    if (path === `/api/items/${item.id}` && route.request().method() === "PATCH") {
      saves++;
      const fields = route.request().postDataJSON();
      const bodyChanged = fields.body !== undefined && fields.body !== item.body;
      item = { ...item, ...fields, revision: item.revision + 1 };
      if (bodyChanged) item = { ...item, refinement: "running", processing: "pending" };
      return route.fulfill({ json: item });
    }
    if (path.endsWith("/process")) {
      refinements++;
      item = { ...item, refinement: "running", processing: "pending", processingError: null };
      return route.fulfill({ json: item });
    }
    return route.fulfill({ status: 404, json: { error: `Unexpected test request: ${path}` } });
  });
  await page.clock.install();
  await page.goto("/");
  await page
    .getByRole("button", { name: item.refinement === "ready" ? "Tasks" : "Inbox", exact: true })
    .click();
  await page.getByRole("button", { name: /^Add Kiana to GitHub/ }).click();
  return {
    options,
    settings,
    launches,
    get saves() {
      return saves;
    },
    get refinements() {
      return refinements;
    },
    get item() {
      return item;
    },
    async update(changes: Partial<Capture>) {
      item = { ...item, ...changes };
      await page.clock.fastForward(5000);
    },
  };
}

test("explains failures and previous clarification, and prevents duplicate refinement", async ({
  page,
}) => {
  const state = await capturePage(page, {
    refinement: "failed",
    processing: "pending",
    processingError: "Interpretation failed. Check model settings and retry.",
    rationale: "Which access category and repository scope should Kiana receive?",
  });
  await expect(page.getByRole("region", { name: "Capture status" })).toContainText(
    "Refinement failed",
  );
  await expect(page.getByText("Previous interpretation", { exact: true })).toBeVisible();
  await expect(page.getByText(/Which access category/)).toBeVisible();
  await page.screenshot({ path: "test-results/capture-failure-desktop.png" });
  await page.getByRole("button", { name: "Retry refinement", exact: true }).click();
  await expect(page.getByRole("button", { name: "Refining…", exact: true })).toBeDisabled();
  await page.getByText("More actions", { exact: true }).click();
  await expect(page.getByRole("button", { name: "Refine again", exact: true })).toBeDisabled();
  await page
    .getByLabel("User input", { exact: true })
    .fill("Kiana needs restricted access to portal.");
  await state.update({
    refinement: "review",
    processing: "review",
    rationale: "Confirm the access category.",
    revision: 1,
  });
  await expect(page.getByLabel("User input", { exact: true })).toHaveValue(
    "Kiana needs restricted access to portal.",
  );
  await expect(page.getByRole("button", { name: "Save and refine", exact: true })).toBeEnabled();
  expect(state.refinements).toBe(1);
  await page.getByRole("button", { name: "Save and refine", exact: true }).click();
  expect(state.launches).toHaveLength(0);
  await expect(page.getByRole("button", { name: "Refining…", exact: true })).toBeDisabled();
  await state.update({ refinement: "ready", processing: "ready", revision: 2 });
  await expect(page.getByRole("button", { name: "Start in T3 Code", exact: true })).toBeEnabled();
  expect(state.launches).toHaveLength(0);
});

test("dismisses drafts without saving and does not reopen when refinement finishes", async ({
  page,
}) => {
  const state = await capturePage(page, { refinement: "running", processing: "pending" });
  await page.getByLabel("Title", { exact: true }).fill("Unsaved title");
  await page.mouse.click(2, 2);
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await state.update({ refinement: "ready", processing: "ready", revision: 1 });
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await page.getByRole("button", { name: "Tasks", exact: true }).click();
  await page.getByRole("button", { name: /^Add Kiana to GitHub/ }).click();
  await expect(page.getByLabel("Title", { exact: true })).toHaveValue("Add Kiana to GitHub");
  for (const close of ["Escape", "Close item"]) {
    await page.getByLabel("Title", { exact: true }).fill("Another draft");
    if (close === "Escape") await page.keyboard.press("Escape");
    else await page.getByRole("button", { name: close }).click();
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await page.getByRole("button", { name: /^Add Kiana to GitHub/ }).click();
    await expect(page.getByLabel("Title", { exact: true })).toHaveValue("Add Kiana to GitHub");
  }
  expect(state.saves).toBe(0);
});

test("preserves drafts through settings and saves the exact version sent to T3 Code", async ({
  page,
}) => {
  const state = await capturePage(page, {
    refinement: "failed",
    processing: "pending",
    processingError: "Model unavailable",
  });
  await page.getByLabel("Title", { exact: true }).fill("Kiana access request");
  await page.getByRole("button", { name: "Check model settings", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Model connection", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Back to capture", exact: true }).click();
  await expect(page.getByLabel("Title", { exact: true })).toHaveValue("Kiana access request");
  await state.update({
    refinement: "ready",
    processing: "ready",
    processingError: null,
    revision: 1,
  });
  await page.getByRole("button", { name: "Save and start in T3 Code", exact: true }).click();
  await expect(page.getByRole("link", { name: "Continue in T3 Code", exact: true })).toBeVisible();
  expect(state.item.title).toBe("Kiana access request");
  expect(state.saves).toBe(1);
  expect(state.launches).toEqual([{ revision: 2, repositoryId: "access" }]);
  expect(state.item.status).toBe("in_progress");
  await expect(
    page.getByRole("button", { name: "Start another implementation", exact: true }),
  ).not.toBeVisible();
});

test("shows missing information and repository together and fits a narrow screen", async ({
  page,
}) => {
  const state = await capturePage(page, {
    refinement: "review",
    processing: "review",
    rationale: "Specify the access category.",
  });
  state.options.configured = false;
  state.options.repositories = [];
  state.options.suggestedRepositoryId = null;
  await state.update({ revision: 1 });
  const status = page.getByRole("region", { name: "Capture status" });
  await expect(status).toContainText("Specify the access category.");
  await expect(status).toContainText("T3 Code is not connected.");
  await expect(status).toContainText("No implementation repositories are available.");
  await page.getByRole("button", { name: "Add missing details", exact: true }).click();
  await expect(page.getByLabel("User input", { exact: true })).toBeFocused();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.locator(".capture-editor").evaluate((element) => {
    element.scrollTop = 0;
  });
  await page.screenshot({ path: "test-results/capture-review-mobile.png" });
  expect(
    await page
      .getByRole("dialog")
      .evaluate((element) => element.scrollWidth <= element.clientWidth),
  ).toBe(true);
  await expect(
    page.getByRole("button", { name: "Add missing details", exact: true }),
  ).toBeInViewport();
});

test("keeps implementation lookup and launch failures visible and recoverable", async ({
  page,
}) => {
  const state = await capturePage(page);
  let failure = "Could not load implementation settings.";
  await page.route("**/api/items/capture-test/implementation", (route) =>
    failure ? route.fulfill({ status: 503, json: { error: failure } }) : route.fallback(),
  );
  await state.update({ revision: 1 });
  await expect(page.getByRole("alert")).toContainText(failure);
  failure = "";
  await page.getByRole("button", { name: "Check implementation again", exact: true }).click();
  await expect(page.getByRole("button", { name: "Start in T3 Code", exact: true })).toBeEnabled();
  failure = "Choose an accessible Git repository before implementing.";
  await page.getByRole("button", { name: "Start in T3 Code", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText(failure);
  await expect(page.getByRole("alert")).toBeInViewport();
  expect(state.launches).toHaveLength(0);
  failure = "";
  await page.getByRole("button", { name: "Check implementation again", exact: true }).click();
  await page.getByRole("button", { name: "Start in T3 Code", exact: true }).click();
  await expect(page.getByRole("link", { name: "Continue in T3 Code", exact: true })).toBeVisible();
});

test("reviews agent output and completes after a local merge without pull request setup", async ({
  page,
}) => {
  const state = await capturePage(page);
  await page.getByRole("button", { name: "Start in T3 Code", exact: true }).click();
  await expect(page.getByRole("link", { name: "Continue in T3 Code", exact: true })).toBeVisible();
  const latest = state.options.latest;
  if (!latest) throw new Error("Missing implementation");
  latest.progress = {
    turnState: "completed",
    checkedAt: "2026-09-23T12:00:00Z",
    error: null,
    localMerge: {
      branch: "panopticon/thread-test",
      mainBranch: "main",
      head: "feature",
      mainHead: "base",
      merged: false,
      dirty: false,
    },
  };
  await page.getByRole("button", { name: "Check progress", exact: true }).click();
  await expect(page.getByRole("region", { name: "Capture status" })).toContainText(
    "Ready for review",
  );
  await expect(page.getByText("Not merged locally", { exact: true })).toBeVisible();
  expect(state.item.status).toBe("in_review");
  await expect(page.getByLabel("Implementation pull request", { exact: true })).toHaveCount(0);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: "test-results/task-progress-mobile.png" });
  expect(
    await page
      .getByRole("dialog")
      .evaluate((element) => element.scrollWidth <= element.clientWidth),
  ).toBe(true);
  latest.progress.localMerge = {
    branch: "panopticon/thread-test",
    mainBranch: "main",
    head: "feature",
    mainHead: "feature",
    merged: true,
    dirty: false,
  };
  await page.getByRole("button", { name: "Check progress", exact: true }).click();
  await expect(page.getByRole("region", { name: "Capture status" })).toContainText("Completed");
  await expect(page.getByText("Merged locally", { exact: true })).toBeVisible();
  expect(state.item.status).toBe("done");
});

test("tracks outside work without T3 and filters started and completed tasks", async ({ page }) => {
  const state = await capturePage(page, {
    prompt: "Add the specified access and verify it.",
  });
  state.options.configured = false;
  await state.update({ revision: 1 });
  await page.getByRole("button", { name: "Mark in progress", exact: true }).click();
  await expect(page.getByRole("button", { name: "Mark waiting", exact: true })).toBeVisible();
  expect(state.item.status).toBe("in_progress");
  await page.getByRole("button", { name: "Mark waiting", exact: true }).click();
  await page.getByRole("button", { name: "Resume", exact: true }).click();
  await page.getByRole("button", { name: "Close item", exact: true }).click();
  await page.getByRole("button", { name: "Today", exact: true }).click();
  const active = page
    .locator(".section")
    .filter({ has: page.getByRole("heading", { name: "In progress", exact: true }) });
  await expect(active).toContainText("Add Kiana to GitHub");
  await page.getByRole("button", { name: "Tasks", exact: true }).click();
  await page.getByLabel("Filter task status").selectOption("open");
  await expect(page.getByRole("button", { name: /^Add Kiana to GitHub/ })).toHaveCount(0);
  await page.getByLabel("Filter task status").selectOption("in_progress");
  await page.getByRole("button", { name: /^Add Kiana to GitHub/ }).click();
  await page.getByRole("button", { name: "Mark done", exact: true }).click();
  await page.getByRole("button", { name: "Close item", exact: true }).click();
  await page.getByLabel("Filter task status").selectOption("done");
  await expect(page.getByRole("button", { name: /^Add Kiana to GitHub/ })).toBeVisible();
  expect(state.launches).toHaveLength(0);
  await page.getByRole("button", { name: "Reopen Add Kiana to GitHub", exact: true }).click();
  await page.getByLabel("Filter task status").selectOption("open");
  await expect(page.getByRole("button", { name: /^Add Kiana to GitHub/ })).toBeVisible();
});
