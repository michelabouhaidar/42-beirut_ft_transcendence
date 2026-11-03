import { Router, Request, Response } from "express";
import { prisma } from "../app";
import {
  sendAccountSuspendedEmail,
  sendAccountReactivatedEmail,
  sendAccountDeletedEmail,
  sendRoleChangedEmail,
  sendInvitationEmail,
} from "../services/mailer";
import { CreateOrgSchema } from "../schemas";
import { createOrgInvitation, createSaInvitation, InvitationError, notifyInvitation } from "../services/invitations";
import { getAuthContextFromRequest, generateSecureToken } from "../services/auth";
import { disconnectUserSockets, emitToOrg, emitToUser, leaveOrgRooms } from "../realtime/socket";
import { emitFriendshipChange, endFriendshipsForUser } from "../services/friends";
import { OrgError, deleteOrganization, findActiveOrgByName, notifyMembership, updateOrganization } from "../services/orgs";
import { notify } from "../services/notifications";
import { deleteAvatarFile } from "../services/avatars";
import { isRefusal, refuse } from "../services/refusal";
import { AccountStatus, OrgRole, MembershipStatus, InvitationRole, InvitationStatus } from "@prisma/client";

export const adminRouter = Router();

// Middleware: Require System Administrator (SA) role
async function requireSystemAdmin(req: Request, res: Response) {
  const auth = await getAuthContextFromRequest(req);
  if (!auth) {
    res.status(401).json({
      error: {
        code: "UNAUTHORIZED",
        message: "Authentication required to access platform administration.",
      },
    });
    return null;
  }

  if (!auth.user.isSystemAdmin || auth.role !== "SA") {
    res.status(200).json({ ok: false,
      error: {
        code: "FORBIDDEN",
        message: "System Administrator privileges required.",
      },
    });
    return null;
  }

  return auth;
}

function countActiveSystemAdmins(): Promise<number> {
  return prisma.user.count({ where: { isSystemAdmin: true, status: AccountStatus.ACTIVE } });
}

// Active OA count per org, for the last-OA rule (§4.1).
async function countActiveOrgAdmins(orgIds: string[]): Promise<Map<string, number>> {
  const unique = [...new Set(orgIds)];
  if (unique.length === 0) return new Map();
  const groups = await prisma.membership.groupBy({
    by: ["orgId"],
    where: { orgId: { in: unique }, role: OrgRole.OA, status: MembershipStatus.ACTIVE },
    _count: { _all: true },
  });
  return new Map(groups.map((g) => [g.orgId, g._count._all]));
}

type AdminUserRow = {
  id: string;
  email: string;
  firstName: string;
  lastName: string;
  jobTitle: string | null;
  bio: string | null;
  avatarPath: string | null;
  isSystemAdmin: boolean;
  status: AccountStatus;
  lastLoginAt: Date | null;
  createdAt: Date;
  twoFactor: { enabledAt: Date | null } | null;
};

type ActiveMembershipRow = {
  orgId: string;
  role: OrgRole;
  organization: { id: string; name: string; deletedAt: Date | null };
};

// One shape for list rows and the detail page. `guards` tells the UI which
// actions the backend would refuse, so it can disable them with a reason
// instead of letting the SA click into an error.
function formatAdminUser(
  u: AdminUserRow,
  membership: ActiveMembershipRow | undefined,
  ctx: { activeSaCount: number; oaCount: number; selfId: string }
) {
  // A System Admin belongs to no organization (§4.1).
  const org =
    !u.isSystemAdmin && membership && !membership.organization.deletedAt
      ? { id: membership.organization.id, name: membership.organization.name }
      : null;
  const role: "SA" | "OA" | "MEMBER" | "VIEWER" | "U" = u.isSystemAdmin
    ? "SA"
    : org && membership
    ? membership.role
    : "U";

  return {
    id: u.id,
    email: u.email,
    firstName: u.firstName,
    lastName: u.lastName,
    fullName: `${u.firstName} ${u.lastName}`.trim(),
    jobTitle: u.jobTitle,
    bio: u.bio,
    avatarPath: u.avatarPath,
    isSystemAdmin: u.isSystemAdmin,
    status: u.status,
    twoFactorEnabled: Boolean(u.twoFactor?.enabledAt),
    lastLoginAt: u.lastLoginAt,
    createdAt: u.createdAt,
    organization: org,
    orgRole: org && membership ? membership.role : null,
    role,
    guards: {
      isSelf: u.id === ctx.selfId,
      lastSa: u.isSystemAdmin && u.status === AccountStatus.ACTIVE && ctx.activeSaCount <= 1,
      lastOa: Boolean(org && membership?.role === OrgRole.OA && ctx.oaCount <= 1),
    },
  };
}

