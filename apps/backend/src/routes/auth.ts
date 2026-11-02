import { Router, Request, Response } from "express";
import { prisma } from "../app";
import {
  hashPassword,
  verifyPassword,
  hashToken,
  generateSecureToken,
  setSessionCookie,
  clearSessionCookie,
  createSession,
  parseCookies,
  SESSION_COOKIE_NAME,
  getAuthContextFromRequest,
} from "../services/auth";
import {
  sendVerificationEmail,
  sendPasswordResetEmail,
  sendPasswordChangedEmail,
  sendAccountLockedEmail,
  sendTwoFactorDisabledEmail,
} from "../services/mailer";
import { disconnectUserSockets } from "../realtime/socket";
import { notify } from "../services/notifications";
import { checkRateLimit } from "../services/rateLimiter";
import {
  encryptSecret,
  decryptSecret,
  verifyTOTPCode,
  generateTOTPDetails,
  generateQRCodeDataUrl,
  generateRecoveryCodes,
} from "../services/twoFactor";
import { AccountStatus, AuthTokenType } from "@prisma/client";
import {
  SignUpSchema,
  LoginSchema,
  TwoFactorLoginSchema,
  TwoFactorSetupSchema,
  TwoFactorEnableSchema,
  TwoFactorDisableSchema,
  ForgotPasswordSchema,
  ResetPasswordSchema,
  VerifyEmailSchema,
  ResendVerificationSchema,
  PasswordSchema,
  UpdateProfileSchema,
} from "../schemas";

export const authRouter = Router();

// Track failed 2FA verification attempts per pending session (2FA-03: 5 wrong codes -> start again)
const failed2faAttempts = new Map<string, number>();

// Helper to reject authenticated requests on public auth endpoints (AUTH guard)
async function requireGuest(req: Request, res: Response): Promise<boolean> {
  const authCtx = await getAuthContextFromRequest(req);
  if (authCtx) {
    res.status(403).json({
      error: {
        code: "ALREADY_AUTHENTICATED",
        message: "You are already logged in. Please log out first.",
      },
    });
    return false;
  }
  return true;
}

// POST /api/v1/auth/signup (AUTH-01)
authRouter.post("/signup", async (req: Request, res: Response) => {
  if (!(await requireGuest(req, res))) return;
  const parseResult = SignUpSchema.safeParse(req.body);
  if (!parseResult.success) {
    return res.status(400).json({
      error: {
        code: "VALIDATION_ERROR",
        message: parseResult.error.errors[0]?.message || "Validation failed",
        details: parseResult.error.errors,
      },
    });
  }

  const { email, password, firstName, lastName } = parseResult.data;
  const normalizedEmail = email.toLowerCase().trim();

  try {
    // Check if user already exists (anti-enumeration: return identical success message)
    const existing = await prisma.user.findFirst({
      where: { email: { equals: normalizedEmail, mode: "insensitive" } },
    });

    if (existing) {
      if (existing.status === AccountStatus.PENDING_VERIFICATION) {
        // Optionally generate a fresh token and email them, but do not leak status
        const { raw, hash } = generateSecureToken();
        const expiresAt = new Date(Date.now() + 24 * 3600 * 1000);

        await prisma.authToken.create({
          data: {
            userId: existing.id,
            type: AuthTokenType.VERIFY_EMAIL,
            tokenHash: hash,
            expiresAt,
          },
        });

        sendVerificationEmail(existing.email, raw, existing.firstName).catch((err) =>
          console.error("[Mailer Error] Sign-up re-verify email failed:", err)
        );
      }

      return res.status(200).json({
        success: true,
        message: "If an account with this email exists, a verification link has been sent.",
      });
    }

    // Create new user
    const passwordHash = await hashPassword(password);
    const newUser = await prisma.user.create({
      data: {
        email: normalizedEmail,
        passwordHash,
        firstName: firstName.trim(),
        lastName: lastName.trim(),
        status: AccountStatus.PENDING_VERIFICATION,
      },
    });

    // Generate 24h verification token
    const { raw, hash } = generateSecureToken();
    const expiresAt = new Date(Date.now() + 24 * 3600 * 1000);

    await prisma.authToken.create({
      data: {
        userId: newUser.id,
        type: AuthTokenType.VERIFY_EMAIL,
        tokenHash: hash,
        expiresAt,
      },
    });

    sendVerificationEmail(newUser.email, raw, newUser.firstName).catch((err) =>
      console.error("[Mailer Error] Sign-up verification email failed:", err)
    );

    // Same status and body as the "email already in use" branch above, so the response can't be
    // used to find out which addresses have an account (AUTH-01).
    return res.status(200).json({
      success: true,
      message: "If an account with this email exists, a verification link has been sent.",
    });
  } catch (err) {
    console.error("[Auth] Sign-up error:", err);
    return res.status(500).json({
      error: {
        code: "INTERNAL_ERROR",
        message: "An unexpected error occurred during registration.",
      },
    });
  }
});

