import { Server as HttpServer } from "http";
import { Server, Socket } from "socket.io";
import { FriendshipStatus } from "@prisma/client";
import { prisma } from "../app";
import { activeWebSocketConnections } from "../services/metrics";
import { SESSION_COOKIE_NAME, getAuthContextFromCookieHeader, hashToken, parseCookieHeader } from "../services/auth";
import { findProject, hasProjectAccess, resolveOrgScope } from "../services/projects";

// Real-time engine (spec §6.13, rooms and events §12.3).
//   user:<id>     notifications, me:updated, session:revoked, presence of friends
//   org:<id>      org:*, project:created/updated/deleted, member:updated
//   project:<id>  task:*, comment:* (joined with project:join, access checked)
// Rooms come from the session, never from what the client says. Services keep them in step with
// membership and access changes (joinOrgRoom, leaveOrgRooms, leaveProjectRoom).

let io: Server | null = null;

// USR-06: online = at least one open socket; offline only after a 10 s grace period, so a reload
// or a short network blip doesn't flicker. In memory: one backend instance.
export const PRESENCE_GRACE_MS = 10_000;
const openSockets = new Map<string, number>();
const offlineTimers = new Map<string, NodeJS.Timeout>();

export function isOnline(userId: string): boolean {
  return (openSockets.get(userId) ?? 0) > 0 || offlineTimers.has(userId);
}

// Only friends see presence (USR-06), so it goes to each friend's user room.
async function broadcastPresence(userId: string, status: "online" | "offline", lastSeenAt: Date | null) {
  if (!io) return;
  const rows = await prisma.friendship.findMany({
    where: { status: FriendshipStatus.ACCEPTED, OR: [{ requesterId: userId }, { addresseeId: userId }] },
    select: { requesterId: true, addresseeId: true },
  });
  const rooms = rows.map((r) => `user:${r.requesterId === userId ? r.addresseeId : r.requesterId}`);
  if (rooms.length) io.to(rooms).emit("presence:update", { userId, status, lastSeenAt });
}

function socketOpened(userId: string) {
  openSockets.set(userId, (openSockets.get(userId) ?? 0) + 1);
  const pending = offlineTimers.get(userId);
  if (pending) {
    // Back within the grace period: friends never saw them go.
    clearTimeout(pending);
    offlineTimers.delete(userId);
  } else if (openSockets.get(userId) === 1) {
    broadcastPresence(userId, "online", null).catch((err) => console.warn("[Socket.IO] Presence broadcast failed:", err));
  }
}

function socketClosed(userId: string) {
  const left = (openSockets.get(userId) ?? 1) - 1;
  if (left > 0) {
    openSockets.set(userId, left);
    return;
  }
  openSockets.delete(userId);
  offlineTimers.set(
    userId,
    setTimeout(async () => {
      offlineTimers.delete(userId);
      if (isOnline(userId)) return;
      try {
        const lastSeenAt = new Date();
        await prisma.user.update({ where: { id: userId }, data: { lastSeenAt } });
        await broadcastPresence(userId, "offline", lastSeenAt);
      } catch (err) {
        console.warn("[Socket.IO] Presence update failed:", err);
      }
    }, PRESENCE_GRACE_MS)
  );
}

