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

const express = require("express");
const { MongoClient } = require("mongodb");
const pino = require("pino");

const { createSessionManager } = require("./session-manager");
const { createBackupService } = require("./backup-service");
const { createR2Client } = require("./r2-storage");
const { createRoutes } = require("./routes");

const logger = pino({ level: "info" });

const PORT = parseInt(process.env.PORT || "3001", 10);
const API_SECRET = process.env.API_SECRET || "change-this-to-a-random-secret";
const MONGO_URI = process.env.MONGO_URI || "mongodb://127.0.0.1:27017";
const MONGO_DB = process.env.MONGO_DB || "samaj";

async function main() {
  // Connect to MongoDB (shared DB with main SAMAJ app)
  const mongoClient = new MongoClient(MONGO_URI);
  await mongoClient.connect();
  const db = mongoClient.db(MONGO_DB);
  logger.info("Connected to MongoDB: %s", MONGO_DB);

  // Initialize R2 storage client
  const r2 = createR2Client();

  // Initialize session manager (handles Baileys connections)
  const sessionManager = createSessionManager(db, logger, {
    onConnected: (userId, sock) => {
      // Auto-backup in background when a user connects
      logger.info({ userId }, "Auto-triggering background backup on connect");
      backupService.runFullBackup(sock, userId, {
        includeProfilePics: true,
        backupType: "auto_connect",
      }).catch((err) => {
        logger.error({ userId, err: err.message }, "Auto-backup failed");
      });
    },
  });

  // Initialize backup service
  const backupService = createBackupService(db, r2, logger);

  // Express API server
  const app = express();
  app.use(express.json());

  // Auth middleware — all requests must include X-API-Secret header
  app.use((req, res, next) => {
    if (req.path === "/health") return next();
    const secret = req.headers["x-api-secret"];
    if (secret !== API_SECRET) {
      return res.status(401).json({ error: "Unauthorized" });
    }
    next();
  });

  // Health check
  app.get("/health", (req, res) => {
    res.json({ status: "ok", activeSessions: sessionManager.getActiveCount() });
  });

  // Mount routes
  createRoutes(app, { sessionManager, backupService, r2, db, logger });

  app.listen(PORT, () => {
    logger.info("WhatsApp Web sidecar running on port %d", PORT);
  });

  // Graceful shutdown
  process.on("SIGTERM", async () => {
    logger.info("Shutting down...");
    await sessionManager.disconnectAll();
    await mongoClient.close();
    process.exit(0);
  });
}

main().catch((err) => {
  console.error("Failed to start WhatsApp Web service:", err);
  process.exit(1);
});
