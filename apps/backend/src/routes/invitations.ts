import { Router, Request, Response } from "express";
import { z } from "zod";
import { InvitationRole, InvitationStatus, MembershipStatus, OrgRole, AccountStatus } from "@prisma/client";
import { NameSchema, PasswordSchema } from "../schemas";
import { prisma } from "../app";
import {
  getAuthContextFromRequest,
  hashToken,
  hashPassword,
  createSession,
  setSessionCookie,
  AuthContext,
} from "../services/auth";
import {
  createOrgInvitation,
  resendInvitation,
  invitationState,
  assertInvitationUsable,
  assertSaInvitationUsable,
  InvitationError,
  notifyInvitation,
} from "../services/invitations";
import { emitToOrg } from "../realtime/socket";
import { isRefusal, refuse } from "../services/refusal";

// Invitations (spec §6.3 INV-01…04, API §12).
export const invitationsRouter = Router();

function sendError(res: Response, err: unknown, fallback: string) {
  if (err instanceof InvitationError) {
    if (isRefusal(err.status)) return refuse(res, err.code, err.message);
    return res.status(err.status).json({ error: { code: err.code, message: err.message } });
  }
  console.error(`[Invitations] ${fallback}:`, err);
  return res.status(500).json({ error: { code: "INTERNAL_ERROR", message: fallback } });
}

async function requireAuth(req: Request, res: Response): Promise<AuthContext | null> {
  const auth = await getAuthContextFromRequest(req);
  if (!auth) {
    res.status(401).json({ error: { code: "UNAUTHORIZED", message: "Sign in to continue." } });
    return null;
  }
  return auth;
}

// OA manages their own org; SA manages any org. Outside scope → 404 (§4.1).
function canManageOrg(auth: AuthContext, orgId: string): boolean {
  return auth.role === "SA" || (auth.role === "OA" && auth.organization?.id === orgId);
}

// ---------------------------------------------------------------------------
// INV-04: list an org's invitations (email, role, inviter, expiry, status)
// ---------------------------------------------------------------------------
invitationsRouter.get("/orgs/:id/invitations", async (req: Request, res: Response) => {
  const auth = await requireAuth(req, res);
  if (!auth) return;
  if (!canManageOrg(auth, req.params.id)) {
    return res.status(200).json({ ok: false, error: { code: "NOT_FOUND", message: "Organization not found." } });
  }

  try {
    const invitations = await prisma.invitation.findMany({
      where: { orgId: req.params.id, organization: { deletedAt: null } },
      include: { invitedBy: { select: { firstName: true, lastName: true } } },
      orderBy: { createdAt: "desc" },
    });
    const now = new Date();
    return res.status(200).json({
      invitations: invitations.map((inv) => ({
        id: inv.id,
        email: inv.email,
        role: inv.role,
        status: invitationState(inv, now),
        invitedByName: `${inv.invitedBy.firstName} ${inv.invitedBy.lastName}`.trim(),
        createdAt: inv.createdAt,
        expiresAt: inv.expiresAt,
      })),
    });
  } catch (err) {
    return sendError(res, err, "Failed to load invitations.");
  }
});

// ---------------------------------------------------------------------------
// INV-01: invite by email. OA → Member or Viewer in their org; SA → any role.
// ---------------------------------------------------------------------------
invitationsRouter.post("/orgs/:id/invitations", async (req: Request, res: Response) => {
  const auth = await requireAuth(req, res);
  if (!auth) return;
  if (!canManageOrg(auth, req.params.id)) {
    return res.status(200).json({ ok: false, error: { code: "NOT_FOUND", message: "Organization not found." } });
  }

  const email = typeof req.body?.email === "string" ? req.body.email.trim() : "";
  const role = typeof req.body?.role === "string" ? req.body.role.toUpperCase() : "MEMBER";
  if (!z.string().email().safeParse(email).success) {
    return res.status(200).json({ ok: false, error: { code: "VALIDATION_ERROR", message: "Enter a valid email address." } });
  }
  if (!["OA", "MEMBER", "VIEWER"].includes(role)) {
    return res.status(200).json({ ok: false, error: { code: "VALIDATION_ERROR", message: "Role must be Org Admin, Member or Viewer." } });
  }
  if (role === "OA" && auth.role !== "SA") {
    return res.status(200).json({ ok: false,
      error: { code: "ROLE_NOT_ALLOWED", message: "Only a System Admin can invite an Org Admin. Invite them as Member or Viewer." },
    });
  }

  try {
    const inv = await createOrgInvitation({ orgId: req.params.id, email, role: role as InvitationRole, inviter: auth.user });
    return res.status(201).json({
      message: `Invitation sent to ${inv.email}.`,
      invitation: { id: inv.id, email: inv.email, role: inv.role, status: "PENDING", expiresAt: inv.expiresAt },
    });
  } catch (err) {
    return sendError(res, err, "Failed to send invitation.");
  }
});

