import { expect, type Page, test } from "@playwright/test";
import type { Project, ProjectDetail, ProjectWorkspace } from "../../shared/projects";
import type { ProfileDocument } from "../../shared/schema";

function project(index: number): Project {
  return {
    id: `project-${index}`,
    name:
      index === 0
        ? "Panopticon with a deliberately long project name"
        : `Project ${String(index).padStart(3, "0")}`,
    profileRoot: "/profile",
    root: "/work",
    path: `/work/project-${index}`,
    document: index === 0 ? "project.md" : null,
    documentSource: "discovery",
    returnToDefault: true,
    hidden: false,
    checkedAt: "2026-09-25T10:00:00Z",
    remoteCheckedAt: "2026-09-25T10:00:00Z",
    error: null,
    remoteError: null,
    git: {
      branch: "main",
      head: "abc123",
      upstream: "origin/main",
      remote: "origin",
      repositoryUrl: "https://github.com/example/project",
      defaultBranch: "main",
      dirty: index === 0,
      conflicts: false,
      operation: false,
      ahead: 0,
      behind: index > 0 && index < 7 ? 1 : 0,
      version: `version-${index}`,
    },
    insights: {
      checkedAt: "2026-09-25T10:00:00Z",
      reviews:
        index === 0
          ? [
              {
                number: 1,
                title: "Review the design",
                url: "https://github.com/example/project/pull/1",
              },
            ]
          : [],
      findings:
        index === 0
          ? [
              {
                number: 2,
                title: "Update a dependency",
                severity: "high",
                source: "Dependabot",
                url: "https://github.com/example/project/security/dependabot/2",
              },
            ]
          : [],
      reviewError: null,
      securityErrors: [],
      pipelines: {
        branch: "main",
        pending: 0,
        checked: 3,
        error: null,
        failures:
          index === 0 || index === 7
            ? Array.from({ length: index === 0 ? 1 : 2 }, (_, i) => ({
                title: i === 0 ? "Build" : "Tests",
                number: 10 + i,
                url: `https://github.com/example/project/actions/runs/${10 + i}`,
              }))
            : [],
      },
    },
  };
}

async function setup(page: Page) {
  const settings = await (await page.request.get("/api/settings")).json();
  await page.route("**/api/settings", (route) =>
    route.fulfill({
      json: { ...settings, modelReady: true, profileReady: true, projectRoots: ["/work"] },
    }),
  );
  const state: ProjectWorkspace = {
    projects: Array.from({ length: 100 }, (_, i) => project(i)),
    refreshing: false,
    errors: [],
  };
  let doc: ProfileDocument = {
    path: "project.md",
    title: "Panopticon",
    type: "Project",
    description: "Personal assistant",
    content: "---\ntype: Project\n---\n# Panopticon\nA useful personal assistant.",
    hash: "doc-1",
  };
  await page.route("**/api/profile", async (route) => {
    if (route.request().method() === "PUT") {
      doc = { ...doc, content: route.request().postDataJSON().content, hash: "doc-2" };
      await route.fulfill({ json: doc });
    } else await route.fulfill({ json: [doc] });
  });
  const actions: Record<string, unknown>[] = [];
  const detail = (p: Project): ProjectDetail => ({
    project: p,
    changes: {
      files: p.git?.dirty ? [{ path: "src/Projects.tsx", status: " M" }] : [],
      diff: p.git?.dirty ? "diff --git a/src/Projects.tsx b/src/Projects.tsx\n+new interface" : "",
      commits: p.git?.ahead
        ? [{ direction: "outgoing", hash: "abc123", subject: "feat: project page" }]
        : [],
    },
  });
  await page.route("**/api/project-workspace{,/**}", async (route) => {
    const pathname = new URL(route.request().url()).pathname;
    if (pathname.endsWith("/refresh") || pathname === "/api/project-workspace") {
      await route.fulfill({ json: state });
      return;
    }
    const id = pathname.split("/")[3];
    const p = state.projects.find((p) => p.id === id);
    if (!p?.git) throw new Error(`Unexpected project ${id}`);
    if (pathname.endsWith("/actions")) {
      const input = route.request().postDataJSON();
      actions.push(input);
      if (input.version !== p.git.version) {
        await route.fulfill({ status: 409, json: { error: "Checkout changed" } });
        return;
      }
      if (input.action === "commit") {
        p.git.dirty = false;
        p.git.ahead = 1;
      }
      if (input.action === "push") p.git.ahead = 0;
      if (input.action === "pull") p.git.behind = 0;
      p.git.version += "-next";
    }
    if (route.request().method() === "PATCH") {
      Object.assign(p, route.request().postDataJSON());
      await route.fulfill({ json: p });
      return;
    }
    await route.fulfill({ json: detail(p) });
  });
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto("/");
  await page
    .getByRole("navigation", { name: "Main navigation" })
    .getByRole("button", { name: "Projects", exact: true })
    .click();
  await expect(page.locator(".project-tile")).toHaveCount(8);
  return { state, actions };
}

