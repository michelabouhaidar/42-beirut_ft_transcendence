import { MembershipStatus, OrgRole, Prisma, TaskPriority, TaskStatus } from "@prisma/client";
import { prisma } from "../app";
import { AuthContext } from "./auth";
import { withFriendsFirst } from "./friends";
import { OrgError as TaskError } from "./orgs";
import { fromDate, toDate } from "./projects";
import { notify } from "./notifications";
import { emitToProject } from "../realtime/socket";

export { TaskError };

type Tx = Prisma.TransactionClient;

const POSITION_STEP = 65536;
// Below this gap the column is renumbered before inserting (§7.2).
const MIN_GAP = 1e-6;

const userCard = { select: { id: true, firstName: true, lastName: true, avatarPath: true } } as const;
export const taskInclude = {
  creator: userCard,
  assignee: userCard,
  _count: { select: { comments: { where: { deletedAt: null } } } },
} as const;

type TaskRow = Prisma.TaskGetPayload<{ include: typeof taskInclude }>;
type UserCard = { id: string; firstName: string; lastName: string; avatarPath: string | null };

const person = (u: UserCard | null) =>
  u ? { id: u.id, name: `${u.firstName} ${u.lastName}`, avatarPath: u.avatarPath } : null;

export function serializeTask(t: TaskRow, projectKey: string) {
  return {
    id: t.id,
    number: t.number,
    key: `${projectKey}-${t.number}`,
    title: t.title,
    description: t.description,
    status: t.status,
    priority: t.priority,
    position: t.position,
    dueDate: fromDate(t.dueDate),
    version: t.version,
    completedAt: t.completedAt,
    createdAt: t.createdAt,
    updatedAt: t.updatedAt,
    creator: person(t.creator),
    assignee: person(t.assignee),
    commentCount: t._count.comments,
  };
}

// OA, SA and Members with access work on tasks; Viewers only read (§4.3).
export const canEditTasks = (auth: AuthContext) => auth.role !== "VIEWER";

// TSK-10: OA/SA, or the Member who created the task.
export const canDeleteTask = (auth: AuthContext, creatorId: string) =>
  auth.role === "SA" || auth.role === "OA" || (auth.role === "MEMBER" && creatorId === auth.user.id);

export async function findTask(projectId: string, number: number) {
  if (!Number.isInteger(number) || number < 1) throw new TaskError(404, "NOT_FOUND", "Task not found.");
  const task = await prisma.task.findFirst({ where: { projectId, number, deletedAt: null }, include: taskInclude });
  if (!task) throw new TaskError(404, "NOT_FOUND", "Task not found.");
  return task;
}

// TSK-03: an active Org Admin of the org, or an active Member with access to the project.
export async function assertAssignable(orgId: string, projectId: string, userId: string) {
  const m = await prisma.membership.findFirst({
    where: { orgId, userId, status: MembershipStatus.ACTIVE, user: { status: "ACTIVE" } },
    select: { role: true },
  });
  const ok =
    m?.role === OrgRole.OA ||
    (m?.role === OrgRole.MEMBER &&
      Boolean(await prisma.projectAccess.findFirst({ where: { projectId, userId, revokedAt: null }, select: { id: true } })));
  if (!ok) {
    throw new TaskError(400, "INVALID_ASSIGNEE", "The assignee must be an Org Admin or a Member with access to this project.");
  }
}

// People a task can be assigned to, for the assignee pickers and the board filter.
// Friends of the viewer come first, with their online status.
export async function listAssignees(orgId: string, projectId: string, viewerId: string) {
  const rows = await prisma.membership.findMany({
    where: {
      orgId,
      status: MembershipStatus.ACTIVE,
      user: { status: "ACTIVE" },
      OR: [
        { role: OrgRole.OA },
        { role: OrgRole.MEMBER, user: { projectAccesses: { some: { projectId, revokedAt: null } } } },
      ],
    },
    include: { user: userCard },
    orderBy: [{ user: { firstName: "asc" } }, { user: { lastName: "asc" } }],
  });
  return withFriendsFirst(viewerId, rows.map((m) => ({ ...person(m.user)!, role: m.role })));
}

// Done sets completed_at; leaving Done clears it (TSK-02).
function completion(from: TaskStatus | null, to: TaskStatus | undefined) {
  if (!to || to === from) return {};
  return { completedAt: to === TaskStatus.DONE ? new Date() : null };
}

async function columnPositions(tx: Tx, projectId: string, status: TaskStatus, excludeId?: string) {
  return tx.task.findMany({
    where: { projectId, status, deletedAt: null, ...(excludeId ? { id: { not: excludeId } } : {}) },
    select: { id: true, position: true },
    orderBy: [{ position: "asc" }, { number: "asc" }],
  });
}