async function loadManagedInvitation(auth: AuthContext, id: string) {
  const inv = await prisma.invitation.findUnique({ where: { id } });
  if (!inv || !canManageOrg(auth, inv.orgId)) throw new InvitationError(404, "NOT_FOUND", "Invitation not found.");
  return inv;
}

// INV-04: resend (new token, old link dead) and revoke.
invitationsRouter.post("/invitations/:id/resend", async (req: Request, res: Response) => {
  const auth = await requireAuth(req, res);
  if (!auth) return;
  try {
    await loadManagedInvitation(auth, req.params.id);
    const inv = await resendInvitation(req.params.id, auth.user);
    return res.status(200).json({
      message: `Invitation resent to ${inv.email}. The previous link no longer works.`,
      invitation: { id: inv.id, status: "PENDING", expiresAt: inv.expiresAt },
    });
  } catch (err) {
    return sendError(res, err, "Failed to resend invitation.");
  }
});

invitationsRouter.post("/invitations/:id/revoke", async (req: Request, res: Response) => {
  const auth = await requireAuth(req, res);
  if (!auth) return;
  try {
    const inv = await loadManagedInvitation(auth, req.params.id);
    if (inv.status !== InvitationStatus.PENDING) {
      throw new InvitationError(409, "NOT_PENDING", `This invitation was already ${inv.status.toLowerCase()}.`);
    }
    await prisma.invitation.update({ where: { id: inv.id }, data: { status: InvitationStatus.REVOKED } });
    const org = await prisma.organization.findUnique({ where: { id: inv.orgId }, select: { name: true } });
    await notifyInvitation("invitation.revoked", inv, org?.name ?? "", auth.user.id);
    return res.status(200).json({ message: `Invitation for ${inv.email} revoked. The link no longer works.` });
  } catch (err) {
    return sendError(res, err, "Failed to revoke invitation.");
  }
});

// ---------------------------------------------------------------------------
// INV-02 / INV-03: the link in the email (public)
// ---------------------------------------------------------------------------
async function findByToken(token: string) {
  if (!/^[a-f0-9]{64}$/i.test(token)) return null;
  return prisma.invitation.findUnique({
    where: { tokenHash: hashToken(token) },
    include: {
      organization: { select: { id: true, name: true, description: true, deletedAt: true } },
      invitedBy: { select: { firstName: true, lastName: true } },
    },
  });
}

invitationsRouter.get("/invitations/by-token/:token", async (req: Request, res: Response) => {
  try {
    const inv = await findByToken(req.params.token);
    assertInvitationUsable(inv);
    const account = await prisma.user.findFirst({
      where: { email: { equals: inv!.email, mode: "insensitive" }, deletedAt: null },
      select: { id: true },
    });
    return res.status(200).json({
      invitation: {
        id: inv!.id,
        email: inv!.email,
        role: inv!.role,
        expiresAt: inv!.expiresAt,
        organization: { name: inv!.organization.name, description: inv!.organization.description },
        invitedByName: `${inv!.invitedBy.firstName} ${inv!.invitedBy.lastName}`.trim(),
      },
      accountExists: Boolean(account),
    });
  } catch (err) {
    return sendError(res, err, "Failed to load invitation.");
  }
});

const AcceptAsNewSchema = z
  .object({
    firstName: NameSchema,
    lastName: NameSchema,
    password: PasswordSchema,
    passwordConfirmation: z.string(),
    acceptTerms: z.literal(true, { errorMap: () => ({ message: "You must accept the Terms and Privacy Policy" }) }),
  })
  .refine((d) => d.password === d.passwordConfirmation, { message: "Passwords do not match", path: ["passwordConfirmation"] });

// ADM-02: System Admin invitation links (public, like org invitation links).
async function findSaByToken(token: string) {
  return prisma.saInvitation.findUnique({
    where: { tokenHash: hashToken(token) },
    include: { invitedBy: { select: { firstName: true, lastName: true } } },
  });
}

invitationsRouter.get("/invitations/sa/by-token/:token", async (req: Request, res: Response) => {
  try {
    const inv = await findSaByToken(req.params.token);
    assertSaInvitationUsable(inv);
    const account = await prisma.user.findFirst({
      where: { email: { equals: inv!.email, mode: "insensitive" }, deletedAt: null },
      select: { id: true },
    });
    return res.status(200).json({
      invitation: {
        email: inv!.email,
        expiresAt: inv!.expiresAt,
        invitedByName: `${inv!.invitedBy.firstName} ${inv!.invitedBy.lastName}`.trim(),
      },
      accountExists: Boolean(account),
    });
  } catch (err) {
    return sendError(res, err, "Failed to load invitation.");
  }
});

