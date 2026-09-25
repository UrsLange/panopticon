import {
  ArrowRight,
  BookOpen,
  Check,
  ChevronRight,
  Circle,
  Command,
  FileText,
  Inbox,
  ListTodo,
  LoaderCircle,
  MessageCircle,
  Plus,
  Search,
  Settings2,
  Sparkles,
  Sun,
  X,
} from "lucide-react";
import { type FormEvent, useCallback, useEffect, useRef, useState } from "react";
import { captureCollection, isRefined, taskNeedsAttention } from "../shared/collections";
import type {
  AssistantReply,
  Capture as Item,
  ItemFields,
  ProfileDocument,
  Settings,
} from "../shared/schema";
import { annotatedText, projectLabel, statusLabels } from "../shared/schema";
import { api } from "./api";
import { PanopticonMark, Wordmark } from "./Brand";
import { CompletionReviews } from "./CompletionReviews";
import { useImplementation } from "./Implementation";
import { Configuration, Enrichment } from "./Settings";

type View = "today" | "inbox" | "tasks" | "notebook" | "ask" | "profile" | "settings";
type Notice = {
  text: string;
  destination?: "tasks" | "notebook";
  undo?: { item: Item; status: Item["status"] };
};
type Daily = { date: string; due: Item[]; suggested: Item[]; waiting: Item[] };
type Message = { id: number; role: string; content: string; sources: string[] };
const navigation = [
  { id: "today", label: "Today", icon: Sun },
  { id: "inbox", label: "Inbox", icon: Inbox },
  { id: "tasks", label: "Tasks", icon: ListTodo },
  { id: "notebook", label: "Notebook", icon: BookOpen },
  { id: "ask", label: "Conversation", icon: MessageCircle },
  { id: "profile", label: "Your context", icon: FileText },
  { id: "settings", label: "Settings", icon: Settings2 },
] as const;

