import { Router, Request, Response } from "express";
import { prisma } from "../app";
import { requireAuth } from "../services/auth";
import { emitNotificationEvent, notificationTarget } from "../services/notifications";

// Notification inbox (spec §6.9 NOTIF-02…04, API §12): GET /notifications · PATCH /notifications/:id/read ·
// POST /notifications/read-all · DELETE /notifications/:id. Each user only ever sees their own rows.
export const notificationsRouter = Router();

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_PAGE_SIZE = 50;

function serverError(res: Response, what: string, err: unknown) {
  console.error(`[Notifications] ${what}:`, err);
  return res.status(500).json({ error: { code: "INTERNAL_ERROR", message: `Failed to ${what.toLowerCase()}.` } });
}

const notFound = (res: Response) => res.status(404).json({ error: { code: "NOT_FOUND", message: "Notification not found." } });

const unreadCount = (userId: string) => prisma.notification.count({ where: { userId, deletedAt: null, readAt: null } });

// ?filter=unread|all &page &pageSize (20 on the page, 10 in the bell).
notificationsRouter.get("/notifications", async (req: Request, res: Response) => {
  const auth = await requireAuth(req, res);
  if (!auth) return;
  const unreadOnly = req.query.filter === "unread";
  const page = Math.max(1, Number.parseInt(String(req.query.page ?? "1"), 10) || 1);
  const pageSize = Math.min(MAX_PAGE_SIZE, Math.max(1, Number.parseInt(String(req.query.pageSize ?? "20"), 10) || 20));
  const where = { userId: auth.user.id, deletedAt: null, ...(unreadOnly ? { readAt: null } : {}) };

  try {
    const [rows, total, unread] = await Promise.all([
      prisma.notification.findMany({
        where,
        include: { actor: { select: { id: true, firstName: true, lastName: true, avatarPath: true } } },
        orderBy: { createdAt: "desc" },
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      prisma.notification.count({ where }),
      unreadCount(auth.user.id),
    ]);
    return res.status(200).json({
      notifications: rows.map((n) => ({
        id: n.id,
        type: n.type,
        params: n.params,
        resourceType: n.resourceType,
        resourceId: n.resourceId,
        read: Boolean(n.readAt),
        createdAt: n.createdAt,
        actor: n.actor
          ? { id: n.actor.id, name: `${n.actor.firstName} ${n.actor.lastName}`.trim(), avatarPath: n.actor.avatarPath }
          : null,
      })),
      total,
      unreadCount: unread,
      page,
      pageSize,
    });
  } catch (err) {
    return serverError(res, "Load notifications", err);
  }
});

// Marks one read and says where it leads now (NOTIF-02); `gone` means deleted or no longer accessible (NOTIF-04).
notificationsRouter.patch("/notifications/:id/read", async (req: Request, res: Response) => {
  const auth = await requireAuth(req, res);
  if (!auth) return;
  if (!UUID_RE.test(req.params.id)) return notFound(res);
  try {
    const n = await prisma.notification.findFirst({ where: { id: req.params.id, userId: auth.user.id, deletedAt: null } });
    if (!n) return notFound(res);
    if (!n.readAt) {
      await prisma.notification.update({ where: { id: n.id }, data: { readAt: new Date() } });
      emitNotificationEvent(auth.user.id, "notification:sync");
    }
    const target = await notificationTarget(n, auth.user);
    return res.status(200).json({ ...target, unreadCount: await unreadCount(auth.user.id) });
  } catch (err) {
    return serverError(res, "Mark the notification read", err);
  }
});

notificationsRouter.post("/notifications/read-all", async (req: Request, res: Response) => {
  const auth = await requireAuth(req, res);
  if (!auth) return;
  try {
    const { count } = await prisma.notification.updateMany({
      where: { userId: auth.user.id, deletedAt: null, readAt: null },
      data: { readAt: new Date() },
    });
    if (count) emitNotificationEvent(auth.user.id, "notification:sync");
    return res.status(200).json({ marked: count, unreadCount: 0 });
  } catch (err) {
    return serverError(res, "Mark notifications read", err);
  }
});

// Soft delete (NOTIF-03).
notificationsRouter.delete("/notifications/:id", async (req: Request, res: Response) => {
  const auth = await requireAuth(req, res);
  if (!auth) return;
  if (!UUID_RE.test(req.params.id)) return notFound(res);
  try {
    const { count } = await prisma.notification.updateMany({
      where: { id: req.params.id, userId: auth.user.id, deletedAt: null },
      data: { deletedAt: new Date() },
    });
    if (!count) return notFound(res);
    emitNotificationEvent(auth.user.id, "notification:sync");
    return res.status(200).json({ message: "Notification deleted.", unreadCount: await unreadCount(auth.user.id) });
  } catch (err) {
    return serverError(res, "Delete the notification", err);
  }
});
