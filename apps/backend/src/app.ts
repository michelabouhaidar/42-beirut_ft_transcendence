import express, { Request, Response, NextFunction } from "express";
import cors from "cors";
import { PrismaClient } from "@prisma/client";
import { readFile } from "fs/promises";
import { metricsMiddleware, register } from "./services/metrics";

import { authRouter } from "./routes/auth";
import { onboardingRouter } from "./routes/onboarding";
import { adminRouter } from "./routes/admin";
import { invitationsRouter } from "./routes/invitations";
import { usersRouter } from "./routes/users";
import { orgsRouter } from "./routes/orgs";
import { projectsRouter } from "./routes/projects";
import { tasksRouter } from "./routes/tasks";
import { searchRouter } from "./routes/search";
import { notificationsRouter } from "./routes/notifications";

export const prisma = new PrismaClient();

const BACKUP_STATUS_FILE = "/backup-status/status.json";
const BACKUP_MAX_AGE_HOURS = Number(process.env.BACKUP_MAX_AGE_HOURS) || 26;

type BackupHealth = {
  status: "ok" | "stale" | "failed" | "unknown";
  lastBackupAt: string | null;
  ageHours: number | null;
  sizeBytes: number | null;
};

async function getBackupHealth(): Promise<BackupHealth> {
  try {
    const file = JSON.parse(await readFile(BACKUP_STATUS_FILE, "utf8"));
    const last = file.lastSuccess as { createdAt: string; sizeBytes: number } | null;
    const ageHours = last ? (Date.now() - Date.parse(last.createdAt)) / 3_600_000 : null;
    let status: BackupHealth["status"] = "ok";
    if (file.status !== "ok") status = "failed";
    else if (ageHours === null || ageHours > BACKUP_MAX_AGE_HOURS) status = "stale";
    return {
      status,
      lastBackupAt: last?.createdAt ?? null,
      ageHours: ageHours === null ? null : Math.round(ageHours * 10) / 10,
      sizeBytes: last?.sizeBytes ?? null,
    };
  } catch {
    return { status: "unknown", lastBackupAt: null, ageHours: null, sizeBytes: null };
  }
}

export function createApp(): express.Express {
  const app = express();

  // Trust exactly one proxy hop: our nginx, which appends the real client
  // address to X-Forwarded-For. req.ip then ignores anything a client puts
  // in that header itself. The backend is not reachable except through nginx.
  app.set("trust proxy", 1);

  // Basic middleware
  app.use(express.json({ limit: "10mb" }));
  app.use(express.urlencoded({ extended: true }));

  // Prometheus request latency & count tracking middleware
  app.use(metricsMiddleware);

  // Prometheus metrics scraping endpoint. nginx does not proxy /metrics, so only
  // Prometheus reaches it, over the internal Docker network (backend:3000).
  app.get("/metrics", async (_req: Request, res: Response) => {
    try {
      res.set("Content-Type", register.contentType);
      res.end(await register.metrics());
    } catch (err) {
      console.error("[Metrics] Could not collect metrics:", err);
      res.status(500).end();
    }
  });

  // CORS configuration: the only origin is the HTTPS front door (nginx on 8443)
  const allowedOrigin = process.env.APP_URL;
  app.use(
    cors({
      origin: allowedOrigin,
      credentials: true,
    })
  );

  // Basic API info
  app.get("/api/v1", (_req: Request, res: Response) => {
    res.json({
      name: "Trenno API",
      version: "0.1.0",
      status: "operational",
    });
  });

  // Mount API routers
  app.use("/api/v1/auth", authRouter);
  app.use("/api/v1/admin", adminRouter);
  app.use("/api/v1", invitationsRouter);
  app.use("/api/v1", onboardingRouter);
  app.use("/api/v1", usersRouter);
  app.use("/api/v1", orgsRouter);
  app.use("/api/v1", projectsRouter);
  app.use("/api/v1", tasksRouter);
  app.use("/api/v1", searchRouter);
  app.use("/api/v1", notificationsRouter);

  // Health check endpoint conforming to NFR-30
  app.get("/api/v1/health", async (_req: Request, res: Response) => {
    let databaseStatus = "disconnected";
    let isHealthy = true;

    try {
      await prisma.$queryRaw`SELECT 1`;
      databaseStatus = "connected";
    } catch (err) {
      console.error("[Health] Database check failed:", err);
      databaseStatus = "disconnected";
      isHealthy = false;
    }

    const backup = await getBackupHealth();

    const payload = {
      status: isHealthy ? "ok" : "degraded",
      timestamp: new Date().toISOString(),
      services: {
        database: databaseStatus,
        backup,
      },
    };

    res.status(isHealthy ? 200 : 503).json(payload);
  });

  // Generic 404 handler for API routes
  app.use("/api/*", (_req: Request, res: Response) => {
    res.status(404).json({
      error: {
        code: "NOT_FOUND",
        message: "API endpoint not found",
      },
    });
  });

  // Global error handler
  app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
    console.error("[Backend Error]", err);
    res.status(500).json({
      error: {
        code: "INTERNAL_ERROR",
        message: process.env.NODE_ENV === "production" ? "Internal server error" : err.message,
      },
    });
  });

  return app;
}