export function App() {
  const [view, setView] = useState<View>("today");
  const [items, setItems] = useState<Item[]>([]);
  const [daily, setDaily] = useState<Daily | null>(null);
  const [settings, setSettings] = useState<Settings | null>(null);
  const [onboarding, setOnboarding] = useState(false);
  const [documents, setDocuments] = useState<ProfileDocument[]>([]);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState<Notice | null>(null);
  const [capture, setCapture] = useState("");
  const [saving, setSaving] = useState(false);
  const [selected, setSelected] = useState<Item | null>(null);
  const [profileDocument, setProfileDocument] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [showClosed, setShowClosed] = useState(false);
  const [statusFilter, setStatusFilter] = useState("all");
  const [projectFilter, setProjectFilter] = useState("");
  const [updating, setUpdating] = useState<string[]>([]);
  const previousCollections = useRef(new Map<string, ReturnType<typeof captureCollection>>());
  const input = useRef<HTMLTextAreaElement>(null);
  const report = useCallback(
    (reason: unknown) =>
      setError(reason instanceof Error ? reason.message : "Something went wrong."),
    [],
  );
  const reload = useCallback(async () => {
    const [nextItems, nextDaily] = await Promise.all([api<Item[]>("/items"), api<Daily>("/today")]);
    for (const item of nextItems) {
      const destination = captureCollection(item);
      if (
        previousCollections.current.get(item.id) === "inbox" &&
        (destination === "tasks" || destination === "notebook") &&
        !["done", "archived"].includes(item.status)
      ) {
        setNotice({
          text: `${item.title} — added to ${destination === "tasks" ? "Tasks" : "Notebook"}.`,
          destination,
        });
      }
      previousCollections.current.set(item.id, destination);
    }
    setItems(nextItems);
    setSelected((current) => {
      const next = nextItems.find((item) => item.id === current?.id);
      return next &&
        (next.revision !== current?.revision || next.refinement !== current?.refinement)
        ? next
        : current;
    });
    setDaily({
      ...nextDaily,
      due: nextDaily.due.filter(isRefined),
      suggested: nextDaily.suggested.filter(isRefined),
      waiting: nextDaily.waiting.filter(isRefined),
    });
  }, []);
  const reloadProfile = useCallback(
    async () => setDocuments(await api<ProfileDocument[]>("/profile")),
    [],
  );
  useEffect(() => {
    void reload().catch(report);
    void api<Settings>("/settings")
      .then((next) => {
        setSettings(next);
        setOnboarding(!next.modelReady || !next.profileReady);
      })
      .catch(report);
    void reloadProfile().catch(report);
    const interval = setInterval(() => {
      void reload().catch(report);
      void reloadProfile().catch(report);
    }, 5000);
    return () => clearInterval(interval);
  }, [reload, reloadProfile, report]);
  useEffect(() => {
    const focus = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        input.current?.focus();
      }
    };
    window.addEventListener("keydown", focus);
    return () => window.removeEventListener("keydown", focus);
  }, []);
  useEffect(() => {
    if (!notice) return;
    const timeout = setTimeout(() => setNotice(null), 8000);
    return () => clearTimeout(timeout);
  }, [notice]);

  const saveCapture = async (event?: FormEvent) => {
    event?.preventDefault();
    if (!capture.trim() || saving) return;
    setSaving(true);
    setError("");
    try {
      const captured = await api<Item>("/captures", "POST", { text: capture });
      previousCollections.current.set(captured.id, "inbox");
      setCapture("");
      setNotice({
        text: settings?.aiConfigured
          ? "Captured. Your assistant is organizing it."
          : "Captured safely. Organize it in your inbox.",
      });
      await reload();
    } catch (reason) {
      report(reason);
    } finally {
      setSaving(false);
    }
  };
  const updateItem = async (item: Item, fields: Partial<ItemFields>) => {
    setUpdating((current) => [...current, item.id]);
    try {
      const updated = await api<Item>(`/items/${item.id}`, "PATCH", {
        ...fields,
        revision: item.revision,
      });
      await reload();
      return updated;
    } finally {
      setUpdating((current) => current.filter((id) => id !== item.id));
    }
  };
  const row = (item: Item, reason?: string) => (
    <ItemRow
      key={item.id}
      item={item}
      reason={reason}
      updating={updating.includes(item.id)}
      onOpen={() => setSelected(item)}
      onComplete={() => {
        void updateItem(item, { status: item.status === "done" ? "open" : "done" })
          .then((updated) =>
            setNotice({
              text: item.status === "done" ? "Task reopened." : "Task completed.",
              undo: { item: updated, status: item.status },
            }),
          )
          .catch(report);
      }}
    />
  );
  const inbox = items.filter(
    (item) => captureCollection(item) === "inbox" && !["done", "archived"].includes(item.status),
  );
  const pending = inbox.filter((item) => item.refinement !== "running").length;
  const refining = inbox.length - pending;
  const tasks = items.filter((item) => captureCollection(item) === "tasks");
  const activeTasks = tasks.filter((item) => !["done", "archived"].includes(item.status));
  const attention = activeTasks.filter((item) =>
    taskNeedsAttention(item, daily?.date ?? ""),
  ).length;
  const inProgress = activeTasks.filter((item) =>
    ["in_progress", "in_review"].includes(item.status),
  );
  const filtered = items.filter(
    (item) =>
      captureCollection(item) === view &&
      ((view === "notebook" && showClosed) ||
        (view === "tasks" && ["done", "archived"].includes(statusFilter)) ||
        !["done", "archived"].includes(item.status)) &&
      (view !== "tasks" ||
        statusFilter === "all" ||
        (statusFilter === "attention"
          ? taskNeedsAttention(item, daily?.date ?? "")
          : item.status === statusFilter)) &&
      (!projectFilter ||
        projectFilter ===
          (item.noProject ? "none" : item.project ? `project:${item.project}` : "unassigned")) &&
      `${item.title} ${item.body} ${item.prompt} ${projectLabel(item)}`
        .toLowerCase()
        .includes(query.toLowerCase()),
  );
  if (view === "tasks")
    filtered.sort(
      (a, b) =>
        (a.dueDate ?? "9999").localeCompare(b.dueDate ?? "9999") ||
        Number(b.priority === "high") - Number(a.priority === "high") ||
        a.createdAt.localeCompare(b.createdAt) ||
        a.id.localeCompare(b.id),
    );
  const projects = [
    ...new Set(
      items
        .filter((item) => captureCollection(item) === view)
        .map((item) => item.project)
        .filter(Boolean),
    ),
  ].sort();
  const navigate = (next: View) => {
    setView(next);
    setQuery("");
    setStatusFilter("all");
    setProjectFilter("");
    setShowClosed(false);
  };
  const dateLabel = daily
    ? new Date(`${daily.date}T12:00:00`).toLocaleDateString(undefined, {
        weekday: "long",
        month: "long",
        day: "numeric",
      })
    : "Your personal workspace";

  const settingsChanged = (next: Settings) => {
    setSettings(next);
    void reloadProfile().catch(report);
    void reload().catch(report);
  };
  if (!settings)
    return (
      <main className="onboarding">
        <p role={error ? "alert" : "status"}>{error || "Loading your workspace…"}</p>
      </main>
    );
  if (onboarding || !settings.modelReady || !settings.profileReady)
    return (
      <main className="onboarding">
        <Configuration
          settings={settings}
          onChange={settingsChanged}
          onboarding
          onFinish={() => setOnboarding(false)}
        />
      </main>
    );

  return (
    <div className="shell">
      <aside className="sidebar">
        <button
          type="button"
          className="brand"
          aria-label="Panopticon"
          onClick={() => setView("today")}
        >
          <span className="brand-icon">
            <PanopticonMark />
          </span>
          <Wordmark />
        </button>
        <div className="workspace-label">YOUR SPACE</div>
        <nav aria-label="Main navigation">
          {navigation.map(({ id, label, icon: Icon }) => (
            <button
              type="button"
              key={id}
              aria-label={label}
              aria-current={view === id ? "page" : undefined}
              className={`nav-item ${view === id ? "active" : ""}`}
              aria-description={
                id === "inbox"
                  ? `${pending} captures need your attention; ${refining} refining.`
                  : id === "tasks"
                    ? `${attention} tasks due today, overdue, or ready for review.`
                    : undefined
              }
              title={
                id === "inbox"
                  ? "Captures needing clarification, retry, or resumption"
                  : id === "tasks"
                    ? "Tasks due today, overdue, or ready for review"
                    : label
              }
              onClick={() => navigate(id)}
            >
              <Icon size={19} />
              <span>{label}</span>
              {id === "inbox" && pending > 0 && <span className="count">{pending}</span>}
              {id === "tasks" && attention > 0 && <span className="count">{attention}</span>}
            </button>
          ))}
        </nav>
        <div className="sidebar-bottom">
          <span className="status-dot" />
          Saved on this Mac<p>A little more room to think.</p>
        </div>
      </aside>
      <main>
        <header className="topbar">
          <span>{dateLabel}</span>
          <CompletionReviews onChange={reload} />
          <span className="quiet">
            Personal workspace <span className="tiny-dot">·</span> MVP
          </span>
        </header>
        <div className="content">
          {error && (
            <div className="banner error" role="alert">
              <span>{error}</span>
              <button type="button" aria-label="Dismiss error" onClick={() => setError("")}>
                <X size={16} />
              </button>
            </div>
          )}
          {view !== "settings" && (
            <div className="page-heading">
              <div>
                <div className="eyebrow">
                  {view === "today" ? "ONE THING AT A TIME" : "ROOM FOR EVERYTHING"}
                </div>
                <h1>
                  {
                    {
                      today: "A clearer day.",
                      inbox: "Out of your head.",
                      tasks: "Make room for the next step.",
                      notebook: "Ideas worth keeping.",
                      ask: "Think it through.",
                      profile: "A little context goes a long way.",
                      settings: "Settings",
                    }[view]
                  }
                </h1>
                <p>
                  {
                    {
                      today: "Your commitments, a few next steps, and space for what’s new.",
                      inbox:
                        "Captures stay here until refinement is complete. We’ll ask when we need your help.",
                      tasks:
                        "Your tasks, from the first step to the last. Open one to plan or continue your work.",
                      notebook: "Your refined ideas, ready to revisit and develop.",
                      ask: "Build on your notes, your context, and what came before.",
                      profile: "An independent knowledge repository, shaped around you.",
                      settings: "",
                    }[view]
                  }
                </p>
              </div>
              {view === "today" && (
                <div className="day-mark">
                  <Sun size={32} strokeWidth={1.1} />
                </div>
              )}
            </div>
          )}

          {view !== "settings" && (
            <form
              className="capture"
              onSubmit={(event) => {
                void saveCapture(event);
              }}
            >
              <div className="capture-top">
                <Sparkles size={18} />
                <label htmlFor="capture">What’s on your mind?</label>
                <span className="shortcut">
                  <Command size={12} /> K
                </span>
              </div>
              <textarea
                ref={input}
                id="capture"
                value={capture}
                onChange={(event) => setCapture(event.target.value)}
                placeholder="An idea, a promise, a loose end… just put it here."
                rows={2}
                maxLength={30000}
                onKeyDown={(event) => {
                  if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
                    event.preventDefault();
                    void saveCapture();
                  }
                }}
              />
              <div className="capture-bottom">
                <span>Type or use macOS dictation. Sort it out later.</span>
                <button className="primary" type="submit" disabled={saving || !capture.trim()}>
                  {saving ? <LoaderCircle className="spin" size={16} /> : <Plus size={16} />}{" "}
                  Capture
                </button>
              </div>
            </form>
          )}

          <div hidden={view !== "settings"}>
            <Configuration settings={settings} onChange={settingsChanged} />
          </div>

          {view === "today" && (
            <div className="dashboard">
              <div>
                <Section
                  title="In progress"
                  subtitle="Work already started, in T3 Code or elsewhere."
                  count={inProgress.length}
                >
                  {inProgress.map((item) => row(item))}
                  {!inProgress.length && (
                    <p className="muted-text">
                      Start a task or mark work in progress to keep it here.
                    </p>
                  )}
                </Section>
                <Section
                  title="Due & overdue"
                  subtitle="Real deadlines. Nothing quietly left out."
                  count={daily?.due.length ?? 0}
                >
                  {daily?.due.length ? (
                    daily.due.map((item) =>
                      row(
                        item,
                        item.dueDate && item.dueDate < daily.date
                          ? `Overdue · ${item.dueDate}`
                          : "Due today",
                      ),
                    )
                  ) : (
                    <Empty
                      icon={<Check size={22} />}
                      title="No deadlines in your way"
                      text="Commitments with a due date will appear here."
                    />
                  )}
                </Section>
                <Section
                  title="Suggested next"
                  subtitle="Undated commitments, ordered by priority then age."
                  count={daily?.suggested.length ?? 0}
                >
                  {daily?.suggested.length ? (
                    daily.suggested.map((item) =>
                      row(
                        item,
                        item.priority === "high"
                          ? "You marked this as high priority"
                          : "An older open commitment",
                      ),
                    )
                  ) : (
                    <Empty
                      icon={<ArrowRight size={22} />}
                      title="Make room for what matters"
                      text="Your next steps appear here as you add commitments."
                    />
                  )}
                </Section>
                {!!daily?.waiting.length && (
                  <Section
                    title="Waiting on something"
                    subtitle="Follow-ups stay visible."
                    count={daily.waiting.length}
                  >
                    {daily.waiting.map((item) => row(item))}
                  </Section>
                )}
              </div>
              <aside className="right-column">
                <div className="context-card">
                  <div className="card-icon">
                    <PanopticonMark />
                  </div>
                  <h3>Start with a little context</h3>
                  <p>
                    Your role, current projects, and a few preferences help your assistant connect
                    the dots.
                  </p>
                  <button className="text-button" type="button" onClick={() => setView("profile")}>
                    Shape your profile <ArrowRight size={15} />
                  </button>
                </div>
                <div className="small-card">
                  <span className="eyebrow">NEEDS YOUR ATTENTION</span>
                  <strong>{pending}</strong>
                  <p>
                    {pending === 1 ? "capture needs your help" : "captures need your help"}
                    {refining > 0 && ` · ${refining} refining`}
                  </p>
                  <button type="button" className="text-button" onClick={() => navigate("inbox")}>
                    Open inbox <ChevronRight size={15} />
                  </button>
                </div>
                <div className="connection-note">
                  <span className={`status-dot ${settings?.aiConfigured ? "" : "muted"}`} />
                  <div>
                    <strong>
                      {settings?.aiConfigured ? "Assistant connected" : "Capture mode"}
                    </strong>
                    <p>
                      {settings?.aiConfigured
                        ? "Your selected model helps organize new captures."
                        : "Everything saves locally. Connect a model to enable interpretation and conversation."}
                    </p>
                    {!settings?.aiConfigured && (
                      <button
                        className="text-button"
                        type="button"
                        onClick={() => setView("profile")}
                      >
                        Connection details <ArrowRight size={14} />
                      </button>
                    )}
                  </div>
                </div>
              </aside>
            </div>
          )}

          {(view === "inbox" || view === "tasks" || view === "notebook") && (
            <section className="collection">
              <div className="section-title">
                <h2>
                  {view === "inbox"
                    ? "Your inbox"
                    : view === "tasks"
                      ? "Your tasks"
                      : "Your notebook"}
                </h2>
              </div>
              <p className="section-subtitle">
                {view === "inbox"
                  ? `${pending} ${pending === 1 ? "needs" : "need"} your attention · ${refining} refining`
                  : view === "tasks"
                    ? `${activeTasks.length} active ${activeTasks.length === 1 ? "task" : "tasks"} · ${attention} ${attention === 1 ? "needs" : "need"} your attention`
                    : "A place for ideas, without a to-do list."}
              </p>
              <div className="collection-toolbar">
                <label className="search">
                  <Search size={17} />
                  <input
                    aria-label="Search items"
                    value={query}
                    onChange={(event) => setQuery(event.target.value)}
                    placeholder={view === "tasks" ? "Find a task" : "Find a capture or idea"}
                  />
                </label>
                {view === "tasks" && (
                  <select
                    aria-label="Filter task status"
                    value={statusFilter}
                    onChange={(event) => setStatusFilter(event.target.value)}
                  >
                    <option value="all">All active tasks</option>
                    <option value="attention">Needs your attention ({attention})</option>
                    {Object.entries(statusLabels).map(([value, label]) => (
                      <option key={value} value={value}>
                        {label}
                      </option>
                    ))}
                  </select>
                )}
                {view !== "inbox" && (
                  <select
                    aria-label="Filter by project"
                    value={projectFilter}
                    onChange={(event) => setProjectFilter(event.target.value)}
                  >
                    <option value="">All projects</option>
                    <option value="none">No project</option>
                    <option value="unassigned">Unassigned</option>
                    {projects.map((project) => (
                      <option key={project} value={`project:${project}`}>
                        {project}
                      </option>
                    ))}
                  </select>
                )}
                {view === "notebook" && (
                  <label className="checkbox">
                    <input
                      type="checkbox"
                      checked={showClosed}
                      onChange={(event) => setShowClosed(event.target.checked)}
                    />
                    Include completed & archived
                  </label>
                )}
              </div>
              {view === "tasks" && (
                <p className="section-subtitle">
                  Within each group: earliest deadline, then high priority, then oldest first.
                </p>
              )}
              {filtered.length ? (
                view === "inbox" ? (
                  [
                    {
                      title: "Needs your attention",
                      running: false,
                      subtitle: "Open a capture to clarify, retry, or resume refinement.",
                    },
                    {
                      title: "Refining",
                      running: true,
                      subtitle: "Your assistant is working. Nothing for you to do here.",
                    },
                  ].map((group) => {
                    const entries = filtered.filter(
                      (item) => (item.refinement === "running") === group.running,
                    );
                    return (
                      entries.length > 0 && (
                        <Section
                          key={group.title}
                          title={group.title}
                          subtitle={group.subtitle}
                          count={entries.length}
                        >
                          {entries.map((item) => row(item))}
                        </Section>
                      )
                    );
                  })
                ) : view === "tasks" ? (
                  [
                    { status: "in_review", title: "Ready for review" },
                    { status: "in_progress", title: "In progress" },
                    { status: "open", title: "Backlog" },
                    { status: "waiting", title: "Waiting" },
                    { status: "done", title: "Completed" },
                    { status: "archived", title: "Archived" },
                  ].map((group) => {
                    const entries = filtered.filter((item) => item.status === group.status);
                    return (
                      entries.length > 0 && (
                        <Section key={group.status} title={group.title} count={entries.length}>
                          {entries.map((item) =>
                            row(
                              item,
                              !["done", "archived"].includes(item.status) &&
                                item.dueDate &&
                                daily &&
                                item.dueDate <= daily.date
                                ? `${item.dueDate < daily.date ? "Overdue" : "Due today"} · ${item.dueDate}`
                                : undefined,
                            ),
                          )}
                        </Section>
                      )
                    );
                  })
                ) : (
                  <div className="item-list">{filtered.map((item) => row(item))}</div>
                )
              ) : (
                <Empty
                  icon={
                    view === "inbox" ? (
                      <Inbox size={25} />
                    ) : view === "tasks" ? (
                      <ListTodo size={25} />
                    ) : (
                      <BookOpen size={25} />
                    )
                  }
                  title={
                    query || projectFilter || statusFilter !== "all"
                      ? "No matching items"
                      : view === "notebook"
                        ? "Let an idea take shape"
                        : view === "tasks"
                          ? "Room for your next task"
                          : "Your inbox is clear"
                  }
                  text={
                    query || projectFilter || statusFilter !== "all"
                      ? "No items match these filters."
                      : view === "notebook"
                        ? "Ideas arrive here automatically after refinement."
                        : view === "tasks"
                          ? "Capture a task above. It will arrive here once refinement is complete."
                          : "New captures appear here while they are being refined."
                  }
                />
              )}
            </section>
          )}
          {view === "ask" && (
            <Conversation
              settings={settings}
              report={report}
              onCapture={async (text) => {
                const captured = await api<Item>("/captures", "POST", { text });
                previousCollections.current.set(captured.id, "inbox");
                setNotice({ text: "Saved to your inbox." });
                await reload();
              }}
            />
          )}
          {view === "profile" && (
            <ProfileEditor
              key={profileDocument ?? "profile"}
              initialPath={profileDocument}
              documents={documents}
              settings={settings}
              onSave={reloadProfile}
              report={report}
            />
          )}
          <footer>Keep the thought. Find the next step.</footer>
        </div>
      </main>
      {notice && (
        <div className="toast" role="status">
          <Check size={17} />
          <span>{notice.text}</span>
          {notice.destination && (
            <button
              type="button"
              className="text-button"
              onClick={() => {
                setSelected(null);
                if (notice.destination) navigate(notice.destination);
                setNotice(null);
              }}
            >
              View {notice.destination === "tasks" ? "Tasks" : "Notebook"}
            </button>
          )}
          {notice.undo && (
            <button
              type="button"
              className="text-button"
              disabled={updating.includes(notice.undo.item.id)}
              onClick={() => {
                if (!notice.undo) return;
                void updateItem(notice.undo.item, { status: notice.undo.status })
                  .then(() => setNotice(null))
                  .catch(report);
              }}
            >
              Undo
            </button>
          )}
        </div>
      )}
      {selected && (
        <ItemEditor
          key={selected.id}
          item={selected}
          items={items}
          aiConfigured={!!settings?.aiConfigured}
          settings={settings}
          onSettingsChange={setSettings}
          profileAvailable={selected.profilePath === settings?.profilePath}
          onOpenProfile={(path) => {
            void reloadProfile()
              .then(() => {
                setSelected(null);
                setProfileDocument(path);
                setView("profile");
              })
              .catch(report);
          }}
          onAddToProfile={async () => {
            await api(`/items/${selected.id}/profile`, "POST", {
              revision: selected.revision,
            });
            await reload();
            await reloadProfile();
          }}
          onClose={() => setSelected(null)}
          onReload={reload}
          onSave={async (fields) => {
            const updated = await api<Item>(`/items/${selected.id}`, "PATCH", {
              ...fields,
              revision: selected.revision,
            });
            setNotice({ text: "Changes saved." });
            await reload();
            return updated;
          }}
          onMarkRefined={async () => {
            await api(`/items/${selected.id}/refined`, "POST", { revision: selected.revision });
            await reload();
            setNotice({
              text: "Marked as refined.",
              destination: selected.kind === "idea" ? "notebook" : "tasks",
            });
            setSelected(null);
          }}
          onRetry={async (resetReferences = false) => {
            await api(`/items/${selected.id}/process`, "POST", {
              resetReferences,
              revision: selected.revision,
            });
            await reload();
          }}
          onAnswer={async (answers, refine) => {
            const saved = await api<Item>(`/items/${selected.id}/clarifications`, "PATCH", {
              revision: selected.revision,
              answers,
            });
            await reload();
            if (refine) {
              try {
                await api(`/items/${selected.id}/process`, "POST", { revision: saved.revision });
              } finally {
                await reload();
              }
            } else setNotice({ text: "Answers saved." });
          }}
        />
      )}
    </div>
  );
}