// POST /api/v1/auth/verify (AUTH-02)
authRouter.post("/verify", async (req: Request, res: Response) => {
  if (!(await requireGuest(req, res))) return;
  const parseResult = VerifyEmailSchema.safeParse(req.body);
  if (!parseResult.success) {
    return res.status(400).json({
      error: {
        code: "VALIDATION_ERROR",
        message: parseResult.error.errors[0]?.message || "Invalid verification token format.",
      },
    });
  }

  const { token } = parseResult.data;
  const hash = hashToken(token.trim());

  try {
    const tokenRecord = await prisma.authToken.findUnique({
      where: { tokenHash: hash },
      include: { user: true },
    });

    if (!tokenRecord || tokenRecord.type !== AuthTokenType.VERIFY_EMAIL || tokenRecord.usedAt) {
      return res.status(400).json({
        error: {
          code: "INVALID_TOKEN",
          message: "Verification link is invalid or has already been used.",
        },
      });
    }

    if (tokenRecord.expiresAt < new Date()) {
      return res.status(400).json({
        error: {
          code: "TOKEN_EXPIRED",
          message: "Verification link has expired. Please request a new one.",
        },
      });
    }

    // Activate user and mark token used
    await prisma.$transaction([
      prisma.authToken.update({
        where: { id: tokenRecord.id },
        data: { usedAt: new Date() },
      }),
      prisma.user.update({
        where: { id: tokenRecord.userId },
        data: { status: AccountStatus.ACTIVE },
      }),
    ]);

    return res.status(200).json({
      success: true,
      message: "Email successfully verified. You can now log in.",
    });
  } catch (err) {
    console.error("[Auth] Verify error:", err);
    return res.status(500).json({
      error: {
        code: "INTERNAL_ERROR",
        message: "Failed to verify email.",
      },
    });
  }
});

// POST /api/v1/auth/verify/resend (AUTH-02)
authRouter.post("/verify/resend", async (req: Request, res: Response) => {
  if (!(await requireGuest(req, res))) return;
  const parseResult = ResendVerificationSchema.safeParse(req.body);
  if (!parseResult.success) {
    return res.status(400).json({
      error: {
        code: "VALIDATION_ERROR",
        message: parseResult.error.errors[0]?.message || "Invalid email address.",
      },
    });
  }

  const { email } = parseResult.data;
  const normalizedEmail = email.toLowerCase().trim();

  // Rate limit: max 3 per hour per email
  const limitCheck = checkRateLimit(`resend_verify:${normalizedEmail}`, 3, 3600);
  if (limitCheck.limited) {
    return res.status(429).json({
      error: {
        code: "RATE_LIMITED",
        message: `Too many verification requests. Please wait ${Math.ceil(limitCheck.retryAfter / 60)} minutes before trying again.`,
      },
    });
  }

  try {
    const user = await prisma.user.findFirst({
      where: {
        email: { equals: normalizedEmail, mode: "insensitive" },
        status: AccountStatus.PENDING_VERIFICATION,
        deletedAt: null,
      },
    });

    if (user) {
      const { raw, hash } = generateSecureToken();
      const expiresAt = new Date(Date.now() + 24 * 3600 * 1000);

      await prisma.authToken.create({
        data: {
          userId: user.id,
          type: AuthTokenType.VERIFY_EMAIL,
          tokenHash: hash,
          expiresAt,
        },
      });

      sendVerificationEmail(user.email, raw, user.firstName).catch((err) =>
        console.error("[Mailer Error] Resend verification email failed:", err)
      );
    }

    // Anti-enumeration: always return success
    return res.status(200).json({
      success: true,
      message: "If your account is pending verification, a new link has been sent to your email.",
    });
  } catch (err) {
    console.error("[Auth] Resend verify error:", err);
    return res.status(500).json({
      error: {
        code: "INTERNAL_ERROR",
        message: "Failed to resend verification email.",
      },
    });
  }
});

