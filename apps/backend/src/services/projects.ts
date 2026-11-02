import { MembershipStatus, OrgRole, TaskStatus } from "@prisma/client";
import { prisma } from "../app";
import { AuthContext } from "./auth";
import { OrgError } from "./orgs";

// Same shape as organization errors: status, code, message.
export { OrgError as ProjectError };

// Calendar dates are stored as DATE; the API speaks YYYY-MM-DD.
export const toDate = (v: string | null | undefined) => (v ? new Date(`${v}T00:00:00Z`) : v === null ? null : undefined);
export const fromDate = (d: Date | null) => (d ? d.toISOString().slice(0, 10) : null);

function startOfTodayUtc() {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}

// Which org a request acts on: an OA/Member/Viewer acts on their own org; a System Admin
// belongs to none and names one (§4.1). Null = nothing in scope (the route answers 404).
export async function resolveOrgScope(auth: AuthContext, requestedOrgId?: unknown): Promise<string | null> {
  if (auth.role === "SA") {
    if (typeof requestedOrgId !== "string") return null;
    const org = await prisma.organization.findFirst({ where: { id: requestedOrgId, deletedAt: null }, select: { id: true } });
    return org?.id ?? null;
  }
  return auth.organization?.id ?? null;
}

export function canManageProjects(auth: AuthContext) {
  return auth.role === "SA" || auth.role === "OA";
}

// A live project by key; a key whose project was deleted gets its own code so open pages can say so (PRJ-05).
export async function findProject(orgId: string, key: string) {
  const project = await prisma.project.findFirst({ where: { orgId, key, deletedAt: null } });
  if (project) return project;
  const deleted = await prisma.project.findFirst({ where: { orgId, key, deletedAt: { not: null } }, select: { id: true } });
  if (deleted) throw new OrgError(404, "PROJECT_DELETED", "This project was deleted.");
  throw new OrgError(404, "NOT_FOUND", "Project not found.");
}

// OAs and System Admins see every project of the org; Members and Viewers only those they were given access to.
export async function hasProjectAccess(auth: AuthContext, projectId: string) {
  if (canManageProjects(auth)) return true;
  const row = await prisma.projectAccess.findFirst({
    where: { projectId, userId: auth.user.id, revokedAt: null },
    select: { id: true },
  });
  return Boolean(row);
}

export interface ProjectStats {
  taskCount: number;
  doneCount: number;
  openCount: number;
  overdueCount: number;
  percentDone: number;
}

// PRJ-02 card numbers: % Done, open and overdue (open with a due date before today).
export async function projectStats(projectIds: string[]): Promise<Map<string, ProjectStats>> {
  const stats = new Map<string, ProjectStats>();
  for (const id of projectIds) stats.set(id, { taskCount: 0, doneCount: 0, openCount: 0, overdueCount: 0, percentDone: 0 });
  if (!projectIds.length) return stats;

  const [byStatus, overdue] = await Promise.all([
    prisma.task.groupBy({
      by: ["projectId", "status"],
      where: { projectId: { in: projectIds }, deletedAt: null },
      _count: { _all: true },
    }),
    prisma.task.groupBy({
      by: ["projectId"],
      where: { projectId: { in: projectIds }, deletedAt: null, status: { not: TaskStatus.DONE }, dueDate: { lt: startOfTodayUtc() } },
      _count: { _all: true },
    }),
  ]);
  for (const row of byStatus) {
    const s = stats.get(row.projectId)!;
    s.taskCount += row._count._all;
    if (row.status === TaskStatus.DONE) s.doneCount += row._count._all;
    else s.openCount += row._count._all;
  }
  for (const row of overdue) stats.get(row.projectId)!.overdueCount = row._count._all;
  for (const s of stats.values()) s.percentDone = s.taskCount ? Math.round((s.doneCount / s.taskCount) * 100) : 0;
  return stats;
}

export function serializeProject(p: {
  id: string;
  orgId: string;
  key: string;
  name: string;
  description: string | null;
  startDate: Date | null;
  targetDate: Date | null;
  createdAt: Date;
  updatedAt: Date;
}) {
  return {
    id: p.id,
    orgId: p.orgId,
    key: p.key,
    name: p.name,
    description: p.description,
    startDate: fromDate(p.startDate),
    targetDate: fromDate(p.targetDate),
    createdAt: p.createdAt,
    updatedAt: p.updatedAt,
  };
}