function Section({
  title,
  subtitle,
  count,
  children,
}: {
  title: string;
  subtitle?: string;
  count: number;
  children: React.ReactNode;
}) {
  return (
    <section className="section" aria-label={title}>
      <div className="section-title">
        <h2>{title}</h2>
        <span className="count">{count}</span>
      </div>
      {subtitle && <p className="section-subtitle">{subtitle}</p>}
      <div className="item-list">{children}</div>
    </section>
  );
}
function Empty({ icon, title, text }: { icon: React.ReactNode; title: string; text: string }) {
  return (
    <div className="empty">
      <div className="empty-icon">{icon}</div>
      <strong>{title}</strong>
      <p>{text}</p>
    </div>
  );
}
function ItemRow({
  item,
  reason,
  onOpen,
  onComplete,
  updating,
}: {
  item: Item;
  reason?: string;
  onOpen: () => void;
  onComplete: () => void;
  updating: boolean;
}) {
  const description =
    reason ||
    (item.refinement === "running"
      ? "Refining…"
      : item.refinement === "failed"
        ? "Refinement failed · Open to retry"
        : item.refinement === "paused"
          ? "Refinement paused · Open to resume"
          : item.kind === "note"
            ? "Profile note needs attention"
            : item.refinement === "review"
              ? "Needs clarification · Open to add details"
              : item.kind === "idea"
                ? "Idea"
                : "");
  return (
    <article className={`item-row ${item.status === "done" ? "completed" : ""}`}>
      {item.kind === "commitment" ? (
        <button
          type="button"
          className="complete-button"
          disabled={updating || item.refinement === "running"}
          aria-label={`${item.status === "done" ? "Reopen" : "Complete"} ${item.title}`}
          onClick={onComplete}
        >
          {item.status === "done" ? <Check size={18} /> : <Circle size={20} />}
        </button>
      ) : (
        <div className="item-symbol">
          {item.kind === "idea" ? <Sparkles size={19} /> : <FileText size={19} />}
        </div>
      )}
      <button type="button" className="item-main" onClick={onOpen}>
        <strong>{item.title}</strong>
        <span>
          {item.kind === "commitment" && (
            <span className={`task-status task-status-${item.status}`}>
              {statusLabels[item.status]}
            </span>
          )}
          <span className="project-tag">{projectLabel(item)}</span>
          {item.priority === "high" && <span>High priority</span>}
          {description && <span>{description}</span>}
          {item.status === "archived" && item.kind !== "commitment" && <span>Archived</span>}
          {!reason && item.dueDate && <span>Due {item.dueDate}</span>}
        </span>
      </button>
      <ChevronRight className="row-arrow" size={17} />
    </article>
  );
}