// POST /api/v1/auth/login (AUTH-03)
authRouter.post("/login", async (req: Request, res: Response) => {
  if (!(await requireGuest(req, res))) return;
  const parseResult = LoginSchema.safeParse(req.body);
  if (!parseResult.success) {
    return res.status(400).json({
      error: {
        code: "VALIDATION_ERROR",
        message: parseResult.error.errors[0]?.message || "Invalid login credentials format.",
      },
    });
  }

  const { email, password } = parseResult.data;
  const normalizedEmail = email.toLowerCase().trim();
  // req.ip comes from the proxy-appended address (see "trust proxy" in app.ts),
  // so a spoofed X-Forwarded-For header can't reset the limit.
  const clientIp = req.ip || req.socket.remoteAddress || "127.0.0.1";

  // Rate limit: max 10 failed login attempts per minute per IP
  const ipCheck = checkRateLimit(`login_ip:${clientIp}`, 10, 60);
  if (ipCheck.limited) {
    return res.status(429).json({
      error: {
        code: "RATE_LIMITED",
        message: `Too many login attempts from this network. Try again in ${ipCheck.retryAfter} seconds.`,
      },
    });
  }

  try {
    const user = await prisma.user.findFirst({
      where: {
        email: { equals: normalizedEmail, mode: "insensitive" },
        deletedAt: null,
      },
      include: {
        twoFactor: true,
        memberships: {
          where: { status: "ACTIVE" },
          include: { organization: true },
        },
      },
    });

    if (!user || !user.passwordHash) {
      return res.status(401).json({
        error: {
          code: "INVALID_CREDENTIALS",
          message: "Invalid email or password.",
        },
      });
    }

    // Check account lockout (5 consecutive failed attempts -> 15 min lock)
    const now = new Date();
    if (user.lockedUntil && user.lockedUntil > now) {
      const remainingMinutes = Math.ceil((user.lockedUntil.getTime() - now.getTime()) / 60000);
      return res.status(423).json({
        error: {
          code: "ACCOUNT_LOCKED",
          message: `Account is temporarily locked. Try again in ${remainingMinutes} minute${remainingMinutes > 1 ? "s" : ""}.`,
        },
      });
    }

    // Verify password
    const isPasswordValid = await verifyPassword(user.passwordHash, password);
    if (!isPasswordValid) {
      // A lock that has run out starts a fresh count: "5 consecutive failures" (AUTH-04).
      const lockExpired = Boolean(user.lockedUntil && user.lockedUntil <= now);
      const newCount = (lockExpired ? 0 : user.failedLoginCount) + 1;
      if (newCount >= 5) {
        const lockoutMinutes = 15;
        const lockedUntil = new Date(Date.now() + lockoutMinutes * 60 * 1000);

        await prisma.user.update({
          where: { id: user.id },
          data: {
            failedLoginCount: newCount,
            lockedUntil,
          },
        });

        sendAccountLockedEmail(user.email, user.firstName, lockoutMinutes).catch((err) =>
          console.error("[Mailer Error] Account locked email failed:", err)
        );
        await notify("account.locked", { kind: "user", id: user.id }, null, { minutes: lockoutMinutes });

        return res.status(423).json({
          error: {
            code: "ACCOUNT_LOCKED",
            message: "Account is temporarily locked. Try again in 15 minutes.",
          },
        });
      } else {
        await prisma.user.update({
          where: { id: user.id },
          data: { failedLoginCount: newCount, ...(lockExpired ? { lockedUntil: null } : {}) },
        });

        return res.status(401).json({
          error: {
            code: "INVALID_CREDENTIALS",
            message: "Invalid email or password.",
          },
        });
      }
    }

    // Password is valid - reset failed attempts & lockout
    if (user.failedLoginCount > 0 || user.lockedUntil) {
      await prisma.user.update({
        where: { id: user.id },
        data: {
          failedLoginCount: 0,
          lockedUntil: null,
        },
      });
    }

    // Check account status
    if (user.status === AccountStatus.PENDING_VERIFICATION) {
      return res.status(403).json({
        error: {
          code: "EMAIL_NOT_VERIFIED",
          message: "Verify your email first.",
        },
      });
    }

    if (user.status === AccountStatus.SUSPENDED) {
      return res.status(403).json({
        error: {
          code: "ACCOUNT_SUSPENDED",
          message: "Account suspended.",
        },
      });
    }

    // Check if 2FA is enabled (2FA-03)
    if (user.twoFactor && user.twoFactor.enabledAt) {
      // Create temporary 2FA-pending session (expires in 5 minutes)
      const rawSessionToken = await createSession(user.id, true);
      setSessionCookie(res, rawSessionToken, 5 * 60);

      return res.status(200).json({
        requires2fa: true,
        message: "Two-factor authentication code required.",
      });
    }

    // Normal session creation (7 days)
    const rawSessionToken = await createSession(user.id, false);
    setSessionCookie(res, rawSessionToken);

    await prisma.user.update({
      where: { id: user.id },
      data: { lastLoginAt: new Date() },
    });

    // Determine role and active org
    let role: "SA" | "OA" | "MEMBER" | "VIEWER" | "U" = "U";
    let activeOrg: { id: string; name: string } | null = null;

    if (user.isSystemAdmin) {
      role = "SA";
    }

    const activeMembership = user.memberships[0];
    // A System Admin belongs to no organization (§4.1), even if an old membership row is still active.
    if (!user.isSystemAdmin && activeMembership && activeMembership.organization && !activeMembership.organization.deletedAt) {
      activeOrg = {
        id: activeMembership.organization.id,
        name: activeMembership.organization.name,
      };
      if (role !== "SA") {
        role = activeMembership.role as "OA" | "MEMBER" | "VIEWER";
      }
    }

    return res.status(200).json({
      requires2fa: false,
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
      organization: activeOrg,
      role,
    });
  } catch (err) {
    console.error("[Auth] Login error:", err);
    return res.status(500).json({
      error: {
        code: "INTERNAL_ERROR",
        message: "An error occurred during login.",
      },
    });
  }
});

