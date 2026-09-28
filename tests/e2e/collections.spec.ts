import { expect, type Page, test } from "@playwright/test";
import { capturedItem, dailyCommitments } from "../../server/application/items";
import { defaultEntra } from "../../shared/people";
import type { Capture, Settings } from "../../shared/schema";

function capture(title: string, fields: Partial<Capture> = {}): Capture {
  return {
    ...capturedItem(title, title, "2026-09-24T08:00:00Z"),
    kind: "commitment",
    processing: "ready",
    refinement: "ready",
    prompt: `Complete ${title}`,
    ...fields,
  };
}

async function workspace(page: Page, items: Capture[]) {
  const settings: Settings = {
    aiConfigured: true,
    modelReady: true,
    profileReady: true,
    model: "test-model",
    provider: "http://127.0.0.1:4320",
    baseURL: "http://127.0.0.1:4320/v1",
    credentialSources: [],
    profilePath: "/test/profile",
    profileGit: true,
    projectRoots: [],
    timezone: "Europe/Berlin",
    ctxAvailable: false,
    entra: defaultEntra,
  };
  const patches: unknown[] = [];
  await page.route("**/api/**", async (route) => {
    const path = decodeURIComponent(new URL(route.request().url()).pathname);
    if (path === "/api/settings") return route.fulfill({ json: settings });
    if (path === "/api/profile") return route.fulfill({ json: [] });
    if (path === "/api/completion-reviews") return route.fulfill({ json: [] });
    if (path === "/api/items") return route.fulfill({ json: items });
    if (path === "/api/today")
      return route.fulfill({ json: dailyCommitments(items, "2026-09-24") });
    if (path === "/api/captures") {
      const item = capture(route.request().postDataJSON().text, {
        kind: "unclassified",
        processing: "pending",
        refinement: "running",
      });
      items.push(item);
      return route.fulfill({ json: item });
    }
    if (path.endsWith("/implementation"))
      return route.fulfill({
        json: { configured: false, repositories: [], suggestedRepositoryId: null, latest: null },
      });
    const item = items.find((entry) => path === `/api/items/${entry.id}`);
    if (item && route.request().method() === "PATCH") {
      const fields = route.request().postDataJSON();
      patches.push(fields);
      const bodyChanged = fields.body !== undefined && fields.body !== item.body;
      Object.assign(item, fields, { revision: item.revision + 1 });
      if (bodyChanged) Object.assign(item, { processing: "pending", refinement: "running" });
      return route.fulfill({ json: item });
    }
    return route.fulfill({ status: 404, json: { error: `Unexpected request: ${path}` } });
  });
  await page.clock.install();
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "A clearer day." })).toBeVisible();
  return {
    patches,
    async refresh() {
      await page.clock.fastForward(5000);
    },
  };
}

