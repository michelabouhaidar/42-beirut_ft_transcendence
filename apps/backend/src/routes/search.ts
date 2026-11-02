import { Router, Request, Response } from "express";
import { MembershipStatus, OrgRole, Prisma } from "@prisma/client";
import { z } from "zod";
import { prisma } from "../app";
import { requireAuth } from "../services/auth";
import { canManageProjects, resolveOrgScope } from "../services/projects";
import { serializeTask, taskInclude } from "../services/tasks";
import { withFriendsFirst } from "../services/friends";

// Search page for tasks (spec §6.10 SRCH-01…04): text, filters, sort, pagination.
export const searchRouter = Router();

export const SEARCH_PAGE_SIZE = 25;

const list = <T extends string>(values: readonly [T, ...T[]]) =>
  z
    .string()
    .optional()
    .transform((v) => (v ? v.split(",").filter(Boolean) : []))
    .pipe(z.array(z.enum(values)));

const day = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "Dates must use the YYYY-MM-DD format")
  .refine((v) => !isNaN(Date.parse(`${v}T00:00:00Z`)) && new Date(`${v}T00:00:00Z`).toISOString().startsWith(v), "Invalid date")
  .optional();

const SearchQuerySchema = z
  .object({
    q: z.string().trim().max(200, "Search text must not exceed 200 characters").optional().default(""),
    project: z
      .string()
      .optional()
      .transform((v) => (v ? v.split(",").filter(Boolean).map((k) => k.toUpperCase()) : [])),
    status: list(["TODO", "IN_PROGRESS", "DONE"] as const),
    priority: list(["LOW", "MEDIUM", "HIGH", "URGENT"] as const),
    // "me", "unassigned", "friends" (tasks assigned to my friends) or a user id.
    assignee: z.union([z.literal("me"), z.literal("unassigned"), z.literal("friends"), z.string().uuid("Invalid assignee")]).optional(),
    dueFrom: day,
    dueTo: day,
    sort: z.enum(["updated", "created", "due", "priority", "title"]).optional().default("updated"),
    dir: z.enum(["asc", "desc"]).optional(),
    page: z.coerce.number().int().min(1).max(100000).optional().default(1),
    orgId: z.string().optional(),
  })
  .strict()
  .refine((d) => !d.dueFrom || !d.dueTo || d.dueFrom <= d.dueTo, { message: "The due date range is reversed" });

// Default direction per sort: newest first, most urgent first, A→Z, soonest due first.
const DEFAULT_DIR = { updated: "desc", created: "desc", due: "asc", priority: "desc", title: "asc" } as const;

const escapeLike = (s: string) => s.replace(/[\\%_]/g, (c) => `\\${c}`);

