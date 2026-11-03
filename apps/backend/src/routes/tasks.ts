import { Router, Request, Response } from "express";
import { TaskPriority, TaskStatus } from "@prisma/client";
import { prisma } from "../app";
import { AuthContext, requireAuth } from "../services/auth";
import { CommentSchema, CreateTaskSchema, MoveTaskSchema, UpdateTaskSchema } from "../schemas";
import { hasProjectAccess } from "../services/projects";
import { notify } from "../services/notifications";
import { emitToProject } from "../realtime/socket";
import { isRefusal, refuse } from "../services/refusal";
import {
  TaskError,
  canDeleteComment,
  canDeleteTask,
  canEditTasks,
  commentInclude,
  createTask,
  deleteTask,
  findTask,
  listAssignees,
  moveTask,
  serializeComment,
  serializeTask,
  taskInclude,
  updateTask,
} from "../services/tasks";
import { loadProject } from "./projects";

// Tasks, board and comments (spec §6.8 TSK-01…11, API §12). Every route runs the project check first:
// authenticated → org scope → project access → role (§7.7).
export const tasksRouter = Router();

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function sendError(res: Response, err: unknown, fallback: string) {
  if (err instanceof TaskError) {
    const task = (err as TaskError & { task?: unknown }).task;
    if (isRefusal(err.status)) return refuse(res, err.code, err.message, task ? { task } : {});
    return res.status(err.status).json({ error: { code: err.code, message: err.message }, ...(task ? { task } : {}) });
  }
  console.error(`[Tasks] ${fallback}:`, err);
  return res.status(500).json({ error: { code: "INTERNAL_ERROR", message: fallback } });
}

const validationError = (res: Response, message: string) => res.status(200).json({ ok: false, error: { code: "VALIDATION_ERROR", message } });
const forbidden = (res: Response, message: string) => res.status(200).json({ ok: false, error: { code: "FORBIDDEN", message } });

async function loadTask(req: Request, res: Response, auth: AuthContext) {
  const found = await loadProject(req, res, auth, false);
  if (!found) return null;
  try {
    const task = await findTask(found.project.id, Number(req.params.n));
    return { ...found, task };
  } catch (err) {
    sendError(res, err, "Failed to load the task.");
    return null;
  }
}

// TSK-05 / TSK-08: every task of the project, in board order.
tasksRouter.get("/projects/:key/tasks", async (req: Request, res: Response) => {
  const auth = await requireAuth(req, res);
  if (!auth) return;
  const found = await loadProject(req, res, auth, false);
  if (!found) return;
  try {
    const tasks = await prisma.task.findMany({
      where: { projectId: found.project.id, deletedAt: null },
      include: taskInclude,
      orderBy: [{ position: "asc" }, { number: "asc" }],
    });
    return res.status(200).json({ tasks: tasks.map((t) => serializeTask(t, found.project.key)) });
  } catch (err) {
    return sendError(res, err, "Failed to load tasks.");
  }
});

// Who can be assigned (TSK-03); also feeds the board's assignee filter.
tasksRouter.get("/projects/:key/assignees", async (req: Request, res: Response) => {
  const auth = await requireAuth(req, res);
  if (!auth) return;
  const found = await loadProject(req, res, auth, false);
  if (!found) return;
  try {
    return res.status(200).json({ assignees: await listAssignees(found.orgId, found.project.id, auth.user.id) });
  } catch (err) {
    return sendError(res, err, "Failed to load assignees.");
  }
});

// TSK-01
tasksRouter.post("/projects/:key/tasks", async (req: Request, res: Response) => {
  const auth = await requireAuth(req, res);
  if (!auth) return;
  const found = await loadProject(req, res, auth, false);
  if (!found) return;
  if (!canEditTasks(auth)) return forbidden(res, "Viewers can't create tasks.");
  const body = req.body ?? {};
  const parsed = CreateTaskSchema.safeParse(body);
  if (!parsed.success) return validationError(res, parsed.error.errors[0]?.message || "Invalid task.");
  try {
    const task = await createTask({ ...found.project, orgId: found.orgId }, auth.user.id, {
      ...parsed.data,
      status: parsed.data.status as TaskStatus | undefined,
      priority: parsed.data.priority as TaskPriority | undefined,
    });
    return res.status(201).json({ message: `${found.project.key}-${task.number} created.`, task: serializeTask(task, found.project.key) });
  } catch (err) {
    return sendError(res, err, "Failed to create the task.");
  }
});

