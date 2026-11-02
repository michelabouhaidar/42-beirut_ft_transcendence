import { SubmitEvent, ReactNode, useCallback, useEffect, useRef, useState } from "react";
import { Check, Link2, Loader2, MoreHorizontal, Pencil, Trash2 } from "lucide-react";
import { Assignee, Task, TaskApiError, TaskComment, TaskInput, TaskPriority, TaskStatus, tasksApi } from "../../api/tasks";
import { useAuth } from "../../context/AuthContext";
import { Alert, Avatar, Button, ConfirmDialog, IconButton, Input, Menu, Modal, PersonPicker, Select, Spinner, Textarea, useToast } from "../../components";
import { ConsequenceList } from "../admin/adminUi";

import { DueDate, PriorityBadge, STATUS_LABELS, StatusBadge, isOverdue, priorityOptions, statusOptions, toPickerPeople } from "./taskUi";
import { formatDate, formatDay, formatRelative, plural } from "../../lib/format";

interface TaskPanelProps {
  projectKey: string;
  projectName?: string;
  number: number;
  assignees: Assignee[];
  /** Bumped by the board when the project changed elsewhere. */
  refreshKey: number;
  onClose: () => void;
  onChanged: (task: Task) => void;
  onDeleted: (task: Task) => void;
}

type SaveState = "idle" | "saving" | "saved";