test("routes captures exclusively and explains attention badges separately from totals", async ({
  page,
}) => {
  const items = [
    capture("Clarify owner", { processing: "review", refinement: "review" }),
    capture("Retry idea", {
      kind: "idea",
      processing: "pending",
      refinement: "failed",
      processingError: "Model unavailable",
    }),
    capture("Resume task", { processing: "pending", refinement: "paused", status: "in_progress" }),
    capture("Refining idea", { kind: "idea", processing: "pending", refinement: "running" }),
    capture("Review delivery", { status: "in_review", dueDate: "2026-09-23", project: "Website" }),
    capture("Call Anna", { dueDate: "2026-09-24" }),
    capture("Waiting for access", { status: "waiting" }),
    capture("Future work", { dueDate: "2026-10-01" }),
    capture("Onboarding idea", { kind: "idea" }),
    capture("Profile preference", { kind: "note", status: "done" }),
  ];
  await workspace(page, items);
  const nav = page.getByRole("navigation", { name: "Main navigation" });
  await expect(nav.getByRole("button", { name: "Inbox", exact: true })).toContainText("3");
  await expect(nav.getByRole("button", { name: "Tasks", exact: true })).toContainText("2");
  await expect(nav.getByRole("button", { name: "Tasks", exact: true })).toHaveAccessibleDescription(
    "2 tasks due today, overdue, or ready for review.",
  );
  await expect(page.getByRole("button", { name: /^Resume task/ })).toHaveCount(0);
  await nav.getByRole("button", { name: "Inbox", exact: true }).click();
  await expect(page.getByText("3 need your attention · 1 refining", { exact: true })).toBeVisible();
  await expect(
    page.getByRole("region", { name: "Needs your attention", exact: true }).locator(".item-row"),
  ).toHaveCount(3);
  await expect(page.getByRole("region", { name: "Refining", exact: true })).toContainText(
    "Refining idea",
  );
  await expect(page.locator(".item-row")).toHaveCount(4);
  await nav.getByRole("button", { name: "Tasks", exact: true }).click();
  await expect(
    page.getByText("4 active tasks · 2 need your attention", { exact: true }),
  ).toBeVisible();
  await page.getByLabel("Filter task status").selectOption("attention");
  await expect(page.locator(".item-row")).toHaveCount(2);
  await page.getByLabel("Filter by project").selectOption("project:Website");
  await expect(page.locator(".item-row")).toHaveCount(1);
  await expect(page.locator(".item-row")).toContainText("Review delivery");
  await nav.getByRole("button", { name: "Notebook", exact: true }).click();
  await expect(page.locator(".item-row")).toHaveCount(1);
  await expect(page.locator(".item-row")).toContainText("Onboarding idea");
  await expect(
    nav.getByRole("button", { name: "Notebook", exact: true }).locator(".count"),
  ).toHaveCount(0);
  await page.getByLabel("Include completed & archived").check();
  await expect(page.getByText("Profile preference")).toHaveCount(0);
});

test("keeps new captures in Inbox until refinement and keeps an open draft intact when they move", async ({
  page,
}) => {
  const items: Capture[] = [];
  const state = await workspace(page, items);
  await page.getByRole("button", { name: "Tasks", exact: true }).click();
  await page.getByLabel("What’s on your mind?").fill("Prepare launch");
  await page.getByRole("button", { name: "Capture", exact: true }).click();
  await expect(page.locator(".item-row")).toHaveCount(0);
  await page.getByRole("button", { name: "Inbox", exact: true }).click();
  await expect(page.getByText("0 need your attention · 1 refining", { exact: true })).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Inbox", exact: true }).locator(".count"),
  ).toHaveCount(0);
  await page.getByRole("button", { name: /^Prepare launch/ }).click();
  await page.getByLabel("Title", { exact: true }).fill("Draft launch title");
  Object.assign(items[0], {
    kind: "commitment",
    refinement: "ready",
    processing: "ready",
    revision: 1,
  });
  await state.refresh();
  await expect(page.getByRole("dialog")).toBeVisible();
  await expect(page.getByLabel("Title", { exact: true })).toHaveValue("Draft launch title");
  await page.getByRole("button", { name: "Close item" }).click();
  await expect(page.locator(".item-row")).toHaveCount(0);
  await page.getByRole("button", { name: "View Tasks", exact: true }).click();
  await expect(page.locator(".item-row")).toContainText("Prepare launch");
  await page.getByRole("button", { name: /^Prepare launch/ }).click();
  await page.getByText("Original input", { exact: true }).click();
  await page.getByLabel("User input", { exact: true }).fill("Prepare a launch idea");
  await page.getByRole("button", { name: "Save and refine", exact: true }).click();
  await expect(page.getByRole("button", { name: "Refining…", exact: true })).toBeDisabled();
  await page.getByRole("button", { name: "Close item" }).click();
  await expect(page.locator(".item-row")).toHaveCount(0);
  await page.getByRole("button", { name: "Inbox", exact: true }).click();
  await expect(page.locator(".item-row")).toHaveCount(1);
  Object.assign(items[0], { kind: "idea", refinement: "ready", processing: "ready", revision: 3 });
  await state.refresh();
  await expect(page.locator(".item-row")).toHaveCount(0);
  await page.getByRole("button", { name: "View Notebook", exact: true }).click();
  await expect(page.locator(".item-row")).toHaveCount(1);
  expect(items[0].status).toBe("open");
});

