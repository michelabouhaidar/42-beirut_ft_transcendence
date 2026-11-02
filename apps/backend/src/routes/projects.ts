import { Router, Request, Response } from "express";
import { prisma } from "../app";
import { AuthContext, requireAuth } from "../services/auth";
import { CreateProjectSchema, PROJECT_KEY_RE, UpdateProjectSchema } from "../schemas";
import {
  ProjectError,
  assertProjectUnique,
  canManageProjects,
  deleteProject,
  findProject,
  grantAccess,
  hasProjectAccess,
  projectAccessList,
  projectStats,
  resolveOrgScope,
  revokeAccess,
  serializeProject,
  toDate,
  uniqueViolation,
} from "../services/projects";
import { notify, projectAudience } from "../services/notifications";
import { closeProjectRoom, emitToOrg, emitToProject, emitToUser, leaveProjectRoom } from "../realtime/socket";

// Projects and project access (spec §6.7 PRJ-01…05, API §12: /projects, /projects/:key, /projects/:key/access).
// A System Admin has no org of their own and passes ?orgId= (or orgId in the body) to act on one.
export const projectsRouter = Router();

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function sendError(res: Response, err: unknown, fallback: string) {
  if (err instanceof ProjectError) return res.status(err.status).json({ error: { code: err.code, message: err.message } });
  console.error(`[Projects] ${fallback}:`, err);
  return res.status(500).json({ error: { code: "INTERNAL_ERROR", message: fallback } });
}

const notFound = (res: Response) => res.status(404).json({ error: { code: "NOT_FOUND", message: "Project not found." } });
const validationError = (res: Response, message: string) => res.status(400).json({ error: { code: "VALIDATION_ERROR", message } });

// Resolves the org scope and the project named by :key, and checks that the caller may see it.
// Anything out of scope is a 404, never a 403 (§4.1). With `manage`, only OA/SA pass.
export async function loadProject(req: Request, res: Response, auth: AuthContext, manage: boolean) {
  const key = String(req.params.key || "").toUpperCase();
  const orgId = await resolveOrgScope(auth, req.query.orgId ?? req.body?.orgId);
  if (!orgId || !PROJECT_KEY_RE.test(key)) {
    notFound(res);
    return null;
  }
  try {
    const project = await findProject(orgId, key);
    if (!(await hasProjectAccess(auth, project.id))) {
      notFound(res);
      return null;
    }
    if (manage && !canManageProjects(auth)) {
      res.status(403).json({ error: { code: "FORBIDDEN", message: "Only Org Admins can change projects." } });
      return null;
    }
    return { orgId, project };
  } catch (err) {
    // A Member or Viewer only learns a key was deleted if they could see that project; otherwise plain 404.
    if (err instanceof ProjectError && err.code === "PROJECT_DELETED" && !canManageProjects(auth)) {
      const hadAccess = await prisma.projectAccess.findFirst({
        where: { userId: auth.user.id, project: { orgId, key } },
        select: { id: true },
      });
      if (!hadAccess) {
        notFound(res);
        return null;
      }
    }
    sendError(res, err, "Failed to load the project.");
    return null;
  }
}

// PRJ-02: OA (and SA with ?orgId) see every project; Members and Viewers see the ones they have access to.
projectsRouter.get("/projects", async (req: Request, res: Response) => {
  const auth = await requireAuth(req, res);
  if (!auth) return;
  const orgId = await resolveOrgScope(auth, req.query.orgId);
  if (!orgId) return res.status(404).json({ error: { code: "NOT_FOUND", message: "Organization not found." } });
  try {
    const manage = canManageProjects(auth);
    const projects = await prisma.project.findMany({
      where: {
        orgId,
        deletedAt: null,
        ...(manage ? {} : { accessList: { some: { userId: auth.user.id, revokedAt: null } } }),
      },
      orderBy: { createdAt: "desc" },
    });
    const stats = await projectStats(projects.map((p) => p.id));
    return res.status(200).json({
      projects: projects.map((p) => ({ ...serializeProject(p), ...stats.get(p.id)! })),
      canManage: manage,
    });
  } catch (err) {
    return sendError(res, err, "Failed to load projects.");
  }
});