// TSK-09
tasksRouter.get("/projects/:key/tasks/:n", async (req: Request, res: Response) => {
  const auth = await requireAuth(req, res);
  if (!auth) return;
  const found = await loadTask(req, res, auth);
  if (!found) return;
  return res.status(200).json({
    task: serializeTask(found.task, found.project.key),
    canEdit: canEditTasks(auth),
    canDelete: canDeleteTask(auth, found.task.creatorId),
  });
});

// TSK-04: version-checked (§7.2).
tasksRouter.patch("/projects/:key/tasks/:n", async (req: Request, res: Response) => {
  const auth = await requireAuth(req, res);
  if (!auth) return;
  const found = await loadTask(req, res, auth);
  if (!found) return;
  if (!canEditTasks(auth)) return forbidden(res, "Viewers can't edit tasks.");
  const body = req.body ?? {};
  const parsed = UpdateTaskSchema.safeParse(body);
  if (!parsed.success) return validationError(res, parsed.error.errors[0]?.message || "Invalid task.");
  const { version, ...fields } = parsed.data;
  try {
    const task = await updateTask(
      { ...found.project, orgId: found.orgId },
      found.task,
      auth.user.id,
      { ...fields, status: fields.status as TaskStatus | undefined, priority: fields.priority as TaskPriority | undefined },
      version
    );
    return res.status(200).json({ message: "Task updated.", task: serializeTask(task, found.project.key) });
  } catch (err) {
    return sendError(res, err, "Failed to update the task.");
  }
});

// TSK-06
tasksRouter.post("/projects/:key/tasks/:n/move", async (req: Request, res: Response) => {
  const auth = await requireAuth(req, res);
  if (!auth) return;
  const found = await loadTask(req, res, auth);
  if (!found) return;
  if (!canEditTasks(auth)) return forbidden(res, "Viewers can't move tasks.");
  const body = req.body ?? {};
  const parsed = MoveTaskSchema.safeParse(body);
  if (!parsed.success) return validationError(res, parsed.error.errors[0]?.message || "Invalid move.");
  try {
    const task = await moveTask(found.project, found.task, auth.user.id, parsed.data.status as TaskStatus, parsed.data.index, parsed.data.version);
    return res.status(200).json({ task: serializeTask(task, found.project.key) });
  } catch (err) {
    return sendError(res, err, "Failed to move the task.");
  }
});

// TSK-10
tasksRouter.delete("/projects/:key/tasks/:n", async (req: Request, res: Response) => {
  const auth = await requireAuth(req, res);
  if (!auth) return;
  const found = await loadTask(req, res, auth);
  if (!found) return;
  if (!canDeleteTask(auth, found.task.creatorId)) {
    return forbidden(res, "Only Org Admins or the Member who created this task can delete it.");
  }
  try {
    await deleteTask(found.project, found.task, auth.user.id);
    return res.status(200).json({ message: `${found.project.key}-${found.task.number} deleted.` });
  } catch (err) {
    return sendError(res, err, "Failed to delete the task.");
  }
});

// TSK-11: comments in order; deleted ones stay as placeholders.
tasksRouter.get("/projects/:key/tasks/:n/comments", async (req: Request, res: Response) => {
  const auth = await requireAuth(req, res);
  if (!auth) return;
  const found = await loadTask(req, res, auth);
  if (!found) return;
  try {
    const comments = await prisma.comment.findMany({
      where: { taskId: found.task.id },
      include: commentInclude,
      orderBy: { createdAt: "asc" },
    });
    return res.status(200).json({
      comments: comments.map((c) => ({
        ...serializeComment(c),
        canEdit: !c.deletedAt && c.authorId === auth.user.id,
        canDelete: !c.deletedAt && canDeleteComment(auth, c.authorId),
      })),
    });
  } catch (err) {
    return sendError(res, err, "Failed to load comments.");
  }
});

