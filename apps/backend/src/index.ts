import { createServer } from "http";
import { createApp, prisma } from "./app.js";
import { initSocketServer } from "./realtime/socket.js";

const PORT = Number(process.env.PORT) || 3000;
const app = createApp();
const server = createServer(app);

// Attach Socket.IO
initSocketServer(server);

server.listen(PORT, "0.0.0.0", () => {
  console.log(`[Trenno Backend] Server listening on http://0.0.0.0:${PORT}`);
  console.log(`[Trenno Backend] Environment: ${process.env.NODE_ENV}`);
});

// Graceful shutdown handling
const handleShutdown = async (signal: string) => {
  console.log(`[Trenno Backend] Received ${signal}. Starting graceful shutdown...`);
  server.close(async () => {
    console.log("[Trenno Backend] HTTP server closed.");
    try {
      await prisma.$disconnect();
      console.log("[Trenno Backend] Database connection closed.");
      process.exit(0);
    } catch (e) {
      console.error("[Trenno Backend] Error during shutdown:", e);
      process.exit(1);
    }
  });

  // Force shutdown after 10s if graceful close hangs
  setTimeout(() => {
    console.error("[Trenno Backend] Forced shutdown after timeout.");
    process.exit(1);
  }, 10000);
};

process.on("SIGTERM", () => handleShutdown("SIGTERM"));
process.on("SIGINT", () => handleShutdown("SIGINT"));