// Name (case-insensitive) and key are unique among the org's live projects; a deleted project's
// name and key can be reused (PRJ-05). The partial unique indexes back this up under races.
export async function assertProjectUnique(orgId: string, data: { name?: string; key?: string }, excludeId?: string) {
  const exclude = excludeId ? { id: { not: excludeId } } : {};
  if (data.key && (await prisma.project.findFirst({ where: { orgId, key: data.key, deletedAt: null, ...exclude }, select: { id: true } }))) {
    throw new OrgError(409, "PROJECT_KEY_TAKEN", `Another project already uses the key ${data.key}.`);
  }
  if (
    data.name &&
    (await prisma.project.findFirst({
      where: { orgId, name: { equals: data.name, mode: "insensitive" }, deletedAt: null, ...exclude },
      select: { id: true },
    }))
  ) {
    throw new OrgError(409, "PROJECT_NAME_TAKEN", `A project named "${data.name}" already exists in this organization.`);
  }
}

export function uniqueViolation(err: unknown) {
  return (err as { code?: string })?.code === "P2002";
}

// PRJ-05: typed key; soft-deletes the project, its tasks and comments, and revokes every access row.
export async function deleteProject(projectId: string, actorId: string) {
  const now = new Date();
  await prisma.$transaction(async (tx) => {
    await tx.comment.updateMany({
      where: { deletedAt: null, task: { projectId } },
      data: { deletedAt: now, deletedById: actorId },
    });
    await tx.task.updateMany({ where: { deletedAt: null, projectId }, data: { deletedAt: now, deletedById: actorId } });
    await tx.projectAccess.updateMany({ where: { projectId, revokedAt: null }, data: { revokedAt: now } });
    await tx.project.update({ where: { id: projectId }, data: { deletedAt: now, deletedById: actorId } });
  });
}

// The org's Members and Viewers, each with whether they can open this project.
export async function projectAccessList(orgId: string, projectId: string) {
  const [memberships, grants, assigned] = await Promise.all([
    prisma.membership.findMany({
      where: { orgId, status: MembershipStatus.ACTIVE },
      include: { user: { select: { id: true, firstName: true, lastName: true, email: true, jobTitle: true, avatarPath: true } } },
      orderBy: [{ user: { firstName: "asc" } }, { user: { lastName: "asc" } }],
    }),
    prisma.projectAccess.findMany({
      where: { projectId, revokedAt: null },
      include: { grantedBy: { select: { firstName: true, lastName: true } } },
    }),
    prisma.task.groupBy({
      by: ["assigneeId"],
      where: { projectId, deletedAt: null, assigneeId: { not: null } },
      _count: { _all: true },
    }),
  ]);
  const grantByUser = new Map(grants.map((g) => [g.userId, g]));
  const tasksByUser = new Map(assigned.map((a) => [a.assigneeId!, a._count._all]));

  return memberships.map((m) => {
    const grant = grantByUser.get(m.userId);
    return {
      userId: m.user.id,
      firstName: m.user.firstName,
      lastName: m.user.lastName,
      email: m.user.email,
      jobTitle: m.user.jobTitle,
      avatarPath: m.user.avatarPath,
      role: m.role,
      // Org Admins always have access (glossary §3).
      hasAccess: m.role === OrgRole.OA || Boolean(grant),
      implicit: m.role === OrgRole.OA,
      grantedAt: grant?.grantedAt ?? null,
      grantedByName: grant ? `${grant.grantedBy.firstName} ${grant.grantedBy.lastName}` : null,
      assignedTasks: tasksByUser.get(m.userId) ?? 0,
    };
  });
}

// PRJ-04: grant a Member or Viewer of the project's org.
export async function grantAccess(orgId: string, projectId: string, userId: string, actorId: string) {
  const membership = await prisma.membership.findFirst({
    where: { orgId, userId, status: MembershipStatus.ACTIVE },
    select: { role: true },
  });
  if (!membership) throw new OrgError(404, "NOT_FOUND", "That person isn't a member of this organization.");
  if (membership.role === OrgRole.OA) {
    throw new OrgError(409, "ALWAYS_HAS_ACCESS", "Org Admins always have access to every project.");
  }
  try {
    await prisma.projectAccess.create({ data: { projectId, userId, grantedById: actorId } });
  } catch (err) {
    if (uniqueViolation(err)) throw new OrgError(409, "ALREADY_HAS_ACCESS", "This person already has access.");
    throw err;
  }
}

// PRJ-04: revoking unassigns the user's tasks in this project. The route then takes them out of the
// project's live room (realtime/socket.ts).
export async function revokeAccess(projectId: string, userId: string) {
  const now = new Date();
  let unassignedTasks = 0;
  await prisma.$transaction(async (tx) => {
    const r = await tx.projectAccess.updateMany({ where: { projectId, userId, revokedAt: null }, data: { revokedAt: now } });
    if (r.count === 0) throw new OrgError(404, "NOT_FOUND", "This person doesn't have access to the project.");
    const t = await tx.task.updateMany({
      where: { projectId, assigneeId: userId, deletedAt: null },
      data: { assigneeId: null },
    });
    unassignedTasks = t.count;
  });
  return { unassignedTasks };
}
