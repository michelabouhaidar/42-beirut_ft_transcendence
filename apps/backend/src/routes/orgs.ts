import { Router, Request, Response } from "express";
import { MembershipStatus, OrgRole } from "@prisma/client";
import { prisma } from "../app";
import { AuthContext, requireAuth } from "../services/auth";
import { CreateOrgSchema } from "../schemas";
import { isRefusal, refuse } from "../services/refusal";
import {
  OrgError,
  changeMemberRole,
  countAssignedTasks,
  deleteOrganization,
  endMembership,
  updateOrganization,
} from "../services/orgs";

// Organization management for Org Admins and System Admins (spec §6.6 ORG-02…07, API §12).
export const orgsRouter = Router();

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function sendError(res: Response, err: unknown, fallback: string) {
  if (err instanceof OrgError && isRefusal(err.status)) return refuse(res, err.code, err.message);
  if (err instanceof OrgError) return res.status(err.status).json({ error: { code: err.code, message: err.message } });
  console.error(`[Orgs] ${fallback}:`, err);
  return res.status(500).json({ error: { code: "INTERNAL_ERROR", message: fallback } });
}

const notFound = (res: Response) => res.status(200).json({ ok: false, error: { code: "NOT_FOUND", message: "Organization not found." } });

// OA manages their own org; SA manages any. Anything else is out of scope -> 404 (§4.1).
function canManage(auth: AuthContext, orgId: string): boolean {
  return auth.role === "SA" || (auth.role === "OA" && auth.organization?.id === orgId);
}

// Overview of an organization for its own members (and System Admins).
orgsRouter.get("/orgs/:id", async (req: Request, res: Response) => {
  const auth = await requireAuth(req, res);
  if (!auth) return;
  const id = req.params.id;
  if (!UUID_RE.test(id) || (auth.role !== "SA" && auth.organization?.id !== id)) return notFound(res);
  try {
    const org = await prisma.organization.findFirst({
      where: { id, deletedAt: null },
      include: {
        _count: { select: { projects: { where: { deletedAt: null } }, memberships: { where: { status: MembershipStatus.ACTIVE } } } },
      },
    });
    if (!org) return notFound(res);
    return res.status(200).json({
      organization: {
        id: org.id,
        name: org.name,
        description: org.description,
        createdAt: org.createdAt,
        memberCount: org._count.memberships,
        projectCount: org._count.projects,
      },
    });
  } catch (err) {
    return sendError(res, err, "Failed to load the organization.");
  }
});

orgsRouter.patch("/orgs/:id", async (req: Request, res: Response) => {
  const auth = await requireAuth(req, res);
  if (!auth) return;
  if (!UUID_RE.test(req.params.id) || !canManage(auth, req.params.id)) return notFound(res);
  const parsed = CreateOrgSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(200).json({ ok: false,
      error: { code: "VALIDATION_ERROR", message: parsed.error.errors[0]?.message || "Invalid organization details." },
    });
  }
  try {
    const org = await updateOrganization(req.params.id, auth.user.id, parsed.data);
    return res.status(200).json({
      message: "Organization updated.",
      organization: { id: org.id, name: org.name, description: org.description },
    });
  } catch (err) {
    return sendError(res, err, "Failed to update the organization.");
  }
});

orgsRouter.delete("/orgs/:id", async (req: Request, res: Response) => {
  const auth = await requireAuth(req, res);
  if (!auth) return;
  if (!UUID_RE.test(req.params.id) || !canManage(auth, req.params.id)) return notFound(res);
  const confirmName = typeof req.body?.confirmName === "string" ? req.body.confirmName.trim() : "";
  try {
    const { name, memberCount } = await deleteOrganization(req.params.id, auth.user.id, confirmName);
    return res.status(200).json({ message: `${name} deleted. ${memberCount} members are now unaffiliated.` });
  } catch (err) {
    return sendError(res, err, "Failed to delete the organization.");
  }
});

// ORG-06 warning: how many tasks a member has that would be unassigned.
orgsRouter.get("/orgs/:id/members/:userId/impact", async (req: Request, res: Response) => {
  const auth = await requireAuth(req, res);
  if (!auth) return;
  if (!UUID_RE.test(req.params.id) || !UUID_RE.test(req.params.userId) || !canManage(auth, req.params.id)) return notFound(res);
  try {
    return res.status(200).json({ assignedTasks: await countAssignedTasks(req.params.id, req.params.userId) });
  } catch (err) {
    return sendError(res, err, "Failed to check the member's tasks.");
  }
});

orgsRouter.patch("/orgs/:id/members/:userId", async (req: Request, res: Response) => {
  const auth = await requireAuth(req, res);
  if (!auth) return;
  if (!UUID_RE.test(req.params.id) || !UUID_RE.test(req.params.userId) || !canManage(auth, req.params.id)) return notFound(res);
  const role = typeof req.body?.role === "string" ? req.body.role.toUpperCase() : "";
  if (role !== "MEMBER" && role !== "VIEWER") {
    return res.status(200).json({ ok: false, error: { code: "VALIDATION_ERROR", message: "Role must be Member or Viewer." } });
  }
  if (req.params.userId === auth.user.id) {
    return res.status(200).json({ ok: false, error: { code: "FORBIDDEN", message: "You can't change your own role." } });
  }
  try {
    const { unassignedTasks } = await changeMemberRole(req.params.id, req.params.userId, role, auth.user.id);
    return res.status(200).json({ message: "Role updated.", unassignedTasks });
  } catch (err) {
    return sendError(res, err, "Failed to change the role.");
  }
});

// An OA removes Members and Viewers; a System Admin can remove anyone. Never the last OA.
orgsRouter.delete("/orgs/:id/members/:userId", async (req: Request, res: Response) => {
  const auth = await requireAuth(req, res);
  if (!auth) return;
  if (!UUID_RE.test(req.params.id) || !UUID_RE.test(req.params.userId) || !canManage(auth, req.params.id)) return notFound(res);
  if (req.params.userId === auth.user.id) {
    return res.status(200).json({ ok: false, error: { code: "USE_LEAVE", message: "Use \"Leave organization\" to remove yourself." } });
  }
  try {
    if (auth.role === "OA") {
      const target = await prisma.membership.findFirst({
        where: { orgId: req.params.id, userId: req.params.userId, status: MembershipStatus.ACTIVE },
        select: { role: true },
      });
      if (target?.role === OrgRole.OA) {
        return res.status(200).json({ ok: false, error: { code: "FORBIDDEN", message: "Only a System Admin can remove an Org Admin." } });
      }
    }
    const { unassignedTasks } = await endMembership(req.params.id, req.params.userId, "removed", auth.user.id);
    return res.status(200).json({ message: "Member removed.", unassignedTasks });
  } catch (err) {
    return sendError(res, err, "Failed to remove the member.");
  }
});

// Anyone can leave, except the last Org Admin.
orgsRouter.post("/orgs/:id/leave", async (req: Request, res: Response) => {
  const auth = await requireAuth(req, res);
  if (!auth) return;
  if (!UUID_RE.test(req.params.id) || auth.organization?.id !== req.params.id) return notFound(res);
  try {
    await endMembership(req.params.id, auth.user.id, "left", auth.user.id);
    return res.status(200).json({ message: `You left ${auth.organization.name}.` });
  } catch (err) {
    return sendError(res, err, "Failed to leave the organization.");
  }
});
