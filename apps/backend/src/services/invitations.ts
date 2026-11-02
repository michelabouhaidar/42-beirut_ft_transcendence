import { Invitation, InvitationRole, InvitationStatus, MembershipStatus } from "@prisma/client";
import { prisma } from "../app";
import { generateSecureToken } from "./auth";
import { sendInvitationEmail, sendSaInvitationEmail } from "./mailer";
import { notify } from "./notifications";

export const INVITATION_TTL_DAYS = 7;

export type InvitationState = "PENDING" | "EXPIRED" | "ACCEPTED" | "DECLINED" | "REVOKED";

// Stored status plus expiry: a pending invitation past its date is expired.
export function invitationState(inv: Pick<Invitation, "status" | "expiresAt">, now = new Date()): InvitationState {
  if (inv.status === InvitationStatus.PENDING && inv.expiresAt <= now) return "EXPIRED";
  return inv.status;
}

export class InvitationError extends Error {
  constructor(public status: number, public code: string, message: string) {
    super(message);
  }
}

function newExpiry(): Date {
  return new Date(Date.now() + INVITATION_TTL_DAYS * 24 * 3600 * 1000);
}

// INV-01: one pending invitation per (org, email); current members and
// System Admins can't be invited; the email carries a single-use link.
export async function createOrgInvitation(params: {
  orgId: string;
  email: string;
  role: InvitationRole;
  inviter: { id: string; firstName: string; lastName: string };
}) {
  const email = params.email.trim().toLowerCase();

  const org = await prisma.organization.findFirst({ where: { id: params.orgId, deletedAt: null } });
  if (!org) throw new InvitationError(404, "NOT_FOUND", "Organization not found.");

  const existingUser = await prisma.user.findFirst({
    where: { email: { equals: email, mode: "insensitive" }, deletedAt: null },
    select: { id: true, isSystemAdmin: true },
  });
  if (existingUser?.isSystemAdmin) {
    throw new InvitationError(409, "INVITEE_IS_SA", "This person is a System Admin. System Admins don't join organizations.");
  }
  if (existingUser) {
    const member = await prisma.membership.findFirst({
      where: { orgId: org.id, userId: existingUser.id, status: MembershipStatus.ACTIVE },
    });
    if (member) throw new InvitationError(409, "ALREADY_MEMBER", `${email} is already a member of ${org.name}.`);
  }

  const pending = await prisma.invitation.findFirst({
    where: { orgId: org.id, email, status: InvitationStatus.PENDING, expiresAt: { gt: new Date() } },
  });
  if (pending) {
    throw new InvitationError(409, "ALREADY_INVITED", `${email} already has a pending invitation. Resend it instead.`);
  }

  const { raw, hash } = generateSecureToken();
  const invitation = await prisma.invitation.create({
    data: {
      orgId: org.id,
      email,
      role: params.role,
      tokenHash: hash,
      expiresAt: newExpiry(),
      invitedById: params.inviter.id,
    },
  });

  await sendInvitationEmail(email, org.name, `${params.inviter.firstName} ${params.inviter.lastName}`, raw).catch((err) =>
    console.warn("[Invitations] Could not send invitation email:", err)
  );
  await notifyInvitation("invitation.received", invitation, org.name, params.inviter.id);

  return invitation;
}

// INV-04: a resend issues a new token (the old link stops working) and a
// fresh 7-day window.
export async function resendInvitation(invitationId: string, inviter: { id: string; firstName: string; lastName: string }) {
  const inv = await prisma.invitation.findUnique({ where: { id: invitationId }, include: { organization: true } });
  if (!inv || inv.organization.deletedAt) throw new InvitationError(404, "NOT_FOUND", "Invitation not found.");
  if (inv.status !== InvitationStatus.PENDING) {
    throw new InvitationError(409, "NOT_PENDING", `This invitation was already ${inv.status.toLowerCase()}.`);
  }

  const { raw, hash } = generateSecureToken();
  const updated = await prisma.invitation.update({
    where: { id: inv.id },
    data: { tokenHash: hash, expiresAt: newExpiry() },
  });

  await sendInvitationEmail(inv.email, inv.organization.name, `${inviter.firstName} ${inviter.lastName}`, raw).catch((err) =>
    console.warn("[Invitations] Could not resend invitation email:", err)
  );
  await notifyInvitation("invitation.received", updated, inv.organization.name, inviter.id, { resent: true });
  return updated;
}

