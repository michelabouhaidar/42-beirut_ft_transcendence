import { AccountStatus, InvitationStatus, MembershipStatus, OrgRole, Prisma } from "@prisma/client";
import { prisma } from "../app";
import { emitToUser } from "../realtime/socket";

// Notifications (spec §6.9, NOTIF-01). Every service calls notify() after its write commits; the audience
// comes from the §6.9 table, never includes the actor, and is limited to people who can still reach the
// resource. Rows hold type + params only; the frontend turns them into text.

export type NotificationType =
  | "account.password_changed"
  | "account.password_reset"
  | "account.2fa_enabled"
  | "account.2fa_disabled"
  | "account.locked"
  | "account.suspended"
  | "account.reactivated"
  | "account.updated"
  | "account.role_changed"
  | "invitation.received"
  | "invitation.revoked"
  | "invitation.accepted"
  | "invitation.declined"
  | "org.updated"
  | "org.deleted"
  | "membership.role_changed"
  | "membership.removed"
  | "membership.left"
  | "project.created"
  | "project.updated"
  | "project.deleted"
  | "project.access_granted"
  | "project.access_revoked"
  | "task.created"
  | "task.updated"
  | "task.moved"
  | "task.assigned"
  | "task.deleted"
  | "comment.created"
  | "comment.updated"
  | "comment.deleted"
  | "friend.request_received"
  | "friend.request_accepted";

// What the notification points at. Fields beyond the id are what the audience is resolved from.
export type NotifyResource =
  | { kind: "user"; id: string }
  | { kind: "invitation"; id: string; orgId: string; email: string; invitedById: string }
  | { kind: "organization"; id: string }
  | { kind: "membership"; id: string; orgId: string; userId: string }
  | { kind: "project"; id: string; orgId: string; userId?: string }
  | { kind: "task"; id: string; projectId: string; creatorId: string; assigneeId: string | null; previousAssigneeId?: string | null }
  | { kind: "comment"; id: string; taskId: string; authorId: string }
  | { kind: "friendship"; id: string; userId: string };

type Params = Record<string, Prisma.InputJsonValue | null>;

const unique = (ids: (string | null | undefined)[]) => [...new Set(ids.filter((id): id is string => Boolean(id)))];

async function orgAdminIds(orgId: string) {
  const rows = await prisma.membership.findMany({
    where: { orgId, role: OrgRole.OA, status: MembershipStatus.ACTIVE },
    select: { userId: true },
  });
  return rows.map((r) => r.userId);
}

async function orgMemberIds(orgId: string) {
  const rows = await prisma.membership.findMany({
    where: { orgId, status: MembershipStatus.ACTIVE, organization: { deletedAt: null } },
    select: { userId: true },
  });
  return rows.map((r) => r.userId);
}

// Of `userIds`, those who can open the project: active members of its live org who are Org Admins
// or hold an access row (glossary §3).
async function withProjectAccess(projectId: string, userIds: string[]) {
  if (!userIds.length) return [];
  const project = await prisma.project.findUnique({ where: { id: projectId }, select: { orgId: true } });
  if (!project) return [];
  const rows = await prisma.membership.findMany({
    where: {
      orgId: project.orgId,
      userId: { in: userIds },
      status: MembershipStatus.ACTIVE,
      organization: { deletedAt: null },
      OR: [{ role: OrgRole.OA }, { user: { projectAccesses: { some: { projectId, revokedAt: null } } } }],
    },
    select: { userId: true },
  });
  return rows.map((r) => r.userId);
}

// Everyone who can open a project now. Deletes call this before deleting and pass the result to notify().
export async function projectAudience(projectId: string, orgId: string) {
  const grants = await prisma.projectAccess.findMany({ where: { projectId, revokedAt: null }, select: { userId: true } });
  return withProjectAccess(projectId, unique([...(await orgAdminIds(orgId)), ...grants.map((g) => g.userId)]));
}

