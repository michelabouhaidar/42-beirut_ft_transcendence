import { Prisma, FriendshipStatus, MembershipStatus } from "@prisma/client";
import { prisma } from "../app";
import { emitToUser, isOnline } from "../realtime/socket";

type Db = Prisma.TransactionClient | typeof prisma;

export type FriendshipState = "NONE" | "FRIENDS" | "OUTGOING" | "INCOMING";

// Ends every pending or accepted friendship a user has (USR-05: leaving an org, deletion).
export async function endFriendshipsForUser(db: Db, userId: string): Promise<string[]> {
  const rows = await db.friendship.findMany({
    where: {
      OR: [{ requesterId: userId }, { addresseeId: userId }],
      status: { in: [FriendshipStatus.PENDING, FriendshipStatus.ACCEPTED] },
    },
    select: { id: true, requesterId: true, addresseeId: true },
  });
  if (rows.length === 0) return [];
  await db.friendship.updateMany({
    where: { id: { in: rows.map((r) => r.id) } },
    data: { status: FriendshipStatus.REMOVED },
  });
  return rows.map((r) => (r.requesterId === userId ? r.addresseeId : r.requesterId));
}

// every change to a friendship (request, accept, decline, cancel, remove, or ended
// because someone left) tells both people, so Friends, Members and profile pages refresh at once.
export function emitFriendshipChange(userIds: string[], change: { friendshipId?: string; reason: string }): void {
  for (const id of new Set(userIds)) emitToUser(id, "friendship:updated", change);
}

// Ids of the user's accepted friends.
export async function friendIdsOf(userId: string): Promise<Set<string>> {
  const rows = await prisma.friendship.findMany({
    where: { status: FriendshipStatus.ACCEPTED, OR: [{ requesterId: userId }, { addresseeId: userId }] },
    select: { requesterId: true, addresseeId: true },
  });
  return new Set(rows.map((r) => (r.requesterId === userId ? r.addresseeId : r.requesterId)));
}

// People in pickers and filters: friends first (each with their presence, which only friends may
// see, USR-06), then everyone else, by name within each group.
export async function withFriendsFirst<T extends { id: string; name: string }>(viewerId: string, people: T[]) {
  const friends = await friendIdsOf(viewerId);
  const presence = await loadPresence(people.filter((p) => friends.has(p.id)).map((p) => p.id));
  return people
    .map((p) => ({ ...p, isFriend: friends.has(p.id), presence: presence.get(p.id) ?? null }))
    .sort((a, b) => Number(b.isFriend) - Number(a.isFriend) || a.name.localeCompare(b.name));
}

// Both users must be active members of the same, live organization.
export async function shareOrganization(db: Db, userA: string, userB: string): Promise<string | null> {
  const a = await db.membership.findFirst({
    where: { userId: userA, status: MembershipStatus.ACTIVE, organization: { deletedAt: null } },
    select: { orgId: true },
  });
  if (!a) return null;
  const b = await db.membership.findFirst({
    where: { userId: userB, orgId: a.orgId, status: MembershipStatus.ACTIVE, user: { status: "ACTIVE", deletedAt: null, isSystemAdmin: false } },
    select: { id: true },
  });
  return b ? a.orgId : null;
}

export function friendshipStateFor(
  viewerId: string,
  row: { requesterId: string; status: FriendshipStatus } | undefined
): FriendshipState {
  if (!row) return "NONE";
  if (row.status === FriendshipStatus.ACCEPTED) return "FRIENDS";
  if (row.status === FriendshipStatus.PENDING) return row.requesterId === viewerId ? "OUTGOING" : "INCOMING";
  return "NONE";
}

// USR-06: online = at least one open socket (10 s grace on disconnect, see realtime/socket.ts).
// "Last seen" is when the last socket closed; for someone who never connected since this was
// built, their latest session activity stands in.
export async function loadPresence(
  userIds: string[]
): Promise<Map<string, { status: "online" | "offline"; lastSeenAt: Date | null }>> {
  const out = new Map<string, { status: "online" | "offline"; lastSeenAt: Date | null }>();
  if (userIds.length === 0) return out;
  const [users, sessions] = await Promise.all([
    prisma.user.findMany({ where: { id: { in: userIds } }, select: { id: true, lastSeenAt: true } }),
    prisma.session.groupBy({
      by: ["userId"],
      where: { userId: { in: userIds }, pending2fa: false },
      _max: { lastActivityAt: true },
    }),
  ]);
  const lastSeen = new Map(users.map((u) => [u.id, u.lastSeenAt]));
  const lastActive = new Map(sessions.map((r) => [r.userId, r._max.lastActivityAt]));
  for (const id of userIds) {
    out.set(id, {
      status: isOnline(id) ? "online" : "offline",
      lastSeenAt: lastSeen.get(id) ?? lastActive.get(id) ?? null,
    });
  }
  return out;
}