// A wide, two-column task view. Every field saves as soon as it changes.
// The title and description edit in place. Read-only for Viewers, who can still comment.
export function TaskPanel({ projectKey, projectName, number, assignees, refreshKey, onClose, onChanged, onDeleted }: TaskPanelProps) {
  const toast = useToast();
  const { user } = useAuth();
  const [task, setTask] = useState<Task | null>(null);
  const [perm, setPerm] = useState({ canEdit: false, canDelete: false });
  const [error, setError] = useState<TaskApiError | null>(null);
  const [saveState, setSaveState] = useState<SaveState>("idle");
  const [deleteOpen, setDeleteOpen] = useState(false);
  const savedTimer = useRef<number | undefined>(undefined);

  const load = useCallback(async () => {
    try {
      const res = await tasksApi.get(projectKey, number);
      setTask(res.task);
      setPerm({ canEdit: res.canEdit, canDelete: res.canDelete });
      setError(null);
    } catch (err) {
      setError(err as TaskApiError);
    }
  }, [projectKey, number]);

  useEffect(() => {
    setTask(null);
    load();
  }, [load]);

  // Someone else changed something. Fields being edited keep their local text.
  useEffect(() => {
    if (refreshKey > 0) load();
  }, [refreshKey]);

  useEffect(() => () => window.clearTimeout(savedTimer.current), []);

  // Saves one change straight away. Returns false when it didn't go through.
  const save = async (changes: TaskInput): Promise<boolean> => {
    if (!task) return false;
    setSaveState("saving");
    try {
      const res = await tasksApi.update(projectKey, number, changes, task.version);
      setTask(res.task);
      onChanged(res.task);
      setSaveState("saved");
      window.clearTimeout(savedTimer.current);
      savedTimer.current = window.setTimeout(() => setSaveState("idle"), 1800);
      return true;
    } catch (err) {
      setSaveState("idle");
      const e = err as TaskApiError;
      if (e.code === "VERSION_CONFLICT" && e.task) {
        toast.warning("This task was just changed by someone else", "Its latest version is shown. Make your change again.");
        setTask(e.task);
        onChanged(e.task);
      } else {
        toast.error("Couldn't save the change", e.message);
      }
      return false;
    }
  };

  const handleDelete = async () => {
    if (!task) return;
    try {
      const res = await tasksApi.remove(projectKey, number);
      toast.success("Task deleted", res.message);
      onDeleted(task);
    } catch (err) {
      toast.error("Couldn't delete the task", (err as Error).message);
      throw err;
    }
  };

  const copyLink = async () => {
    try {
      await navigator.clipboard.writeText(`${window.location.origin}/projects/${projectKey}/tasks/${number}`);
      toast.success("Link copied", `Anyone with access to ${projectKey} can open it.`);
    } catch {
      toast.error("Couldn't copy the link", "Copy it from the address bar instead.");
    }
  };

  const key = task?.key ?? `${projectKey}-${number}`;
  const people =
    task?.assignee && !assignees.some((a) => a.id === task.assignee!.id)
      ? [...assignees, { ...task.assignee, role: "MEMBER" as const }]
      : assignees;

  return (
    <Modal
      isOpen
      onClose={onClose}
      maxWidth="6xl"
      title={key}
      eyebrow={
        <span className="text-xs text-zinc-500 dark:text-zinc-400">
          {projectName ?? projectKey} <span aria-hidden="true">/</span>
        </span>
      }
      headerActions={
        <>
          <SaveIndicator state={saveState} />
          <Menu
            label="More actions"
            icon={<MoreHorizontal className="w-4 h-4" />}
            items={[
              { id: "copy", label: "Copy link", icon: <Link2 className="w-3.5 h-3.5" /> },
              ...(perm.canDelete ? [{ id: "delete", label: "Delete task", icon: <Trash2 className="w-3.5 h-3.5 text-destructive-600" /> }] : []),
            ]}
            onSelect={(id) => (id === "copy" ? copyLink() : setDeleteOpen(true))}
          />
        </>
      }
    >
      {error?.code === "NOT_FOUND" ? (
        <Alert variant="warning" title="This task isn't available">
          It was deleted, or you no longer have access to it.
        </Alert>
      ) : !task ? (
        error ? (
          <Alert variant="error" action={<Button size="sm" variant="outline" onClick={load}>Try again</Button>}>
            Couldn't load this task: {error.message}
          </Alert>
        ) : (
          <div className="py-24 flex justify-center">
            <Spinner size="lg" label="Loading task" />
          </div>
        )
      ) : (
        <div className="grid grid-cols-1 lg:grid-cols-[minmax(0,1fr)_19rem] gap-8 lg:gap-10">
          {/* Main column: title, description, activity */}
          <div className="min-w-0 space-y-8 order-2 lg:order-1">
            <InlineTitle value={task.title} editable={perm.canEdit} onSave={(title) => save({ title })} />

            <section aria-labelledby="task-description">
              <h3 id="task-description" className="text-xs font-semibold uppercase tracking-wide text-zinc-500 dark:text-zinc-400 mb-2">
                Description
              </h3>
              <InlineDescription
                value={task.description ?? ""}
                editable={perm.canEdit}
                onSave={(text) => save({ description: text.trim() ? text : null })}
              />
            </section>

            <Comments projectKey={projectKey} number={number} refreshKey={refreshKey} />
          </div>

          {/* Sidebar: status and details */}
          <aside className="order-1 lg:order-2 space-y-5 lg:sticky lg:top-0 self-start" aria-label="Task details">
            {perm.canEdit ? (
              <Select value={task.status} onChange={(v) => v !== task.status && save({ status: v as TaskStatus })} options={statusOptions} />
            ) : (
              <StatusBadge status={task.status} />
            )}

            <div className="border border-zinc-200 dark:border-dark-border">
              <h3 className="px-4 py-2.5 text-xs font-semibold uppercase tracking-wide text-zinc-500 dark:text-zinc-400 border-b border-zinc-200 dark:border-dark-border bg-zinc-50/70 dark:bg-dark-elevated/40">
                Details
              </h3>
              <dl className="p-4 space-y-4 text-sm">
                <Field label="Assignee">
                  {/* Click the name to pick someone else, in place (friends first, with live dots). */}
                  <PersonPicker
                    label="Assignee"
                    people={toPickerPeople(people)}
                    value={task.assignee?.id ?? null}
                    fallback={task.assignee ? { id: task.assignee.id, name: task.assignee.name, avatarPath: task.assignee.avatarPath } : null}
                    currentUserId={user?.id}
                    disabled={!perm.canEdit}
                    onChange={(id) => save({ assigneeId: id })}
                  />
                </Field>

                <Field label="Priority">
                  {perm.canEdit ? (
                    <Select value={task.priority} onChange={(v) => v !== task.priority && save({ priority: v as TaskPriority })} options={priorityOptions} />
                  ) : (
                    <PriorityBadge priority={task.priority} />
                  )}
                </Field>

                <Field label="Due date">
                  {perm.canEdit ? (
                    <>
                      <Input
                        type="date"
                        aria-label="Due date"
                        value={task.dueDate ?? ""}
                        onChange={(e) => e.target.value !== (task.dueDate ?? "") && save({ dueDate: e.target.value || null })}
                        error={isOverdue(task) ? "Overdue" : undefined}
                      />
                      {task.dueDate && (
                        <button
                          type="button"
                          onClick={() => save({ dueDate: null })}
                          className="mt-1.5 text-xs font-medium text-zinc-500 hover:text-zinc-900 dark:hover:text-white cursor-pointer"
                        >
                          Clear due date
                        </button>
                      )}
                    </>
                  ) : task.dueDate ? (
                    <DueDate task={task} className="!text-sm" />
                  ) : (
                    <span className="text-zinc-400">None</span>
                  )}
                </Field>

                <Field label="Reporter">{task.creator ? <Person person={task.creator} /> : <span className="text-zinc-400">Deleted user</span>}</Field>
              </dl>
            </div>

            <dl className="space-y-1 text-xs text-zinc-500 dark:text-zinc-400">
              <div className="flex justify-between gap-3">
                <dt>Created</dt>
                <dd title={formatDate(task.createdAt, true)}>{formatDate(task.createdAt, true)}</dd>
              </div>
              <div className="flex justify-between gap-3">
                <dt>Updated</dt>
                <dd title={formatDate(task.updatedAt, true)}>{formatRelative(task.updatedAt)}</dd>
              </div>
              {task.completedAt && (
                <div className="flex justify-between gap-3">
                  <dt>Completed</dt>
                  <dd>{formatDate(task.completedAt, true)}</dd>
                </div>
              )}
            </dl>

            {!perm.canEdit && (
              <p className="text-xs text-zinc-500 dark:text-zinc-400">
                You can view this task and comment on it. Status is {STATUS_LABELS[task.status]}
                {task.dueDate ? `, due ${formatDay(task.dueDate)}` : ""}.
              </p>
            )}
          </aside>
        </div>
      )}

      {task && (
        <ConfirmDialog
          isOpen={deleteOpen}
          onClose={() => setDeleteOpen(false)}
          onConfirm={handleDelete}
          variant="danger"
          title="Delete task"
          description={`${task.key} “${task.title}” will be deleted. There's no undo in the app.`}
          confirmLabel="Delete task"
        >
          <ConsequenceList
            items={[
              ...(task.commentCount > 0 ? [{ kind: "change" as const, text: `${plural(task.commentCount, "comment")} on it are deleted too` }] : []),
              { kind: "change", text: "It disappears from the board and the list for everyone" },
              { kind: "keep", text: `The number ${task.key}, which is never given to another task` },
            ]}
          />
        </ConfirmDialog>
      )}
    </Modal>
  );
}