// SRCH-01: never returns tasks outside the user's scope. OA (and SA with ?orgId) search the whole org;
// Members and Viewers only projects they have access to.
searchRouter.get("/search/tasks", async (req: Request, res: Response) => {
  const auth = await requireAuth(req, res);
  if (!auth) return;
  const parsed = SearchQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    return res.status(400).json({ error: { code: "VALIDATION_ERROR", message: parsed.error.errors[0]?.message || "Invalid search." } });
  }
  const f = parsed.data;
  const orgId = await resolveOrgScope(auth, f.orgId);
  if (!orgId) return res.status(404).json({ error: { code: "NOT_FOUND", message: "Organization not found." } });

  try {
    const scope = canManageProjects(auth)
      ? Prisma.empty
      : Prisma.sql`AND EXISTS (SELECT 1 FROM project_access pa WHERE pa.project_id = p.id AND pa.user_id = ${auth.user.id}::uuid AND pa.revoked_at IS NULL)`;

    const where: Prisma.Sql[] = [];
    if (f.q) {
      const like = `%${escapeLike(f.q)}%`;
      where.push(Prisma.sql`(t.title ILIKE ${like} OR t.description ILIKE ${like} OR (p.key || '-' || t.number) ILIKE ${like})`);
    }
    if (f.project.length) where.push(Prisma.sql`p.key IN (${Prisma.join(f.project)})`);
    if (f.status.length) where.push(Prisma.sql`t.status::text IN (${Prisma.join(f.status)})`);
    if (f.priority.length) where.push(Prisma.sql`t.priority::text IN (${Prisma.join(f.priority)})`);
    if (f.assignee === "me") where.push(Prisma.sql`t.assignee_id = ${auth.user.id}::uuid`);
    else if (f.assignee === "unassigned") where.push(Prisma.sql`t.assignee_id IS NULL`);
    else if (f.assignee === "friends") {
      where.push(Prisma.sql`t.assignee_id IN (
        SELECT CASE WHEN fr.requester_id = ${auth.user.id}::uuid THEN fr.addressee_id ELSE fr.requester_id END
        FROM friendship fr
        WHERE fr.status = 'ACCEPTED' AND (fr.requester_id = ${auth.user.id}::uuid OR fr.addressee_id = ${auth.user.id}::uuid))`);
    }
    else if (f.assignee) where.push(Prisma.sql`t.assignee_id = ${f.assignee}::uuid`);
    if (f.dueFrom) where.push(Prisma.sql`t.due_date >= ${f.dueFrom}::date`);
    if (f.dueTo) where.push(Prisma.sql`t.due_date <= ${f.dueTo}::date`);
    const filters = where.length ? Prisma.sql`AND ${Prisma.join(where, " AND ")}` : Prisma.empty;

    const dir = f.dir ?? DEFAULT_DIR[f.sort];
    const d = Prisma.raw(dir === "asc" ? "ASC" : "DESC");
    // SRCH-03: empty due dates always last; ties broken by newest number so pages are stable.
    const order = {
      updated: Prisma.sql`t.updated_at ${d}`,
      created: Prisma.sql`t.created_at ${d}`,
      due: Prisma.sql`t.due_date IS NULL, t.due_date ${d}`,
      priority: Prisma.sql`CASE t.priority WHEN 'LOW' THEN 0 WHEN 'MEDIUM' THEN 1 WHEN 'HIGH' THEN 2 ELSE 3 END ${d}`,
      title: Prisma.sql`lower(t.title) ${d}`,
    }[f.sort];

    const from = Prisma.sql`
      FROM task t JOIN project p ON p.id = t.project_id
      WHERE t.deleted_at IS NULL AND p.deleted_at IS NULL AND p.org_id = ${orgId}::uuid ${scope} ${filters}`;

    const [{ total }] = await prisma.$queryRaw<{ total: bigint }[]>`SELECT count(*) AS total ${from}`;
    const count = Number(total);
    const pages = Math.max(1, Math.ceil(count / SEARCH_PAGE_SIZE));
    const page = Math.min(f.page, pages);
    const rows = await prisma.$queryRaw<{ id: string }[]>`
      SELECT t.id ${from} ORDER BY ${order}, t.created_at DESC, t.id LIMIT ${SEARCH_PAGE_SIZE} OFFSET ${(page - 1) * SEARCH_PAGE_SIZE}`;

    const ids = rows.map((r) => r.id);
    const found = await prisma.task.findMany({
      where: { id: { in: ids } },
      include: { ...taskInclude, project: { select: { key: true, name: true } } },
    });
    const byId = new Map(found.map((t) => [t.id, t]));

    // Filter choices (SRCH-02): projects in scope and the org's people who can hold tasks.
    const [projects, people] = await Promise.all([
      prisma.project.findMany({
        where: {
          orgId,
          deletedAt: null,
          ...(canManageProjects(auth) ? {} : { accessList: { some: { userId: auth.user.id, revokedAt: null } } }),
        },
        select: { key: true, name: true },
        orderBy: { name: "asc" },
      }),
      prisma.membership.findMany({
        where: { orgId, status: MembershipStatus.ACTIVE, role: { in: [OrgRole.OA, OrgRole.MEMBER] } },
        select: { user: { select: { id: true, firstName: true, lastName: true, avatarPath: true } } },
        orderBy: [{ user: { firstName: "asc" } }, { user: { lastName: "asc" } }],
      }),
    ]);

    return res.status(200).json({
      tasks: ids
        .map((id) => byId.get(id))
        .filter((t): t is NonNullable<typeof t> => Boolean(t))
        .map((t) => ({ ...serializeTask(t, t.project.key), project: { key: t.project.key, name: t.project.name } })),
      total: count,
      page,
      pageSize: SEARCH_PAGE_SIZE,
      sort: f.sort,
      dir,
      options: {
        projects,
        assignees: await withFriendsFirst(
          auth.user.id,
          people.map((m) => ({ id: m.user.id, name: `${m.user.firstName} ${m.user.lastName}`, avatarPath: m.user.avatarPath }))
        ),
      },
    });
  } catch (err) {
    console.error("[Search] Search error:", err);
    return res.status(500).json({ error: { code: "INTERNAL_ERROR", message: "Search failed." } });
  }
});