// PRJ-01
projectsRouter.post("/projects", async (req: Request, res: Response) => {
  const auth = await requireAuth(req, res);
  if (!auth) return;
  if (!canManageProjects(auth)) {
    return res.status(403).json({ error: { code: "FORBIDDEN", message: "Only Org Admins can create projects." } });
  }
  const parsed = CreateProjectSchema.safeParse(req.body);
  if (!parsed.success) return validationError(res, parsed.error.errors[0]?.message || "Invalid project details.");
  const orgId = await resolveOrgScope(auth, parsed.data.orgId);
  if (!orgId) return res.status(404).json({ error: { code: "NOT_FOUND", message: "Organization not found." } });

  const { name, key, description, startDate, targetDate } = parsed.data;
  try {
    await assertProjectUnique(orgId, { name, key });
    const project = await prisma.project.create({
      data: {
        orgId,
        key,
        name,
        description: description || null,
        startDate: toDate(startDate) ?? null,
        targetDate: toDate(targetDate) ?? null,
      },
    });
    emitToOrg(orgId, "project:created", { id: project.id, key: project.key });
    await notify("project.created", { kind: "project", id: project.id, orgId }, auth.user.id, { projectKey: project.key, projectName: project.name });
    const stats = await projectStats([project.id]);
    return res.status(201).json({
      message: `Project ${project.name} (${project.key}) created.`,
      project: { ...serializeProject(project), ...stats.get(project.id)! },
    });
  } catch (err) {
    if (uniqueViolation(err)) {
      return res.status(409).json({ error: { code: "PROJECT_CONFLICT", message: "Another project already uses this name or key." } });
    }
    return sendError(res, err, "Failed to create the project.");
  }
});

projectsRouter.get("/projects/:key", async (req: Request, res: Response) => {
  const auth = await requireAuth(req, res);
  if (!auth) return;
  const found = await loadProject(req, res, auth, false);
  if (!found) return;
  try {
    const stats = await projectStats([found.project.id]);
    return res.status(200).json({
      project: { ...serializeProject(found.project), ...stats.get(found.project.id)! },
      canManage: canManageProjects(auth),
      canEditTasks: auth.role !== "VIEWER",
    });
  } catch (err) {
    return sendError(res, err, "Failed to load the project.");
  }
});

// PRJ-03: the key can't change.
projectsRouter.patch("/projects/:key", async (req: Request, res: Response) => {
  const auth = await requireAuth(req, res);
  if (!auth) return;
  const found = await loadProject(req, res, auth, true);
  if (!found) return;
  const { project } = found;

  if (req.body?.key !== undefined && String(req.body.key).trim().toUpperCase() !== project.key) {
    return res.status(400).json({ error: { code: "KEY_IMMUTABLE", message: "A project's key can't be changed." } });
  }
  const parsed = UpdateProjectSchema.safeParse(req.body);
  if (!parsed.success) return validationError(res, parsed.error.errors[0]?.message || "Invalid project details.");
  const data = parsed.data;

  const startDate = data.startDate !== undefined ? toDate(data.startDate) ?? null : project.startDate;
  const targetDate = data.targetDate !== undefined ? toDate(data.targetDate) ?? null : project.targetDate;
  if (startDate && targetDate && targetDate < startDate) {
    return validationError(res, "The target date can't be before the start date");
  }

  try {
    if (data.name) await assertProjectUnique(found.orgId, { name: data.name }, project.id);
    const updated = await prisma.project.update({
      where: { id: project.id },
      data: {
        ...(data.name ? { name: data.name } : {}),
        ...(data.description !== undefined ? { description: data.description || null } : {}),
        startDate,
        targetDate,
      },
    });
    emitToOrg(found.orgId, "project:updated", { id: project.id, key: project.key });
    await notify("project.updated", { kind: "project", id: project.id, orgId: found.orgId }, auth.user.id, {
      projectKey: updated.key,
      projectName: updated.name,
      ...(updated.name !== project.name ? { previousName: project.name } : {}),
    });
    return res.status(200).json({ message: "Project updated.", project: serializeProject(updated) });
  } catch (err) {
    if (uniqueViolation(err)) {
      return res.status(409).json({ error: { code: "PROJECT_NAME_TAKEN", message: "Another project already uses this name." } });
    }
    return sendError(res, err, "Failed to update the project.");
  }
});