test("completes tasks with one click and Undo restores the exact prior status", async ({
  page,
}) => {
  const items = [capture("Review proposal", { status: "in_review" })];
  const state = await workspace(page, items);
  await page.getByRole("button", { name: "Tasks", exact: true }).click();
  await expect(page.locator(".item-row button")).toHaveCount(2);
  await page.getByRole("button", { name: "Complete Review proposal", exact: true }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(page.locator(".item-row")).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "Tasks", exact: true }).locator(".count"),
  ).toHaveCount(0);
  expect(state.patches).toEqual([{ status: "done", revision: 0 }]);
  await page.getByRole("button", { name: "Undo", exact: true }).click();
  await expect(page.getByRole("region", { name: "Ready for review", exact: true })).toContainText(
    "Review proposal",
  );
  expect(items[0].status).toBe("in_review");
  await page.getByRole("button", { name: "Today", exact: true }).click();
  await page.getByRole("button", { name: "Complete Review proposal", exact: true }).click();
  await expect(page.getByRole("status")).toContainText("Task completed.");
  await page.getByRole("button", { name: "Tasks", exact: true }).click();
  await page.getByLabel("Filter task status").selectOption("done");
  await expect(page.locator(".item-row")).toContainText("Review proposal");
  await page.getByRole("button", { name: "Reopen Review proposal", exact: true }).click();
  await page.getByLabel("Filter task status").selectOption("open");
  await expect(page.getByRole("region", { name: "Backlog", exact: true })).toContainText(
    "Review proposal",
  );
});

test("sorts the backlog and preserves filters and position across the details panel", async ({
  page,
}) => {
  const items = [
    capture("Normal task", { project: "Website" }),
    capture("Important task", { project: "Website", priority: "high" }),
    capture("Tomorrow task", { project: "Website", dueDate: "2026-09-25" }),
    capture("Today task", { project: "Website", dueDate: "2026-09-24" }),
    ...Array.from({ length: 15 }, (_, index) =>
      capture(`Later task ${index}`, { project: "Website", createdAt: "2026-09-24T09:00:00Z" }),
    ),
    capture("Other project", { project: "Other" }),
  ];
  await workspace(page, items);
  await page.getByRole("button", { name: "Tasks", exact: true }).click();
  await page.getByLabel("Filter by project").selectOption("project:Website");
  await page.getByLabel("Filter task status").selectOption("open");
  await page.getByRole("textbox", { name: "Search items" }).fill("task");
  expect((await page.locator(".item-main strong").allTextContents()).slice(0, 4)).toEqual([
    "Today task",
    "Tomorrow task",
    "Important task",
    "Normal task",
  ]);
  await page.screenshot({ path: "test-results/tasks-desktop.png", fullPage: true });
  const target = page.getByRole("button", { name: /^Later task 5/ });
  await target.scrollIntoViewIfNeeded();
  const before = await page.evaluate(() => window.scrollY);
  await target.click();
  await expect(page.getByRole("dialog")).toBeVisible();
  const bounds = await page.getByRole("dialog").boundingBox();
  expect(bounds).not.toBeNull();
  expect(Math.round((bounds?.x ?? 0) + (bounds?.width ?? 0))).toBe(page.viewportSize()?.width);
  await page.getByRole("button", { name: "Close item" }).click();
  await expect(page.getByLabel("Filter by project")).toHaveValue("project:Website");
  await expect(page.getByLabel("Filter task status")).toHaveValue("open");
  await expect(page.getByRole("textbox", { name: "Search items" })).toHaveValue("task");
  expect(await page.evaluate(() => window.scrollY)).toBe(before);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.evaluate(() => window.scrollTo(0, 0));
  await expect(
    page.getByRole("button", { name: "Tasks", exact: true }).locator(".count"),
  ).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
  await page.screenshot({ path: "test-results/tasks-mobile.png", fullPage: true });
});