// POST /api/v1/auth/login/2fa (2FA-03)
authRouter.post("/login/2fa", async (req: Request, res: Response) => {
  const parseResult = TwoFactorLoginSchema.safeParse(req.body);
  if (!parseResult.success) {
    return res.status(400).json({
      error: {
        code: "VALIDATION_ERROR",
        message: parseResult.error.errors[0]?.message || "Invalid 2FA verification request.",
      },
    });
  }

  const { code, isRecoveryCode } = parseResult.data;
  const cookies = parseCookies(req);
  const rawSession = cookies[SESSION_COOKIE_NAME];

  if (!rawSession) {
    return res.status(401).json({
      error: {
        code: "UNAUTHORIZED",
        message: "2FA session expired. Please log in again.",
      },
    });
  }

  const idHash = hashToken(rawSession);

  try {
    const session = await prisma.session.findUnique({
      where: { idHash },
      include: {
        user: {
          include: {
            twoFactor: true,
            recoveryCodes: {
              where: { usedAt: null },
            },
            memberships: {
              where: { status: "ACTIVE" },
              include: { organization: true },
            },
          },
        },
      },
    });

    if (!session || !session.pending2fa || session.expiresAt < new Date() || session.revokedAt) {
      return res.status(401).json({
        error: {
          code: "UNAUTHORIZED",
          message: "2FA session expired or invalid. Please log in again.",
        },
      });
    }

    const user = session.user;
    if (!user.twoFactor || !user.twoFactor.enabledAt) {
      return res.status(400).json({
        error: {
          code: "BAD_REQUEST",
          message: "2FA is not enabled on this account.",
        },
      });
    }

    const recordFailed2fa = async (errMsg: string) => {
      const attempts = (failed2faAttempts.get(idHash) || 0) + 1;
      if (attempts >= 5) {
        failed2faAttempts.delete(idHash);
        await prisma.session.delete({ where: { idHash } }).catch(() => {});
        clearSessionCookie(res);
        return res.status(401).json({
          error: {
            code: "EXPIRED_SESSION",
            message: "Too many failed attempts (5/5). Your verification session has ended. Please sign in again.",
          },
        });
      }
      failed2faAttempts.set(idHash, attempts);
      return res.status(400).json({
        error: {
          code: "INVALID_2FA_CODE",
          message: `${errMsg} (${5 - attempts} attempts remaining)`,
        },
      });
    };

    if (isRecoveryCode) {
      const codeClean = code.trim().toUpperCase();
      const codeHash = hashToken(codeClean);
      const matched = user.recoveryCodes.find((rc) => rc.codeHash === codeHash);

      if (!matched) {
        return await recordFailed2fa("Invalid or already used recovery code.");
      }

      // Mark recovery code used
      await prisma.recoveryCode.update({
        where: { id: matched.id },
        data: { usedAt: new Date() },
      });
    } else {
      const cleanCode = code.trim();
      const secret = decryptSecret(user.twoFactor.secretEncrypted);
      const isValid = verifyTOTPCode(secret, cleanCode);

      if (!isValid) {
        return await recordFailed2fa("Invalid verification code. Please check your authenticator app.");
      }
    }

    // Success: clear failed counter
    failed2faAttempts.delete(idHash);

    // Promote session from pending to full 7-day session
    const expiresAt = new Date(Date.now() + 7 * 24 * 3600 * 1000);
    await prisma.session.update({
      where: { idHash },
      data: {
        pending2fa: false,
        expiresAt,
        lastActivityAt: new Date(),
      },
    });

    setSessionCookie(res, rawSession);

    await prisma.user.update({
      where: { id: user.id },
      data: { lastLoginAt: new Date() },
    });

    let role: "SA" | "OA" | "MEMBER" | "VIEWER" | "U" = "U";
    let activeOrg: { id: string; name: string } | null = null;

    if (user.isSystemAdmin) {
      role = "SA";
    }

    const activeMembership = user.memberships[0];
    // A System Admin belongs to no organization (§4.1), even if an old membership row is still active.
    if (!user.isSystemAdmin && activeMembership && activeMembership.organization && !activeMembership.organization.deletedAt) {
      activeOrg = {
        id: activeMembership.organization.id,
        name: activeMembership.organization.name,
      };
      if (role !== "SA") {
        role = activeMembership.role as "OA" | "MEMBER" | "VIEWER";
      }
    }

    return res.status(200).json({
      success: true,
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
      organization: activeOrg,
      role,
    });
  } catch (err) {
    console.error("[Auth] 2FA verification error:", err);
    return res.status(500).json({
      error: {
        code: "INTERNAL_ERROR",
        message: "Failed to verify 2FA code.",
      },
    });
  }
});

// POST /api/v1/auth/logout (AUTH-03)
authRouter.post("/logout", async (req: Request, res: Response) => {
  const cookies = parseCookies(req);
  const rawSession = cookies[SESSION_COOKIE_NAME];

  if (rawSession) {
    const idHash = hashToken(rawSession);
    try {
      const session = await prisma.session.findUnique({
        where: { idHash },
        select: { userId: true },
      });

      if (session) {
        await prisma.session.deleteMany({
          where: { idHash },
        });
        // Only this session's sockets: the user's other devices stay connected.
        await disconnectUserSockets(session.userId, { sessionHash: idHash, reason: "You signed out." });
      }
    } catch (err) {
      console.warn("[Auth] Logout session deletion warning:", err);
    }
  }

  clearSessionCookie(res);
  return res.status(200).json({
    success: true,
    message: "Logged out successfully.",
  });
});

