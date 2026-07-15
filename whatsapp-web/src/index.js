/**
 * SAMAJ WhatsApp Web Sidecar Service
 *
 * Provides:
 * - OTP-based WhatsApp pairing (no QR code)
 * - Contact & group backup
 * - Profile picture backup to Cloudflare R2
 * - Message routing (personal follow-ups via Web session)
 */

require("dotenv").config();

// Global crash guard — keep the sidecar alive even if Baileys or a bad
// message throws an unhandled error. Errors are logged but the process stays up.
process.on("uncaughtException", (err) => {
  console.error("[sidecar] uncaughtException:", err.message);
});
process.on("unhandledRejection", (reason) => {
  // Baileys fires unhandled rejections for WS timeouts and init queries —
  // these are non-fatal and sessions auto-reconnect.
  const msg = reason?.message || String(reason);
  if (msg === "Timed Out" || msg === "1006" || /Connection (Closed|Terminated)/.test(msg)) {
    console.error("[sidecar] Unhandled rejection (non-fatal):", msg);
    return;
  }
  console.error("[sidecar] unhandledRejection:", reason);
});

const express = require("express");
const { MongoClient } = require("mongodb");
const pino = require("pino");

const { createSessionManager } = require("./session-manager");
const { createBackupService } = require("./backup-service");
const { createR2Client } = require("./r2-storage");
const { createRoutes } = require("./routes");
const { createUIRoutes } = require("./ui-routes");

const logger = pino({ level: "info" });

const PORT = parseInt(process.env.PORT || "3001", 10);
const API_SECRET = process.env.API_SECRET || "change-this-to-a-random-secret";
const MONGO_URI = process.env.MONGO_URI || "mongodb://127.0.0.1:27017";
const MONGO_DB = process.env.MONGO_DB || "samaj";

async function main() {
  // Start Express immediately so health checks pass while MongoDB connects
  const app = express();
  app.use(express.json());

  let db = null;
  let sessionManager = null;
  let backupService = null;

  // Auth middleware — all requests must include X-API-Secret header
  app.use((req, res, next) => {
    if (req.path === "/health") return next();
    const secret = req.headers["x-api-secret"];
    if (secret !== API_SECRET) {
      return res.status(401).json({ error: "Unauthorized" });
    }
    next();
  });

  // Health check — always responds, even before MongoDB is ready
  app.get("/health", (req, res) => {
    res.json({
      status: db ? "ok" : "starting",
      mongodb: db ? "connected" : "connecting",
      activeSessions: sessionManager ? sessionManager.getActiveCount() : 0,
    });
  });

  // Start listening immediately
  app.listen(PORT, () => {
    logger.info("WhatsApp Web sidecar listening on port %d", PORT);
  });

  // Connect to MongoDB (retry on failure)
  let mongoClient;
  for (let attempt = 1; attempt <= 5; attempt++) {
    try {
      mongoClient = new MongoClient(MONGO_URI, {
        serverSelectionTimeoutMS: 10000,
        connectTimeoutMS: 10000,
      });
      await mongoClient.connect();
      db = mongoClient.db(MONGO_DB);
      logger.info("Connected to MongoDB: %s (attempt %d)", MONGO_DB, attempt);
      break;
    } catch (err) {
      logger.error(
        { attempt, err: err.message },
        "MongoDB connection failed, retrying in 5s..."
      );
      if (attempt === 5) {
        logger.error("All MongoDB connection attempts failed. Service will run without DB.");
      } else {
        await new Promise((r) => setTimeout(r, 5000));
      }
    }
  }

  if (!db) {
    // Service stays up for health checks but rejects all API calls
    app.use((req, res) => {
      res.status(503).json({ error: "Database unavailable. Retrying..." });
    });
    return;
  }

  // Initialize R2 storage client
  const r2 = createR2Client();

  // Initialize backup service FIRST (referenced by session manager callback)
  backupService = createBackupService(db, r2, logger);

  // Initialize session manager (handles Baileys connections)
  sessionManager = createSessionManager(db, logger, {
    onConnected: (userId, sock) => {
      // Delay auto-backup by 15s to let Baileys init queries finish first.
      // Triggering groupFetchAllParticipating while init is still running
      // causes WS timeouts on small instances with multiple sessions.
      setTimeout(() => {
        logger.info({ userId }, "Auto-triggering background backup on connect");
        backupService.runFullBackup(sock, userId, {
          includeProfilePics: true,
          backupType: "auto_connect",
        }).catch((err) => {
          logger.error({ userId, err: err.message }, "Auto-backup failed");
        });
      }, 15000);
    },
  });

  // Mount routes
  createRoutes(app, { sessionManager, backupService, r2, db, logger });

  // Mount standalone UI routes (login, contacts, TN, messaging, static files)
  createUIRoutes(app, { sessionManager, backupService, r2, db, logger });

  // Restore previously connected sessions from disk
  try {
    await sessionManager.restoreSessions();
  } catch (err) {
    logger.error({ err: err.message }, "Failed to restore sessions on startup");
  }

  logger.info("All services initialized. Ready to accept connections.");

  // Graceful shutdown
  process.on("SIGTERM", async () => {
    logger.info("Shutting down...");
    if (sessionManager) await sessionManager.disconnectAll();
    if (mongoClient) await mongoClient.close();
    process.exit(0);
  });
}

main().catch((err) => {
  logger.error({ err: err.message }, "Fatal startup error");
  // Don't exit — keep container alive for health checks and debugging
});
