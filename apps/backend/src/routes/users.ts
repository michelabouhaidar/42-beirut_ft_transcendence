import express, { Router, Request, Response, NextFunction } from "express";
import path from "path";
import { Prisma, FriendshipStatus, MembershipStatus } from "@prisma/client";
import { prisma } from "../app";
import { requireAuth } from "../services/auth";
import {
  AVATAR_DIR,
  AVATAR_MAX_BYTES,
  deleteAvatarFile,
  detectImageType,
  isAvatarFileName,
  saveAvatar,
} from "../services/avatars";
import { FriendshipState, emitFriendshipChange, friendIdsOf, friendshipStateFor, loadPresence, shareOrganization } from "../services/friends";
import { notify } from "../services/notifications";
import { FriendRequestSchema } from "../schemas";
import { isRefusal, refuse } from "../services/refusal";

export const usersRouter = Router();

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function fail(res: Response, status: number, code: string, message: string) {
  if (isRefusal(status)) return refuse(res, code, message);
  return res.status(status).json({ error: { code, message } });
}

function serverError(res: Response, label: string, err: unknown) {
  console.error(`[Users] ${label}:`, err);
  return fail(res, 500, "INTERNAL_ERROR", "Something went wrong. Please try again.");
}

const publicUserSelect = {
  id: true,
  firstName: true,
  lastName: true,
  jobTitle: true,
  avatarPath: true,
} satisfies Prisma.UserSelect;

// ---------------------------------------------------------------------------
// Avatar (USR-02)
// ---------------------------------------------------------------------------

// Raw image body, max 2 MB. Reports size and type problems as 4xx instead of a 500.
function readImageBody(req: Request, res: Response, next: NextFunction) {
  express.raw({ type: ["image/jpeg", "image/png", "image/webp"], limit: AVATAR_MAX_BYTES })(req, res, (err?: unknown) => {
    if ((err as { type?: string } | undefined)?.type === "entity.too.large") {
      return fail(res, 413, "FILE_TOO_LARGE", "The image must be 2 MB or smaller.");
    }
    if (err) return next(err);
    next();
  });
}

usersRouter.post("/users/me/avatar", readImageBody, async (req: Request, res: Response) => {
  const auth = await requireAuth(req, res);
  if (!auth) return;

  const body = req.body;
  if (!Buffer.isBuffer(body) || body.length === 0) {
    return fail(res, 415, "UNSUPPORTED_TYPE", "Upload a JPEG, PNG or WebP image.");
  }
  if (!detectImageType(body)) {
    return fail(res, 415, "UNSUPPORTED_TYPE", "That file is not a JPEG, PNG or WebP image.");
  }

  let avatarPath: string;
  try {
    avatarPath = await saveAvatar(body);
  } catch {
    // sharp could not decode it: corrupt or truncated image.
    return fail(res, 422, "INVALID_IMAGE", "That image could not be read. Try a different file.");
  }

  try {
    const previous = await prisma.user.findUnique({ where: { id: auth.user.id }, select: { avatarPath: true } });
    await prisma.user.update({ where: { id: auth.user.id }, data: { avatarPath } });
    await deleteAvatarFile(previous?.avatarPath);
    return res.status(200).json({ avatarPath });
  } catch (err) {
    await deleteAvatarFile(avatarPath);
    return serverError(res, "Avatar upload", err);
  }
});

usersRouter.delete("/users/me/avatar", async (req: Request, res: Response) => {
  const auth = await requireAuth(req, res);
  if (!auth) return;
  try {
    const previous = await prisma.user.findUnique({ where: { id: auth.user.id }, select: { avatarPath: true } });
    await prisma.user.update({ where: { id: auth.user.id }, data: { avatarPath: null } });
    await deleteAvatarFile(previous?.avatarPath);
    return res.status(200).json({ avatarPath: null });
  } catch (err) {
    return serverError(res, "Avatar removal", err);
  }
});

// Only logged-in users can fetch avatars. File names are random, so they can be cached for good.
usersRouter.get("/avatars/:file", async (req: Request, res: Response) => {
  const auth = await requireAuth(req, res);
  if (!auth) return;
  const file = req.params.file;
  if (!isAvatarFileName(file)) return fail(res, 404, "NOT_FOUND", "Avatar not found.");
  res.set("Cache-Control", "private, max-age=31536000, immutable");
  res.set("X-Content-Type-Options", "nosniff");
  res.sendFile(path.join(AVATAR_DIR, file), (err) => {
    if (err && !res.headersSent) fail(res, 404, "NOT_FOUND", "Avatar not found.");
  });
});

