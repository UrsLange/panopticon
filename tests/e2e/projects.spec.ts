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
      behind: index > 0 && index < 8 ? 1 : 0,
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
      .evaluateAll((nodes) => nodes.every((node) => node.children.length === 5)),
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

test("keeps all project information and profile edits on one detail page", async ({ page }) => {
  await setup(page);
  await page.locator(".project-name").first().click();
  for (const name of [
    "Checkout",
    "Local changes & commits",
    "Reviews & security",
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
  await page.screenshot({ path: "test-results/project-information.png", fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
  await page.screenshot({ path: "test-results/project-information-mobile.png", fullPage: true });
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