// =========================================================================
// ADM-03: List and view users
// Table: name, email, status, org, role, 2FA on/off, last login.
// Search by name/email, filter by status/org, sort, pagination.
// =========================================================================
adminRouter.get("/users", async (req: Request, res: Response) => {
  const auth = await requireSystemAdmin(req, res);
  if (!auth) return;

  try {
    const q = typeof req.query.q === "string" ? req.query.q.trim() : "";
    const status = typeof req.query.status === "string" ? req.query.status.toUpperCase() : "";
    const orgId = typeof req.query.orgId === "string" ? req.query.orgId : "";
    const roleFilter = typeof req.query.role === "string" ? req.query.role.toUpperCase() : "";
    const sortField = typeof req.query.sort === "string" ? req.query.sort : "createdAt";
    const sortDirection = req.query.order === "asc" ? "asc" : "desc";
    const page = Math.max(1, parseInt(String(req.query.page || "1"), 10) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(String(req.query.limit || "25"), 10) || 25));
    const skip = (page - 1) * limit;

    // Every filter except status goes into `scope`, so the status strip can
    // show per-status counts for the current search/org/role selection.
    const scope: any[] = [];

    if (q) {
      scope.push({
        OR: [
          { firstName: { contains: q, mode: "insensitive" } },
          { lastName: { contains: q, mode: "insensitive" } },
          { email: { contains: q, mode: "insensitive" } },
        ],
      });
    }

    if (orgId === "unaffiliated") {
      scope.push({ isSystemAdmin: false, memberships: { none: { status: MembershipStatus.ACTIVE } } });
    } else if (orgId) {
      scope.push({ memberships: { some: { orgId, status: MembershipStatus.ACTIVE } } });
    }

    if (roleFilter === "SA") {
      scope.push({ isSystemAdmin: true });
    } else if (["OA", "MEMBER", "VIEWER"].includes(roleFilter)) {
      scope.push({
        isSystemAdmin: false,
        memberships: { some: { role: roleFilter as OrgRole, status: MembershipStatus.ACTIVE } },
      });
    } else if (roleFilter === "U") {
      scope.push({ isSystemAdmin: false, memberships: { none: { status: MembershipStatus.ACTIVE } } });
    }

    const where: any = { AND: [...scope] };
    if (status && Object.values(AccountStatus).includes(status as any)) {
      where.AND.push({ status: status as AccountStatus });
    }

    let orderBy: any = { createdAt: sortDirection };
    if (sortField === "name") {
      orderBy = [{ firstName: sortDirection }, { lastName: sortDirection }];
    } else if (sortField === "email") {
      orderBy = { email: sortDirection };
    } else if (sortField === "lastLoginAt") {
      orderBy = { lastLoginAt: { sort: sortDirection, nulls: "last" } };
    } else if (sortField === "status") {
      orderBy = { status: sortDirection };
    }

    const [total, users, statusGroups, activeSaCount] = await Promise.all([
      prisma.user.count({ where }),
      prisma.user.findMany({
        where,
        include: {
          twoFactor: { select: { enabledAt: true } },
          memberships: {
            where: { status: MembershipStatus.ACTIVE },
            include: { organization: { select: { id: true, name: true, deletedAt: true } } },
            take: 1,
          },
        },
        orderBy,
        skip,
        take: limit,
      }),
      prisma.user.groupBy({ by: ["status"], where: { AND: scope }, _count: { _all: true } }),
      countActiveSystemAdmins(),
    ]);

    const oaCounts = await countActiveOrgAdmins(
      users.flatMap((u) => (u.memberships[0]?.role === OrgRole.OA ? [u.memberships[0].orgId] : []))
    );

    const formattedUsers = users.map((u) =>
      formatAdminUser(u, u.memberships[0], {
        activeSaCount,
        oaCount: u.memberships[0] ? oaCounts.get(u.memberships[0].orgId) ?? 0 : 0,
        selfId: auth.user.id,
      })
    );

    const statusCounts: Record<string, number> = {
      ACTIVE: 0,
      PENDING_VERIFICATION: 0,
      SUSPENDED: 0,
      DELETED: 0,
    };
    for (const g of statusGroups) statusCounts[g.status] = g._count._all;

    return res.status(200).json({
      users: formattedUsers,
      statusCounts,
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit) || 1,
      },
    });
  } catch (err: any) {
    console.error("[Admin] List users error:", err);
    return res.status(500).json({
      error: {
        code: "INTERNAL_ERROR",
        message: "Failed to retrieve user accounts.",
      },
    });
  }
});