async function resolveAudience(type: NotificationType, r: NotifyResource): Promise<string[]> {
  switch (r.kind) {
    case "user":
    case "friendship":
      return [r.kind === "user" ? r.id : r.userId];

    case "invitation": {
      if (type === "invitation.received" || type === "invitation.revoked") {
        const invitee = await prisma.user.findFirst({
          where: { email: { equals: r.email, mode: "insensitive" }, deletedAt: null },
          select: { id: true },
        });
        return invitee ? [invitee.id] : [];
      }
      // Accepted / declined: the org's admins, and the inviter if they still see the org (a System Admin does).
      const inviter = await prisma.user.findUnique({ where: { id: r.invitedById }, select: { isSystemAdmin: true } });
      return unique([...(await orgAdminIds(r.orgId)), inviter?.isSystemAdmin ? r.invitedById : null]);
    }

    case "organization":
      return orgMemberIds(r.id);

    case "membership":
      // The person concerned plus the org's admins.
      return unique([r.userId, ...(await orgAdminIds(r.orgId))]);

    case "project":
      if (r.userId) return [r.userId]; // access granted / revoked
      return projectAudience(r.id, r.orgId);

    case "task":
      return withProjectAccess(r.projectId, unique([r.creatorId, r.assigneeId, r.previousAssigneeId]));

    case "comment": {
      if (type === "comment.deleted") return [r.authorId];
      const task = await prisma.task.findUnique({
        where: { id: r.taskId },
        select: { projectId: true, creatorId: true, assigneeId: true },
      });
      if (!task) return [];
      const commenters = await prisma.comment.findMany({
        where: { taskId: r.taskId, deletedAt: null },
        distinct: ["authorId"],
        select: { authorId: true },
      });
      return withProjectAccess(task.projectId, unique([task.creatorId, task.assigneeId, ...commenters.map((c) => c.authorId)]));
    }
  }
}

const RESOURCE_TYPE: Record<NotifyResource["kind"], string> = {
  user: "user",
  invitation: "invitation",
  organization: "organization",
  membership: "membership",
  project: "project",
  task: "task",
  comment: "comment",
  friendship: "friendship",
};

export function emitNotificationEvent(userId: string, event: "notification:new" | "notification:sync", payload: unknown = {}) {
  emitToUser(userId, event, payload);
}

// NOTIF-01. `actorId` is null for events nobody in particular caused (lockout, a change to your own
// password or 2FA), so the user concerned is always told. `audience` replaces the resolved one for deletes,
// whose audience must be read before the delete. Never throws: a failed notification can't undo the action.
export async function notify(
  type: NotificationType,
  resource: NotifyResource,
  actorId: string | null,
  params: Params = {},
  options: { audience?: string[] } = {}
): Promise<void> {
  try {
    const candidates = unique(options.audience ?? (await resolveAudience(type, resource))).filter((id) => id !== actorId);
    if (!candidates.length) return;
    // Deleted accounts get nothing.
    const recipients = await prisma.user.findMany({
      where: { id: { in: candidates }, deletedAt: null, status: { not: AccountStatus.DELETED } },
      select: { id: true },
    });
    if (!recipients.length) return;

    const rows = await prisma.notification.createManyAndReturn({
      data: recipients.map((u) => ({
        userId: u.id,
        actorId,
        type,
        params,
        resourceType: RESOURCE_TYPE[resource.kind],
        resourceId: resource.id,
      })),
      select: { id: true, userId: true },
    });
    for (const row of rows) emitNotificationEvent(row.userId, "notification:new", { id: row.id });
  } catch (err) {
    console.warn(`[Notifications] Could not create ${type}:`, err);
  }
}

// ---------------------------------------------------------------------------------------------------------------
// NOTIF-02 / NOTIF-04: where a click goes, checked again now. `gone` = deleted or no longer accessible.
// ---------------------------------------------------------------------------------------------------------------

export type NotificationTarget = { path: string | null; gone: boolean };
const GONE: NotificationTarget = { path: null, gone: true };
const open = (path: string | null): NotificationTarget => ({ path, gone: false });