function SaveIndicator({ state }: { state: SaveState }) {
  if (state === "idle") return null;
  return (
    <span role="status" className="inline-flex items-center gap-1.5 px-2 text-xs text-zinc-500 dark:text-zinc-400">
      {state === "saving" ? (
        <>
          <Loader2 className="w-3.5 h-3.5 animate-spin" aria-hidden="true" /> Saving…
        </>
      ) : (
        <>
          <Check className="w-3.5 h-3.5 text-success-600" aria-hidden="true" /> Saved
        </>
      )}
    </span>
  );
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div>
      <dt className="text-xs font-medium text-zinc-500 dark:text-zinc-400 mb-1.5">{label}</dt>
      <dd>{children}</dd>
    </div>
  );
}

function Person({ person }: { person: { id: string; name: string; avatarPath: string | null } }) {
  return (
    <span className="flex items-center gap-2 min-w-0">
      <Avatar size="xs" name={person.name} src={person.avatarPath || undefined} colorSeed={person.id} />
      <span className="truncate text-zinc-800 dark:text-zinc-200">{person.name}</span>
    </span>
  );
}

// Click to edit; Enter or leaving the field saves, Escape cancels.
function InlineTitle({ value, editable, onSave }: { value: string; editable: boolean; onSave: (v: string) => Promise<boolean> }) {
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(value);
  useEffect(() => {
    if (!editing) setText(value);
  }, [value, editing]);

  const commit = async () => {
    const next = text.trim();
    if (!next || next === value) {
      setText(value);
      setEditing(false);
      return;
    }
    if (await onSave(next)) setEditing(false);
  };

  const heading = "text-xl sm:text-2xl font-semibold tracking-tight text-zinc-950 dark:text-white break-words";
  if (!editable) return <h2 className={heading}>{value}</h2>;
  if (editing) {
    return (
      <input
        autoFocus
        aria-label="Title"
        value={text}
        maxLength={200}
        onChange={(e) => setText(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            commit();
          } else if (e.key === "Escape") {
            e.stopPropagation();
            setText(value);
            setEditing(false);
          }
        }}
        className={`${heading} w-full bg-white dark:bg-dark-card border border-brand-600 ring-2 ring-brand-600/20 px-2 py-1 -mx-2 focus:outline-none`}
      />
    );
  }
  return (
    <h2>
      <button
        type="button"
        onClick={() => setEditing(true)}
        title="Click to edit the title"
        className={`${heading} w-full text-left px-2 py-1 -mx-2 border border-transparent hover:bg-zinc-50 hover:border-zinc-200 dark:hover:bg-dark-elevated dark:hover:border-dark-border cursor-text`}
      >
        {value}
      </button>
    </h2>
  );
}