// §6.9 Invitation: created/resent/revoked → the invitee if they have an account; accepted/declined →
// the inviter and the org's admins.
export async function notifyInvitation(
  type: "invitation.received" | "invitation.revoked" | "invitation.accepted" | "invitation.declined",
  inv: { id: string; orgId: string; email: string; role: InvitationRole; invitedById: string },
  orgName: string,
  actorId: string,
  extra: Record<string, boolean> = {}
) {
  await notify(
    type,
    { kind: "invitation", id: inv.id, orgId: inv.orgId, email: inv.email, invitedById: inv.invitedById },
    actorId,
    { orgName, role: inv.role, email: inv.email, ...extra }
  );
}

const DEAD_LINK: Record<Exclude<InvitationState, "PENDING">, { code: string; message: string }> = {
  EXPIRED: { code: "INVITATION_EXPIRED", message: "This invitation has expired. Ask the person who invited you to send a new one." },
  REVOKED: { code: "INVITATION_REVOKED", message: "This invitation was cancelled by the organization." },
  ACCEPTED: { code: "INVITATION_USED", message: "This invitation has already been used. Sign in to open your workspace." },
  DECLINED: { code: "INVITATION_DECLINED", message: "This invitation was declined. Ask for a new one if you changed your mind." },
};

// Throws 404 for unknown links and 410 for expired, revoked or used ones (INV-04).
export function assertInvitationUsable(inv: { status: InvitationStatus; expiresAt: Date; organization: { deletedAt: Date | null } } | null) {
  if (!inv) throw new InvitationError(404, "INVITATION_NOT_FOUND", "This invitation link isn't valid. Check that you copied the whole link.");
  if (inv.organization.deletedAt) {
    throw new InvitationError(410, "ORG_DELETED", "The organization behind this invitation no longer exists.");
  }
  const state = invitationState(inv);
  if (state !== "PENDING") {
    const { code, message } = DEAD_LINK[state];
    throw new InvitationError(410, code, message);
  }
}

// ---------------------------------------------------------------------------
// ADM-02: invitation to become System Admin
// ---------------------------------------------------------------------------

// One live link per address: a new invitation cancels the previous pending one.
// Existing accounts are refused here; they get SA from their user page instead.
export async function createSaInvitation(params: {
  email: string;
  inviter: { id: string; firstName: string; lastName: string };
}) {
  const email = params.email.trim().toLowerCase();

  const existing = await prisma.user.findFirst({
    where: { email: { equals: email, mode: "insensitive" }, deletedAt: null },
    select: { isSystemAdmin: true },
  });
  if (existing) {
    throw new InvitationError(
      409,
      existing.isSystemAdmin ? "ALREADY_SA" : "ACCOUNT_EXISTS",
      existing.isSystemAdmin
        ? "This person is already a System Admin."
        : "This email already has an account. Grant System Admin from their user page instead."
    );
  }

  const { raw, hash } = generateSecureToken();
  const invitation = await prisma.$transaction(async (tx) => {
    await tx.saInvitation.updateMany({
      where: { email, status: InvitationStatus.PENDING },
      data: { status: InvitationStatus.REVOKED },
    });
    return tx.saInvitation.create({
      data: { email, tokenHash: hash, expiresAt: newExpiry(), invitedById: params.inviter.id },
    });
  });

  await sendSaInvitationEmail(email, `${params.inviter.firstName} ${params.inviter.lastName}`, raw).catch((err) =>
    console.warn("[Invitations] Could not send SA invitation email:", err)
  );
  return invitation;
}

// 404 for unknown links, 410 for expired, cancelled or used ones.
export function assertSaInvitationUsable(inv: { status: InvitationStatus; expiresAt: Date } | null) {
  if (!inv) throw new InvitationError(404, "INVITATION_NOT_FOUND", "This invitation link isn't valid. Check that you copied the whole link.");
  const state = invitationState(inv);
  if (state !== "PENDING") {
    const { code, message } = DEAD_LINK[state];
    throw new InvitationError(410, code, message);
  }
}
