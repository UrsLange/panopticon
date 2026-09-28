import { expect, type Page, test } from "@playwright/test";
import { capturedItem } from "../../server/application/items";
import { defaultEntra } from "../../shared/people";
import type { Capture, Settings } from "../../shared/schema";
import type { CompletionReview, ImplementationOptions } from "../../shared/t3";

async function capturePage(page: Page, changes: Partial<Capture> = {}) {
  let item: Capture = {
    ...capturedItem("Add Kiana to GitHub", "capture-test", "2026-09-23T09:00:00.000Z"),
    kind: "commitment",
    execution: "implementation",
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
  let reviews: CompletionReview[] = [];
  await page.route("**/api/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === "/api/settings") return route.fulfill({ json: settings });
    if (path === "/api/profile") return route.fulfill({ json: [] });
    if (path === "/api/completion-reviews") return route.fulfill({ json: reviews });
    if (path.endsWith("/completion-review")) {
      if (route.request().postDataJSON().decision === "confirm")
        item = { ...item, status: "done", revision: item.revision + 1 };
      reviews = [];
      return route.fulfill({ json: item });
    }
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
      if (progress?.turnState === "completed")
        item = { ...item, status: "in_review", revision: item.revision + 1 };
      if (progress?.localMerge?.merged && options.latest)
        reviews = [
          {
            itemId: item.id,
            implementationId: options.latest.id,
            revision: item.revision,
            title: item.title,
            head: progress.localMerge.head,
            reason: "The implementation was merged into main.",
          },
        ];
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
    if (path.endsWith("/refined")) {
      expect(route.request().postDataJSON()).toEqual({ revision: item.revision });
      item = {
        ...item,
        refinement: "ready",
        processing: "ready",
        processingError: null,
        revision: item.revision + 1,
      };
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

test("shows auto-start failure separately from successful refinement and keeps manual launch available", async ({
  page,
}) => {
  const state = await capturePage(page, { autoStartError: "Connect T3 Code in Settings first." });
  state.options.autoStart = true;
  await page.clock.fastForward(5000);
  await expect(page.getByText("Auto-start after refinement: On.")).toBeVisible();
  await expect(page.getByRole("alert")).toContainText(
    "Refinement succeeded, but T3 auto-start failed",
  );
  await expect(page.getByRole("button", { name: "Start in T3 Code", exact: true })).toBeEnabled();
  expect(state.item.refinement).toBe("ready");
  expect(state.launches).toHaveLength(0);
});

test("refreshes capture details without changing the visible content while waiting", async ({
  page,
}) => {
  const state = await capturePage(page);
  const action = page.getByRole("button", { name: "Start in T3 Code", exact: true });
  await expect(action).toBeEnabled();
  const title = page.getByLabel("Title", { exact: true });
  await title.fill("Unsaved title");
  const status = page.getByRole("region", { name: "Capture status" });
  for (const revision of [1, 2]) {
    const content = await status.textContent();
    const bounds = await status.boundingBox();
    const scrollTop = await page.getByRole("dialog").evaluate((element) => element.scrollTop);
    let release!: () => void;
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    await page.route("**/api/items/capture-test/implementation", async (route) => {
      await pending;
      await route.fallback();
    });
    const request = page.waitForRequest("**/api/items/capture-test/implementation");
    await state.update({ revision });
    await request;
    await expect(page.getByText("Checking T3 Code readiness…", { exact: true })).toHaveCount(0);
    expect(await status.textContent()).toBe(content);
    expect(await status.boundingBox()).toEqual(bounds);
    await expect(title).toBeFocused();
    await expect(title).toHaveValue("Unsaved title");
    expect(await page.getByRole("dialog").evaluate((element) => element.scrollTop)).toBe(scrollTop);

    state.options.repositories[0].name = `Updated repository ${revision}`;
    release();
    await expect(
      page.getByRole("option", {
        name: `Updated repository ${revision} — /repos/access`,
        exact: true,
      }),
    ).toHaveCount(1);
    await expect(
      page.getByRole("button", { name: "Save and start in T3 Code", exact: true }),
    ).toBeEnabled();
  }
});

test("keeps capture details stable while implementation readiness refreshes", async ({ page }) => {
  const state = await capturePage(page);
  const start = page.getByRole("button", { name: "Start in T3 Code", exact: true });
  await expect(start).toBeEnabled();
  const title = page.getByLabel("Title", { exact: true });
  const before = await title.boundingBox();
  let release = () => {};
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  let requested = false;
  await page.route("**/api/items/capture-test/implementation", async (route) => {
    requested = true;
    await pending;
    await route.fulfill({ json: { ...state.options, configured: false } });
  });
  await page.clock.fastForward(5000);
  await expect.poll(() => requested).toBe(true);
  try {
    await expect(page.getByText("Checking T3 Code readiness…", { exact: true })).toHaveCount(0);
    await expect(start).toBeEnabled();
    expect(await title.boundingBox()).toEqual(before);
  } finally {
    release();
  }
  await expect(page.getByRole("region", { name: "Capture status" })).toContainText(
    "T3 Code is not connected.",
  );
});

test("accepts the current brief and keeps future tasks in Tasks", async ({ page }) => {
  const state = await capturePage(page, {
    refinement: "review",
    processing: "review",
    rationale: "Which Benjamin?",
    dueDate: "2099-01-01",
  });
  await page.getByRole("button", { name: "Mark as refined", exact: true }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  expect(state.item.status).toBe("open");
  expect(state.refinements).toBe(0);
  await page.getByRole("button", { name: "Inbox", exact: true }).click();
  await expect(page.getByRole("button", { name: /^Add Kiana to GitHub/ })).toHaveCount(0);
  await page.getByRole("button", { name: "Tasks", exact: true }).click();
  await expect(page.getByRole("button", { name: /^Add Kiana to GitHub/ })).toBeVisible();
});

test("moves a manually accepted idea into the notebook without refinement", async ({ page }) => {
  const state = await capturePage(page, {
    kind: "idea",
    refinement: "review",
    processing: "review",
  });
  await page.getByRole("button", { name: "Close item", exact: true }).click();
  await page.getByRole("button", { name: "Notebook", exact: true }).click();
  await expect(page.getByRole("button", { name: /^Add Kiana to GitHub/ })).toHaveCount(0);
  await page.getByRole("button", { name: "Inbox", exact: true }).click();
  await page.getByRole("button", { name: /^Add Kiana to GitHub/ }).click();
  await page.getByRole("button", { name: "Mark as refined", exact: true }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await page.getByRole("button", { name: "Notebook", exact: true }).click();
  await expect(page.getByRole("button", { name: /^Add Kiana to GitHub/ })).toBeVisible();
  expect(state.refinements).toBe(0);
  expect(state.item.kind).toBe("idea");
});

test("explains failures and previous clarification, and prevents duplicate refinement", async ({
  page,
}) => {
  const state = await capturePage(page, {
    refinement: "failed",
    processing: "pending",
    processingError: "Interpretation failed. Check model settings and retry.",
    clarifications: [
      {
        id: "scope",
        question: "Which access category and repository scope should Kiana receive?",
        answer: "",
        resolved: false,
      },
    ],
  });
  await expect(page.getByRole("region", { name: "Capture status" })).toContainText(
    "Refinement failed",
  );
  await expect(page.getByText("Previous interpretation", { exact: true })).toHaveCount(0);
  await expect(page.getByText(/Which access category/)).toBeVisible();
  await page.screenshot({ path: "test-results/capture-failure-desktop.png" });
  await page.getByRole("button", { name: "Retry refinement", exact: true }).click();
  await expect(page.getByRole("button", { name: "Refining…", exact: true })).toBeDisabled();
  await page.getByText("More actions", { exact: true }).click();
  await expect(page.getByRole("button", { name: "Refine again", exact: true })).toBeDisabled();
  await page.getByText("Original input", { exact: true }).click();
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
    clarifications: [
      { id: "category", question: "Specify the access category.", answer: "", resolved: false },
    ],
  });
  state.options.configured = false;
  state.options.repositories = [];
  state.options.suggestedRepositoryId = null;
  await state.update({ revision: 1 });
  const status = page.getByRole("region", { name: "Capture status" });
  await expect(page.getByRole("textbox", { name: /Specify the access category/ })).toBeVisible();
  await expect(status).toContainText("T3 Code is not connected.");
  await expect(status).toContainText("No implementation repositories are available.");
  await page.getByRole("button", { name: "Answer questions", exact: true }).click();
  await expect(page.getByRole("textbox", { name: /Specify the access category/ })).toBeFocused();
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
    page.getByRole("button", { name: "Answer questions", exact: true }),
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

test("reviews agent output and confirms completion after a local merge", async ({ page }) => {
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
  await expect(page.getByRole("region", { name: "Capture status" })).toContainText(
    "Ready for review",
  );
  await expect(page.getByText("Merged locally", { exact: true })).toBeVisible();
  expect(state.item.status).toBe("in_review");
  await page.getByRole("button", { name: "Close item", exact: true }).click();
  await page.clock.fastForward(5000);
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await page.getByRole("button", { name: "1 task ready for review" }).click();
  await page.keyboard.press("c");
  await expect(page.getByRole("dialog")).toHaveCount(0);
  expect(state.item.status).toBe("done");
});

test("reviews pending completions with shortcuts, preserves deferrals, and fits mobile", async ({
  page,
}) => {
  await capturePage(page);
  let reviews: CompletionReview[] = ["Search", "Settings", "Navigation"].map((title, index) => ({
    itemId: `task-${index}`,
    implementationId: `implementation-${index}`,
    revision: 2,
    title,
    head: `commit-${index}`,
    reason: "The implementation branch was merged into main, with no uncommitted work detected.",
  }));
  const decisions: string[] = [];
  await page.route("**/api/completion-reviews", (route) => route.fulfill({ json: reviews }));
  await page.route("**/api/items/*/completion-review", (route) => {
    const body = route.request().postDataJSON();
    decisions.push(body.decision);
    reviews = reviews.filter((review) => review.implementationId !== body.implementationId);
    return route.fulfill({ json: {} });
  });
  await page.reload();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toContainText("Is “Search” complete?");
  await page.screenshot({ path: "test-results/completion-review-desktop.png" });
  await page.keyboard.press("Tab");
  await expect(dialog.getByRole("button", { name: /Keep open/ })).toBeFocused();
  await page.keyboard.press("Tab");
  await page.keyboard.press("Tab");
  await expect(dialog.getByRole("button", { name: "Decide later" })).toBeFocused();
  await page.keyboard.press("Control+k");
  expect(decisions).toEqual([]);
  await expect(page.getByLabel("What’s on your mind?")).not.toBeFocused();
  await dialog.getByRole("button", { name: "Decide later" }).click();
  await expect(dialog).toContainText("Is “Settings” complete?");
  await page.keyboard.press("k");
  await expect(dialog).toContainText("Is “Navigation” complete?");
  await expect(dialog.getByRole("button", { name: /Confirm completion/ })).toBeEnabled();
  await page.keyboard.press("c");
  await expect(dialog).toHaveCount(0);
  expect(decisions).toEqual(["keep_open", "confirm"]);
  await page.clock.fastForward(10000);
  await expect(dialog).toHaveCount(0);
  await expect(page.getByRole("button", { name: "1 task ready for review" })).toBeVisible();
  await page.reload();
  await expect(dialog).toContainText("Is “Search” complete?");
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: "test-results/completion-review-mobile.png" });
  expect(await dialog.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  expect(decisions).toEqual(["keep_open", "confirm"]);
  await page.getByRole("button", { name: "1 task ready for review" }).click();
  await expect(dialog).toBeVisible();
});

test("keeps failed completion decisions reviewable and prevents repeat-key submissions", async ({
  page,
}) => {
  await capturePage(page);
  const reviews: CompletionReview[] = [
    {
      itemId: "capture-test",
      implementationId: "thread-test",
      revision: 2,
      title: "Access",
      head: "commit",
      reason: "Merged into main.",
    },
  ];
  await page.route("**/api/completion-reviews", (route) => route.fulfill({ json: reviews }));
  let submissions = 0;
  await page.route("**/api/items/*/completion-review", (route) => {
    submissions++;
    return route.fulfill({
      status: 409,
      json: { error: "This completion suggestion changed. Reload before reviewing." },
    });
  });
  await page.reload();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  await dialog.dispatchEvent("keydown", { key: "c", repeat: true });
  expect(submissions).toBe(0);
  await page.keyboard.press("c");
  await expect(dialog.getByRole("alert")).toContainText("suggestion changed");
  await expect(dialog.getByRole("button", { name: /Confirm completion/ })).toBeEnabled();
  expect(submissions).toBe(1);
  await page.keyboard.press("Escape");
  await expect(page.getByRole("button", { name: "1 task ready for review" })).toBeVisible();
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
  await expect(page.getByRole("dialog")).toHaveCount(0);
  expect(state.item.status).toBe("done");
  await page.getByLabel("Filter task status").selectOption("done");
  await expect(page.getByRole("button", { name: /^Add Kiana to GitHub/ })).toBeVisible();
  expect(state.launches).toHaveLength(0);
  await page.getByRole("button", { name: "Reopen Add Kiana to GitHub", exact: true }).click();
  await page.getByLabel("Filter task status").selectOption("open");
  await expect(page.getByRole("button", { name: /^Add Kiana to GitHub/ })).toBeVisible();
});

test("keeps capture details open when marking done fails", async ({ page }) => {
  const state = await capturePage(page);
  await page.route("**/api/items/capture-test", (route) =>
    route.fulfill({ status: 500, json: { error: "Could not update status." } }),
  );
  await page.getByRole("button", { name: "Mark done", exact: true }).click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await expect(page.getByRole("dialog").getByRole("alert")).toContainText(
    "Could not update status.",
  );
  expect(state.item.status).toBe("open");
});

test("chooses no project, filters it separately, and can return to a named project", async ({
  page,
}) => {
  const state = await capturePage(page, { project: "GitHub access" });
  await page.locator(".capture-details summary").click();
  await page.getByLabel("Execution", { exact: true }).selectOption("manual");
  await page.getByLabel("No project", { exact: true }).check();
  await expect(page.getByLabel("Project", { exact: true })).toBeDisabled();
  await expect(page.getByLabel("Implementation repository")).toHaveCount(0);
  await page.getByRole("button", { name: "Save changes", exact: true }).click();
  await expect(page.getByRole("button", { name: "Mark complete", exact: true })).toBeVisible();
  expect(state.item).toMatchObject({ noProject: true, project: "" });
  state.options.configured = false;
  state.options.repositories = [];
  await page.reload();
  await page.getByRole("button", { name: /^Tasks/ }).click();
  const row = page.getByRole("button", { name: /^Add Kiana to GitHub/ });
  await page.getByLabel("Filter by project").selectOption("none");
  await expect(row).toContainText("No project");
  await page.getByLabel("Filter by project").selectOption("unassigned");
  await expect(row).toHaveCount(0);
  await page.getByLabel("Filter by project").selectOption("none");
  await row.click();
  await expect(page.getByText("T3 Code is not connected.")).toHaveCount(0);
  await page.locator(".capture-details summary").click();
  await expect(page.getByLabel("No project", { exact: true })).toBeChecked();
  await page.getByLabel("No project", { exact: true }).uncheck();
  await page.getByRole("button", { name: "Save changes", exact: true }).click();
  await page.getByRole("button", { name: "Close item", exact: true }).click();
  await expect(row).toHaveCount(0);
  await page.getByLabel("Filter by project").selectOption("unassigned");
  await expect(row).toContainText("Unassigned");
  await row.click();
  await page.locator(".capture-details summary").click();
  await page.getByLabel("Project", { exact: true }).fill("GitHub access");
  await page.getByRole("button", { name: "Save changes", exact: true }).click();
  await page.getByRole("button", { name: "Close item", exact: true }).click();
  await page.getByLabel("Filter by project").selectOption("project:GitHub access");
  await expect(row).toBeVisible();
  await page.getByLabel("Search items").fill("missing text");
  await expect(row).toHaveCount(0);
  await page.getByLabel("Search items").fill("");
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
  await page.screenshot({ path: "test-results/project-filter-mobile.png" });
  expect(state.launches).toHaveLength(0);
});

test("completes a no-project task without a prompt or implementation setup", async ({ page }) => {
  const state = await capturePage(page, { noProject: true, execution: "manual", prompt: "" });
  await expect(page.getByLabel("Implementation repository")).toHaveCount(0);
  await page.getByRole("button", { name: "Mark complete", exact: true }).click();
  await expect(page.getByRole("region", { name: "Capture status" })).toContainText("Completed");
  expect(state.item.status).toBe("done");
  expect(state.launches).toHaveLength(0);
});