// GET /api/v1/admin/users/:id - View single user details
adminRouter.get("/users/:id", async (req: Request, res: Response) => {
  const auth = await requireSystemAdmin(req, res);
  if (!auth) return;

  const targetId = req.params.id;

  try {
    const user = await prisma.user.findUnique({
      where: { id: targetId },
      include: {
        twoFactor: { select: { enabledAt: true } },
        memberships: {
          include: { organization: { select: { id: true, name: true, deletedAt: true } } },
          orderBy: { joinedAt: "desc" },
        },
        _count: {
          select: {
            createdTasks: { where: { deletedAt: null } },
            assignedTasks: { where: { deletedAt: null } },
            comments: { where: { deletedAt: null } },
          },
        },
      },
    });

    if (!user) {
      return res.status(200).json({ ok: false,
        error: { code: "NOT_FOUND", message: "User account not found." },
      });
    }

    const active = user.memberships.find(
      (m) => m.status === MembershipStatus.ACTIVE && !m.organization.deletedAt
    );
    const [activeSaCount, oaCounts, friendships] = await Promise.all([
      countActiveSystemAdmins(),
      countActiveOrgAdmins(active?.role === OrgRole.OA ? [active.orgId] : []),
      prisma.friendship.count({
        where: {
          status: { in: ["PENDING", "ACCEPTED"] },
          OR: [{ requesterId: targetId }, { addresseeId: targetId }],
        },
      }),
    ]);

    return res.status(200).json({
      user: {
        ...formatAdminUser(user, active, {
          activeSaCount,
          oaCount: active ? oaCounts.get(active.orgId) ?? 0 : 0,
          selfId: auth.user.id,
        }),
        memberships: user.memberships.map((m) => ({
          id: m.id,
          orgId: m.orgId,
          orgName: m.organization.name,
          orgDeleted: Boolean(m.organization.deletedAt),
          role: m.role,
          status: m.status,
          joinedAt: m.joinedAt,
          leftAt: m.leftAt,
        })),
        counts: {
          tasksCreated: user._count.createdTasks,
          tasksAssigned: user._count.assignedTasks,
          comments: user._count.comments,
          friendships,
        },
      },
    });
  } catch (err: any) {
    console.error("[Admin] Get user details error:", err);
    return res.status(500).json({
      error: {
        code: "INTERNAL_ERROR",
        message: "Failed to retrieve user details.",
      },
    });
  }
});