// POST /api/v1/auth/password/forgot (AUTH-05)
authRouter.post("/password/forgot", async (req: Request, res: Response) => {
  if (!(await requireGuest(req, res))) return;
  const parseResult = ForgotPasswordSchema.safeParse(req.body);
  if (!parseResult.success) {
    return res.status(400).json({
      error: {
        code: "VALIDATION_ERROR",
        message: parseResult.error.errors[0]?.message || "Invalid email address format.",
      },
    });
  }

  const { email } = parseResult.data;
  const normalizedEmail = email.toLowerCase().trim();

  // Rate limit: max 3 per hour per email
  const limitCheck = checkRateLimit(`forgot_pass:${normalizedEmail}`, 3, 3600);
  if (limitCheck.limited) {
    return res.status(429).json({
      error: {
        code: "RATE_LIMITED",
        message: `Too many password reset requests. Please wait ${Math.ceil(limitCheck.retryAfter / 60)} minutes before trying again.`,
      },
    });
  }

  try {
    const user = await prisma.user.findFirst({
      where: {
        email: { equals: normalizedEmail, mode: "insensitive" },
        deletedAt: null,
      },
    });

    if (user && user.status !== AccountStatus.DELETED) {
      // Invalidate any older unused reset tokens (AUTH-05: new request invalidates older links)
      await prisma.authToken.updateMany({
        where: {
          userId: user.id,
          type: AuthTokenType.RESET_PASSWORD,
          usedAt: null,
        },
        data: {
          usedAt: new Date(),
        },
      });

      const { raw, hash } = generateSecureToken();
      // Valid for 30 minutes
      const expiresAt = new Date(Date.now() + 30 * 60 * 1000);

      await prisma.authToken.create({
        data: {
          userId: user.id,
          type: AuthTokenType.RESET_PASSWORD,
          tokenHash: hash,
          expiresAt,
        },
      });

      sendPasswordResetEmail(user.email, raw, user.firstName).catch((err) =>
        console.error("[Mailer Error] Password reset email failed:", err)
      );
    }

    // Anti-enumeration: identical message in all cases (AUTH-05)
    return res.status(200).json({
      success: true,
      message: "If an account exists, a link was sent.",
    });
  } catch (err) {
    console.error("[Auth] Forgot password error:", err);
    return res.status(500).json({
      error: {
        code: "INTERNAL_ERROR",
        message: "Failed to process password reset request.",
      },
    });
  }
});

// ALL /api/v1/auth/password/reset/verify (Verify reset token upfront without consuming)
authRouter.all("/password/reset/verify", async (req: Request, res: Response) => {
  if (req.method !== "GET" && req.method !== "POST") {
    return res.status(405).json({
      error: { code: "METHOD_NOT_ALLOWED", message: "Method not allowed." },
    });
  }

  const rawToken = req.method === "GET" ? req.query.token : req.body?.token;
  const token = typeof rawToken === "string" ? rawToken.trim() : "";

  if (!token) {
    return res.status(400).json({
      error: {
        code: "INVALID_TOKEN",
        message: "Password reset link is invalid or has already been used.",
      },
    });
  }

  const hash = hashToken(token);

  try {
    const tokenRecord = await prisma.authToken.findUnique({
      where: { tokenHash: hash },
      include: { user: true },
    });

    if (!tokenRecord || tokenRecord.type !== AuthTokenType.RESET_PASSWORD || tokenRecord.usedAt) {
      return res.status(400).json({
        error: {
          code: "INVALID_TOKEN",
          message: "Password reset link is invalid or has already been used.",
        },
      });
    }

    if (tokenRecord.expiresAt < new Date()) {
      return res.status(400).json({
        error: {
          code: "TOKEN_EXPIRED",
          message: "Password reset link has expired. Please request a new one.",
        },
      });
    }

    return res.status(200).json({
      valid: true,
      email: tokenRecord.user.email,
    });
  } catch (err) {
    console.error("[Auth] Verify reset token error:", err);
    return res.status(500).json({
      error: {
        code: "INTERNAL_ERROR",
        message: "Failed to verify reset token.",
      },
    });
  }
});