async function viewerMembership(userId: string) {
  return prisma.membership.findFirst({
    where: { userId, status: MembershipStatus.ACTIVE, organization: { deletedAt: null } },
    select: { orgId: true, role: true },
  });
}

async function projectPath(viewerId: string, projectId: string, suffix: (key: string) => string) {
  const project = await prisma.project.findFirst({ where: { id: projectId, deletedAt: null }, select: { key: true } });
  if (!project) return GONE;
  const [ok] = await withProjectAccess(projectId, [viewerId]);
  return ok ? open(suffix(project.key)) : GONE;
}

export async function notificationTarget(
  n: { resourceType: string; resourceId: string },
  viewer: { id: string; email: string; isSystemAdmin: boolean }
): Promise<NotificationTarget> {
  const id = n.resourceId;
  switch (n.resourceType) {
    case "user":
      // Account notices have nothing to open.
      return open(null);

    case "organization": {
      const org = await prisma.organization.findFirst({ where: { id, deletedAt: null }, select: { id: true } });
      if (!org) return GONE;
      if (viewer.isSystemAdmin) return open(`/admin/orgs/${id}`);
      const m = await viewerMembership(viewer.id);
      if (m?.orgId !== id) return GONE;
      return open(m.role === OrgRole.OA ? "/org/settings" : "/projects");
    }

    case "membership": {
      const ms = await prisma.membership.findUnique({
        where: { id },
        select: { orgId: true, userId: true, status: true, organization: { select: { deletedAt: true } } },
      });
      if (!ms || ms.organization.deletedAt) return GONE;
      if (viewer.isSystemAdmin) return open(`/admin/orgs/${ms.orgId}`);
      const m = await viewerMembership(viewer.id);
      if (m?.orgId !== ms.orgId) return GONE;
      if (m.role === OrgRole.OA) return open("/org/members");
      return ms.userId === viewer.id && ms.status === MembershipStatus.ACTIVE ? open("/projects") : GONE;
    }

    case "invitation": {
      const inv = await prisma.invitation.findUnique({
        where: { id },
        select: { orgId: true, email: true, status: true, expiresAt: true, organization: { select: { deletedAt: true } } },
      });
      if (!inv || inv.organization.deletedAt) return GONE;
      if (inv.email.toLowerCase() === viewer.email.toLowerCase()) {
        return inv.status === InvitationStatus.PENDING && inv.expiresAt > new Date() ? open("/onboarding") : GONE;
      }
      if (viewer.isSystemAdmin) return open(`/admin/orgs/${inv.orgId}`);
      const m = await viewerMembership(viewer.id);
      return m?.orgId === inv.orgId && m.role === OrgRole.OA ? open("/org/invitations") : GONE;
    }

    case "project":
      return projectPath(viewer.id, id, (key) => `/projects/${key}/board`);

    case "task":
    case "comment": {
      // A comment opens its task, even once the comment itself was deleted.
      const taskId =
        n.resourceType === "task"
          ? id
          : (await prisma.comment.findUnique({ where: { id }, select: { taskId: true } }))?.taskId;
      const task = taskId
        ? await prisma.task.findFirst({ where: { id: taskId, deletedAt: null }, select: { projectId: true, number: true } })
        : null;
      if (!task) return GONE;
      return projectPath(viewer.id, task.projectId, (key) => `/projects/${key}/tasks/${task.number}`);
    }

    case "friendship": {
      const f = await prisma.friendship.findUnique({ where: { id }, select: { requesterId: true, addresseeId: true, status: true } });
      if (!f || (f.requesterId !== viewer.id && f.addresseeId !== viewer.id)) return GONE;
      if (f.status === "PENDING") return open("/friends");
      if (f.status === "ACCEPTED") return open(`/users/${f.requesterId === viewer.id ? f.addresseeId : f.requesterId}`);
      return GONE;
    }
  }
  return GONE;
}