// =========================================================================
// ADM-04: Edit users
// Names, job title, bio. Role changes: grant/revoke SA, appoint OA / demote OA
// to Member (last-SA and last-OA rules apply). User notified.
// =========================================================================
adminRouter.patch("/users/:id", async (req: Request, res: Response) => {
  const auth = await requireSystemAdmin(req, res);
  if (!auth) return;

  const targetId = req.params.id;
  const { firstName, lastName, jobTitle, bio, isSystemAdmin, orgRole } = req.body;

  const refuse = (status: number, code: string, message: string) =>
    res.status(status).json({ error: { code, message } });

  try {
    const targetUser = await prisma.user.findUnique({
      where: { id: targetId },
      include: {
        memberships: { where: { status: MembershipStatus.ACTIVE } },
      },
    });

    if (!targetUser) return refuse(404, "NOT_FOUND", "User account not found.");
    if (targetUser.status === AccountStatus.DELETED) {
      return refuse(400, "CANNOT_EDIT_DELETED", "A deleted account can't be edited.");
    }

    // 1. Validate every field before writing anything, so a refused role
    //    change never leaves a half-applied profile edit behind.
    const updates: Record<string, unknown> = {};
    const changes: string[] = [];

    if (firstName !== undefined) {
      const v = String(firstName).trim();
      if (!v || v.length > 50) return refuse(400, "INVALID_FIRST_NAME", "First name must be 1–50 characters.");
      if (v !== targetUser.firstName) {
        updates.firstName = v;
        changes.push(`First name changed to "${v}"`);
      }
    }
    if (lastName !== undefined) {
      const v = String(lastName).trim();
      if (!v || v.length > 50) return refuse(400, "INVALID_LAST_NAME", "Last name must be 1–50 characters.");
      if (v !== targetUser.lastName) {
        updates.lastName = v;
        changes.push(`Last name changed to "${v}"`);
      }
    }
    if (jobTitle !== undefined) {
      const v = jobTitle ? String(jobTitle).trim() : null;
      if (v && v.length > 100) return refuse(400, "INVALID_JOB_TITLE", "Job title must not exceed 100 characters.");
      if (v !== targetUser.jobTitle) {
        updates.jobTitle = v;
        changes.push("Job title updated");
      }
    }
    if (bio !== undefined) {
      const v = bio ? String(bio).trim() : null;
      if (v && v.length > 500) return refuse(400, "INVALID_BIO", "Bio must not exceed 500 characters.");
      if (v !== targetUser.bio) {
        updates.bio = v;
        changes.push("Bio updated");
      }
    }

    if (typeof isSystemAdmin === "boolean" && isSystemAdmin !== targetUser.isSystemAdmin) {
      if (!isSystemAdmin) {
        if (targetUser.status === AccountStatus.ACTIVE && (await countActiveSystemAdmins()) <= 1) {
          return refuse(409, "LAST_SA", "This is the last active System Admin. Grant SA to someone else first.");
        }
        changes.push("System Admin role revoked");
      } else {
        // An SA belongs to no org (§4.1): granting SA ends the membership.
        const oaMembership = targetUser.memberships.find((m) => m.role === OrgRole.OA);
        if (oaMembership) {
          const oaCounts = await countActiveOrgAdmins([oaMembership.orgId]);
          if ((oaCounts.get(oaMembership.orgId) ?? 0) <= 1) {
            return refuse(409, "LAST_ORG_ADMIN", "This user is the last Org Admin of their organization. Appoint another OA first.");
          }
        }
        changes.push("System Admin role granted");
      }
      updates.isSystemAdmin = isSystemAdmin;
    }

    const membership = targetUser.memberships[0];
    const nextRole: OrgRole | null =
      orgRole && ["OA", "MEMBER", "VIEWER"].includes(orgRole) && membership && orgRole !== membership.role
        ? (orgRole as OrgRole)
        : null;

    if (nextRole && updates.isSystemAdmin === true) {
      return refuse(400, "CONFLICTING_CHANGES", "Granting System Admin removes the org membership; don't change the org role in the same edit.");
    }
    if (nextRole && membership.role === OrgRole.OA) {
      const oaCounts = await countActiveOrgAdmins([membership.orgId]);
      if ((oaCounts.get(membership.orgId) ?? 0) <= 1) {
        return refuse(409, "LAST_ORG_ADMIN", "This user is the last Org Admin of their organization. Appoint another OA first.");
      }
    }
    if (nextRole) changes.push(`Organization role changed to ${nextRole}`);

    if (changes.length === 0) {
      return res.status(200).json({ message: "Nothing to update.", changes });
    }

    // 2. Apply in one transaction.
    let unassignedTasks = 0;
    let exFriends: string[] = [];
    await prisma.$transaction(async (tx) => {
      await tx.user.update({ where: { id: targetId }, data: updates });

      if (updates.isSystemAdmin === true && membership) {
        await tx.membership.update({
          where: { id: membership.id },
          data: { status: MembershipStatus.REMOVED, leftAt: new Date() },
        });
        await tx.projectAccess.updateMany({
          where: { userId: targetId, revokedAt: null, project: { orgId: membership.orgId } },
          data: { revokedAt: new Date() },
        });
        exFriends = await endFriendshipsForUser(tx, targetId);
        const r = await tx.task.updateMany({
          where: { assigneeId: targetId, project: { orgId: membership.orgId } },
          data: { assigneeId: null },
        });
        unassignedTasks = r.count;
      }

      if (nextRole) {
        await tx.membership.update({ where: { id: membership.id }, data: { role: nextRole } });
        // Becoming a Viewer unassigns their tasks (ORG-06).
        if (nextRole === OrgRole.VIEWER) {
          const r = await tx.task.updateMany({
            where: { assigneeId: targetId, deletedAt: null, project: { orgId: membership.orgId } },
            data: { assigneeId: null },
          });
          unassignedTasks = r.count;
        }
      }
    });

    if (updates.isSystemAdmin !== undefined || nextRole) {
      emitToUser(targetId, "me:updated", { reason: "role" });
    }
    if (exFriends.length) emitFriendshipChange([targetId, ...exFriends], { reason: "system_admin" });
    if (membership && (nextRole || updates.isSystemAdmin === true)) {
      // Granting SA ends the membership (§4.1): out of the org's live rooms.
      if (updates.isSystemAdmin === true) await leaveOrgRooms([targetId], membership.orgId);
      emitToOrg(membership.orgId, "member:updated", { userId: targetId });
    }

    // §6.9 Account: edited or role changed by an SA → the user; an org role change also tells the org's admins.
    const profileFields = ["firstName", "lastName", "jobTitle", "bio"].filter((f) => f in updates);
    if (profileFields.length) {
      await notify("account.updated", { kind: "user", id: targetId }, auth.user.id, { fields: profileFields });
    }
    if (typeof updates.isSystemAdmin === "boolean") {
      await notify("account.role_changed", { kind: "user", id: targetId }, auth.user.id, { systemAdmin: updates.isSystemAdmin });
    }
    if (membership && (nextRole || updates.isSystemAdmin === true)) {
      const org = await prisma.organization.findUnique({ where: { id: membership.orgId }, select: { name: true } });
      const m = {
        ...membership,
        user: { firstName: String(updates.firstName ?? targetUser.firstName), lastName: String(updates.lastName ?? targetUser.lastName) },
        organization: { name: org?.name ?? "" },
      };
      if (nextRole) await notifyMembership("membership.role_changed", m, auth.user.id, { from: membership.role, role: nextRole });
      else await notifyMembership("membership.removed", m, auth.user.id, { role: membership.role });
    }

    try {
      await sendRoleChangedEmail(targetUser.email, targetUser.firstName, changes.join(", "));
    } catch (mailErr) {
      console.warn("[Admin] Could not send user update notification email:", mailErr);
    }

    return res.status(200).json({ message: "User updated.", changes, unassignedTasks });
  } catch (err: any) {
    console.error("[Admin] Edit user error:", err);
    return res.status(500).json({
      error: { code: "INTERNAL_ERROR", message: "Failed to update user account." },
    });
  }
});