// POST /api/v1/auth/password/reset (AUTH-06)
authRouter.post("/password/reset", async (req: Request, res: Response) => {
  if (!(await requireGuest(req, res))) return;
  const parseResult = ResetPasswordSchema.safeParse(req.body);
  if (!parseResult.success) {
    return res.status(400).json({
      error: {
        code: "VALIDATION_ERROR",
        message: parseResult.error.errors[0]?.message || "Validation failed.",
        details: parseResult.error.errors,
      },
    });
  }

  const { token, password } = parseResult.data;
  const hash = hashToken(token.trim());

  try {
    const tokenRecord = await prisma.authToken.findUnique({
      where: { tokenHash: hash },
      include: { user: true },
    });

    if (!tokenRecord || tokenRecord.type !== AuthTokenType.RESET_PASSWORD || tokenRecord.usedAt) {
      return res.status(400).json({
        error: {
          code: "INVALID_TOKEN",
          message: "Password reset link is invalid or has already been used.",
        },
      });
    }

    if (tokenRecord.expiresAt < new Date()) {
      return res.status(400).json({
        error: {
          code: "TOKEN_EXPIRED",
          message: "Password reset link has expired. Please request a new one.",
        },
      });
    }

    const newPasswordHash = await hashPassword(password);
    const now = new Date();

    // In transaction: update password, mark token used, revoke ALL existing sessions
    await prisma.$transaction([
      prisma.user.update({
        where: { id: tokenRecord.userId },
        data: {
          passwordHash: newPasswordHash,
          failedLoginCount: 0,
          lockedUntil: null,
        },
      }),
      prisma.authToken.update({
        where: { id: tokenRecord.id },
        data: { usedAt: now },
      }),
      prisma.session.updateMany({
        where: { userId: tokenRecord.userId, revokedAt: null },
        data: { revokedAt: now },
      }),
    ]);

    await disconnectUserSockets(tokenRecord.userId, { reason: "Your password was reset. Sign in again." });
    await notify("account.password_reset", { kind: "user", id: tokenRecord.userId }, null);

    sendPasswordChangedEmail(tokenRecord.user.email, tokenRecord.user.firstName).catch((err) =>
      console.error("[Mailer Error] Password changed email failed:", err)
    );

    return res.status(200).json({
      success: true,
      message: "Password reset successfully. You can now log in with your new password.",
    });
  } catch (err) {
    console.error("[Auth] Reset password error:", err);
    return res.status(500).json({
      error: {
        code: "INTERNAL_ERROR",
        message: "Failed to reset password.",
      },
    });
  }
});

// GET /api/v1/auth/me
authRouter.get("/me", async (req: Request, res: Response) => {
  try {
    const authContext = await getAuthContextFromRequest(req);
    if (!authContext) {
      return res.status(401).json({
        error: {
          code: "UNAUTHORIZED",
          message: "Authentication required.",
        },
      });
    }

    return res.status(200).json({
      user: authContext.user,
      organization: authContext.organization,
      role: authContext.role,
    });
  } catch (err) {
    console.error("[Auth] Get current user error:", err);
    return res.status(500).json({
      error: {
        code: "INTERNAL_ERROR",
        message: "Failed to get user profile.",
      },
    });
  }
});

// PATCH /api/v1/auth/profile (USR-01)
authRouter.patch("/profile", async (req: Request, res: Response) => {
  try {
    const authContext = await getAuthContextFromRequest(req);
    if (!authContext) {
      return res.status(401).json({
        error: { code: "UNAUTHORIZED", message: "Authentication required." },
      });
    }

    const parsed = UpdateProfileSchema.safeParse(req.body);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      return res.status(400).json({
        error: { code: "VALIDATION_ERROR", message: issue?.message || "Invalid profile data.", field: issue?.path[0] },
      });
    }
    const { firstName, lastName, jobTitle, bio } = parsed.data;

    const dataToUpdate: Record<string, string | null> = {};
    if (firstName !== undefined) dataToUpdate.firstName = firstName;
    if (lastName !== undefined) dataToUpdate.lastName = lastName;
    if (jobTitle !== undefined) dataToUpdate.jobTitle = jobTitle || null;
    if (bio !== undefined) dataToUpdate.bio = bio || null;

    const updatedUser = await prisma.user.update({
      where: { id: authContext.user.id },
      data: dataToUpdate,
      select: {
        id: true,
        email: true,
        firstName: true,
        lastName: true,
        jobTitle: true,
        bio: true,
        avatarPath: true,
        isSystemAdmin: true,
        status: true,
      },
    });

    return res.status(200).json({
      success: true,
      message: "Profile updated successfully.",
      user: updatedUser,
    });
  } catch (err) {
    console.error("[Auth] Update profile error:", err);
    return res.status(500).json({
      error: { code: "INTERNAL_ERROR", message: "Failed to update profile." },
    });
  }
});

