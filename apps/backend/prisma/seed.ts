import { PrismaClient, AccountStatus } from "@prisma/client";
import * as argon2 from "argon2";

const prisma = new PrismaClient();

function validatePasswordPolicy(password: string): boolean {
  if (password.length < 8) return false;
  if (!/[a-z]/.test(password)) return false;
  if (!/[A-Z]/.test(password)) return false;
  if (!/[0-9]/.test(password)) return false;
  if (!/[^a-zA-Z0-9]/.test(password)) return false;
  return true;
}

async function main() {
  const saEmail = process.env.SEED_SA_EMAIL;
  const saPassword = process.env.SEED_SA_PASSWORD;

  if (!saEmail || !saPassword) {
    throw new Error(`[Seed] FATAL: SEED_SA_EMAIL and SEED_SA_PASSWORD must be set in .env.`);
  }

  if (!validatePasswordPolicy(saPassword)) {
    throw new Error(
      `[Seed] FATAL: SEED_SA_PASSWORD does not meet the security policy (minimum 8 chars, 1 uppercase, 1 lowercase, 1 digit, 1 special character).`
    );
  }

  console.log(`[Seed] Checking for System Administrator (${saEmail})...`);

  let sa = await prisma.user.findFirst({
    where: {
      OR: [{ email: saEmail.toLowerCase().trim() }, { isSystemAdmin: true }],
    },
  });

  if (!sa) {
    console.log(`[Seed] Creating initial System Administrator account...`);
    const passwordHash = await argon2.hash(saPassword, {
      type: argon2.argon2id,
      memoryCost: 19 * 1024,
      timeCost: 2,
      parallelism: 1,
    });

    sa = await prisma.user.create({
      data: {
        email: saEmail.toLowerCase().trim(),
        passwordHash,
        firstName: "System",
        lastName: "Administrator",
        jobTitle: "Platform Admin",
        isSystemAdmin: true,
        status: AccountStatus.ACTIVE,
      },
    });
    console.log(`[Seed] Initial System Administrator created successfully: ${sa.email} (${sa.id})`);
  } else {
    if (!sa.isSystemAdmin) {
      sa = await prisma.user.update({
        where: { id: sa.id },
        data: { isSystemAdmin: true, status: AccountStatus.ACTIVE },
      });
      console.log(`[Seed] Upgraded existing user ${sa.email} to System Administrator.`);
    } else {
      console.log(`[Seed] System Administrator already exists (${sa.email}).`);
    }
  }

  // A System Admin belongs to no organization (§4.1). Older seeds linked the SA
  // to a default "Trenno" org as its OA; undo that on existing databases.
  const now = new Date();
  const ended = await prisma.membership.updateMany({
    where: { userId: sa.id, status: "ACTIVE" },
    data: { status: "REMOVED", leftAt: now },
  });
  if (ended.count > 0) {
    console.log(`[Seed] Ended ${ended.count} organization membership(s) held by the System Administrator.`);
  }

  // The seeded "Trenno" org is only removed while nobody else uses it:
  // created by the SA, no other active members, no projects.
  const seededOrg = await prisma.organization.findFirst({
    where: { name: "Trenno", createdById: sa.id, deletedAt: null },
    include: {
      _count: {
        select: {
          memberships: { where: { status: "ACTIVE" } },
          projects: { where: { deletedAt: null } },
        },
      },
    },
  });
  if (seededOrg && seededOrg._count.memberships === 0 && seededOrg._count.projects === 0) {
    await prisma.invitation.updateMany({
      where: { orgId: seededOrg.id, status: "PENDING" },
      data: { status: "REVOKED" },
    });
    await prisma.organization.update({
      where: { id: seededOrg.id },
      data: { deletedAt: now, deletedById: sa.id },
    });
    console.log(`[Seed] Removed the unused default 'Trenno' organization (${seededOrg.id}).`);
  }
}

main()
  .catch((e) => {
    console.error("[Seed] Error during seeding:", e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