tasksRouter.post("/projects/:key/tasks/:n/comments", async (req: Request, res: Response) => {
  const auth = await requireAuth(req, res);
  if (!auth) return;
  const found = await loadTask(req, res, auth);
  if (!found) return;
  const body = req.body ?? {};
  const parsed = CommentSchema.safeParse(body);
  if (!parsed.success) return validationError(res, parsed.error.errors[0]?.message || "Invalid comment.");
  try {
    const comment = await prisma.comment.create({
      data: { taskId: found.task.id, authorId: auth.user.id, body: parsed.data.body },
      include: commentInclude,
    });
    emitToProject(found.project.id, "comment:created", { id: comment.id, taskId: found.task.id, number: found.task.number });
    await notify("comment.created", { kind: "comment", id: comment.id, taskId: found.task.id, authorId: auth.user.id }, auth.user.id, {
      projectKey: found.project.key,
      number: found.task.number,
      title: found.task.title,
    });
    return res.status(201).json({ comment: { ...serializeComment(comment), canEdit: true, canDelete: true } });
  } catch (err) {
    return sendError(res, err, "Failed to add the comment.");
  }
});

// A comment is reached through its task's project, with the same checks as the task (§7.7).
async function loadComment(req: Request, res: Response, auth: AuthContext) {
  if (!UUID_RE.test(req.params.id)) {
    res.status(200).json({ ok: false, error: { code: "NOT_FOUND", message: "Comment not found." } });
    return null;
  }
  const comment = await prisma.comment.findFirst({
    where: { id: req.params.id, deletedAt: null, task: { deletedAt: null, project: { deletedAt: null } } },
    include: {
      ...commentInclude,
      task: { select: { id: true, number: true, title: true, project: { select: { id: true, orgId: true, key: true } } } },
    },
  });
  const project = comment?.task.project;
  const inScope = project && auth.organization?.id === project.orgId && (await hasProjectAccess(auth, project.id));
  if (!comment || !inScope) {
    res.status(200).json({ ok: false, error: { code: "NOT_FOUND", message: "Comment not found." } });
    return null;
  }
  return comment;
}

const commentParams = (c: NonNullable<Awaited<ReturnType<typeof loadComment>>>) => ({
  projectKey: c.task.project.key,
  number: c.task.number,
  title: c.task.title,
});

tasksRouter.patch("/comments/:id", async (req: Request, res: Response) => {
  const auth = await requireAuth(req, res);
  if (!auth) return;
  const comment = await loadComment(req, res, auth);
  if (!comment) return;
  if (comment.authorId !== auth.user.id) return forbidden(res, "You can only edit your own comments.");
  const parsed = CommentSchema.safeParse(req.body ?? {});
  if (!parsed.success) return validationError(res, parsed.error.errors[0]?.message || "Invalid comment.");
  try {
    const updated = await prisma.comment.update({
      where: { id: comment.id },
      data: { body: parsed.data.body, editedAt: new Date() },
      include: commentInclude,
    });
    emitToProject(comment.task.project.id, "comment:updated", { id: comment.id, taskId: comment.task.id, number: comment.task.number });
    await notify("comment.updated", { kind: "comment", id: comment.id, taskId: comment.task.id, authorId: comment.authorId }, auth.user.id, commentParams(comment));
    return res.status(200).json({ comment: { ...serializeComment(updated), canEdit: true, canDelete: true } });
  } catch (err) {
    return sendError(res, err, "Failed to edit the comment.");
  }
});

tasksRouter.delete("/comments/:id", async (req: Request, res: Response) => {
  const auth = await requireAuth(req, res);
  if (!auth) return;
  const comment = await loadComment(req, res, auth);
  if (!comment) return;
  if (!canDeleteComment(auth, comment.authorId)) return forbidden(res, "You can only delete your own comments.");
  try {
    await prisma.comment.update({ where: { id: comment.id }, data: { deletedAt: new Date(), deletedById: auth.user.id } });
    emitToProject(comment.task.project.id, "comment:deleted", { id: comment.id, taskId: comment.task.id, number: comment.task.number });
    // Only the author hears about it, and only when someone else (an admin) deleted it.
    await notify("comment.deleted", { kind: "comment", id: comment.id, taskId: comment.task.id, authorId: comment.authorId }, auth.user.id, commentParams(comment));
    return res.status(200).json({ message: "Comment deleted." });
  } catch (err) {
    return sendError(res, err, "Failed to delete the comment.");
  }
});