function ItemEditor({
  item,
  items,
  aiConfigured,
  onClose,
  onSave,
  onReload,
  onRetry,
  onMarkRefined,
  onAnswer,
  onAddToProfile,
  onOpenProfile,
  profileAvailable,
  settings,
  onSettingsChange,
}: {
  item: Item;
  items: Item[];
  aiConfigured: boolean;
  onClose: () => void;
  onSave: (fields: ItemFields) => Promise<Item>;
  onReload: () => Promise<void>;
  onRetry: (resetReferences?: boolean) => Promise<void>;
  onMarkRefined: () => Promise<void>;
  onAnswer: (answers: { id: string; answer: string }[], refine: boolean) => Promise<void>;
  onAddToProfile: () => Promise<void>;
  onOpenProfile: (path: string) => void;
  profileAvailable: boolean;
  settings: Settings | null;
  onSettingsChange: (settings: Settings) => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [fields, setFields] = useState<ItemFields>({
    title: item.title,
    body: item.body,
    prompt: item.prompt,
    kind: item.kind,
    status: item.status,
    project: item.project,
    noProject: item.noProject,
    dueDate: item.dueDate,
    priority: item.priority,
    relatedId: item.relatedId,
  });
  const [busy, setBusy] = useState(false);
  const [activity, setActivity] = useState("");
  const [settingsSection, setSettingsSection] = useState<"Model" | "Projects" | "T3 Code" | null>(
    null,
  );
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const promptRef = useRef<HTMLTextAreaElement>(null);
  const backdropPointer = useRef(false);
  const implementation = useImplementation(item, settingsSection, onReload);
  const [error, setError] = useState("");
  const [history, setHistory] = useState<{ item: Item; changedAt: string }[] | null>(null);
  const [copiedPrompt, setCopiedPrompt] = useState<string | null>(null);
  const previous = useRef(item);
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const questions = item.clarifications.filter((entry) => !entry.resolved);
  const answersDirty = questions.some(
    (entry) => (answers[entry.id] ?? entry.answer) !== entry.answer,
  );
  const hasAnswers = questions.some((entry) => (answers[entry.id] ?? entry.answer).trim());
  const dirty = (Object.keys(fields) as (keyof ItemFields)[]).some(
    (key) => fields[key] !== item[key],
  );
  useEffect(() => {
    dialog.current?.showModal();
  }, []);
  useEffect(() => {
    if (error || implementation.error || item.processingError) dialog.current?.scrollTo({ top: 0 });
  }, [error, implementation.error, item.processingError]);
  useEffect(() => {
    if (settingsSection) dialog.current?.scrollTo({ top: 0 });
  }, [settingsSection]);
  useEffect(() => {
    const before = previous.current;
    previous.current = item;
    setAnswers((current) =>
      Object.fromEntries(
        item.clarifications.map((entry) => [
          entry.id,
          current[entry.id] === undefined ||
          current[entry.id] === before.clarifications.find((old) => old.id === entry.id)?.answer
            ? entry.answer
            : current[entry.id],
        ]),
      ),
    );
    setFields(
      (current) =>
        Object.fromEntries(
          Object.entries(current).map(([key, value]) => [
            key,
            value === before[key as keyof ItemFields] ? item[key as keyof ItemFields] : value,
          ]),
        ) as ItemFields,
    );
  }, [item]);
  const bodyChanged = fields.body !== item.body;
  const running = item.refinement === "running" || activity === "Refining…";
  const closed = ["done", "archived"].includes(item.status);
  const note = item.kind === "note";
  const failed = item.refinement === "failed";
  const review = item.refinement === "review";
  const paused = item.refinement === "paused";
  const { options, repositoryId, setRepositoryId } = implementation;
  const latest = options?.latest;
  const pendingHandoff = latest?.state === "pending";
  const submitted = latest?.state === "submitted";
  const canImplement =
    !fields.noProject &&
    !item.noProject &&
    fields.kind === "commitment" &&
    ["open", "in_progress", "in_review", "waiting"].includes(fields.status) &&
    item.refinement === "ready" &&
    !bodyChanged &&
    fields.project === item.project &&
    !!fields.prompt.trim() &&
    !!options?.configured &&
    !!repositoryId &&
    !implementation.loading &&
    !implementation.error;
  const run = async (label: string, action: () => Promise<unknown>) => {
    if (busy) return;
    setBusy(true);
    setActivity(label);
    setError("");
    try {
      await action();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Could not complete this action.");
    } finally {
      setBusy(false);
      setActivity("");
    }
  };
  const save = () => run("Saving…", () => onSave(fields));
  const refine = (resetReferences = false) =>
    answersDirty && !resetReferences
      ? saveAnswers(true)
      : run("Refining…", () => onRetry(resetReferences));
  const saveAnswers = (refine: boolean) =>
    run(refine ? "Refining…" : "Saving answers…", () => {
      const submitted = questions.map((entry) => ({
        id: entry.id,
        answer: (answers[entry.id] ?? entry.answer).trim(),
      }));
      setAnswers(Object.fromEntries(submitted.map((entry) => [entry.id, entry.answer])));
      return onAnswer(submitted, refine);
    });
  const implement = () =>
    run("Sending to T3 Code…", async () => {
      const saved = dirty ? await onSave(fields) : item;
      await implementation.start(saved);
    });
  const stateLabel = closed
    ? item.status === "done"
      ? "Completed"
      : "Archived"
    : running
      ? "Refining…"
      : failed
        ? note && item.processing === "review"
          ? "Profile update failed"
          : "Refinement failed"
        : paused
          ? aiConfigured
            ? "Refinement paused"
            : "Model connection required"
          : review
            ? note
              ? "Ready for profile review"
              : "Information needed"
            : !fields.prompt.trim() && !note && !fields.noProject
              ? "Prompt needed"
              : submitted
                ? statusLabels[item.status]
                : pendingHandoff && !fields.noProject
                  ? "Handoff unconfirmed"
                  : canImplement
                    ? "Ready for implementation"
                    : "Refined";
  let action: { label: string; disabled?: boolean; run: () => void } = {
    label: "Close",
    run: onClose,
  };
  if (dirty) {
    action = bodyChanged
      ? { label: aiConfigured ? "Save and refine" : "Save changes", run: () => void save() }
      : canImplement && !latest
        ? { label: "Save and start in T3 Code", run: () => void implement() }
        : { label: "Save changes", run: () => void save() };
  } else if (!closed) {
    if (pendingHandoff && !fields.noProject) {
      action = options?.configured
        ? {
            label: "Retry handoff",
            run: () => void run("Checking handoff…", () => implementation.start(item)),
          }
        : { label: "Connect T3 Code", run: () => setSettingsSection("T3 Code") };
    } else if ((failed || paused) && !aiConfigured) {
      action = { label: "Open model settings", run: () => setSettingsSection("Model") };
    } else if (failed && note && item.processing === "review") {
      action = {
        label: "Retry profile update",
        run: () => void run("Updating profile…", onAddToProfile),
      };
    } else if (failed || paused) {
      action = {
        label: failed ? "Retry refinement" : "Resume refinement",
        run: () => void refine(),
      };
    } else if (item.processing !== "ready" && questions.length && hasAnswers && aiConfigured) {
      action = { label: "Save answers and refine", run: () => void saveAnswers(true) };
    } else if (item.processing !== "ready" && questions.length) {
      action = {
        label: "Answer questions",
        run: () =>
          dialog.current
            ?.querySelector<HTMLTextAreaElement>(".clarification-interview textarea")
            ?.focus(),
      };
    } else if (review && !note) {
      action = { label: "Add missing details", run: () => inputRef.current?.focus() };
    } else if (note) {
      action = aiConfigured
        ? { label: "Add to profile", run: () => void run("Updating profile…", onAddToProfile) }
        : { label: "Open model settings", run: () => setSettingsSection("Model") };
    } else if (fields.kind === "commitment" && fields.noProject) {
      action = {
        label: "Mark complete",
        run: () => void run("Completing…", () => onSave({ ...fields, status: "done" })),
      };
    } else if (!fields.prompt.trim()) {
      action = { label: "Write prompt", run: () => promptRef.current?.focus() };
    } else if (fields.kind === "commitment" && !submitted) {
      action = implementation.loading
        ? { label: "Checking implementation…", disabled: true, run: () => {} }
        : implementation.error
          ? { label: "Check implementation again", run: implementation.refresh }
          : !options?.configured
            ? { label: "Connect T3 Code", run: () => setSettingsSection("T3 Code") }
            : !options.repositories.length
              ? { label: "Open project settings", run: () => setSettingsSection("Projects") }
              : !repositoryId
                ? {
                    label: "Choose repository",
                    run: () =>
                      dialog.current
                        ?.querySelector<HTMLSelectElement>(
                          '[aria-label="Implementation repository"]',
                        )
                        ?.focus(),
                  }
                : {
                    label: "Start in T3 Code",
                    disabled: !canImplement,
                    run: () => void implement(),
                  };
    }
  }
  if (running) action = { label: "Refining…", disabled: true, run: () => {} };
  if (busy) action = { label: activity, disabled: true, run: () => {} };
  return (
    <dialog
      ref={dialog}
      className="editor-modal capture-editor"
      aria-labelledby="capture-heading"
      onCancel={onClose}
      onPointerDown={(event) => {
        const bounds = event.currentTarget.getBoundingClientRect();
        backdropPointer.current =
          event.target === event.currentTarget &&
          (event.clientX < bounds.left ||
            event.clientX > bounds.right ||
            event.clientY < bounds.top ||
            event.clientY > bounds.bottom);
      }}
      onPointerUp={(event) => {
        const bounds = event.currentTarget.getBoundingClientRect();
        if (
          backdropPointer.current &&
          event.target === event.currentTarget &&
          (event.clientX < bounds.left ||
            event.clientX > bounds.right ||
            event.clientY < bounds.top ||
            event.clientY > bounds.bottom)
        )
          onClose();
        backdropPointer.current = false;
      }}
    >
      <div className="modal-top">
        <span className="eyebrow">{settingsSection ? "CAPTURE SETTINGS" : item.kind}</span>
        <button type="button" aria-label="Close item" className="icon-button" onClick={onClose}>
          <X size={20} />
        </button>
      </div>
      <h2 id="capture-heading">{item.title}</h2>
      {settingsSection && settings ? (
        <>
          <button type="button" className="secondary" onClick={() => setSettingsSection(null)}>
            Back to capture
          </button>
          <p className="muted-text">Your capture edits are kept while you change settings.</p>
          <Configuration
            key={settingsSection}
            settings={settings}
            onChange={onSettingsChange}
            initialSection={settingsSection}
          />
        </>
      ) : (
        <form
          onSubmit={(event) => {
            event.preventDefault();
            if (!busy && !running && dirty) void save();
          }}
        >
          <section
            className={`capture-state ${failed || (review && !note) ? "needs-attention" : ""}`}
            aria-label="Capture status"
          >
            <p className="capture-state-heading" aria-live="polite">
              {running && <LoaderCircle size={16} className="spin" />}
              <strong>{stateLabel}</strong>
              <span>
                {item.kind === "commitment" && stateLabel !== statusLabels[item.status]
                  ? statusLabels[item.status]
                  : item.status === "waiting"
                    ? "Waiting"
                    : ""}
              </span>
            </p>
            {running && (
              <p>
                Refining this capture. You can edit a draft or close this window. Save after
                refinement finishes.
              </p>
            )}
            {!closed && !running && failed && (
              <>
                <p role="alert">{item.processingError}</p>
                {item.processing === "pending" && (
                  <p>The previous prompt may be out of date and cannot be sent to T3 Code.</p>
                )}
                {aiConfigured && item.processing === "pending" && (
                  <button
                    type="button"
                    className="text-button"
                    onClick={() => setSettingsSection("Model")}
                  >
                    Check model settings
                  </button>
                )}
              </>
            )}
            {!closed && !running && paused && (
              <p>
                {aiConfigured
                  ? "No refinement is running. Resume to prepare this capture."
                  : "Connect and validate a model to refine this capture."}
              </p>
            )}
            {!closed && !running && review && (
              <>
                <p>
                  {note
                    ? "Review this note before adding it to your profile."
                    : questions.length
                      ? "Answer the questions below, then refine the brief again."
                      : "Add the missing information to User input, then save and refine."}
                </p>
                {item.rationale && <p className="capture-explanation">{item.rationale}</p>}
              </>
            )}
            {!closed && !running && !review && item.rationale && (failed || paused) && (
              <details open>
                <summary>Previous interpretation</summary>
                <p className="capture-explanation">{item.rationale}</p>
                <button
                  type="button"
                  className="text-button"
                  onClick={() => inputRef.current?.focus()}
                >
                  Add missing details
                </button>
              </details>
            )}
            {!closed &&
              item.processing !== "ready" &&
              ["idea", "commitment"].includes(item.kind) && (
                <div>
                  <button
                    type="button"
                    className="secondary"
                    disabled={busy || running || dirty || answersDirty}
                    onClick={() => void run("Marking as refined…", onMarkRefined)}
                  >
                    Mark as refined
                  </button>
                  <p>
                    Accept the current brief and keep it in{" "}
                    {item.kind === "idea" ? "your notebook" : "Tasks"}. This does not complete the
                    task.
                  </p>
                  {dirty && <p>Save your changes before accepting this brief.</p>}
                </div>
              )}
            {!closed &&
              !running &&
              !failed &&
              !paused &&
              !review &&
              !fields.noProject &&
              !fields.prompt.trim() &&
              !note && <p>Write a complete prompt below, or use Refine again to generate one.</p>}
            {bodyChanged && (
              <p>
                Saving your input will regenerate the prompt. Review the result before starting
                implementation.
              </p>
            )}
            {!closed && !aiConfigured && !paused && (
              <p>
                Refinement needs a model connection.{" "}
                <button
                  type="button"
                  className="text-button"
                  onClick={() => setSettingsSection("Model")}
                >
                  Open model settings
                </button>
              </p>
            )}
            {fields.noProject && (
              <p>No project. Track this task here without a local repository.</p>
            )}
            {item.kind === "commitment" && (!fields.noProject || latest) && (
              <div className="implementation">
                {!fields.noProject && implementation.loading && <p>Checking T3 Code readiness…</p>}
                {!fields.noProject &&
                  implementation.error &&
                  implementation.error !== latest?.error && (
                    <p role="alert">
                      {implementation.error}{" "}
                      <button
                        type="button"
                        className="text-button"
                        onClick={implementation.refresh}
                      >
                        Check again
                      </button>
                    </p>
                  )}
                {latest && (
                  <>
                    <p>
                      {submitted ? "Sent to T3 Code" : "T3 Code has not confirmed the handoff"} ·
                      revision {latest.revision}
                      {latest.taskChanged && " (earlier task description)"}
                    </p>
                    {latest.error && <p role="alert">{latest.error}</p>}
                    {pendingHandoff && !fields.noProject && (
                      <p>
                        Retry checks the same thread using the original saved task. It does not send
                        your current edits.
                      </p>
                    )}
                    {submitted && !fields.noProject && (
                      <>
                        {latest.taskChanged && (
                          <p>
                            This task’s prompt changed after handoff. Progress checks will not
                            change its status. Start another implementation for the updated task, or
                            mark it complete manually after reviewing the result.
                          </p>
                        )}
                        <p>
                          Continue work and answer approvals in T3 Code. A finished agent turn needs
                          review; the task is done when the implementation is merged.
                        </p>
                        {latest.progress && (
                          <p aria-live="polite">
                            {latest.progress.turnState === "running"
                              ? "Agent working"
                              : latest.progress.turnState === "completed"
                                ? "Agent finished — review its result"
                                : latest.progress.turnState === "error"
                                  ? "Agent failed — check T3 Code"
                                  : latest.progress.turnState === "interrupted"
                                    ? "Agent interrupted"
                                    : "Agent progress unavailable"}
                            {" · Last check "}
                            {new Date(latest.progress.checkedAt).toLocaleTimeString()}
                          </p>
                        )}
                        {latest.progress?.error && <p role="alert">{latest.progress.error}</p>}
                        {latest.progress?.localMerge && (
                          <p>
                            <strong>
                              {latest.progress.localMerge.merged
                                ? "Merged locally"
                                : latest.progress.localMerge.dirty
                                  ? "Uncommitted implementation changes"
                                  : "Not merged locally"}
                            </strong>
                            {" · "}
                            {latest.progress.localMerge.branch}
                            {" into "}
                            {latest.progress.localMerge.mainBranch}
                          </p>
                        )}
                        {!closed && (
                          <>
                            <p>
                              Panopticon checks the implementation branch every 30 seconds and marks
                              this task done after it is merged into the local main branch.
                            </p>
                            <button
                              type="button"
                              className="secondary"
                              disabled={busy || dirty}
                              onClick={() =>
                                void run("Checking progress…", implementation.checkProgress)
                              }
                            >
                              Check progress
                            </button>
                          </>
                        )}
                      </>
                    )}
                  </>
                )}
                {options && !closed && !fields.noProject && (
                  <>
                    {!options.configured && (
                      <p>
                        T3 Code is not connected.{" "}
                        <button
                          type="button"
                          className="text-button"
                          onClick={() => setSettingsSection("T3 Code")}
                        >
                          Connect T3 Code
                        </button>
                      </p>
                    )}
                    {!pendingHandoff && !submitted && !options.repositories.length && (
                      <p>
                        No implementation repositories are available.{" "}
                        <button
                          type="button"
                          className="text-button"
                          onClick={() => setSettingsSection("Projects")}
                        >
                          Add a project root and discover repositories
                        </button>
                      </p>
                    )}
                    {!pendingHandoff && options.repositories.length > 0 && (
                      <label className="field">
                        Implementation repository
                        <select
                          aria-label="Implementation repository"
                          value={repositoryId}
                          disabled={busy}
                          onChange={(event) => setRepositoryId(event.target.value)}
                        >
                          <option value="">Choose a repository</option>
                          {options.repositories.map((repository) => (
                            <option key={repository.id} value={repository.id}>
                              {repository.name} — {repository.path}
                            </option>
                          ))}
                        </select>
                      </label>
                    )}
                    {!pendingHandoff && !repositoryId && options.repositories.length > 0 && (
                      <p>Choose the repository for this task.</p>
                    )}
                    {!pendingHandoff && canImplement && !latest && (
                      <p>
                        Starts an agent in a new worktree from the current commit. Uncommitted
                        changes are not included.
                      </p>
                    )}
                    {fields.project !== item.project && (
                      <p>Save the project change to check its implementation repository.</p>
                    )}
                  </>
                )}
              </div>
            )}
          </section>
          {error && (
            <div role="alert" className="banner error">
              {error}
            </div>
          )}
          {!closed && questions.length > 0 && item.processing !== "ready" && (
            <section
              className="clarification-interview capture-state"
              aria-label="Clarification questions"
            >
              <h3>Let’s clarify the brief</h3>
              <p>
                Answer what you know. Partial answers are welcome; the next refinement will use your
                answers and the previous brief.
              </p>
              {questions.map((entry, index) => (
                <label className="field" key={entry.id}>
                  {index + 1}. {entry.question}
                  <textarea
                    aria-label={`${index + 1}. ${entry.question}`}
                    rows={2}
                    maxLength={5000}
                    disabled={busy || running}
                    value={answers[entry.id] ?? entry.answer}
                    onChange={(event) => setAnswers({ ...answers, [entry.id]: event.target.value })}
                    placeholder="Your answer…"
                  />
                </label>
              ))}
              <div className="modal-actions">
                <button
                  type="button"
                  className="secondary"
                  disabled={busy || running || !answersDirty || dirty}
                  onClick={() => void saveAnswers(false)}
                >
                  Save answers
                </button>
                <button
                  type="button"
                  className="secondary"
                  disabled={busy || running || !hasAnswers || dirty || !aiConfigured}
                  onClick={() => void saveAnswers(true)}
                >
                  Refine with answers
                </button>
              </div>
              {dirty && <p>Save your brief edits before submitting answers.</p>}
              {answersDirty && <p>Unsaved answers · save before closing.</p>}
            </section>
          )}
          {item.clarifications.some((entry) => entry.resolved) && (
            <details className="capture-tools">
              <summary>Previous answers</summary>
              {item.clarifications
                .filter((entry) => entry.resolved)
                .map((entry) => (
                  <div key={entry.id}>
                    <strong>{entry.question}</strong>
                    <p className="capture-explanation">{entry.answer}</p>
                  </div>
                ))}
            </details>
          )}
          <label className="field">
            Title
            <input
              required
              maxLength={300}
              value={fields.title}
              onChange={(event) => setFields({ ...fields, title: event.target.value })}
            />
          </label>
          <label className="field">
            User input
            <textarea
              ref={inputRef}
              aria-label="User input"
              rows={4}
              value={fields.body}
              maxLength={30000}
              onChange={(event) => setFields({ ...fields, body: event.target.value })}
            />
          </label>
          <label className="field">
            Prompt
            <textarea
              ref={promptRef}
              aria-label="Prompt"
              rows={6}
              value={fields.prompt}
              maxLength={30000}
              placeholder="A self-contained prompt will appear here after refinement."
              onChange={(event) => setFields({ ...fields, prompt: event.target.value })}
            />
          </label>
          <button
            type="button"
            className="text-button"
            disabled={
              busy ||
              !fields.prompt.trim() ||
              bodyChanged ||
              running ||
              item.processing === "pending"
            }
            onClick={() =>
              void run("Copying…", async () => {
                await navigator.clipboard.writeText(fields.prompt);
                setCopiedPrompt(fields.prompt);
              })
            }
          >
            {copiedPrompt === fields.prompt ? "Prompt copied" : "Copy prompt"}
          </button>
          <details className="capture-details">
            <summary>
              Task details{" "}
              <span>
                {projectLabel(fields)} · {fields.status}
              </span>
            </summary>
            <div className="field-grid">
              <label className="field">
                Kind
                <select
                  aria-label="Kind"
                  value={fields.kind}
                  onChange={(event) =>
                    setFields({
                      ...fields,
                      kind: event.target.value as ItemFields["kind"],
                      status:
                        event.target.value === "note" &&
                        fields.kind !== "note" &&
                        fields.status === "done"
                          ? "open"
                          : fields.status,
                      dueDate: event.target.value === "commitment" ? fields.dueDate : null,
                    })
                  }
                >
                  <option value="unclassified">Unclassified</option>
                  <option value="idea">Idea</option>
                  <option value="note">Note</option>
                  <option value="commitment">Commitment</option>
                </select>
              </label>
              <label className="field">
                Status
                <select
                  aria-label="Status"
                  value={fields.status}
                  onChange={(event) =>
                    setFields({ ...fields, status: event.target.value as ItemFields["status"] })
                  }
                >
                  <option value="open">Not started</option>
                  {fields.kind === "commitment" && <option value="in_progress">In progress</option>}
                  {fields.kind === "commitment" && (
                    <option value="in_review">Ready for review</option>
                  )}
                  <option value="waiting">Waiting</option>
                  <option value="done" disabled={fields.kind === "note" && item.status !== "done"}>
                    {fields.kind === "note" && item.profilePath ? "Added to profile" : "Done"}
                  </option>
                  <option value="archived">Archived</option>
                </select>
              </label>
            </div>
            <label className="field">
              Project
              <input
                value={fields.project}
                disabled={fields.noProject}
                maxLength={200}
                placeholder="Unassigned project or context"
                onChange={(event) => setFields({ ...fields, project: event.target.value })}
              />
            </label>
            <label className="checkbox">
              <input
                type="checkbox"
                checked={fields.noProject}
                onChange={(event) =>
                  setFields({ ...fields, noProject: event.target.checked, project: "" })
                }
              />
              No project (outside local repositories)
            </label>
            {fields.kind === "commitment" && (
              <div className="field-grid">
                <label className="field">
                  Due date
                  <input
                    type="date"
                    value={fields.dueDate ?? ""}
                    onChange={(event) =>
                      setFields({ ...fields, dueDate: event.target.value || null })
                    }
                  />
                </label>
                <label className="field">
                  Priority
                  <select
                    aria-label="Priority"
                    value={fields.priority}
                    onChange={(event) =>
                      setFields({
                        ...fields,
                        priority: event.target.value as ItemFields["priority"],
                      })
                    }
                  >
                    <option value="normal">Normal</option>
                    <option value="high">High</option>
                  </select>
                </label>
              </div>
            )}

            <label className="field">
              Related idea or item
              <select
                aria-label="Related idea or item"
                value={fields.relatedId ?? ""}
                onChange={(event) =>
                  setFields({ ...fields, relatedId: event.target.value || null })
                }
              >
                <option value="">No link</option>
                {items
                  .filter((other) => other.id !== item.id)
                  .map((other) => (
                    <option key={other.id} value={other.id}>
                      {other.title}
                    </option>
                  ))}
              </select>
            </label>
          </details>
          {item.references.length > 0 && (
            <div className="interpretation">
              <p>{annotatedText(item.body, item.references)}</p>
            </div>
          )}
          {item.rationale && !failed && !paused && !review && (
            <details>
              <summary>Interpretation</summary>
              <p className="capture-explanation">{item.rationale}</p>
            </details>
          )}
          {note && item.profilePath && (
            <details open>
              <summary>Added to profile</summary>
              {item.sourcePaths.map((path) =>
                profileAvailable ? (
                  <button
                    type="button"
                    className="text-button"
                    key={path}
                    onClick={() => onOpenProfile(path)}
                  >
                    {path}
                  </button>
                ) : (
                  <p key={path}>{path}</p>
                ),
              )}
            </details>
          )}
          <details>
            <summary>Original capture & sources</summary>
            <pre>{item.original}</pre>
            {item.sourcePaths.map((path) => (
              <div className="source" key={path}>
                {path}
              </div>
            ))}
            <p className="muted-text">Captured {new Date(item.createdAt).toLocaleString()}</p>
          </details>
          <details
            onToggle={(event) => {
              if (event.currentTarget.open && !history)
                void api<{ item: Item; changedAt: string }[]>(`/items/${item.id}/history`)
                  .then(setHistory)
                  .catch((reason) => setError(String(reason)));
            }}
          >
            <summary>Revision history</summary>
            {history?.length ? (
              history.map((entry) => (
                <div key={entry.item.revision} className="history-entry">
                  <strong>{entry.item.title}</strong>
                  {entry.item.prompt && <pre>{entry.item.prompt}</pre>}
                  <p>
                    {entry.item.kind} · {entry.item.status} ·{" "}
                    {new Date(entry.changedAt).toLocaleString()}
                  </p>
                  <pre>{entry.item.body}</pre>
                </div>
              ))
            ) : (
              <p className="muted-text">No earlier revisions.</p>
            )}
          </details>

          {!closed && (
            <details className="capture-tools">
              <summary>More actions</summary>
              <div className="modal-actions">
                <button
                  type="button"
                  className="secondary"
                  disabled={busy || running || dirty || answersDirty || !aiConfigured}
                  onClick={() => void refine()}
                >
                  Refine again
                </button>
                {item.references.length > 0 && (
                  <button
                    type="button"
                    className="secondary"
                    disabled={busy || running || dirty || answersDirty || !aiConfigured}
                    onClick={() => void refine(true)}
                  >
                    Resolve aliases again
                  </button>
                )}
                {submitted && !fields.noProject && (
                  <button
                    type="button"
                    className="secondary"
                    disabled={busy || running || dirty || !canImplement}
                    onClick={() => void implement()}
                  >
                    Start another implementation
                  </button>
                )}
              </div>
              {(dirty || running || !aiConfigured) && (
                <p className="muted-text">
                  {running
                    ? "Wait for the current refinement to finish."
                    : dirty
                      ? "Save your changes before refining again."
                      : "Connect a model to refine this capture."}
                </p>
              )}
              {submitted && !fields.noProject && (
                <p className="muted-text">
                  Another implementation starts a separate thread from the current saved version.
                </p>
              )}
            </details>
          )}
          <div className="capture-footer">
            <span className="capture-save-state">
              {dirty || answersDirty
                ? "Unsaved changes · closing discards edits"
                : "All changes saved"}
            </span>
            <div className="modal-actions">
              {item.kind === "commitment" && !dirty && !closed && (
                <>
                  {["open", "waiting", "in_review"].includes(item.status) && (
                    <button
                      type="button"
                      className="secondary"
                      disabled={busy}
                      onClick={() =>
                        void run("Updating status…", () =>
                          onSave({ ...fields, status: "in_progress" }),
                        )
                      }
                    >
                      {item.status === "open" ? "Mark in progress" : "Resume"}
                    </button>
                  )}
                  {item.status === "in_progress" && (
                    <button
                      type="button"
                      className="secondary"
                      disabled={busy}
                      onClick={() =>
                        void run("Updating status…", () => onSave({ ...fields, status: "waiting" }))
                      }
                    >
                      Mark waiting
                    </button>
                  )}
                  <button
                    type="button"
                    className="secondary"
                    disabled={busy}
                    onClick={() =>
                      void run("Completing…", () => onSave({ ...fields, status: "done" }))
                    }
                  >
                    {submitted ? "Mark merged" : "Mark done"}
                  </button>
                </>
              )}
              {dirty && action.label !== "Save changes" && action.label !== "Save and refine" && (
                <button type="submit" className="secondary" disabled={busy || running}>
                  Save changes
                </button>
              )}
              {submitted && !dirty && !running && !busy ? (
                <a
                  className="primary capture-open"
                  href={latest.url}
                  target="_blank"
                  rel="noreferrer"
                >
                  Continue in T3 Code
                </a>
              ) : (
                <button
                  type="button"
                  className="primary"
                  disabled={action.disabled}
                  onClick={(event) => {
                    if (!dirty || event.currentTarget.form?.reportValidity()) action.run();
                  }}
                >
                  {action.label}
                </button>
              )}
            </div>
          </div>
        </form>
      )}
    </dialog>
  );
}

function Conversation({
  settings,
  report,
  onCapture,
}: {
  settings: Settings | null;
  report: (reason: unknown) => void;
  onCapture: (text: string) => Promise<void>;
}) {
  const [messages, setMessages] = useState<Message[]>([]);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [search, setSearch] = useState("");
  const [evidence, setEvidence] = useState("");
  const [searching, setSearching] = useState(false);
  const [includeEvidence, setIncludeEvidence] = useState(false);
  useEffect(() => {
    void api<Message[]>("/messages").then(setMessages).catch(report);
  }, [report]);
  const ask = async (event: FormEvent) => {
    event.preventDefault();
    if (!text.trim() || busy) return;
    setBusy(true);
    try {
      await api<AssistantReply>("/ask", "POST", {
        text,
        sessionEvidence: includeEvidence ? evidence.slice(0, 30000) : "",
      });
      setText("");
      setMessages(await api<Message[]>("/messages"));
    } catch (reason) {
      report(reason);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="conversation-layout">
      <section className="chat-panel">
        <div className="section-title">
          <h2>Your thinking partner</h2>
          <span className="pill">Read-only conversation</span>
        </div>
        <p className="muted-text">
          Answers use your profile and relevant local items. Save useful answers as captures; edit
          items to make changes.
        </p>
        {!settings?.aiConfigured && (
          <div className="setup-hint">
            <strong>Connect a model to start talking.</strong>
            <p>Open Settings to connect and validate a model.</p>
          </div>
        )}
        <div className="messages">
          {messages.length ? (
            messages.map((message) => (
              <article className={`message ${message.role}`} key={message.id}>
                <span className="eyebrow">{message.role === "user" ? "YOU" : "ASSISTANT"}</span>
                <p>{message.content}</p>
                {message.sources.length > 0 && (
                  <div className="sources">
                    {message.sources.map((source) => (
                      <span className="source" key={source}>
                        {source}
                      </span>
                    ))}
                  </div>
                )}
                {message.role === "assistant" && (
                  <button
                    type="button"
                    className="text-button"
                    onClick={() => {
                      void onCapture(message.content).catch(report);
                    }}
                  >
                    <Plus size={14} />
                    Save as capture
                  </button>
                )}
              </article>
            ))
          ) : (
            <div className="conversation-empty">
              <MessageCircle size={30} strokeWidth={1.3} />
              <h3>A place to work things out.</h3>
              <p>
                “What needs my attention?”
                <br />
                “Help me develop that onboarding idea.”
              </p>
            </div>
          )}
        </div>
        <form
          className="chat-compose"
          onSubmit={(event) => {
            void ask(event);
          }}
        >
          <textarea
            aria-label="Message your assistant"
            value={text}
            onChange={(event) => setText(event.target.value)}
            placeholder="Ask, reflect, or explore an idea…"
            rows={3}
            maxLength={10000}
          />
          <button
            type="submit"
            className="primary"
            disabled={busy || !text.trim() || !settings?.aiConfigured}
          >
            {busy ? "Thinking…" : "Send"}
            <ArrowRight size={16} />
          </button>
        </form>
      </section>
      <aside>
        <div className="small-card">
          <h3>Previous sessions</h3>
          <p>Search CTX locally. Review results before sharing them with your model.</p>
          <form
            onSubmit={(event) => {
              event.preventDefault();
              setSearching(true);
              setIncludeEvidence(false);
              void api<{ evidence: string }>("/sessions/search", "POST", { query: search })
                .then((result) => setEvidence(result.evidence))
                .catch(report)
                .finally(() => setSearching(false));
            }}
          >
            <label className="field">
              Search session history
              <input
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                maxLength={500}
                placeholder="Project, decision, or previous work"
              />
            </label>
            <button
              type="submit"
              className="secondary"
              disabled={searching || !search.trim() || !settings?.ctxAvailable}
            >
              {searching ? "Searching…" : "Search CTX"}
            </button>
          </form>
          {evidence && (
            <>
              <pre className="evidence">{evidence}</pre>
              <label className="checkbox">
                <input
                  type="checkbox"
                  checked={includeEvidence}
                  onChange={(event) => setIncludeEvidence(event.target.checked)}
                />
                Share these results with the model
              </label>
            </>
          )}
          {settings && !settings.ctxAvailable && (
            <p className="warning-text">CTX is not available on the server’s PATH.</p>
          )}
        </div>
        <div className="connection-note">
          <BookOpen size={20} />
          <div>
            <strong>Company knowledge</strong>
            <p>Guru / Onyx is not connected in this first version.</p>
          </div>
        </div>
      </aside>
    </div>
  );
}

function ProfileEditor({
  initialPath,
  documents,
  settings,
  onSave,
  report,
}: {
  initialPath: string | null;
  documents: ProfileDocument[];
  settings: Settings | null;
  onSave: () => Promise<void>;
  report: (reason: unknown) => void;
}) {
  const [selected, setSelected] = useState<ProfileDocument | null>(
    () => documents.find((doc) => doc.path === initialPath) ?? null,
  );
  const [content, setContent] = useState(selected?.content ?? "");
  const [busy, setBusy] = useState(false);
  const [creating, setCreating] = useState(false);
  const [title, setTitle] = useState("");
  const [type, setType] = useState("Project");
  const [saved, setSaved] = useState("");
  const editor = useRef<HTMLElement>(null);
  const dirty = selected ? content !== selected.content : !!content || !!title;
  const choose = (doc: ProfileDocument | null) => {
    if (dirty && !window.confirm("Discard your unsaved changes?")) return false;
    setSelected(doc);
    setContent(doc?.content ?? "");
    setCreating(!doc);
    setTitle("");
    setSaved("");
    editor.current?.scrollIntoView({ block: "start", behavior: "instant" });
    return true;
  };
  const save = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    try {
      const doc = selected
        ? await api<ProfileDocument>("/profile", "PUT", {
            path: selected.path,
            hash: selected.hash,
            content,
          })
        : await api<ProfileDocument>("/profile", "POST", { title, type, body: content });
      setSelected(doc);
      setContent(doc.content);
      setCreating(false);
      setSaved("Saved to your repository. Changes are not committed automatically.");
      await onSave();
    } catch (reason) {
      report(reason);
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <div className="profile-intro">
        <div>
          <span className="pill">
            <span className="status-dot" />
            {settings?.profileGit ? "Independent Git repository" : "Profile repository needs setup"}
          </span>
          <p className="repository-path">{settings?.profilePath}</p>
          <p>
            Start with your role and goals, add your active projects, then refine how you like to
            work. These Markdown files belong to you.
          </p>
        </div>
        <FileText size={35} strokeWidth={1} />
      </div>
      <div className="profile-layout">
        <aside className="document-list">
          {documents.map((doc) => (
            <button
              type="button"
              key={doc.path}
              className={selected?.path === doc.path ? "selected" : ""}
              onClick={() => choose(doc)}
            >
              <FileText size={17} />
              <span>
                <strong>{doc.title}</strong>
                <small>{doc.type}</small>
              </span>
              <ChevronRight size={14} />
            </button>
          ))}
          <button type="button" className="add-document" onClick={() => choose(null)}>
            <Plus size={17} />
            Add context
          </button>
          <button
            type="button"
            className="add-document"
            onClick={() => {
              if (!choose(null)) return;
              setTitle("Aliases");
              setType("Aliases");
              setContent("| Alias | Kind | Target |\n| --- | --- | --- |\n");
            }}
          >
            <Plus size={17} />
            Add aliases
          </button>
        </aside>
        <section className="document-editor" ref={editor}>
          {selected || creating ? (
            <form
              onSubmit={(event) => {
                void save(event);
              }}
            >
              <div className="section-title">
                <h2>{selected?.title ?? "Add a piece of context"}</h2>
              </div>
              {(selected?.type === "Aliases" || (creating && type === "Aliases")) && (
                <p className="muted-text">
                  Add one table row per alias, including given names. Kind is person, project, or
                  repository. For a person, use their directory email as the target. For a project
                  or repository, use its profile document path. For example: | Tobi | person |
                  tobias@example.com |. These mappings stay separate from directory sync.
                </p>
              )}
              {creating && (
                <div className="field-grid">
                  <label className="field">
                    Document title
                    <input
                      required
                      value={title}
                      maxLength={200}
                      onChange={(event) => setTitle(event.target.value)}
                    />
                  </label>
                  <label className="field">
                    Document type
                    <input
                      required
                      value={type}
                      maxLength={100}
                      onChange={(event) => setType(event.target.value)}
                      placeholder="Any meaningful concept type"
                    />
                  </label>
                </div>
              )}
              <label className="field">
                {selected ? "Markdown document" : "Content"}
                <textarea
                  className="markdown-editor"
                  aria-label={selected ? "Markdown document" : "Content"}
                  rows={18}
                  value={content}
                  maxLength={50000}
                  onChange={(event) => setContent(event.target.value)}
                />
              </label>
              <div className="document-actions">
                <p role="status">
                  {saved || "Manual edits and authorized notes update this repository."}
                </p>
                <button type="submit" className="primary" disabled={busy || !dirty}>
                  {busy ? "Saving…" : "Save document"}
                </button>
              </div>
            </form>
          ) : (
            <Empty
              icon={<PanopticonMark />}
              title="Help your assistant understand your world"
              text="Choose any document or add context. Nested folders and custom concept types are welcome. External changes are discovered automatically; reselect a document to load its latest contents."
            />
          )}
        </section>
      </div>
      <p className="muted-text">
        Connection, model, and repository preferences are available in Settings. Git commits and
        pushes remain under your control.
      </p>
      <Enrichment />
    </>
  );
}