function InlineDescription({ value, editable, onSave }: { value: string; editable: boolean; onSave: (v: string) => Promise<boolean> }) {
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(value);
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    if (!editing) setText(value);
  }, [value, editing]);

  const body = "text-sm leading-relaxed text-zinc-700 dark:text-zinc-300 whitespace-pre-wrap break-words";
  if (!editable) return value ? <p className={body}>{value}</p> : <p className="text-sm text-zinc-400">No description.</p>;

  if (editing) {
    return (
      <div
        className="space-y-2"
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            e.stopPropagation();
            setText(value);
            setEditing(false);
          }
        }}
      >
        <Textarea autoFocus aria-label="Description" value={text} onChange={(e) => setText(e.target.value)} rows={8} maxLength={10000} disabled={saving} />
        <div className="flex gap-2">
          <Button
            size="sm"
            isLoading={saving}
            disabled={text === value}
            onClick={async () => {
              setSaving(true);
              const ok = await onSave(text);
              setSaving(false);
              if (ok) setEditing(false);
            }}
          >
            Save
          </Button>
          <Button
            size="sm"
            variant="ghost"
            onClick={() => {
              setText(value);
              setEditing(false);
            }}
          >
            Cancel
          </Button>
        </div>
      </div>
    );
  }
  return (
    <button
      type="button"
      onClick={() => setEditing(true)}
      title="Click to edit the description"
      className="w-full text-left px-3 py-2.5 -mx-3 border border-transparent hover:bg-zinc-50 hover:border-zinc-200 dark:hover:bg-dark-elevated dark:hover:border-dark-border cursor-text min-h-[3rem]"
    >
      {value ? <span className={body}>{value}</span> : <span className="text-sm text-zinc-400">Add a description…</span>}
    </button>
  );
}