// =========================================================================
// ADM-05: Suspend / reactivate
// Sessions revoked and sockets closed immediately; email to the user.
// Not on self or last SA.
// =========================================================================
adminRouter.post("/users/:id/suspend", async (req: Request, res: Response) => {
  const auth = await requireSystemAdmin(req, res);
  if (!auth) return;

  const targetId = req.params.id;
  const reason = typeof req.body.reason === "string" ? req.body.reason.trim().slice(0, 500) : undefined;

  try {
    const targetUser = await prisma.user.findUnique({
      where: { id: targetId },
      include: {
        memberships: {
          where: { status: MembershipStatus.ACTIVE },
        },
      },
    });

    if (!targetUser) {
      return res.status(200).json({ ok: false,
        error: { code: "NOT_FOUND", message: "User account not found." },
      });
    }

    if (targetUser.status === AccountStatus.SUSPENDED) {
      return res.status(200).json({ ok: false,
        error: { code: "ALREADY_SUSPENDED", message: "This account is already suspended." },
      });
    }

    if (targetUser.status === AccountStatus.DELETED) {
      return res.status(200).json({ ok: false,
        error: { code: "CANNOT_SUSPEND_DELETED", message: "Cannot suspend an anonymized deleted account." },
      });
    }

    // 1. Not on self
    if (targetUser.id === auth.user.id) {
      return res.status(200).json({ ok: false,
        error: { code: "CANNOT_SUSPEND_SELF", message: "You cannot suspend your own account." },
      });
    }

    // 2. Not on last active SA
    if (targetUser.isSystemAdmin) {
      const activeSaCount = await prisma.user.count({
        where: { isSystemAdmin: true, status: AccountStatus.ACTIVE },
      });
      if (activeSaCount <= 1) {
        return res.status(200).json({ ok: false,
          error: { code: "LAST_SA", message: "Cannot suspend the last active System Administrator." },
        });
      }
    }

    // 3. Not on last active OA of an active organization
    const activeOaMembership = targetUser.memberships.find((m) => m.role === OrgRole.OA);
    if (activeOaMembership) {
      const activeOaCount = await prisma.membership.count({
        where: {
          orgId: activeOaMembership.orgId,
          role: OrgRole.OA,
          status: MembershipStatus.ACTIVE,
        },
      });
      if (activeOaCount <= 1) {
        return res.status(200).json({ ok: false,
          error: {
            code: "LAST_ORG_ADMIN",
            message: "Cannot suspend the last active Organization Administrator of an active organization.",
          },
        });
      }
    }

    // Execute suspension
    await prisma.user.update({
      where: { id: targetId },
      data: { status: AccountStatus.SUSPENDED },
    });

    // Revoke all sessions immediately
    await prisma.session.updateMany({
      where: { userId: targetId, revokedAt: null },
      data: { revokedAt: new Date() },
    });

    // Close real-time sockets immediately (ADM-05)
    await disconnectUserSockets(targetId, { reason: "Your account was suspended." });
    for (const m of targetUser.memberships) emitToOrg(m.orgId, "member:updated", { userId: targetId });
    // Waits in their inbox until they're reactivated.
    await notify("account.suspended", { kind: "user", id: targetId }, auth.user.id);

    // Send notification email to the user
    try {
      await sendAccountSuspendedEmail(targetUser.email, targetUser.firstName, reason);
    } catch (mailErr) {
      console.warn("[Admin] Could not send suspension email:", mailErr);
    }

    return res.status(200).json({
      message: `Account for ${targetUser.email} has been suspended.`,
    });
  } catch (err: any) {
    console.error("[Admin] Suspend user error:", err);
    return res.status(500).json({
      error: { code: "INTERNAL_ERROR", message: "Failed to suspend account." },
    });
  }
});

adminRouter.post("/users/:id/reactivate", async (req: Request, res: Response) => {
  const auth = await requireSystemAdmin(req, res);
  if (!auth) return;

  const targetId = req.params.id;

  try {
    const targetUser = await prisma.user.findUnique({
      where: { id: targetId },
    });

    if (!targetUser) {
      return res.status(200).json({ ok: false,
        error: { code: "NOT_FOUND", message: "User account not found." },
      });
    }

    if (targetUser.status === AccountStatus.ACTIVE) {
      return res.status(200).json({ ok: false,
        error: { code: "ALREADY_ACTIVE", message: "Account is already active." },
      });
    }

    if (targetUser.status === AccountStatus.DELETED) {
      return res.status(200).json({ ok: false,
        error: { code: "CANNOT_REACTIVATE_DELETED", message: "Cannot reactivate a deleted account." },
      });
    }

    await prisma.user.update({
      where: { id: targetId },
      data: {
        status: AccountStatus.ACTIVE,
        failedLoginCount: 0,
        lockedUntil: null,
      },
    });

    await notify("account.reactivated", { kind: "user", id: targetId }, auth.user.id);

    try {
      await sendAccountReactivatedEmail(targetUser.email, targetUser.firstName);
    } catch (mailErr) {
      console.warn("[Admin] Could not send reactivation email:", mailErr);
    }

    return res.status(200).json({
      message: `Account for ${targetUser.email} has been reactivated.`,
    });
  } catch (err: any) {
    console.error("[Admin] Reactivate user error:", err);
    return res.status(500).json({
      error: { code: "INTERNAL_ERROR", message: "Failed to reactivate account." },
    });
  }
});