// POST /api/v1/auth/password/change (AUTH-06)
authRouter.post("/password/change", async (req: Request, res: Response) => {
  try {
    const authContext = await getAuthContextFromRequest(req);
    if (!authContext) {
      return res.status(401).json({
        error: { code: "UNAUTHORIZED", message: "Authentication required." },
      });
    }

    const { currentPassword, newPassword } = req.body;
    if (!currentPassword || !newPassword) {
      return res.status(400).json({
        error: { code: "VALIDATION_ERROR", message: "Current password and new password are required." },
      });
    }

    const user = await prisma.user.findUnique({
      where: { id: authContext.user.id },
    });
    if (!user || !user.passwordHash) {
      return res.status(400).json({
        error: { code: "BAD_REQUEST", message: "Account has no password set." },
      });
    }

    const isMatch = await verifyPassword(user.passwordHash, currentPassword);
    if (!isMatch) {
      return res.status(400).json({
        error: { code: "INVALID_CREDENTIALS", message: "Current password is incorrect." },
      });
    }

    const parseResult = PasswordSchema.safeParse(newPassword);
    if (!parseResult.success) {
      return res.status(400).json({
        error: { code: "VALIDATION_ERROR", message: parseResult.error.errors[0]?.message || "New password does not meet security requirements." },
      });
    }

    const newHash = await hashPassword(newPassword);
    await prisma.user.update({
      where: { id: user.id },
      data: { passwordHash: newHash },
    });

    // Revoke all OTHER sessions
    const rawSession = parseCookies(req)[SESSION_COOKIE_NAME];
    const currentHash = rawSession ? hashToken(rawSession) : null;
    if (currentHash) {
      await prisma.session.updateMany({
        where: {
          userId: user.id,
          idHash: { not: currentHash },
          revokedAt: null,
        },
        data: { revokedAt: new Date() },
      });
      await disconnectUserSockets(user.id, { exceptSessionHash: currentHash, reason: "Your password was changed. Sign in again." });
    }

    sendPasswordChangedEmail(user.email, user.firstName).catch((err) =>
      console.error("[Mailer Error] Password changed confirmation email failed:", err)
    );
    await notify("account.password_changed", { kind: "user", id: user.id }, null);

    return res.status(200).json({
      success: true,
      message: "Password changed successfully.",
    });
  } catch (err) {
    console.error("[Auth] Change password error:", err);
    return res.status(500).json({
      error: { code: "INTERNAL_ERROR", message: "Failed to change password." },
    });
  }
});

// GET /api/v1/auth/2fa/status (2FA-01)
authRouter.get("/2fa/status", async (req: Request, res: Response) => {
  try {
    const authContext = await getAuthContextFromRequest(req);
    if (!authContext) {
      return res.status(401).json({
        error: { code: "UNAUTHORIZED", message: "Authentication required." },
      });
    }

    const twoFactor = await prisma.twoFactor.findUnique({
      where: { userId: authContext.user.id },
    });

    const isEnabled = Boolean(twoFactor && twoFactor.enabledAt);
    let remainingRecoveryCodes = 0;
    if (isEnabled) {
      remainingRecoveryCodes = await prisma.recoveryCode.count({
        where: { userId: authContext.user.id, usedAt: null },
      });
    }

    return res.status(200).json({
      enabled: isEnabled,
      remainingRecoveryCodes,
    });
  } catch (err) {
    console.error("[Auth] 2FA status error:", err);
    return res.status(500).json({
      error: { code: "INTERNAL_ERROR", message: "Failed to get 2FA status." },
    });
  }
});

// POST /api/v1/auth/2fa/setup (2FA-01)
// Password required, QR code generated locally + secret as text. Secret stored encrypted (AES-256-GCM).
authRouter.post("/2fa/setup", async (req: Request, res: Response) => {
  try {
    const authContext = await getAuthContextFromRequest(req);
    if (!authContext) {
      return res.status(401).json({
        error: { code: "UNAUTHORIZED", message: "Authentication required." },
      });
    }

    const parseResult = TwoFactorSetupSchema.safeParse(req.body);
    if (!parseResult.success) {
      return res.status(400).json({
        error: {
          code: "VALIDATION_ERROR",
          message: parseResult.error.errors[0]?.message || "Password is required to set up 2FA.",
        },
      });
    }

    const { password } = parseResult.data;
    const user = await prisma.user.findUnique({
      where: { id: authContext.user.id },
    });

    if (!user || !user.passwordHash) {
      return res.status(400).json({
        error: { code: "BAD_REQUEST", message: "Account has no password configured." },
      });
    }

    const isPasswordValid = await verifyPassword(user.passwordHash, password);
    if (!isPasswordValid) {
      return res.status(400).json({
        error: { code: "INVALID_PASSWORD", message: "Incorrect password. Please verify your current password." },
      });
    }

    // Generate TOTP secret and local QR code (locally in-process)
    const { secret, otpauthUrl } = generateTOTPDetails(user.email);
    const qrCodeDataUrl = await generateQRCodeDataUrl(otpauthUrl);
    const secretEncrypted = new Uint8Array(encryptSecret(secret));

    // Save pending secret (enabledAt: null until verified)
    await prisma.twoFactor.upsert({
      where: { userId: user.id },
      create: {
        userId: user.id,
        secretEncrypted,
        enabledAt: null,
      },
      update: {
        secretEncrypted,
        enabledAt: null,
      },
    });

    return res.status(200).json({
      secret,
      qrCodeDataUrl,
    });
  } catch (err) {
    console.error("[Auth] 2FA setup error:", err);
    return res.status(500).json({
      error: { code: "INTERNAL_ERROR", message: "Failed to initiate 2FA setup." },
    });
  }
});