// ---------------------------------------------------------------------------
// Member directory (USR-04)
// ---------------------------------------------------------------------------

usersRouter.get("/orgs/current/members", async (req: Request, res: Response) => {
  const auth = await requireAuth(req, res);
  if (!auth) return;
  if (!auth.organization) return fail(res, 403, "NO_ORGANIZATION", "You need to belong to an organization to see its members.");

  const pageSize = Math.min(50, Math.max(1, parseInt(String(req.query.pageSize ?? "20"), 10) || 20));
  const page = Math.max(1, parseInt(String(req.query.page ?? "1"), 10) || 1);
  const tokens = String(req.query.q ?? "")
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 5);

  const where: Prisma.MembershipWhereInput = {
    orgId: auth.organization.id,
    status: MembershipStatus.ACTIVE,
    user: {
      status: "ACTIVE",
      deletedAt: null,
      AND: tokens.map((t) => ({
        OR: [
          { firstName: { contains: t, mode: "insensitive" as const } },
          { lastName: { contains: t, mode: "insensitive" as const } },
          { jobTitle: { contains: t, mode: "insensitive" as const } },
        ],
      })),
    },
  };

  try {
    const [total, orgAdminCount, rows] = await Promise.all([
      prisma.membership.count({ where }),
      prisma.membership.count({ where: { orgId: auth.organization.id, role: "OA", status: MembershipStatus.ACTIVE } }),
      prisma.membership.findMany({
        where,
        select: { role: true, user: { select: publicUserSelect } },
        orderBy: [{ user: { lastName: "asc" } }, { user: { firstName: "asc" } }, { id: "asc" }],
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
    ]);

    const ids = rows.map((r) => r.user.id);
    const friendships = await prisma.friendship.findMany({
      where: {
        status: { in: [FriendshipStatus.PENDING, FriendshipStatus.ACCEPTED] },
        OR: [
          { requesterId: auth.user.id, addresseeId: { in: ids } },
          { addresseeId: auth.user.id, requesterId: { in: ids } },
        ],
      },
      select: { id: true, requesterId: true, addresseeId: true, status: true },
    });
    const byOther = new Map(friendships.map((f) => [f.requesterId === auth.user.id ? f.addresseeId : f.requesterId, f]));
    // Online status is shown for friends only (USR-06).
    const presence = await loadPresence(
      friendships.filter((f) => f.status === FriendshipStatus.ACCEPTED).map((f) => (f.requesterId === auth.user.id ? f.addresseeId : f.requesterId))
    );

    return res.status(200).json({
      members: rows.map((r) => {
        const f = byOther.get(r.user.id);
        return {
          userId: r.user.id,
          firstName: r.user.firstName,
          lastName: r.user.lastName,
          jobTitle: r.user.jobTitle,
          avatarPath: r.user.avatarPath,
          role: r.role,
          friendship: { state: friendshipStateFor(auth.user.id, f), id: f?.id ?? null },
          presence: presence.get(r.user.id) ?? null,
        };
      }),
      total,
      orgAdminCount,
      page,
      pageSize,
    });
  } catch (err) {
    return serverError(res, "Member directory", err);
  }
});

// ---------------------------------------------------------------------------
// Profile page (USR-03)
// ---------------------------------------------------------------------------

usersRouter.get("/users/:id", async (req: Request, res: Response) => {
  const auth = await requireAuth(req, res);
  if (!auth) return;

  const targetId = req.params.id;
  const notFound = () => fail(res, 404, "NOT_FOUND", "User not found.");
  if (!UUID_RE.test(targetId)) return notFound();

  const isSelf = targetId === auth.user.id;
  try {
    // Visible to the user themself, to members of the same organization, and to System Admins.
    if (!isSelf && !auth.user.isSystemAdmin && !(await shareOrganization(prisma, auth.user.id, targetId))) {
      return notFound();
    }

    const target = await prisma.user.findFirst({
      where: { id: targetId, status: "ACTIVE", deletedAt: null },
      select: {
        ...publicUserSelect,
        bio: true,
        createdAt: true,
        isSystemAdmin: true,
        memberships: {
          where: { status: MembershipStatus.ACTIVE, organization: { deletedAt: null } },
          select: { role: true, joinedAt: true, organization: { select: { id: true, name: true } } },
          take: 1,
        },
      },
    });
    if (!target) return notFound();

    const membership = target.memberships[0];
    const row =
      isSelf || !membership
        ? undefined
        : await prisma.friendship.findFirst({
            where: {
              status: { in: [FriendshipStatus.PENDING, FriendshipStatus.ACCEPTED] },
              OR: [
                { requesterId: auth.user.id, addresseeId: targetId },
                { requesterId: targetId, addresseeId: auth.user.id },
              ],
            },
            select: { id: true, requesterId: true, status: true, updatedAt: true },
          });
    const state: FriendshipState = friendshipStateFor(auth.user.id, row ?? undefined);
    // Work and friends, for people in the viewer's own organization (USR-03).
    const work =
      membership && auth.organization?.id === membership.organization.id
        ? await profileWork(auth.user.id, auth.role, targetId, membership.organization.id, membership.role)
        : null;

    return res.status(200).json({
      user: {
        id: target.id,
        firstName: target.firstName,
        lastName: target.lastName,
        jobTitle: target.jobTitle,
        bio: target.bio,
        avatarPath: target.avatarPath,
        organization: membership?.organization ?? null,
        role: target.isSystemAdmin ? "SA" : membership?.role ?? null,
        memberSince: membership?.joinedAt ?? target.createdAt,
      },
      isSelf,
      friendship: { state, id: row?.id ?? null },
      // Presence is only shown to the user and their friends.
      presence: isSelf || state === "FRIENDS" ? (await loadPresence([target.id])).get(target.id) : null,
      canRequestFriend: !isSelf && !auth.user.isSystemAdmin && Boolean(membership) && state === "NONE",
      friendsSince: state === "FRIENDS" ? row?.updatedAt ?? null : null,
      work,
    });
  } catch (err) {
    return serverError(res, "Profile", err);
  }
});

// Profile extras (USR-03): only what the viewer may see. Tasks and projects come from projects the
// viewer can open (OA: all of the org's; Members and Viewers: those with access).
async function profileWork(viewerId: string, viewerRole: string, targetId: string, orgId: string, targetRole: string) {
  const live = { orgId, deletedAt: null };
  const viewerProjects = await prisma.project.findMany({
    where: viewerRole === "OA" ? live : { ...live, accessList: { some: { userId: viewerId, revokedAt: null } } },
    select: { id: true, key: true, name: true },
    orderBy: { name: "asc" },
  });
  const visible = viewerProjects.map((p) => p.id);
  // Projects the target works in, among those the viewer can see.
  const targetAccess =
    targetRole === "OA"
      ? new Set(visible)
      : new Set(
          (await prisma.projectAccess.findMany({ where: { userId: targetId, revokedAt: null, projectId: { in: visible } }, select: { projectId: true } })).map(
            (a) => a.projectId
          )
        );

  const today = new Date(new Date().toISOString().slice(0, 10) + "T00:00:00Z");
  const monthAgo = new Date(Date.now() - 30 * 86400000);
  const mine = { assigneeId: targetId, deletedAt: null, projectId: { in: visible } };
  const taskSelect = {
    number: true,
    title: true,
    status: true,
    priority: true,
    dueDate: true,
    completedAt: true,
    updatedAt: true,
    project: { select: { key: true, name: true } },
  } as const;
  const [open, overdue, doneRecently, openTasks, completed, openByProject, targetFriends, viewerFriends] = await Promise.all([
    prisma.task.count({ where: { ...mine, status: { not: "DONE" } } }),
    prisma.task.count({ where: { ...mine, status: { not: "DONE" }, dueDate: { lt: today } } }),
    prisma.task.count({ where: { ...mine, status: "DONE", completedAt: { gte: monthAgo } } }),
    prisma.task.findMany({
      where: { ...mine, status: { not: "DONE" } },
      select: taskSelect,
      orderBy: [{ dueDate: { sort: "asc", nulls: "last" } }, { updatedAt: "desc" }],
      take: 8,
    }),
    prisma.task.findMany({ where: { ...mine, status: "DONE" }, select: taskSelect, orderBy: { completedAt: "desc" }, take: 5 }),
    prisma.task.groupBy({ by: ["projectId"], where: { ...mine, status: { not: "DONE" } }, _count: { _all: true } }),
    friendIdsOf(targetId),
    friendIdsOf(viewerId),
  ]);
  const openCount = new Map(openByProject.map((r) => [r.projectId, r._count._all]));
  const mutualIds = [...targetFriends].filter((id) => id !== viewerId && viewerFriends.has(id));
  const mutual = await prisma.user.findMany({
    where: { id: { in: mutualIds }, status: "ACTIVE", memberships: { some: { orgId, status: MembershipStatus.ACTIVE } } },
    select: { id: true, firstName: true, lastName: true, avatarPath: true },
    orderBy: [{ firstName: "asc" }, { lastName: "asc" }],
  });
  const card = (t: (typeof openTasks)[number]) => ({
    key: `${t.project.key}-${t.number}`,
    projectKey: t.project.key,
    projectName: t.project.name,
    number: t.number,
    title: t.title,
    status: t.status,
    priority: t.priority,
    dueDate: t.dueDate ? t.dueDate.toISOString().slice(0, 10) : null,
    completedAt: t.completedAt,
    updatedAt: t.updatedAt,
  });
  return {
    stats: { open, overdue, doneLast30Days: doneRecently },
    openTasks: openTasks.map(card),
    recentlyCompleted: completed.map(card),
    projects: viewerProjects
      .filter((p) => targetAccess.has(p.id))
      .map((p) => ({ key: p.key, name: p.name, openAssigned: openCount.get(p.id) ?? 0 })),
    friendCount: targetFriends.size,
    mutualFriends: mutual.map((u) => ({ id: u.id, name: `${u.firstName} ${u.lastName}`, avatarPath: u.avatarPath })),
  };
}

// ---------------------------------------------------------------------------
// Friends (USR-05)
// ---------------------------------------------------------------------------

usersRouter.get("/friends", async (req: Request, res: Response) => {
  const auth = await requireAuth(req, res);
  if (!auth) return;
  if (!auth.organization) return res.status(200).json({ friends: [], incoming: [], outgoing: [] });

  try {
    const rows = await prisma.friendship.findMany({
      where: {
        status: { in: [FriendshipStatus.PENDING, FriendshipStatus.ACCEPTED] },
        OR: [{ requesterId: auth.user.id }, { addresseeId: auth.user.id }],
        // Only people who are still in the viewer's organization.
        requester: { memberships: { some: { orgId: auth.organization.id, status: MembershipStatus.ACTIVE } } },
        addressee: { memberships: { some: { orgId: auth.organization.id, status: MembershipStatus.ACTIVE } } },
      },
      select: {
        id: true,
        requesterId: true,
        status: true,
        createdAt: true,
        updatedAt: true,
        requester: { select: { ...publicUserSelect } },
        addressee: { select: { ...publicUserSelect } },
      },
      orderBy: { updatedAt: "desc" },
    });

    const otherIds = rows.map((r) => (r.requesterId === auth.user.id ? r.addressee.id : r.requesterId));
    const presence = await loadPresence(otherIds);
    const friends: unknown[] = [];
    const incoming: unknown[] = [];
    const outgoing: unknown[] = [];
    for (const r of rows) {
      const other = r.requesterId === auth.user.id ? r.addressee : r.requester;
      const user = other;
      const item = { friendshipId: r.id, user, since: r.updatedAt, requestedAt: r.createdAt };
      if (r.status === FriendshipStatus.ACCEPTED) friends.push({ ...item, presence: presence.get(user.id) });
      else if (r.requesterId === auth.user.id) outgoing.push(item);
      else incoming.push(item);
    }
    return res.status(200).json({ friends, incoming, outgoing });
  } catch (err) {
    return serverError(res, "Friends list", err);
  }
});

usersRouter.post("/friends/requests", async (req: Request, res: Response) => {
  const auth = await requireAuth(req, res);
  if (!auth) return;

  const parsed = FriendRequestSchema.safeParse(req.body);
  if (!parsed.success) return fail(res, 422, "VALIDATION_ERROR", "Choose a person to send the request to.");
  const targetId = parsed.data.userId;

  if (targetId === auth.user.id) return fail(res, 422, "CANNOT_FRIEND_SELF", "You can't send a friend request to yourself.");
  if (auth.user.isSystemAdmin || !auth.organization) {
    return fail(res, 403, "NO_ORGANIZATION", "You need to belong to an organization to add friends.");
  }

  try {
    const result = await prisma.$transaction(async (tx) => {
      // Serialize requests between the same two people so two clicks can't both create a row.
      const [a, b] = [auth.user.id, targetId].sort();
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${a + b}))`;

      const orgId = await shareOrganization(tx, auth.user.id, targetId);
      if (!orgId || orgId !== auth.organization!.id) return { error: "OTHER_ORG" as const };

      const existing = await tx.friendship.findFirst({
        where: {
          status: { in: [FriendshipStatus.PENDING, FriendshipStatus.ACCEPTED] },
          OR: [
            { requesterId: auth.user.id, addresseeId: targetId },
            { requesterId: targetId, addresseeId: auth.user.id },
          ],
        },
        select: { status: true },
      });
      if (existing) {
        return { error: existing.status === FriendshipStatus.ACCEPTED ? ("ALREADY_FRIENDS" as const) : ("ALREADY_PENDING" as const) };
      }

      const friendship = await tx.friendship.create({
        data: { requesterId: auth.user.id, addresseeId: targetId },
        select: { id: true },
      });
      return { friendship };
    });

    if ("error" in result) {
      if (result.error === "OTHER_ORG") return fail(res, 403, "NOT_SAME_ORG", "You can only add people from your own organization.");
      if (result.error === "ALREADY_FRIENDS") return fail(res, 409, "ALREADY_FRIENDS", "You are already friends.");
      return fail(res, 409, "REQUEST_PENDING", "A friend request between you two is already pending.");
    }

    emitFriendshipChange([auth.user.id, targetId], { friendshipId: result.friendship.id, reason: "requested" });
    await notify("friend.request_received", { kind: "friendship", id: result.friendship.id, userId: targetId }, auth.user.id);
    return res.status(201).json({ friendshipId: result.friendship.id });
  } catch (err) {
    return serverError(res, "Friend request", err);
  }
});

async function loadFriendship(req: Request, res: Response, viewerId: string) {
  const id = req.params.id;
  if (!UUID_RE.test(id)) {
    fail(res, 404, "NOT_FOUND", "Friend request not found.");
    return null;
  }
  const f = await prisma.friendship.findUnique({ where: { id } });
  if (!f || (f.requesterId !== viewerId && f.addresseeId !== viewerId)) {
    fail(res, 404, "NOT_FOUND", "Friend request not found.");
    return null;
  }
  return f;
}

// Accept or decline: only the addressee, only while pending.
function respondTo(action: "accept" | "decline") {
  return async (req: Request, res: Response) => {
    const auth = await requireAuth(req, res);
    if (!auth) return;
    try {
      const f = await loadFriendship(req, res, auth.user.id);
      if (!f) return;
      if (f.addresseeId !== auth.user.id || f.status !== FriendshipStatus.PENDING) {
        return fail(res, 409, "NOT_PENDING", "This request can't be answered any more.");
      }
      if (action === "accept" && !(await shareOrganization(prisma, auth.user.id, f.requesterId))) {
        return fail(res, 409, "NOT_SAME_ORG", "You no longer share an organization with this person.");
      }
      // Conditional update so a request cancelled a moment ago can't be accepted.
      const { count } = await prisma.friendship.updateMany({
        where: { id: f.id, status: FriendshipStatus.PENDING },
        data: { status: action === "accept" ? FriendshipStatus.ACCEPTED : FriendshipStatus.DECLINED },
      });
      if (count === 0) return fail(res, 409, "NOT_PENDING", "This request can't be answered any more.");
      emitFriendshipChange([f.requesterId, f.addresseeId], { friendshipId: f.id, reason: action === "accept" ? "accepted" : "declined" });
      // A decline is silent (§6.9 lists only received and accepted).
      if (action === "accept") {
        await notify("friend.request_accepted", { kind: "friendship", id: f.id, userId: f.requesterId }, auth.user.id);
      }
      return res.status(200).json({ status: action === "accept" ? "ACCEPTED" : "DECLINED" });
    } catch (err) {
      return serverError(res, `Friend request ${action}`, err);
    }
  };
}
usersRouter.post("/friendships/:id/accept", respondTo("accept"));
usersRouter.post("/friendships/:id/decline", respondTo("decline"));

// Remove a friend (either side) or cancel an outgoing request (sender).
usersRouter.delete("/friendships/:id", async (req: Request, res: Response) => {
  const auth = await requireAuth(req, res);
  if (!auth) return;
  try {
    const f = await loadFriendship(req, res, auth.user.id);
    if (!f) return;
    const allowed =
      f.status === FriendshipStatus.ACCEPTED || (f.status === FriendshipStatus.PENDING && f.requesterId === auth.user.id);
    if (!allowed) return fail(res, 409, "NOT_REMOVABLE", "There is nothing to remove.");
    const { count } = await prisma.friendship.updateMany({
      where: { id: f.id, status: f.status },
      data: { status: FriendshipStatus.REMOVED },
    });
    if (count > 0) {
      emitFriendshipChange([f.requesterId, f.addresseeId], {
        friendshipId: f.id,
        reason: f.status === FriendshipStatus.PENDING ? "cancelled" : "removed",
      });
    }
    return res.status(200).json({ status: "REMOVED" });
  } catch (err) {
    return serverError(res, "Friendship removal", err);
  }
});