// =========================================================================
// ADM-06: Delete users
// Typed email confirmation. Soft delete with anonymization (§7.1).
// Refused for the last OA of an org or the last SA. Email sent before anonymization.
// =========================================================================
adminRouter.delete("/users/:id", async (req: Request, res: Response) => {
  const auth = await requireSystemAdmin(req, res);
  if (!auth) return;

  const targetId = req.params.id;
  const confirmEmail = typeof req.body?.confirmEmail === "string" ? req.body.confirmEmail.trim() : "";

  try {
    const targetUser = await prisma.user.findUnique({
      where: { id: targetId },
      include: {
        memberships: {
          where: { status: MembershipStatus.ACTIVE },
        },
      },
    });

    if (!targetUser) {
      return res.status(200).json({ ok: false,
        error: { code: "NOT_FOUND", message: "User account not found." },
      });
    }

    if (targetUser.status === AccountStatus.DELETED) {
      return res.status(200).json({ ok: false,
        error: { code: "ALREADY_DELETED", message: "Account is already deleted." },
      });
    }

    if (targetUser.id === auth.user.id) {
      return res.status(200).json({ ok: false,
        error: { code: "CANNOT_DELETE_SELF", message: "You can't delete your own account from the admin panel." },
      });
    }

    // 1. Typed email confirmation
    if (confirmEmail.toLowerCase() !== targetUser.email.toLowerCase()) {
      return res.status(200).json({ ok: false,
        error: {
          code: "CONFIRMATION_MISMATCH",
          message: `Confirmation email "${confirmEmail}" does not match target account email.`,
        },
      });
    }

    // 2. Cannot delete last active SA
    if (targetUser.isSystemAdmin) {
      const activeSaCount = await prisma.user.count({
        where: { isSystemAdmin: true, status: AccountStatus.ACTIVE },
      });
      if (activeSaCount <= 1) {
        return res.status(200).json({ ok: false,
          error: { code: "LAST_SA", message: "Cannot delete the last active System Administrator." },
        });
      }
    }

    // 3. Cannot delete last active OA of an active organization
    const activeOaMembership = targetUser.memberships.find((m) => m.role === OrgRole.OA);
    if (activeOaMembership) {
      const activeOaCount = await prisma.membership.count({
        where: {
          orgId: activeOaMembership.orgId,
          role: OrgRole.OA,
          status: MembershipStatus.ACTIVE,
        },
      });
      if (activeOaCount <= 1) {
        return res.status(200).json({ ok: false,
          error: {
            code: "LAST_ORG_ADMIN",
            message: "Cannot delete the last active Organization Administrator of an active organization.",
          },
        });
      }
    }

    // 4. Send email to user BEFORE anonymization (ADM-06 requirement)
    try {
      await sendAccountDeletedEmail(targetUser.email, targetUser.firstName);
    } catch (mailErr) {
      console.warn("[Admin] Could not send deletion notice email:", mailErr);
    }

    // 5. Anonymize in one transaction (§7.1).
    const now = new Date();
    let exFriends: string[] = [];
    await prisma.$transaction(async (tx) => {
      await tx.session.updateMany({ where: { userId: targetId, revokedAt: null }, data: { revokedAt: now } });
      await tx.twoFactor.deleteMany({ where: { userId: targetId } });
      await tx.recoveryCode.deleteMany({ where: { userId: targetId } });
      await tx.membership.updateMany({
        where: { userId: targetId, status: MembershipStatus.ACTIVE },
        data: { status: MembershipStatus.REMOVED, leftAt: now },
      });
      await tx.projectAccess.updateMany({ where: { userId: targetId, revokedAt: null }, data: { revokedAt: now } });
      exFriends = await endFriendshipsForUser(tx, targetId);
      await tx.task.updateMany({ where: { assigneeId: targetId }, data: { assigneeId: null } });
      await tx.user.update({
        where: { id: targetId },
        data: {
          firstName: "Deleted",
          lastName: "user",
          jobTitle: null,
          bio: null,
          avatarPath: null,
          email: `deleted-${targetId}@invalid`,
          passwordHash: null,
          isSystemAdmin: false,
          status: AccountStatus.DELETED,
          deletedAt: now,
        },
      });
    });
    await disconnectUserSockets(targetId, { reason: "Your account was deleted." });
    emitFriendshipChange(exFriends, { reason: "deleted" });
    for (const m of targetUser.memberships) emitToOrg(m.orgId, "member:updated", { userId: targetId });
    await deleteAvatarFile(targetUser.avatarPath);

    return res.status(200).json({
      message: `Account for ${confirmEmail} has been soft-deleted and anonymized.`,
    });
  } catch (err: any) {
    console.error("[Admin] Delete user error:", err);
    return res.status(500).json({
      error: { code: "INTERNAL_ERROR", message: "Failed to delete user account." },
    });
  }
});

