import { ReactNode, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { CalendarDays, FolderX, KanbanSquare, List, Plus, Search, Settings } from "lucide-react";
import { Project, ProjectApiError, projectsApi } from "../api/projects";
import { Assignee, Task, TaskApiError, TaskStatus, tasksApi } from "../api/tasks";
import { useAuth } from "../context/AuthContext";
import { Button, EmptyState, ErrorPage, Input, LoadError, Loading, Select, Tabs, useToast } from "../components";
import { AppLayout } from "./AppLayout";
import { useApp } from "../context/AppContext";
import { ProjectProgress } from "./projects/projectUi";
import { BoardView } from "./projects/BoardView";
import { ListView } from "./projects/ListView";
import { TaskPanel } from "./projects/TaskPanel";
import { CreateTaskDialog, PRIORITY_LABELS, PRIORITIES, UNASSIGNED, applyPresence, personOption, toPickerPeople, useProjectLive } from "./projects/taskUi";
import { useSocketEvent } from "../context/RealtimeContext";
import type { PresenceUpdate } from "../api/users";
import { formatDay } from "../lib/format";

export type ProjectView = "board" | "list";

interface ProjectPageProps {
  projectKey: string;
  view: ProjectView;
  // Task opened by URL /projects/:key/tasks/:n
  taskNumber?: number;
}

const ALL = "__all__";
const ME = "__me__";
const FRIENDS = "__friends__";

// /projects/:key/board and /projects/:key/list.
// The last view is remembered so a task opened by URL returns to it.
const VIEW_KEY = "trenno-project-view";
const rememberedView = (): ProjectView => {
  try {
    return localStorage.getItem(VIEW_KEY) === "list" ? "list" : "board";
  } catch {
    return "board";
  }
};

export function ProjectPage({ projectKey, view: routeView, taskNumber }: ProjectPageProps) {
  const toast = useToast();
  const { navigate } = useApp();
  const { user } = useAuth();
  const view = taskNumber ? rememberedView() : routeView;
  const [project, setProject] = useState<Project | null>(null);
  const [canManage, setCanManage] = useState(false);
  const [canEditTasks, setCanEditTasks] = useState(false);
  const [tasks, setTasks] = useState<Task[] | null>(null);
  const [assignees, setAssignees] = useState<Assignee[]>([]);
  const [error, setError] = useState<ProjectApiError | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);
  const [createIn, setCreateIn] = useState<TaskStatus | null>(null);

  const [query, setQuery] = useState("");
  const [assigneeFilter, setAssigneeFilter] = useState(ALL);
  const [priorityFilter, setPriorityFilter] = useState(ALL);

  useEffect(() => {
    if (!taskNumber) {
      try {
        localStorage.setItem(VIEW_KEY, routeView);
      } catch {
        // Storage unavailable: the board is the default.
      }
    }
  }, [routeView, taskNumber]);

  const load = useCallback(async () => {
    try {
      const [p, t, a] = await Promise.all([projectsApi.get(projectKey), tasksApi.list(projectKey), tasksApi.assignees(projectKey)]);
      setProject(p.project);
      setCanManage(p.canManage);
      setCanEditTasks(p.canEditTasks);
      setTasks(t.tasks);
      setAssignees(a.assignees);
      setError(null);
    } catch (err) {
      setError(err as ProjectApiError);
    }
  }, [projectKey]);

  useEffect(() => {
    load();
  }, [load]);

  // Other people's changes arrive over the socket; the open panel refreshes too.
  // An update we already hold at that version (usually our own) is ignored.
  const tasksRef = useRef(tasks);
  tasksRef.current = tasks;
  useProjectLive(
    projectKey,
    (events) => {
      const stale = events.every((e) => {
        if (e.event !== "task:updated" || e.payload.version === undefined) return false;
        const mine = tasksRef.current?.find((t) => t.id === e.payload.id);
        return Boolean(mine && mine.version >= e.payload.version);
      });
      if (stale) return;
      load();
      setRefreshKey((k) => k + 1);
    },
    !error || (error.code !== "NOT_FOUND" && error.code !== "PROJECT_DELETED")
  );

  const replaceTask = (task: Task) => setTasks((ts) => (ts ?? []).map((t) => (t.id === task.id ? task : t)));

  // Friends' online dots in pickers, filters and on cards follow presence live.
  useSocketEvent<PresenceUpdate>("presence:update", (u) => setAssignees((a) => applyPresence(a, u)));
  // Becoming or stopping being friends reorders the pickers.
  useSocketEvent("friendship:updated", () => tasksApi.assignees(projectKey).then((r) => setAssignees(r.assignees)).catch(() => {}));
  const people = useMemo(() => toPickerPeople(assignees), [assignees]);
  const friendIds = useMemo(() => new Set(assignees.filter((a) => a.isFriend).map((a) => a.id)), [assignees]);

  // A version conflict means someone else changed the task first; either way the board reloads.
  const failed = (err: unknown, what: string) => {
    const e = err as TaskApiError;
    if (e.code === "VERSION_CONFLICT") toast.warning("This task was just changed by someone else", "The board has been refreshed.");
    else toast.error(what, e.message);
    load();
  };

  // Click the assignee on a card or row and pick someone else, version-checked.
  const handleAssign = async (task: Task, assigneeId: string | null) => {
    replaceTask({ ...task, assignee: assigneeId ? assignees.find((a) => a.id === assigneeId) ?? null : null });
    try {
      replaceTask((await tasksApi.update(projectKey, task.number, { assigneeId }, task.version)).task);
    } catch (err) {
      failed(err, "Couldn't change the assignee");
    }
  };

  const handleMove = async (task: Task, status: TaskStatus, index: number) => {
    try {
      replaceTask((await tasksApi.move(projectKey, task.number, status, index, task.version)).task);
      load();
    } catch (err) {
      failed(err, "Couldn't move the task");
    }
  };

  const openTask = (task: Task) => navigate(`/projects/${projectKey}/tasks/${task.number}`);
  const closeTask = () => navigate(`/projects/${projectKey}/${view}`);

  const visibleTasks = useMemo(() => {
    const q = query.trim().toLowerCase();
    return (tasks ?? []).filter((t) => {
      if (q && !t.title.toLowerCase().includes(q) && !t.key.toLowerCase().includes(q) && !(t.description ?? "").toLowerCase().includes(q)) return false;
      if (assigneeFilter === ME && t.assignee?.id !== user?.id) return false;
      if (assigneeFilter === UNASSIGNED && t.assignee) return false;
      if (assigneeFilter === FRIENDS && !(t.assignee && friendIds.has(t.assignee.id))) return false;
      if (![ALL, ME, UNASSIGNED, FRIENDS].includes(assigneeFilter) && t.assignee?.id !== assigneeFilter) return false;
      if (priorityFilter !== ALL && t.priority !== priorityFilter) return false;
      return true;
    });
  }, [tasks, query, assigneeFilter, priorityFilter, user?.id, friendIds]);
  const visibleIds = useMemo(() => new Set(visibleTasks.map((t) => t.id)), [visibleTasks]);
  const filtering = query.trim() !== "" || assigneeFilter !== ALL || priorityFilter !== ALL;

  const layout = (children: ReactNode) => <AppLayout>{children}</AppLayout>;

  if (error?.code === "PROJECT_DELETED") {
    return layout(
      <EmptyState
        icon={<FolderX className="w-6 h-6" />}
        title="This project was deleted"
        description={`${projectKey} and its tasks are no longer available.`}
        action={{ label: "Back to projects", onClick: () => navigate("/projects") }}
      />
    );
  }

  if (error?.code === "NOT_FOUND") {
    return (
      <ErrorPage
        code="404"
        title="Project not found"
        message="This project doesn't exist, or you don't have access to it."
        home="/projects"
      />
    );
  }

  if (!project || !tasks) {
    return layout(
      error ? <LoadError what="this project" message={error.message} onRetry={load} /> : <Loading label="Loading project" />
    );
  }

  return layout(
    <>
      <div className="flex flex-col lg:flex-row lg:items-start justify-between gap-6">
        <div className="min-w-0 max-w-prose">
          <div className="flex items-center gap-2 text-xs text-zinc-500 dark:text-zinc-400">
            <button type="button" onClick={() => navigate("/projects")} className="hover:text-brand-600 dark:hover:text-brand-400 cursor-pointer">
              Projects
            </button>
            <span aria-hidden="true">/</span>
            <code className="font-semibold text-brand-700 dark:text-brand-300">{project.key}</code>
          </div>
          <h1 className="mt-2 text-2xl font-bold tracking-tight text-zinc-950 dark:text-white break-words">{project.name}</h1>
          {project.description && (
            <p className="text-sm leading-relaxed text-zinc-600 dark:text-zinc-300 mt-2 whitespace-pre-line">{project.description}</p>
          )}
          <p className="mt-3 inline-flex items-center gap-1.5 text-xs text-zinc-500 dark:text-zinc-400">
            <CalendarDays className="w-3.5 h-3.5" aria-hidden="true" />
            Start {formatDay(project.startDate)} · Target {formatDay(project.targetDate)}
          </p>
        </div>
        <div className="flex flex-col gap-3 lg:items-end shrink-0">
          <div className="flex flex-wrap gap-2">
            {canManage && (
              <Button variant="outline" onClick={() => navigate(`/projects/${project.key}/settings`)} leftIcon={<Settings className="w-4 h-4" />}>
                Project settings
              </Button>
            )}
            {canEditTasks && (
              <Button onClick={() => setCreateIn("TODO")} leftIcon={<Plus className="w-4 h-4" />}>
                New task
              </Button>
            )}
          </div>
          <ProjectProgress project={project} className="w-full sm:w-80" />
        </div>
      </div>

      <div className="space-y-4">
        <div className="flex flex-col xl:flex-row xl:items-end justify-between gap-3">
          <Tabs
            activeTab={view}
            onChange={(id) => navigate(`/projects/${project.key}/${id}`)}
            tabs={[
              { id: "board", label: "Board", icon: <KanbanSquare className="w-4 h-4" /> },
              { id: "list", label: "List", icon: <List className="w-4 h-4" />, count: tasks.length },
            ]}
          />
          <div className="grid grid-cols-1 sm:grid-cols-[minmax(0,16rem)_12rem_10rem] gap-2" role="search" aria-label="Filter tasks">
            <Input
              type="search"
              aria-label="Filter by text"
              placeholder="Filter by text or key…"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              leftIcon={<Search className="w-3.5 h-3.5" />}
            />
            <Select
              value={assigneeFilter}
              onChange={setAssigneeFilter}
              options={[
                { value: ALL, label: "All assignees" },
                { value: ME, label: "Assigned to me" },
                { value: FRIENDS, label: "My friends' tasks", description: friendIds.size ? undefined : "You have no friends here yet" },
                { value: UNASSIGNED, label: "Unassigned" },
                ...assignees.map(personOption),
              ]}
            />
            <Select
              value={priorityFilter}
              onChange={setPriorityFilter}
              options={[{ value: ALL, label: "All priorities" }, ...PRIORITIES.map((p) => ({ value: p, label: PRIORITY_LABELS[p] }))]}
            />
          </div>
        </div>

        {filtering && (
          <p className="text-xs text-zinc-500 dark:text-zinc-400">
            Showing {visibleTasks.length} of {tasks.length} tasks.{" "}
            <button
              type="button"
              className="font-medium text-brand-600 dark:text-brand-400 hover:underline cursor-pointer"
              onClick={() => {
                setQuery("");
                setAssigneeFilter(ALL);
                setPriorityFilter(ALL);
              }}
            >
              Clear filters
            </button>
          </p>
        )}

        {tasks.length === 0 ? (
          <EmptyState
            icon={<KanbanSquare className="w-6 h-6" />}
            title="No tasks yet"
            description={canEditTasks ? "Create the first task to get the board going." : "Tasks appear here once the team adds them."}
            action={canEditTasks ? { label: "New task", onClick: () => setCreateIn("TODO"), icon: <Plus className="w-3.5 h-3.5" /> } : undefined}
          />
        ) : view === "board" ? (
          <BoardView
            tasks={tasks}
            visible={visibleIds}
            canEdit={canEditTasks}
            onOpen={openTask}
            onMove={handleMove}
            onCreateIn={setCreateIn}
            people={people}
            currentUserId={user?.id}
            onAssign={handleAssign}
          />
        ) : visibleTasks.length === 0 ? (
          <EmptyState icon={<Search className="w-6 h-6" />} title="No matching tasks" description="Try other filters." />
        ) : (
          <ListView
            tasks={visibleTasks}
            onOpen={openTask}
            people={people}
            currentUserId={user?.id}
            onAssign={canEditTasks ? handleAssign : undefined}
          />
        )}
      </div>

      <CreateTaskDialog
        isOpen={createIn !== null}
        initialStatus={createIn ?? "TODO"}
        projectKey={project.key}
        assignees={assignees}
        onClose={() => setCreateIn(null)}
        onCreated={(task) => {
          setCreateIn(null);
          setTasks((ts) => [...(ts ?? []), task]);
          load();
        }}
      />

      {taskNumber && (
        <TaskPanel
          key={taskNumber}
          projectKey={project.key}
          projectName={project.name}
          number={taskNumber}
          assignees={assignees}
          refreshKey={refreshKey}
          onClose={closeTask}
          onChanged={(task) => {
            replaceTask(task);
            load();
          }}
          onDeleted={() => {
            closeTask();
            load();
          }}
        />
      )}
    </>
  );
}