test("shows dense equal tiles, fixed icon positions, and searches all 100 projects", async ({
  page,
}) => {
  await setup(page);
  const sizes = await page.locator(".project-tile").evaluateAll((nodes) =>
    nodes.map((node) => {
      const rect = node.getBoundingClientRect();
      return { width: rect.width, height: rect.height, y: rect.y };
    }),
  );
  expect(sizes.filter((size) => size.y === sizes[0].y).length).toBeGreaterThan(2);
  expect(
    Math.max(...sizes.map((size) => size.width)) - Math.min(...sizes.map((size) => size.width)),
  ).toBeLessThan(1);
  expect(new Set(sizes.map((size) => size.height)).size).toBe(1);
  expect(
    await page
      .locator(".project-name")
      .first()
      .evaluate((node) => node.scrollWidth > node.clientWidth),
  ).toBe(true);
  expect(
    await page
      .locator(".project-icon-slots")
      .evaluateAll((nodes) => nodes.every((node) => node.children.length === 6)),
  ).toBe(true);
  await expect(page.getByRole("link", { name: /Open requested reviews/ })).toHaveAttribute(
    "href",
    "https://github.com/example/project/pull/1",
  );
  await expect(page.getByRole("link", { name: /Review Dependabot alerts/ })).toHaveAttribute(
    "href",
    /dependabot\/2/,
  );
  await page.screenshot({ path: "test-results/projects-attention.png", fullPage: true });
  await page.getByRole("button", { name: "All projects 100" }).click();
  await expect(page.locator(".project-tile")).toHaveCount(100);
  await page.getByRole("button", { name: "Attention 8" }).click();
  await page.getByLabel("Search all projects").fill("099");
  await expect(page.locator(".project-tile")).toHaveCount(1);
  await expect(page.locator(".project-name")).toHaveText("Project 099");
});

test("hides projects from both views and search, and restores them through Show hidden projects", async ({
  page,
}) => {
  const { state } = await setup(page);
  state.refreshing = true;
  await page.getByRole("button", { name: "Refresh", exact: true }).click();
  await expect(page.getByRole("button", { name: "Checking…", exact: true })).toBeDisabled();
  await page.locator(".project-name").first().click();
  await page.getByLabel("Hide project from dashboard").click();
  await expect(page.getByLabel("Hide project from dashboard")).toBeChecked();
  expect(state.projects[0].hidden).toBe(true);
  await page.getByRole("button", { name: "Close project details" }).click();
  await expect(page.locator(".project-tile")).toHaveCount(7);
  await page.getByLabel("Show hidden projects").check();
  await expect(page.locator(".project-tile")).toHaveCount(8);
  await expect(page.getByLabel("Hidden project", { exact: true })).toHaveCount(1);
  await page.getByRole("button", { name: "All projects 100" }).click();
  await expect(page.locator(".project-tile")).toHaveCount(100);
  await page.getByLabel("Show hidden projects").uncheck();
  await expect(page.locator(".project-tile")).toHaveCount(99);
  await page.getByLabel("Search all projects").fill("Panopticon");
  await expect(page.locator(".project-tile")).toHaveCount(0);
  await page.getByLabel("Show hidden projects").check();
  await expect(page.locator(".project-tile")).toHaveCount(1);
  await page.locator(".project-name").click();
  await page.getByLabel("Hide project from dashboard").click();
  await expect(page.getByLabel("Hide project from dashboard")).not.toBeChecked();
  expect(state.projects[0].hidden).toBe(false);
  await page.getByRole("button", { name: "Close project details" }).click();
  await page.getByLabel("Show hidden projects").uncheck();
  await expect(page.locator(".project-tile")).toHaveCount(1);
});