// =========================================================================
// ADM-02: Create users / Send invitations (including SA invitations)
// =========================================================================
adminRouter.post("/invitations", async (req: Request, res: Response) => {
  const auth = await requireSystemAdmin(req, res);
  if (!auth) return;

  const { email, role, orgId } = req.body;
  const isSa = req.body.isSa === true || role === "SA";

  if (!email || typeof email !== "string" || !email.includes("@")) {
    return res.status(200).json({ ok: false,
      error: { code: "INVALID_EMAIL", message: "Valid email address is required." },
    });
  }

  const cleanEmail = email.toLowerCase().trim();

  try {
    if (isSa) {
      try {
        const inv = await createSaInvitation({ email: cleanEmail, inviter: auth.user });
        return res.status(200).json({ message: `System Administrator invitation sent to ${inv.email}.` });
      } catch (e) {
        if (e instanceof InvitationError) {
          return isRefusal(e.status) ? refuse(res, e.code, e.message) : res.status(e.status).json({ error: { code: e.code, message: e.message } });
        }
        throw e;
      }
    }

    // Organization invitation (INV-01): same rules as the org route.
    if (!orgId) {
      return res.status(200).json({ ok: false,
        error: { code: "MISSING_ORG", message: "Pick the organization they'll join." },
      });
    }
    const inviteRole: InvitationRole = role === "OA" ? "OA" : role === "VIEWER" ? "VIEWER" : "MEMBER";
    try {
      const inv = await createOrgInvitation({ orgId, email: cleanEmail, role: inviteRole, inviter: auth.user });
      return res.status(201).json({ message: `Invitation sent to ${inv.email}.` });
    } catch (e) {
      if (e instanceof InvitationError) {
        return isRefusal(e.status) ? refuse(res, e.code, e.message) : res.status(e.status).json({ error: { code: e.code, message: e.message } });
      }
      throw e;
    }
  } catch (err: any) {
    console.error("[Admin] Send invitation error:", err);
    return res.status(500).json({
      error: { code: "INTERNAL_ERROR", message: "Failed to send invitation." },
    });
  }
});

// =========================================================================
// ORG-02: SA organization list + detail
// =========================================================================
adminRouter.get("/orgs", async (req: Request, res: Response) => {
  const auth = await requireSystemAdmin(req, res);
  if (!auth) return;

  try {
    const orgs = await prisma.organization.findMany({
      where: { deletedAt: null },
      select: {
        id: true,
        name: true,
        description: true,
        createdAt: true,
        _count: {
          select: {
            memberships: { where: { status: MembershipStatus.ACTIVE } },
            projects: { where: { deletedAt: null } },
          },
        },
      },
      orderBy: { name: "asc" },
    });

    return res.status(200).json({
      organizations: orgs.map((o) => ({
        id: o.id,
        name: o.name,
        description: o.description,
        createdAt: o.createdAt,
        memberCount: o._count.memberships,
        projectCount: o._count.projects,
      })),
    });
  } catch (err: any) {
    console.error("[Admin] List organizations error:", err);
    return res.status(500).json({
      error: { code: "INTERNAL_ERROR", message: "Failed to retrieve organizations." },
    });
  }
});

// ORG-01 (SA path): the SA creates the org without joining it, then invites
// the first OA.
adminRouter.post("/orgs", async (req: Request, res: Response) => {
  const auth = await requireSystemAdmin(req, res);
  if (!auth) return;

  const parsed = CreateOrgSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(200).json({ ok: false,
      error: { code: "VALIDATION_ERROR", message: parsed.error.errors[0]?.message || "Invalid organization details." },
    });
  }
  const { name, description } = parsed.data;
  const firstOaEmail =
    typeof req.body.firstOaEmail === "string" ? req.body.firstOaEmail.trim().toLowerCase() : "";
  if (firstOaEmail && !firstOaEmail.includes("@")) {
    return res.status(200).json({ ok: false, error: { code: "INVALID_EMAIL", message: "Enter a valid email for the first Org Admin." } });
  }

  try {
    if (await findActiveOrgByName(name)) {
      return res.status(200).json({ ok: false,
        error: { code: "ORG_NAME_TAKEN", message: `An organization named "${name}" already exists.` },
      });
    }

    const { raw: rawToken, hash: tokenHash } = generateSecureToken();
    const { org, firstOaInvitation } = await prisma.$transaction(async (tx) => {
      const created = await tx.organization.create({
        data: { name, description: description || null, createdById: auth.user.id },
      });
      if (firstOaEmail) {
        const expiresAt = new Date();
        expiresAt.setDate(expiresAt.getDate() + 7);
        const invitation = await tx.invitation.create({
          data: {
            orgId: created.id,
            email: firstOaEmail,
            role: InvitationRole.OA,
            tokenHash,
            expiresAt,
            invitedById: auth.user.id,
          },
        });
        return { org: created, firstOaInvitation: invitation };
      }
      return { org: created, firstOaInvitation: null };
    });

    if (firstOaEmail) {
      try {
        await sendInvitationEmail(firstOaEmail, org.name, `${auth.user.firstName} ${auth.user.lastName}`, rawToken);
      } catch (mailErr) {
        console.warn("[Admin] Could not send first-OA invitation email:", mailErr);
      }
    }
    if (firstOaInvitation) await notifyInvitation("invitation.received", firstOaInvitation, org.name, auth.user.id);

    return res.status(201).json({
      message: firstOaEmail
        ? `${org.name} created. Invitation sent to ${firstOaEmail}.`
        : `${org.name} created.`,
      organization: { id: org.id, name: org.name, description: org.description },
    });
  } catch (err: any) {
    if (err?.code === "P2002") {
      return res.status(200).json({ ok: false,
        error: { code: "ORG_NAME_TAKEN", message: `An organization named "${name}" already exists.` },
      });
    }
    console.error("[Admin] Create organization error:", err);
    return res.status(500).json({
      error: { code: "INTERNAL_ERROR", message: "Failed to create organization." },
    });
  }
});