// PRJ-05: typed key.
projectsRouter.delete("/projects/:key", async (req: Request, res: Response) => {
  const auth = await requireAuth(req, res);
  if (!auth) return;
  const found = await loadProject(req, res, auth, true);
  if (!found) return;
  const confirmKey = typeof req.body?.confirmKey === "string" ? req.body.confirmKey.trim() : "";
  if (confirmKey !== found.project.key) {
    return res.status(400).json({ error: { code: "CONFIRMATION_MISMATCH", message: "The typed key doesn't match the project key." } });
  }
  try {
    // Read before the delete revokes every access row.
    const audience = await projectAudience(found.project.id, found.orgId);
    await deleteProject(found.project.id, auth.user.id);
    // Open boards show "This project was deleted" right away (PRJ-05).
    emitToOrg(found.orgId, "project:deleted", { id: found.project.id, key: found.project.key });
    emitToProject(found.project.id, "project:deleted", { id: found.project.id, key: found.project.key });
    closeProjectRoom(found.project.id);
    await notify(
      "project.deleted",
      { kind: "project", id: found.project.id, orgId: found.orgId },
      auth.user.id,
      { projectKey: found.project.key, projectName: found.project.name },
      { audience }
    );
    return res.status(200).json({ message: `${found.project.name} (${found.project.key}) deleted.` });
  } catch (err) {
    return sendError(res, err, "Failed to delete the project.");
  }
});

// PRJ-04: the org's Members and Viewers with their access; Org Admins are listed as always having access.
projectsRouter.get("/projects/:key/access", async (req: Request, res: Response) => {
  const auth = await requireAuth(req, res);
  if (!auth) return;
  const found = await loadProject(req, res, auth, true);
  if (!found) return;
  try {
    return res.status(200).json({ members: await projectAccessList(found.orgId, found.project.id) });
  } catch (err) {
    return sendError(res, err, "Failed to load project access.");
  }
});

projectsRouter.post("/projects/:key/access", async (req: Request, res: Response) => {
  const auth = await requireAuth(req, res);
  if (!auth) return;
  const found = await loadProject(req, res, auth, true);
  if (!found) return;
  const userId = req.body?.userId;
  if (typeof userId !== "string" || !UUID_RE.test(userId)) return validationError(res, "Choose a member to give access to.");
  try {
    await grantAccess(found.orgId, found.project.id, userId, auth.user.id);
    emitToUser(userId, "me:updated", { reason: "access", projectId: found.project.id });
    emitToOrg(found.orgId, "member:updated", { userId });
    await notify("project.access_granted", { kind: "project", id: found.project.id, orgId: found.orgId, userId }, auth.user.id, {
      projectKey: found.project.key,
      projectName: found.project.name,
    });
    return res.status(201).json({ message: "Access granted." });
  } catch (err) {
    return sendError(res, err, "Failed to grant access.");
  }
});

projectsRouter.delete("/projects/:key/access/:userId", async (req: Request, res: Response) => {
  const auth = await requireAuth(req, res);
  if (!auth) return;
  const found = await loadProject(req, res, auth, true);
  if (!found) return;
  if (!UUID_RE.test(req.params.userId)) return notFound(res);
  try {
    const { unassignedTasks } = await revokeAccess(found.project.id, req.params.userId);
    // PRJ-04: out of the live room; their open board refetches and gets a 404.
    leaveProjectRoom(req.params.userId, found.project.id);
    emitToUser(req.params.userId, "me:updated", { reason: "access", projectId: found.project.id });
    emitToOrg(found.orgId, "member:updated", { userId: req.params.userId });
    await notify(
      "project.access_revoked",
      { kind: "project", id: found.project.id, orgId: found.orgId, userId: req.params.userId },
      auth.user.id,
      { projectKey: found.project.key, projectName: found.project.name }
    );
    return res.status(200).json({ message: "Access revoked.", unassignedTasks });
  } catch (err) {
    return sendError(res, err, "Failed to revoke access.");
  }
});