// Position for a card placed at `index` of a column: midpoint of its neighbours, renumbering the
// column first when the gap is too small (§7.2).
async function positionAt(tx: Tx, projectId: string, status: TaskStatus, index: number, excludeId?: string) {
  let column = await columnPositions(tx, projectId, status, excludeId);
  const i = Math.min(Math.max(index, 0), column.length);
  const gapTooSmall = () => {
    const prev = column[i - 1]?.position;
    const next = column[i]?.position;
    return prev !== undefined && next !== undefined && next - prev < MIN_GAP;
  };
  if (gapTooSmall()) {
    for (const [n, row] of column.entries()) {
      await tx.task.update({ where: { id: row.id }, data: { position: (n + 1) * POSITION_STEP } });
    }
    column = await columnPositions(tx, projectId, status, excludeId);
  }
  const prev = column[i - 1]?.position;
  const next = column[i]?.position;
  if (prev !== undefined && next !== undefined) return (prev + next) / 2;
  if (prev !== undefined) return prev + POSITION_STEP;
  if (next !== undefined) return next / 2;
  return POSITION_STEP;
}

// What every task notification carries (§6.9): enough to word it and link it without a join.
function taskParams(t: { number: number; title: string }, projectKey: string) {
  return { projectKey, number: t.number, title: t.title };
}

const fullName = (u: UserCard | null) => (u ? `${u.firstName} ${u.lastName}` : null);

export interface TaskInput {
  title?: string;
  description?: string | null;
  status?: TaskStatus;
  priority?: TaskPriority;
  dueDate?: string | null;
  assigneeId?: string | null;
}

// TSK-01: the number comes from the project's counter in the same transaction (§7.3); never reused.
export async function createTask(
  project: { id: string; orgId: string; key: string },
  actorId: string,
  input: TaskInput & { title: string }
) {
  if (input.assigneeId) await assertAssignable(project.orgId, project.id, input.assigneeId);
  const status = input.status ?? TaskStatus.TODO;
  const task = await prisma.$transaction(async (tx) => {
    const [{ task_counter: number }] = await tx.$queryRaw<{ task_counter: number }[]>`
      UPDATE project SET task_counter = task_counter + 1, updated_at = now() WHERE id = ${project.id}::uuid RETURNING task_counter`;
    const position = await positionAt(tx, project.id, status, Number.MAX_SAFE_INTEGER);
    const task = await tx.task.create({
      data: {
        projectId: project.id,
        number,
        title: input.title,
        description: input.description?.trim() ? input.description : null,
        status,
        priority: input.priority ?? TaskPriority.MEDIUM,
        dueDate: toDate(input.dueDate) ?? null,
        assigneeId: input.assigneeId ?? null,
        creatorId: actorId,
        position,
        completedAt: status === TaskStatus.DONE ? new Date() : null,
      },
      include: taskInclude,
    });
    return task;
  });
  emitTaskEvent(project.id, "task:created", task);
  await notify("task.created", { kind: "task", id: task.id, projectId: project.id, creatorId: actorId, assigneeId: task.assigneeId }, actorId, {
    ...taskParams(task, project.key),
    assigneeId: task.assigneeId,
    assigneeName: fullName(task.assignee),
  });
  return task;
}

// Version check (§7.2): the update only applies to the version the client saw; otherwise 409 + current task.
async function conflict(taskId: string, projectKey: string): Promise<never> {
  const current = await prisma.task.findFirst({ where: { id: taskId, deletedAt: null }, include: taskInclude });
  if (!current) throw new TaskError(404, "NOT_FOUND", "Task not found.");
  const err = new TaskError(409, "VERSION_CONFLICT", "This task was just changed by someone else.");
  (err as TaskError & { task?: unknown }).task = serializeTask(current, projectKey);
  throw err;
}

// TSK-04
export async function updateTask(
  project: { id: string; orgId: string; key: string },
  task: TaskRow,
  actorId: string,
  input: TaskInput,
  version: number
) {
  if (input.assigneeId) await assertAssignable(project.orgId, project.id, input.assigneeId);
  const statusChanged = input.status !== undefined && input.status !== task.status;

  const updated = await prisma.$transaction(async (tx) => {
    const position = statusChanged ? await positionAt(tx, project.id, input.status!, Number.MAX_SAFE_INTEGER, task.id) : undefined;
    const r = await tx.task.updateMany({
      where: { id: task.id, version, deletedAt: null },
      data: {
        ...(input.title !== undefined ? { title: input.title } : {}),
        ...(input.description !== undefined ? { description: input.description?.trim() ? input.description : null } : {}),
        ...(input.status !== undefined ? { status: input.status } : {}),
        ...(input.priority !== undefined ? { priority: input.priority } : {}),
        ...(input.dueDate !== undefined ? { dueDate: toDate(input.dueDate) ?? null } : {}),
        ...(input.assigneeId !== undefined ? { assigneeId: input.assigneeId } : {}),
        ...(position !== undefined ? { position } : {}),
        ...completion(task.status, input.status),
        version: { increment: 1 },
      },
    });
    if (r.count === 0) return null;
    return tx.task.findUniqueOrThrow({ where: { id: task.id }, include: taskInclude });
  });
  if (!updated) return conflict(task.id, project.key);
  emitTaskEvent(project.id, "task:updated", updated);
  await notifyTaskChanges(project, task, updated, actorId);
  return updated;
}