// The emailed link proves the address, so the account is created ACTIVE as a System Admin
// (no organization) and signed in. The link works once.
invitationsRouter.post("/invitations/sa/by-token/:token/accept", async (req: Request, res: Response) => {
  const parsed = AcceptAsNewSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(200).json({ ok: false,
      error: { code: "VALIDATION_ERROR", message: parsed.error.errors[0]?.message || "Check the form and try again." },
    });
  }

  try {
    const inv = await findSaByToken(req.params.token);
    assertSaInvitationUsable(inv);

    const existing = await prisma.user.findFirst({
      where: { email: { equals: inv!.email, mode: "insensitive" }, deletedAt: null },
      select: { id: true },
    });
    if (existing) {
      throw new InvitationError(409, "ACCOUNT_EXISTS", "An account already uses this email. Ask a System Admin to grant you the role from your user page.");
    }

    const { firstName, lastName, password } = parsed.data;
    const passwordHash = await hashPassword(password);

    const user = await prisma.$transaction(async (tx) => {
      const claimed = await tx.saInvitation.updateMany({
        where: { id: inv!.id, status: InvitationStatus.PENDING, expiresAt: { gt: new Date() } },
        data: { status: InvitationStatus.ACCEPTED },
      });
      if (claimed.count === 0) throw new InvitationError(410, "INVITATION_USED", "This invitation has already been used.");
      return tx.user.create({
        data: {
          email: inv!.email,
          firstName,
          lastName,
          passwordHash,
          isSystemAdmin: true,
          status: AccountStatus.ACTIVE,
          lastLoginAt: new Date(),
        },
      });
    });

    setSessionCookie(res, await createSession(user.id, false));
    return res.status(201).json({
      message: "Your System Administrator account is ready.",
      user: {
        id: user.id,
        email: user.email,
        firstName: user.firstName,
        lastName: user.lastName,
        jobTitle: user.jobTitle,
        bio: user.bio,
        avatarPath: user.avatarPath,
        isSystemAdmin: user.isSystemAdmin,
        status: user.status,
      },
      organization: null,
      role: "SA",
    });
  } catch (err: any) {
    if (err?.code === "P2002") {
      return res.status(200).json({ ok: false, error: { code: "ACCOUNT_EXISTS", message: "An account already uses this email." } });
    }
    return sendError(res, err, "Failed to accept invitation.");
  }
});

// INV-02: accept as a new person. Clicking the emailed link proves the email,
// so the account is created ACTIVE, joins the org and is signed in.
invitationsRouter.post("/invitations/by-token/:token/accept", async (req: Request, res: Response) => {
  const parsed = AcceptAsNewSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(200).json({ ok: false,
      error: { code: "VALIDATION_ERROR", message: parsed.error.errors[0]?.message || "Check the form and try again." },
    });
  }

  try {
    const inv = await findByToken(req.params.token);
    assertInvitationUsable(inv);

    const existing = await prisma.user.findFirst({
      where: { email: { equals: inv!.email, mode: "insensitive" }, deletedAt: null },
      select: { id: true },
    });
    if (existing) {
      throw new InvitationError(409, "ACCOUNT_EXISTS", "An account already uses this email. Sign in to accept the invitation.");
    }

    const { firstName, lastName, password } = parsed.data;
    const passwordHash = await hashPassword(password);

    const user = await prisma.$transaction(async (tx) => {
      // Re-check inside the transaction so a double submit can't use the link twice.
      const claimed = await tx.invitation.updateMany({
        where: { id: inv!.id, status: InvitationStatus.PENDING, expiresAt: { gt: new Date() } },
        data: { status: InvitationStatus.ACCEPTED },
      });
      if (claimed.count === 0) throw new InvitationError(410, "INVITATION_USED", "This invitation has already been used.");

      const created = await tx.user.create({
        data: {
          email: inv!.email,
          firstName,
          lastName,
          passwordHash,
          status: AccountStatus.ACTIVE,
          lastLoginAt: new Date(),
        },
      });
      await tx.membership.create({
        data: { orgId: inv!.orgId, userId: created.id, role: inv!.role as OrgRole, status: MembershipStatus.ACTIVE },
      });
      return created;
    });

    await notifyInvitation("invitation.accepted", inv!, inv!.organization.name, user.id);
    // A brand-new account has no socket yet; it joins the org room when it connects.
    emitToOrg(inv!.orgId, "member:updated", { userId: user.id });
    setSessionCookie(res, await createSession(user.id, false));
    return res.status(201).json({
      message: `Welcome to ${inv!.organization.name}.`,
      user: {
        id: user.id,
        email: user.email,
        firstName: user.firstName,
        lastName: user.lastName,
        jobTitle: user.jobTitle,
        bio: user.bio,
        avatarPath: user.avatarPath,
        isSystemAdmin: user.isSystemAdmin,
        status: user.status,
      },
      organization: { id: inv!.organization.id, name: inv!.organization.name },
      role: inv!.role,
    });
  } catch (err: any) {
    if (err?.code === "P2002") {
      return res.status(200).json({ ok: false,
        error: { code: "ACCOUNT_EXISTS", message: "An account already uses this email. Sign in to accept the invitation." },
      });
    }
    return sendError(res, err, "Failed to accept invitation.");
  }
});