// POST /api/v1/auth/2fa/enable (2FA-01, 2FA-02)
// Active only after a valid 6-digit code. Generates 10 single-use recovery codes, stored hashed.
authRouter.post("/2fa/enable", async (req: Request, res: Response) => {
  try {
    const authContext = await getAuthContextFromRequest(req);
    if (!authContext) {
      return res.status(401).json({
        error: { code: "UNAUTHORIZED", message: "Authentication required." },
      });
    }

    const parseResult = TwoFactorEnableSchema.safeParse(req.body);
    if (!parseResult.success) {
      return res.status(400).json({
        error: {
          code: "VALIDATION_ERROR",
          message: parseResult.error.errors[0]?.message || "Invalid 6-digit verification code.",
        },
      });
    }

    const { code } = parseResult.data;
    const twoFactor = await prisma.twoFactor.findUnique({
      where: { userId: authContext.user.id },
    });

    if (!twoFactor) {
      return res.status(400).json({
        error: {
          code: "NO_PENDING_SETUP",
          message: "No pending 2FA configuration found. Please start 2FA setup first.",
        },
      });
    }

    const secret = decryptSecret(twoFactor.secretEncrypted);
    const isValid = verifyTOTPCode(secret, code);

    if (!isValid) {
      return res.status(400).json({
        error: {
          code: "INVALID_2FA_CODE",
          message: "Invalid verification code. Please check your authenticator app and try again.",
        },
      });
    }

    // Activate 2FA
    await prisma.twoFactor.update({
      where: { userId: authContext.user.id },
      data: { enabledAt: new Date() },
    });

    // Generate 10 single-use recovery codes, stored hashed (2FA-02)
    const rawCodes = generateRecoveryCodes(10);
    await prisma.recoveryCode.deleteMany({
      where: { userId: authContext.user.id },
    });

    await prisma.recoveryCode.createMany({
      data: rawCodes.map((c) => ({
        userId: authContext.user.id,
        codeHash: hashToken(c.toUpperCase().trim()),
      })),
    });
    await notify("account.2fa_enabled", { kind: "user", id: authContext.user.id }, null);

    return res.status(200).json({
      success: true,
      recoveryCodes: rawCodes,
    });
  } catch (err) {
    console.error("[Auth] 2FA enable error:", err);
    return res.status(500).json({
      error: { code: "INTERNAL_ERROR", message: "Failed to enable 2FA." },
    });
  }
});

// POST /api/v1/auth/2fa/disable (2FA-04)
// Password + valid code. Confirmation email.
authRouter.post("/2fa/disable", async (req: Request, res: Response) => {
  try {
    const authContext = await getAuthContextFromRequest(req);
    if (!authContext) {
      return res.status(401).json({
        error: { code: "UNAUTHORIZED", message: "Authentication required." },
      });
    }

    const parseResult = TwoFactorDisableSchema.safeParse(req.body);
    if (!parseResult.success) {
      return res.status(400).json({
        error: {
          code: "VALIDATION_ERROR",
          message: parseResult.error.errors[0]?.message || "Password and code are required to disable 2FA.",
        },
      });
    }

    const { password, code } = parseResult.data;
    const user = await prisma.user.findUnique({
      where: { id: authContext.user.id },
      include: {
        twoFactor: true,
        recoveryCodes: { where: { usedAt: null } },
      },
    });

    if (!user || !user.passwordHash) {
      return res.status(400).json({
        error: { code: "BAD_REQUEST", message: "Account has no password configured." },
      });
    }

    const isPasswordValid = await verifyPassword(user.passwordHash, password);
    if (!isPasswordValid) {
      return res.status(400).json({
        error: { code: "INVALID_PASSWORD", message: "Incorrect password. Please verify your current password." },
      });
    }

    if (!user.twoFactor || !user.twoFactor.enabledAt) {
      return res.status(400).json({
        error: { code: "BAD_REQUEST", message: "Two-factor authentication is not active on this account." },
      });
    }

    // Verify code: accept either TOTP (±1 step) or unused recovery code
    const secret = decryptSecret(user.twoFactor.secretEncrypted);
    let isCodeValid = verifyTOTPCode(secret, code);

    if (!isCodeValid) {
      const codeClean = code.trim().toUpperCase();
      const codeHash = hashToken(codeClean);
      const matched = user.recoveryCodes.find((rc) => rc.codeHash === codeHash);
      if (matched) {
        isCodeValid = true;
      }
    }

    if (!isCodeValid) {
      return res.status(400).json({
        error: {
          code: "INVALID_2FA_CODE",
          message: "Invalid verification code or recovery code.",
        },
      });
    }

    // Delete twoFactor and all recovery codes
    await prisma.twoFactor.deleteMany({
      where: { userId: user.id },
    });
    await prisma.recoveryCode.deleteMany({
      where: { userId: user.id },
    });

    await notify("account.2fa_disabled", { kind: "user", id: user.id }, null);
    // Send confirmation email (2FA-04)
    await sendTwoFactorDisabledEmail(user.email, user.firstName);

    return res.status(200).json({
      success: true,
      message: "Two-factor authentication has been disabled.",
    });
  } catch (err) {
    console.error("[Auth] 2FA disable error:", err);
    return res.status(500).json({
      error: { code: "INTERNAL_ERROR", message: "Failed to disable 2FA." },
    });
  }
});