test("opens failing default-branch pipelines and removes recovered projects from attention", async ({
  page,
}) => {
  const { state } = await setup(page);
  await expect(
    page.getByRole("link", { name: /Open failing pipelines on main: Panopticon/ }),
  ).toHaveAttribute("href", "https://github.com/example/project/actions/runs/10");
  await page
    .getByRole("button", { name: "Open failing pipelines on main: Project 007", exact: true })
    .click();
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByRole("link")).toHaveCount(2);
  await expect(
    dialog.getByRole("heading", { name: "Default-branch pipelines · main" }),
  ).toBeVisible();
  await page.screenshot({ path: "test-results/project-pipeline-actions.png", fullPage: true });
  await page.getByRole("button", { name: "Close project action" }).click();
  await page.getByRole("button", { name: "Project 007", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Default-branch pipelines · main" }),
  ).toBeVisible();
  await expect(page.getByRole("link", { name: /Tests.*Open run and logs/ })).toHaveAttribute(
    "href",
    "https://github.com/example/project/actions/runs/11",
  );
  await page.getByRole("button", { name: "Close project details" }).click();
  const pipelines = state.projects[7].insights?.pipelines;
  if (!pipelines) throw new Error("Missing pipeline fixture");
  pipelines.failures = [];
  await page.getByRole("button", { name: "Refresh", exact: true }).click();
  await expect(page.locator(".project-tile")).toHaveCount(7);
  pipelines.error = "Cannot check pipelines";
  await page.getByLabel("Search all projects").fill("007");
  await page.getByRole("button", { name: "Project 007", exact: true }).click();
  await expect(page.getByText("Cannot check pipelines", { exact: true })).toBeVisible();
  await expect(page.getByText("No failing pipelines detected.")).toHaveCount(0);
});