// Add, edit own ("edited"), delete own (Org Admins: any); deleted ones leave a placeholder.
// Newest first, with the box to write on top.
function Comments({ projectKey, number, refreshKey }: { projectKey: string; number: number; refreshKey: number }) {
  const toast = useToast();
  const { user } = useAuth();
  const [comments, setComments] = useState<TaskComment[] | null>(null);
  const [body, setBody] = useState("");
  const [focused, setFocused] = useState(false);
  const [posting, setPosting] = useState(false);
  const [editing, setEditing] = useState<{ id: string; body: string } | null>(null);
  const [toDelete, setToDelete] = useState<TaskComment | null>(null);

  const load = useCallback(async () => {
    try {
      setComments((await tasksApi.comments(projectKey, number)).comments);
    } catch {
      setComments((c) => c ?? []);
    }
  }, [projectKey, number]);

  useEffect(() => {
    load();
  }, [load, refreshKey]);

  const post = async (e?: SubmitEvent<HTMLFormElement>) => {
    e?.preventDefault();
    if (!body.trim()) return;
    setPosting(true);
    try {
      const res = await tasksApi.addComment(projectKey, number, body);
      setComments((c) => [...(c ?? []), res.comment]);
      setBody("");
      setFocused(false);
    } catch (err) {
      toast.error("Couldn't add the comment", (err as Error).message);
    } finally {
      setPosting(false);
    }
  };

  const saveEdit = async () => {
    if (!editing || !editing.body.trim()) return;
    try {
      const res = await tasksApi.editComment(editing.id, editing.body);
      setComments((c) => (c ?? []).map((x) => (x.id === res.comment.id ? res.comment : x)));
      setEditing(null);
    } catch (err) {
      toast.error("Couldn't edit the comment", (err as Error).message);
    }
  };

  const remove = async () => {
    if (!toDelete) return;
    try {
      await tasksApi.deleteComment(toDelete.id);
      await load();
    } catch (err) {
      toast.error("Couldn't delete the comment", (err as Error).message);
      throw err;
    }
  };

  const live = comments?.filter((c) => !c.deleted).length ?? 0;
  const myName = user ? `${user.firstName} ${user.lastName}` : "You";

  return (
    <section aria-labelledby="task-activity">
      <h3 id="task-activity" className="text-xs font-semibold uppercase tracking-wide text-zinc-500 dark:text-zinc-400 mb-3">
        Comments {live > 0 && <span className="tabular-nums">({live})</span>}
      </h3>

      <form onSubmit={post} className="flex gap-3 mb-6">
        <Avatar size="sm" name={myName} src={user?.avatarPath || undefined} colorSeed={user?.id} />
        <div className="flex-1 space-y-2">
          <Textarea
            aria-label="Add a comment"
            placeholder="Add a comment…"
            value={body}
            onChange={(e) => setBody(e.target.value)}
            onFocus={() => setFocused(true)}
            onKeyDown={(e) => {
              // Ctrl/Cmd + Enter posts.
              if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) post();
            }}
            rows={focused || body ? 3 : 1}
            maxLength={focused || body ? 5000 : undefined}
            disabled={posting}
          />
          {(focused || body) && (
            <div className="flex items-center gap-2">
              <Button type="submit" size="sm" isLoading={posting} disabled={!body.trim()}>
                Comment
              </Button>
              <Button
                size="sm"
                variant="ghost"
                onClick={() => {
                  setBody("");
                  setFocused(false);
                }}
              >
                Cancel
              </Button>
              <span className="ml-auto text-[11px] text-zinc-400 hidden sm:inline">Ctrl + Enter to post</span>
            </div>
          )}
        </div>
      </form>

      {!comments ? (
        <Spinner label="Loading comments" />
      ) : comments.length === 0 ? (
        <p className="text-sm text-zinc-500 dark:text-zinc-400">No comments yet. Start the conversation.</p>
      ) : (
        <ol className="space-y-5">
          {[...comments].reverse().map((c) => (
            <li key={c.id} className="flex gap-3">
              {c.deleted ? (
                <div className="flex-1 ml-11 px-3 py-2 text-xs italic text-zinc-400 dark:text-zinc-500 border border-dashed border-zinc-200 dark:border-zinc-800">
                  This comment was deleted
                </div>
              ) : (
                <>
                  <Avatar size="sm" name={c.author?.name ?? "Deleted user"} src={c.author?.avatarPath || undefined} colorSeed={c.author?.id} />
                  <div className="flex-1 min-w-0 group">
                    <div className="flex items-center gap-2 text-xs">
                      <span className="font-semibold text-zinc-900 dark:text-white">
                        {c.author?.name ?? "Deleted user"}
                        {c.author?.id === user?.id && <span className="font-normal text-zinc-400"> (you)</span>}
                      </span>
                      <span className="text-zinc-400" title={formatDate(c.createdAt, true)}>
                        {formatRelative(c.createdAt)}
                      </span>
                      {c.edited && (
                        <span className="text-zinc-400" title={c.editedAt ? `Edited ${formatDate(c.editedAt, true)}` : undefined}>
                          · edited
                        </span>
                      )}
                      <span className="ml-auto flex items-center opacity-100 sm:opacity-0 sm:group-hover:opacity-100 sm:group-focus-within:opacity-100 transition-opacity">
                        {c.canEdit && editing?.id !== c.id && (
                          <IconButton label="Edit comment" size="sm" icon={<Pencil className="w-3.5 h-3.5" />} onClick={() => setEditing({ id: c.id, body: c.body ?? "" })} />
                        )}
                        {c.canDelete && <IconButton label="Delete comment" tone="danger" size="sm" icon={<Trash2 className="w-3.5 h-3.5" />} onClick={() => setToDelete(c)} />}
                      </span>
                    </div>
                    {editing?.id === c.id ? (
                      <div className="mt-1.5 space-y-2">
                        <Textarea aria-label="Edit comment" value={editing.body} onChange={(e) => setEditing({ ...editing, body: e.target.value })} rows={3} maxLength={5000} />
                        <div className="flex gap-2">
                          <Button size="sm" onClick={saveEdit} disabled={!editing.body.trim()}>
                            Save
                          </Button>
                          <Button size="sm" variant="ghost" onClick={() => setEditing(null)}>
                            Cancel
                          </Button>
                        </div>
                      </div>
                    ) : (
                      <p className="mt-1 text-sm leading-relaxed text-zinc-700 dark:text-zinc-300 whitespace-pre-wrap break-words">{c.body}</p>
                    )}
                  </div>
                </>
              )}
            </li>
          ))}
        </ol>
      )}

      <ConfirmDialog
        isOpen={Boolean(toDelete)}
        onClose={() => setToDelete(null)}
        onConfirm={remove}
        variant="danger"
        title="Delete comment"
        description="The comment is replaced by “This comment was deleted” for everyone."
        confirmLabel="Delete comment"
      />
    </section>
  );
}