// TSK-03/04 (§6.9): a new assignee is its own notification; other edits are "moved" when only the
// column changed, "edited" otherwise. Saving without a real change tells nobody.
async function notifyTaskChanges(project: { id: string; key: string }, before: TaskRow, after: TaskRow, actorId: string) {
  const resource = { kind: "task" as const, id: after.id, projectId: project.id, creatorId: after.creatorId, assigneeId: after.assigneeId };
  const params = taskParams(after, project.key);

  if (before.assigneeId !== after.assigneeId) {
    await notify("task.assigned", { ...resource, previousAssigneeId: before.assigneeId }, actorId, {
      ...params,
      assigneeId: after.assigneeId,
      assigneeName: fullName(after.assignee),
      previousAssigneeId: before.assigneeId,
      previousAssigneeName: fullName(before.assignee),
    });
  }

  const fields = (
    [
      ["title", before.title !== after.title],
      ["description", before.description !== after.description],
      ["status", before.status !== after.status],
      ["priority", before.priority !== after.priority],
      ["dueDate", fromDate(before.dueDate) !== fromDate(after.dueDate)],
    ] as const
  )
    .filter(([, changed]) => changed)
    .map(([field]) => field);
  if (!fields.length) return;
  if (fields.length === 1 && fields[0] === "status") {
    await notify("task.moved", resource, actorId, { ...params, from: before.status, status: after.status });
  } else {
    await notify("task.updated", resource, actorId, { ...params, fields: [...fields] });
  }
}

// TSK-06: drag and drop or "Move to…": new column and place, version-checked.
export async function moveTask(
  project: { id: string; key: string },
  task: TaskRow,
  actorId: string,
  status: TaskStatus,
  index: number,
  version: number
) {
  const updated = await prisma.$transaction(async (tx) => {
    const position = await positionAt(tx, project.id, status, index, task.id);
    const r = await tx.task.updateMany({
      where: { id: task.id, version, deletedAt: null },
      data: { status, position, ...completion(task.status, status), version: { increment: 1 } },
    });
    if (r.count === 0) return null;
    return tx.task.findUniqueOrThrow({ where: { id: task.id }, include: taskInclude });
  });
  if (!updated) return conflict(task.id, project.key);
  emitTaskEvent(project.id, "task:updated", updated);
  // Reordering inside a column isn't news; changing column is (§6.9 "moved").
  if (task.status !== status) await notifyTaskChanges(project, task, updated, actorId);
  return updated;
}

// TSK-10: soft delete with its comments.
export async function deleteTask(project: { id: string; key: string }, task: TaskRow, actorId: string) {
  const now = new Date();
  await prisma.$transaction(async (tx) => {
    await tx.comment.updateMany({ where: { taskId: task.id, deletedAt: null }, data: { deletedAt: now, deletedById: actorId } });
    await tx.task.update({ where: { id: task.id }, data: { deletedAt: now, deletedById: actorId } });
  });
  emitTaskEvent(project.id, "task:deleted", { ...task, version: task.version + 1 });
  await notify(
    "task.deleted",
    { kind: "task", id: task.id, projectId: project.id, creatorId: task.creatorId, assigneeId: task.assigneeId },
    actorId,
    taskParams(task, project.key)
  );
}

// TSK-07 / RT-02: everyone with the board open hears about a change. Events carry the version
// so a client that already has a newer copy ignores a late one (§7.2).
export function emitTaskEvent(projectId: string, event: "task:created" | "task:updated" | "task:deleted", t: { id: string; number: number; version: number }) {
  emitToProject(projectId, event, { id: t.id, number: t.number, version: t.version });
}

// --- Comments (TSK-11) ----------------------------------------------------------------------------

export function serializeComment(c: {
  id: string;
  body: string;
  editedAt: Date | null;
  createdAt: Date;
  deletedAt: Date | null;
  author: UserCard;
}) {
  const deleted = Boolean(c.deletedAt);
  return {
    id: c.id,
    // A deleted comment keeps its place in the thread but not its text.
    body: deleted ? null : c.body,
    deleted,
    edited: Boolean(c.editedAt) && !deleted,
    editedAt: deleted ? null : c.editedAt,
    createdAt: c.createdAt,
    author: person(c.author),
  };
}

export const commentInclude = { author: userCard } as const;

// OA, Members and Viewers with access can comment (TSK-11 as amended); the project check happens first.
export function canDeleteComment(auth: AuthContext, authorId: string) {
  return auth.role === "SA" || auth.role === "OA" || authorId === auth.user.id;
}
