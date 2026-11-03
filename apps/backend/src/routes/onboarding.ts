import { Router, Request, Response } from "express";
import { prisma } from "../app";
import { getAuthContextFromRequest } from "../services/auth";
import { assertInvitationUsable, InvitationError, notifyInvitation } from "../services/invitations";
import { CreateOrgSchema } from "../schemas";
import { findActiveOrgByName } from "../services/orgs";
import { OrgRole, MembershipStatus, InvitationStatus } from "@prisma/client";
import { emitToOrg, joinOrgRoom } from "../realtime/socket";
import { isRefusal, refuse } from "../services/refusal";

export const onboardingRouter = Router();

// Middleware helper to ensure authentication
async function requireAuth(req: Request, res: Response): Promise<NonNullable<Awaited<ReturnType<typeof getAuthContextFromRequest>>> | null> {
  const ctx = await getAuthContextFromRequest(req);
  if (!ctx) {
    res.status(401).json({
      error: {
        code: "UNAUTHORIZED",
        message: "You must be logged in to perform this action.",
      },
    });
    return null;
  }
  return ctx;
}

// GET /api/v1/me/invitations (INV-03, unaffiliated user view pending invites)
onboardingRouter.get("/me/invitations", async (req: Request, res: Response) => {
  const auth = await requireAuth(req, res);
  if (!auth) return;

  try {
    const invitations = await prisma.invitation.findMany({
      where: {
        email: { equals: auth.user.email, mode: "insensitive" },
        status: InvitationStatus.PENDING,
        expiresAt: { gt: new Date() },
        organization: { deletedAt: null },
      },
      include: {
        organization: {
          select: {
            id: true,
            name: true,
            description: true,
          },
        },
        invitedBy: {
          select: {
            id: true,
            firstName: true,
            lastName: true,
            email: true,
          },
        },
      },
      orderBy: { createdAt: "desc" },
    });

    return res.status(200).json({ invitations });
  } catch (err) {
    console.error("[Onboarding] Get invitations error:", err);
    return res.status(500).json({
      error: {
        code: "INTERNAL_ERROR",
        message: "Failed to fetch pending invitations.",
      },
    });
  }
});

// POST /api/v1/invitations/:id/accept (INV-03)
onboardingRouter.post("/invitations/:id/accept", async (req: Request, res: Response) => {
  const auth = await requireAuth(req, res);
  if (!auth) return;

  // A System Admin belongs to no organization (§4.1).
  if (auth.user.isSystemAdmin) {
    return res.status(200).json({ ok: false,
      error: { code: "SA_NO_ORG", message: "System Admins can't join an organization. Ask another admin to revoke your System Admin role first." },
    });
  }

  const invitationId = req.params.id;

  try {
    const invitation = await prisma.invitation.findUnique({
      where: { id: invitationId },
      include: { organization: true },
    });

    if (!invitation || invitation.email.toLowerCase() !== auth.user.email.toLowerCase()) {
      return res.status(200).json({ ok: false,
        error: { code: "NOT_FOUND", message: "Invitation not found." },
      });
    }
    try {
      assertInvitationUsable(invitation);
    } catch (e) {
      const err = e as InvitationError;
      if (isRefusal(err.status)) return refuse(res, err.code, err.message);
      return res.status(err.status).json({ error: { code: err.code, message: err.message } });
    }

    // INV-03: one org per user (§4.1). Leaving the current org comes first.
    if (auth.organization && auth.organization.id !== invitation.orgId) {
      return res.status(200).json({ ok: false,
        error: {
          code: "ALREADY_IN_ORG",
          message: `You're already a member of ${auth.organization.name}. Leave it first, then accept this invitation.`,
        },
      });
    }

    // Check if user is already a member
    const existingMembership = await prisma.membership.findFirst({
      where: {
        orgId: invitation.orgId,
        userId: auth.user.id,
      },
    });

    await prisma.$transaction(async (tx) => {
      // Mark invitation accepted
      await tx.invitation.update({
        where: { id: invitation.id },
        data: { status: InvitationStatus.ACCEPTED },
      });

      if (existingMembership) {
        await tx.membership.update({
          where: { id: existingMembership.id },
          data: {
            role: invitation.role as OrgRole,
            status: MembershipStatus.ACTIVE,
            leftAt: null,
          },
        });
      } else {
        await tx.membership.create({
          data: {
            orgId: invitation.orgId,
            userId: auth.user.id,
            role: invitation.role as OrgRole,
            status: MembershipStatus.ACTIVE,
          },
        });
      }
    });

    await notifyInvitation("invitation.accepted", invitation, invitation.organization.name, auth.user.id);
    joinOrgRoom(auth.user.id, invitation.orgId);
    emitToOrg(invitation.orgId, "member:updated", { userId: auth.user.id });

    return res.status(200).json({
      success: true,
      message: `You have successfully joined ${invitation.organization.name}.`,
      organization: {
        id: invitation.organization.id,
        name: invitation.organization.name,
      },
      role: invitation.role,
    });
  } catch (err) {
    console.error("[Onboarding] Accept invitation error:", err);
    return res.status(500).json({
      error: {
        code: "INTERNAL_ERROR",
        message: "Failed to accept invitation.",
      },
    });
  }
});

