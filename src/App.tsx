import {
  ArrowRight,
  BookOpen,
  Check,
  ChevronRight,
  Circle,
  Command,
  FileText,
  Inbox,
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
import type { AssistantReply, Item, ItemFields, ProfileDocument, Settings } from "../shared/schema";
import { annotatedText } from "../shared/schema";
import { api } from "./api";
import { PanopticonMark, Wordmark } from "./Brand";
import { Implementation } from "./Implementation";
import { Configuration } from "./Settings";

type View = "today" | "inbox" | "notebook" | "ask" | "profile" | "settings";
type Daily = { date: string; due: Item[]; suggested: Item[]; waiting: Item[] };
type Message = { id: number; role: string; content: string; sources: string[] };
const navigation = [
  { id: "today", label: "Today", icon: Sun },
  { id: "inbox", label: "Inbox", icon: Inbox },
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
  const [notice, setNotice] = useState("");
  const [capture, setCapture] = useState("");
  const [saving, setSaving] = useState(false);
  const [selected, setSelected] = useState<Item | null>(null);
  const [profileDocument, setProfileDocument] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [showClosed, setShowClosed] = useState(false);
  const input = useRef<HTMLTextAreaElement>(null);
  const report = useCallback(
    (reason: unknown) =>
      setError(reason instanceof Error ? reason.message : "Something went wrong."),
    [],
  );
  const reload = useCallback(async () => {
    const [nextItems, nextDaily] = await Promise.all([api<Item[]>("/items"), api<Daily>("/today")]);
    setItems(nextItems);
    setSelected((current) => {
      const next = nextItems.find((item) => item.id === current?.id);
      return next && next.revision !== current?.revision ? next : current;
    });
    setDaily(nextDaily);
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
    const timeout = setTimeout(() => setNotice(""), 5000);
    return () => clearTimeout(timeout);
  }, [notice]);

  const saveCapture = async (event?: FormEvent) => {
    event?.preventDefault();
    if (!capture.trim() || saving) return;
    setSaving(true);
    setError("");
    try {
      await api<Item>("/captures", "POST", { text: capture });
      setCapture("");
      setNotice(
        settings?.aiConfigured
          ? "Captured. Your assistant is organizing it."
          : "Captured safely. Organize it in your inbox.",
      );
      await reload();
    } catch (reason) {
      report(reason);
    } finally {
      setSaving(false);
    }
  };
  const updateItem = async (item: Item, fields: Partial<ItemFields>) => {
    await api(`/items/${item.id}`, "PATCH", { ...fields, revision: item.revision });
    await reload();
  };
  const row = (item: Item, reason?: string) => (
    <ItemRow
      key={item.id}
      item={item}
      reason={reason}
      onOpen={() => setSelected(item)}
      onComplete={() => {
        void updateItem(item, { status: item.status === "done" ? "open" : "done" }).catch(report);
      }}
    />
  );
  const pending = items.filter(
    (item) => item.processing !== "ready" && !["done", "archived"].includes(item.status),
  ).length;
  const filtered = items.filter(
    (item) =>
      (showClosed || !["done", "archived"].includes(item.status)) &&
      (view !== "notebook" || ["idea", "note"].includes(item.kind)) &&
      `${item.title} ${item.body} ${item.prompt} ${item.project}`
        .toLowerCase()
        .includes(query.toLowerCase()),
  );
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
              onClick={() => {
                setView(id);
                setQuery("");
              }}
            >
              <Icon size={19} />
              <span>{label}</span>
              {id === "inbox" && pending > 0 && <span className="count">{pending}</span>}
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
                      notebook: "Ideas and context worth keeping.",
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
                      inbox: "Everything you captured. Organize it when you have a moment.",
                      notebook: "Develop ideas and add pending notes to your profile.",
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

          {view === "settings" && <Configuration settings={settings} onChange={settingsChanged} />}

          {view === "today" && (
            <div className="dashboard">
              <div>
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
                  <span className="eyebrow">WAITING FOR A MOMENT</span>
                  <strong>{pending}</strong>
                  <p>{pending === 1 ? "capture to organize" : "captures to organize"}</p>
                  <button type="button" className="text-button" onClick={() => setView("inbox")}>
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

          {(view === "inbox" || view === "notebook") && (
            <section className="collection">
              <div className="collection-toolbar">
                <label className="search">
                  <Search size={17} />
                  <input
                    aria-label="Search items"
                    value={query}
                    onChange={(event) => setQuery(event.target.value)}
                    placeholder="Find a thought or commitment"
                  />
                </label>
                <label className="checkbox">
                  <input
                    type="checkbox"
                    checked={showClosed}
                    onChange={(event) => setShowClosed(event.target.checked)}
                  />
                  Include completed & archived
                </label>
              </div>
              <div className="section-title">
                <h2>{view === "inbox" ? "All captures" : "Your notebook"}</h2>
                <span className="count">{filtered.length}</span>
              </div>
              {filtered.length ? (
                filtered.map((item) => row(item))
              ) : (
                <Empty
                  icon={<BookOpen size={25} />}
                  title={view === "notebook" ? "Let an idea take shape" : "A fresh page"}
                  text={
                    query
                      ? "No items match this search."
                      : view === "notebook"
                        ? "Ideas stay here. Notes await incorporation into your profile."
                        : "Your next thought belongs in the capture box above."
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
                await api("/captures", "POST", { text });
                await reload();
                setNotice("Saved to your inbox.");
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
          {notice}
        </div>
      )}
      {selected && (
        <ItemEditor
          key={selected.id}
          item={selected}
          items={items}
          aiConfigured={!!settings?.aiConfigured}
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
            const updated = await api<Item>(`/items/${selected.id}/profile`, "POST", {
              revision: selected.revision,
            });
            setSelected(updated);
            await reload();
            await reloadProfile();
          }}
          onClose={() => setSelected(null)}
          onSave={async (fields) => {
            await updateItem(selected, fields);
            setSelected(null);
            setNotice("Changes saved.");
          }}
          onRetry={async (resetReferences = false) => {
            const updated = await api<Item>(`/items/${selected.id}/process`, "POST", {
              resetReferences,
              revision: selected.revision,
            });
            setSelected(updated);
            await reload();
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
  subtitle: string;
  count: number;
  children: React.ReactNode;
}) {
  return (
    <section className="section">
      <div className="section-title">
        <h2>{title}</h2>
        <span className="count">{count}</span>
      </div>
      <p className="section-subtitle">{subtitle}</p>
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
}: {
  item: Item;
  reason?: string;
  onOpen: () => void;
  onComplete: () => void;
}) {
  return (
    <article className={`item-row ${item.status === "done" ? "completed" : ""}`}>
      {item.kind === "commitment" ? (
        <button
          type="button"
          className="complete-button"
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
          {item.project && <span className="project-tag">{item.project}</span>}
          {reason ||
            (item.kind === "note"
              ? item.profilePath && item.status === "done"
                ? "Added to profile"
                : item.status === "done"
                  ? "Done"
                  : item.processingError
                    ? "Profile update needs attention"
                    : "Pending profile note"
              : item.processing !== "ready"
                ? item.processing === "review"
                  ? "Needs clarification"
                  : "Awaiting organization"
                : item.kind)}
          {item.status === "waiting" && " · Waiting"}
          {item.status === "archived" && " · Archived"}
          {!reason && item.dueDate && ` · ${item.dueDate}`}
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
  onRetry,
  onAddToProfile,
  onOpenProfile,
  profileAvailable,
}: {
  item: Item;
  items: Item[];
  aiConfigured: boolean;
  onClose: () => void;
  onSave: (fields: ItemFields) => Promise<void>;
  onRetry: (resetReferences?: boolean) => Promise<void>;
  onAddToProfile: () => Promise<void>;
  onOpenProfile: (path: string) => void;
  profileAvailable: boolean;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [fields, setFields] = useState<ItemFields>({
    title: item.title,
    body: item.body,
    prompt: item.prompt,
    kind: item.kind,
    status: item.status,
    project: item.project,
    dueDate: item.dueDate,
    priority: item.priority,
    relatedId: item.relatedId,
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [history, setHistory] = useState<{ item: Item; changedAt: string }[] | null>(null);
  const [copiedPrompt, setCopiedPrompt] = useState<string | null>(null);
  const previous = useRef(item);
  const dirty = (Object.keys(fields) as (keyof ItemFields)[]).some(
    (key) => fields[key] !== item[key],
  );
  useEffect(() => {
    dialog.current?.showModal();
  }, []);
  useEffect(() => {
    const before = previous.current;
    previous.current = item;
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
  const run = async (action: () => Promise<void>) => {
    setBusy(true);
    setError("");
    try {
      await action();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Could not save.");
    } finally {
      setBusy(false);
    }
  };
  return (
    <dialog ref={dialog} className="editor-modal" onCancel={onClose}>
      <div className="modal-top">
        <span className="eyebrow">MAKE IT YOURS</span>
        <button type="button" aria-label="Close item" className="icon-button" onClick={onClose}>
          <X size={20} />
        </button>
      </div>
      <h2>Organize this thought</h2>
      <p className="muted-text">Your original capture is always preserved.</p>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void run(() => onSave(fields));
        }}
      >
        {error && (
          <div role="alert" className="banner error">
            {error}
          </div>
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
              <option value="open">Open</option>
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
            maxLength={200}
            placeholder="Optional project or context"
            onChange={(event) => setFields({ ...fields, project: event.target.value })}
          />
        </label>
        {fields.kind === "commitment" && (
          <div className="field-grid">
            <label className="field">
              Due date
              <input
                type="date"
                value={fields.dueDate ?? ""}
                onChange={(event) => setFields({ ...fields, dueDate: event.target.value || null })}
              />
            </label>
            <label className="field">
              Priority
              <select
                aria-label="Priority"
                value={fields.priority}
                onChange={(event) =>
                  setFields({ ...fields, priority: event.target.value as ItemFields["priority"] })
                }
              >
                <option value="normal">Normal</option>
                <option value="high">High</option>
              </select>
            </label>
          </div>
        )}
        <label className="field">
          User input
          <textarea
            aria-label="User input"
            rows={5}
            value={fields.body}
            maxLength={30000}
            onChange={(event) => setFields({ ...fields, body: event.target.value })}
          />
        </label>
        <p className="muted-text">
          Saving changed user input regenerates the prompt and interpretation.
        </p>
        <label className="field">
          Prompt
          <textarea
            aria-label="Prompt"
            rows={7}
            value={fields.prompt}
            maxLength={30000}
            placeholder="A self-contained prompt will appear here after refinement."
            onChange={(event) => setFields({ ...fields, prompt: event.target.value })}
          />
        </label>
        {item.processing === "pending" && (
          <p className="muted-text">
            {item.processingError || !aiConfigured
              ? "Prompt regeneration is pending. The previous prompt may be out of date."
              : "Generating prompt… The previous prompt may be out of date."}
          </p>
        )}
        <button
          type="button"
          className="secondary"
          disabled={
            busy ||
            !fields.prompt.trim() ||
            fields.body !== item.body ||
            item.processing === "pending"
          }
          onClick={() => {
            void run(async () => {
              await navigator.clipboard.writeText(fields.prompt);
              setCopiedPrompt(fields.prompt);
            });
          }}
        >
          {copiedPrompt === fields.prompt ? "Prompt copied" : "Copy prompt"}
        </button>
        <label className="field">
          Related idea or item
          <select
            aria-label="Related idea or item"
            value={fields.relatedId ?? ""}
            onChange={(event) => setFields({ ...fields, relatedId: event.target.value || null })}
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
        {item.references.length > 0 && (
          <div className="interpretation">
            <p>{annotatedText(item.body, item.references)}</p>
          </div>
        )}
        {item.rationale && (
          <div className="interpretation">
            <Sparkles size={16} />
            <p>{item.rationale}</p>
          </div>
        )}
        {item.processingError && <p className="warning-text">{item.processingError}</p>}
        {item.kind === "note" && item.profilePath && (
          <div className="interpretation">
            <p>Added to profile: {item.profilePath}</p>
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
          </div>
        )}
        {item.kind === "note" && !["done", "archived"].includes(item.status) && (
          <p className="muted-text">
            {dirty
              ? "Save your changes before adding this note to the profile."
              : "Add this note to your profile. Unclear or conflicting information will remain here for review."}
          </p>
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
        <div className="modal-actions">
          {aiConfigured && item.kind === "note" && !["done", "archived"].includes(item.status) && (
            <button
              type="button"
              className="primary"
              disabled={busy || dirty}
              onClick={() => {
                void run(onAddToProfile);
              }}
            >
              {busy
                ? "Updating profile…"
                : item.processingError
                  ? "Retry profile update"
                  : "Add to profile"}
            </button>
          )}
          {aiConfigured &&
            item.references.length > 0 &&
            !(item.kind === "note" && item.status === "done") && (
              <button
                type="button"
                className="secondary"
                disabled={busy || dirty}
                onClick={() => {
                  void run(() => onRetry(true));
                }}
              >
                Resolve aliases again
              </button>
            )}
          {aiConfigured && !(item.kind === "note" && item.status === "done") && (
            <button
              type="button"
              className="secondary"
              disabled={busy || dirty}
              onClick={() => {
                void run(onRetry);
              }}
            >
              Regenerate prompt
            </button>
          )}
          <button type="submit" className="primary" disabled={busy}>
            {busy ? "Saving…" : "Save changes"}
          </button>
        </div>
        {item.kind === "commitment" && (
          <Implementation item={item} dirty={dirty} busy={busy} run={run} />
        )}
      </form>
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
        Connection, model, repository, and agent enrichment guidance are available in Settings. Git
        commits and pushes remain under your control.
      </p>
    </>
  );
}