adminRouter.get("/orgs/:id", async (req: Request, res: Response) => {
  const auth = await requireSystemAdmin(req, res);
  if (!auth) return;

  try {
    const org = await prisma.organization.findFirst({
      where: { id: req.params.id, deletedAt: null },
      include: {
        createdBy: { select: { firstName: true, lastName: true } },
        memberships: {
          where: { status: MembershipStatus.ACTIVE },
          include: {
            user: {
              select: { id: true, firstName: true, lastName: true, email: true, avatarPath: true, status: true },
            },
          },
          orderBy: [{ role: "asc" }, { joinedAt: "asc" }],
        },
        projects: {
          where: { deletedAt: null },
          select: {
            id: true,
            key: true,
            name: true,
            _count: { select: { tasks: { where: { deletedAt: null } } } },
          },
          orderBy: { key: "asc" },
        },
        invitations: {
          where: { status: InvitationStatus.PENDING, expiresAt: { gt: new Date() } },
          select: { id: true, email: true, role: true, expiresAt: true },
          orderBy: { createdAt: "desc" },
        },
      },
    });

    if (!org) {
      return res.status(200).json({ ok: false, error: { code: "NOT_FOUND", message: "Organization not found." } });
    }

    const projectIds = org.projects.map((p) => p.id);
    const comments = projectIds.length
      ? await prisma.comment.count({ where: { deletedAt: null, task: { deletedAt: null, projectId: { in: projectIds } } } })
      : 0;

    return res.status(200).json({
      organization: {
        id: org.id,
        name: org.name,
        description: org.description,
        createdAt: org.createdAt,
        createdByName: `${org.createdBy.firstName} ${org.createdBy.lastName}`.trim(),
        members: org.memberships.map((m) => ({
          userId: m.user.id,
          fullName: `${m.user.firstName} ${m.user.lastName}`.trim(),
          email: m.user.email,
          avatarPath: m.user.avatarPath,
          accountStatus: m.user.status,
          role: m.role,
          joinedAt: m.joinedAt,
        })),
        projects: org.projects.map((p) => ({ id: p.id, key: p.key, name: p.name, taskCount: p._count.tasks })),
        pendingInvitations: org.invitations,
        counts: {
          members: org.memberships.length,
          projects: org.projects.length,
          tasks: org.projects.reduce((n, p) => n + p._count.tasks, 0),
          comments,
          pendingInvitations: org.invitations.length,
        },
      },
    });
  } catch (err: any) {
    console.error("[Admin] Get organization error:", err);
    return res.status(500).json({
      error: { code: "INTERNAL_ERROR", message: "Failed to retrieve organization." },
    });
  }
});

// ORG-03: Edit an org
adminRouter.patch("/orgs/:id", async (req: Request, res: Response) => {
  const auth = await requireSystemAdmin(req, res);
  if (!auth) return;

  const parsed = CreateOrgSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(200).json({ ok: false,
      error: { code: "VALIDATION_ERROR", message: parsed.error.errors[0]?.message || "Invalid organization details." },
    });
  }
  const { name, description } = parsed.data;

  try {
    const updated = await updateOrganization(req.params.id, auth.user.id, { name, description });
    return res.status(200).json({
      message: "Organization updated.",
      organization: { id: updated.id, name: updated.name, description: updated.description },
    });
  } catch (err: any) {
    if (err instanceof OrgError) return isRefusal(err.status) ? refuse(res, err.code, err.message) : res.status(err.status).json({ error: { code: err.code, message: err.message } });
    console.error("[Admin] Update organization error:", err);
    return res.status(500).json({
      error: { code: "INTERNAL_ERROR", message: "Failed to update organization." },
    });
  }
});

// ORG-04: Delete an org (typed name). Soft-deletes the org and everything
// under it, revokes pending invitations, ends memberships and friendships
// between its members, and emails every member.
adminRouter.delete("/orgs/:id", async (req: Request, res: Response) => {
  const auth = await requireSystemAdmin(req, res);
  if (!auth) return;

  const confirmName = typeof req.body?.confirmName === "string" ? req.body.confirmName.trim() : "";

  try {
    const { name, memberCount } = await deleteOrganization(req.params.id, auth.user.id, confirmName);
    return res.status(200).json({ message: `${name} deleted. ${memberCount} members are now unaffiliated.` });
  } catch (err: any) {
    if (err instanceof OrgError) return isRefusal(err.status) ? refuse(res, err.code, err.message) : res.status(err.status).json({ error: { code: err.code, message: err.message } });
    console.error("[Admin] Delete organization error:", err);
    return res.status(500).json({
      error: { code: "INTERNAL_ERROR", message: "Failed to delete organization." },
    });
  }
});