// POST /api/v1/invitations/:id/decline (INV-03)
onboardingRouter.post("/invitations/:id/decline", async (req: Request, res: Response) => {
  const auth = await requireAuth(req, res);
  if (!auth) return;

  const invitationId = req.params.id;

  try {
    const invitation = await prisma.invitation.findUnique({
      where: { id: invitationId },
      include: { organization: { select: { name: true } } },
    });

    if (!invitation || invitation.email.toLowerCase() !== auth.user.email.toLowerCase()) {
      return res.status(200).json({ ok: false,
        error: {
          code: "NOT_FOUND",
          message: "Invitation not found.",
        },
      });
    }
    // Revoked, expired or answered in another tab meanwhile.
    if (invitation.status !== InvitationStatus.PENDING) {
      return refuse(res, "NOT_PENDING", `This invitation was already ${invitation.status.toLowerCase()}.`);
    }

    await prisma.invitation.update({
      where: { id: invitation.id },
      data: { status: InvitationStatus.DECLINED },
    });
    await notifyInvitation("invitation.declined", invitation, invitation.organization.name, auth.user.id);

    return res.status(200).json({
      success: true,
      message: "Invitation declined.",
    });
  } catch (err) {
    console.error("[Onboarding] Decline invitation error:", err);
    return res.status(500).json({
      error: {
        code: "INTERNAL_ERROR",
        message: "Failed to decline invitation.",
      },
    });
  }
});

// POST /api/v1/orgs (ORG-01: Create organization)
onboardingRouter.post("/orgs", async (req: Request, res: Response) => {
  const auth = await requireAuth(req, res);
  if (!auth) return;

  // A System Admin belongs to no organization (§4.1).
  if (auth.user.isSystemAdmin) {
    return res.status(200).json({ ok: false,
      error: { code: "SA_NO_ORG", message: "System Admins don't join organizations. Create it from Admin > Organizations and invite its first Org Admin." },
    });
  }

  const parseResult = CreateOrgSchema.safeParse(req.body);
  if (!parseResult.success) {
    return res.status(200).json({ ok: false,
      error: {
        code: "VALIDATION_ERROR",
        message: parseResult.error.errors[0]?.message || "Invalid organization details.",
        details: parseResult.error.errors,
      },
    });
  }

  const { name, description } = parseResult.data;

  // One organization at a time (§4.1): leave the current one first.
  if (auth.organization) {
    return res.status(200).json({ ok: false,
      error: { code: "ALREADY_IN_ORG", message: "You already belong to an organization. Leave it before creating a new one." },
    });
  }

  try {
    if (await findActiveOrgByName(name)) {
      return res.status(200).json({ ok: false,
        error: { code: "ORG_NAME_TAKEN", message: `An organization named "${name}" already exists.` },
      });
    }

    const result = await prisma.$transaction(async (tx) => {
      const org = await tx.organization.create({
        data: {
          name,
          description: description || null,
          createdById: auth.user.id,
        },
      });

      const membership = await tx.membership.create({
        data: {
          orgId: org.id,
          userId: auth.user.id,
          role: OrgRole.OA,
          status: MembershipStatus.ACTIVE,
        },
      });

      return { org, membership };
    });
    joinOrgRoom(auth.user.id, result.org.id);

    return res.status(201).json({
      success: true,
      message: "Organization created successfully.",
      organization: {
        id: result.org.id,
        name: result.org.name,
        description: result.org.description,
      },
      role: result.membership.role,
    });
  } catch (err: any) {
    if (err?.code === "P2002") {
      return res.status(200).json({ ok: false,
        error: {
          code: "ORG_ALREADY_EXISTS",
          message: `An organization named "${name}" already exists. Please choose a different name.`,
        },
      });
    }
    console.error("[Onboarding] Create org error:", err);
    return res.status(500).json({
      error: {
        code: "INTERNAL_ERROR",
        message: "Failed to create organization.",
      },
    });
  }
});

// GET /api/v1/orgs/current (Get active organization workspace details for working users)
onboardingRouter.get("/orgs/current", async (req: Request, res: Response) => {
  const auth = await requireAuth(req, res);
  if (!auth) return;

  if (!auth.organization) {
    return res.status(200).json({ organization: null });
  }

  try {
    const org = await prisma.organization.findUnique({
      where: { id: auth.organization.id },
      include: {
        memberships: {
          where: { status: MembershipStatus.ACTIVE },
          include: {
            user: {
              select: {
                id: true,
                firstName: true,
                lastName: true,
                email: true,
                jobTitle: true,
                avatarPath: true,
                status: true,
              },
            },
          },
          orderBy: { joinedAt: "asc" },
        },
        invitations: {
          where: {
            status: InvitationStatus.PENDING,
            expiresAt: { gt: new Date() },
          },
          orderBy: { createdAt: "desc" },
        },
      },
    });

    if (!org || org.deletedAt) {
      return res.status(200).json({ organization: null });
    }

    return res.status(200).json({
      organization: {
        id: org.id,
        name: org.name,
        description: org.description,
        createdAt: org.createdAt,
      },
      members: org.memberships.map((m) => ({
        id: m.id,
        userId: m.user.id,
        firstName: m.user.firstName,
        lastName: m.user.lastName,
        email: m.user.email,
        jobTitle: m.user.jobTitle,
        avatarPath: m.user.avatarPath,
        role: m.role,
        joinedAt: m.joinedAt,
      })),
      pendingInvitationsCount: org.invitations.length,
      pendingInvitations: org.invitations.map((i) => ({
        id: i.id,
        email: i.email,
        role: i.role,
        expiresAt: i.expiresAt,
        createdAt: i.createdAt,
      })),
      role: auth.role,
    });
  } catch (err) {
    console.error("[Onboarding] Get current org error:", err);
    return res.status(500).json({
      error: {
        code: "INTERNAL_ERROR",
        message: "Failed to load workspace details.",
      },
    });
  }
});