test("pulls directly from a tile and commits and pushes from one action form", async ({ page }) => {
  const { actions } = await setup(page);
  await page.getByRole("button", { name: "Pull updates: Project 001", exact: true }).click();
  await expect(page.locator(".project-tile")).toHaveCount(7);
  expect(actions[0]).toMatchObject({ action: "pull", version: "version-1" });
  await page.getByRole("button", { name: /Review and commit local changes: Panopticon/ }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  await dialog.getByRole("checkbox").check();
  await dialog.getByLabel("Commit message").fill("feat: project page");
  await dialog.getByRole("button", { name: "Commit & push", exact: true }).click();
  await expect(dialog).not.toBeVisible();
  expect(actions.slice(1)).toMatchObject([
    { action: "commit", files: ["src/Projects.tsx"], message: "feat: project page" },
    { action: "push", version: "version-0-next" },
  ]);
});

test("keeps all project information and profile edits in one modal", async ({ page }) => {
  await setup(page);
  await page.locator(".project-name").first().click();
  await expect(page.getByRole("dialog")).toHaveAttribute(
    "aria-labelledby",
    "project-details-heading",
  );
  for (const name of [
    "Checkout",
    "Local changes & commits",
    "Repository insights",
    "Profile description",
  ])
    await expect(page.getByRole("heading", { name, exact: true })).toBeVisible();
  await expect(page.getByRole("tab")).toHaveCount(0);
  await page.getByRole("button", { name: "Edit description", exact: true }).click();
  await page
    .getByLabel("Project profile document")
    .fill("---\ntype: Project\n---\nUpdated project description.");
  await page.getByRole("button", { name: "Save description", exact: true }).click();
  await expect(page.locator(".project-profile-text")).toHaveText("Updated project description.");
  await page.getByRole("dialog").evaluate((node) => {
    node.scrollTop = 0;
  });
  expect(await page.getByRole("dialog").evaluate((node) => node.clientWidth)).toBeGreaterThan(900);
  await page.screenshot({ path: "test-results/project-information.png", fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
  await page.getByRole("dialog").evaluate((node) => {
    node.scrollTop = 0;
  });
  await page.screenshot({ path: "test-results/project-information-mobile.png" });
  expect(
    await page.getByRole("dialog").evaluate((node) => node.scrollWidth <= node.clientWidth),
  ).toBe(true);
});

test("preserves the project grid, filters, scroll position, and focus when closing details", async ({
  page,
}) => {
  await setup(page);
  await page.getByRole("button", { name: "All projects 100" }).click();
  await page.getByLabel("Show hidden projects").check();
  await page.getByLabel("Search all projects").fill("Project");
  const tile = page.getByRole("button", { name: "Project 090", exact: true });
  await tile.scrollIntoViewIfNeeded();
  const before = await page.evaluate(() => window.scrollY);
  expect(before).toBeGreaterThan(500);
  await tile.click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  await expect(page.locator(".project-tile")).toHaveCount(100);
  await dialog.evaluate((node) => {
    node.scrollTop = node.scrollHeight;
  });
  expect(await page.evaluate(() => window.scrollY)).toBe(before);
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await expect(tile).toBeFocused();
  expect(await page.evaluate(() => window.scrollY)).toBe(before);
  await expect(page.getByLabel("Search all projects")).toHaveValue("Project");
  await expect(page.getByLabel("Show hidden projects")).toBeChecked();
  await tile.click();
  await expect(dialog).toBeVisible();
  await page.mouse.click(2, 2);
  await expect(dialog).toHaveCount(0);
  expect(await page.evaluate(() => window.scrollY)).toBe(before);
});

test("starts each project's details at the top without resetting scroll on a saved change", async ({
  page,
}) => {
  await setup(page);
  await page.setViewportSize({ width: 800, height: 600 });
  const dialog = page.getByRole("dialog");
  for (const name of ["Project 001", "Project 002", "Project 001"]) {
    await page.getByRole("button", { name, exact: true }).click();
    await expect(dialog).toBeVisible();
    await expect.poll(() => dialog.evaluate((node) => node.scrollTop)).toBe(0);
    const reminder = dialog.getByLabel("Remind me to return to the default branch");
    await reminder.evaluate((node) => node.scrollIntoView({ block: "center" }));
    const position = await dialog.evaluate((node) => node.scrollTop);
    expect(position).toBeGreaterThan(0);
    const wasChecked = await reminder.isChecked();
    await reminder.click();
    await expect(reminder).toBeChecked({ checked: !wasChecked });
    expect(await dialog.evaluate((node) => node.scrollTop)).toBe(position);
    await dialog.evaluate((node) => {
      node.scrollTop = node.scrollHeight;
    });
    await expect.poll(() => dialog.evaluate((node) => node.scrollTop)).toBeGreaterThan(100);
    await page.getByRole("button", { name: "Close project details" }).click();
    await expect(dialog).toHaveCount(0);
  }
});

test("protects unsaved profile edits when dismissing project details", async ({ page }) => {
  await setup(page);
  await page.locator(".project-name").first().click();
  await page.getByRole("button", { name: "Edit description" }).click();
  await page.getByLabel("Project profile document").fill("Unsaved description");
  page.once("dialog", (dialog) => dialog.dismiss());
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toBeVisible();
  await expect(page.getByLabel("Project profile document")).toHaveValue("Unsaved description");
  page.once("dialog", (dialog) => dialog.accept());
  await page.getByRole("button", { name: "Close project details" }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
});

test("preserves unknown remote status and fits tiles on narrow screens", async ({ page }) => {
  const { state } = await setup(page);
  state.projects[1].remoteError = "Authentication required";
  await page.getByRole("button", { name: "Refresh", exact: true }).click();
  await expect(page.getByRole("button", { name: "Retry remote check: Project 001" })).toBeVisible();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: "test-results/projects-attention-mobile.png", fullPage: true });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
  await page.getByRole("button", { name: /Review and commit local changes: Panopticon/ }).click();
  await expect(page.getByRole("dialog")).toBeVisible();
  expect(
    await page.getByRole("dialog").evaluate((node) => node.scrollWidth <= node.clientWidth),
  ).toBe(true);
});

test("shows security actions only for findings and keeps coverage errors in details", async ({
  page,
}) => {
  const { state } = await setup(page);
  for (const p of state.projects) {
    if (p.insights) p.insights.securityErrors = ["Dependabot unavailable"];
  }
  await page.getByRole("button", { name: "Refresh", exact: true }).click();
  await expect(page.locator(".project-tile")).toHaveCount(8);
  await expect(page.getByRole("link", { name: /Review Dependabot alerts/ })).toHaveCount(1);
  await expect(page.getByRole("button", { name: /Check security coverage/ })).toHaveCount(0);
  await page.getByLabel("Search all projects").fill("099");
  await page.locator(".project-name").click();
  await expect(page.getByText("Dependabot unavailable", { exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Dependabot alerts", exact: true })).toBeVisible();
  await expect(page.getByText("No open Dependabot alerts.")).toHaveCount(0);
});