export function initSocketServer(server: HttpServer): Server {
  io = new Server(server, {
    path: "/socket.io",
    cors: {
      origin: process.env.APP_URL,
      credentials: true,
    },
  });

  // RT-01: the handshake carries the session cookie (same origin through nginx); no valid session → refused.
  io.use(async (socket, next) => {
    try {
      const cookieHeader = socket.handshake.headers.cookie;
      const auth = await getAuthContextFromCookieHeader(cookieHeader);
      if (!auth) return next(new Error("UNAUTHORIZED"));
      socket.data.userId = auth.user.id;
      socket.data.orgId = auth.organization?.id ?? null;
      socket.data.sessionHash = hashToken(parseCookieHeader(cookieHeader)[SESSION_COOKIE_NAME]);
      next();
    } catch (err) {
      next(err as Error);
    }
  });

  io.on("connection", (socket: Socket) => {
    const userId: string = socket.data.userId;
    activeWebSocketConnections.inc();
    socket.join(`user:${userId}`);
    if (socket.data.orgId) socket.join(`org:${socket.data.orgId}`);
    socketOpened(userId);

    socket.on("ping", () => {
      socket.emit("pong", { timestamp: Date.now() });
    });

    // RT-03: a board joins its project room; same checks as GET /projects/:key (§7.7), with the
    // session's current role. One project room per socket (a tab shows one board).
    socket.on("project:join", async (data: { key?: unknown; orgId?: unknown } | undefined, ack?: (r: unknown) => void) => {
      const reply = typeof ack === "function" ? ack : () => {};
      try {
        const auth = await getAuthContextFromCookieHeader(socket.handshake.headers.cookie);
        if (!auth) {
          reply({ ok: false, code: "UNAUTHORIZED" });
          socket.disconnect(true);
          return;
        }
        const orgId = await resolveOrgScope(auth, data?.orgId);
        const key = String(data?.key ?? "").toUpperCase();
        const project = orgId ? await findProject(orgId, key).catch(() => null) : null;
        if (!project || !(await hasProjectAccess(auth, project.id))) return reply({ ok: false, code: "NOT_FOUND" });
        for (const room of socket.rooms) if (room.startsWith("project:")) socket.leave(room);
        socket.join(`project:${project.id}`);
        reply({ ok: true, projectId: project.id });
      } catch (err) {
        console.warn("[Socket.IO] project:join failed:", err);
        reply({ ok: false, code: "INTERNAL_ERROR" });
      }
    });

    socket.on("project:leave", (data: { projectId?: unknown } | undefined) => {
      if (typeof data?.projectId === "string") socket.leave(`project:${data.projectId}`);
    });

    socket.on("disconnect", () => {
      activeWebSocketConnections.dec();
      socketClosed(userId);
    });
  });

  console.log("[Socket.IO] Real-time engine initialized");
  return io;
}

// --- Emitting ------------------------------------------------------------------------------------
// All no-ops before the server starts (scripts, seed).

export function emitToUser(userId: string, event: string, payload: unknown = {}): void {
  io?.to(`user:${userId}`).emit(event, payload);
}

export function emitToOrg(orgId: string, event: string, payload: unknown = {}): void {
  io?.to(`org:${orgId}`).emit(event, payload);
}

export function emitToProject(projectId: string, event: string, payload: unknown = {}): void {
  io?.to(`project:${projectId}`).emit(event, payload);
}

// --- Keeping rooms in step with membership and access ---------------------------------------------

export function joinOrgRoom(userId: string, orgId: string): void {
  io?.in(`user:${userId}`).socketsJoin(`org:${orgId}`);
}

// Leaving an org (removed, left, became SA, org deleted) also leaves its project rooms.
export async function leaveOrgRooms(userIds: string[], orgId: string): Promise<void> {
  if (!io || !userIds.length) return;
  const projects = await prisma.project.findMany({ where: { orgId }, select: { id: true } });
  io.in(userIds.map((id) => `user:${id}`)).socketsLeave([`org:${orgId}`, ...projects.map((p) => `project:${p.id}`)]);
}

// PRJ-04: a revoked user is removed from the project's live room.
export function leaveProjectRoom(userId: string, projectId: string): void {
  io?.in(`user:${userId}`).socketsLeave(`project:${projectId}`);
}

// A deleted project's room is closed for everyone.
export function closeProjectRoom(projectId: string): void {
  io?.in(`project:${projectId}`).socketsLeave(`project:${projectId}`);
}

// RT-01: close sockets whose session ended. `sessionHash` limits it to one session (logout keeps the
// user's other devices connected); `exceptSessionHash` keeps the current one (password change).
export async function disconnectUserSockets(
  userId: string,
  options: { reason?: string; sessionHash?: string; exceptSessionHash?: string } = {}
): Promise<void> {
  if (!io) return;
  try {
    const sockets = await io.in(`user:${userId}`).fetchSockets();
    for (const s of sockets) {
      if (options.sessionHash && s.data.sessionHash !== options.sessionHash) continue;
      if (options.exceptSessionHash && s.data.sessionHash === options.exceptSessionHash) continue;
      s.emit("session:revoked", { reason: options.reason ?? "Your session has ended." });
      s.disconnect(true);
    }
  } catch (err) {
    console.warn(`[Socket.IO] Error disconnecting sockets for user ${userId}:`, err);
  }
}

export function getSocketServer(): Server {
  if (!io) {
    throw new Error("Socket.IO server has not been initialized");
  }
  return io;
}
