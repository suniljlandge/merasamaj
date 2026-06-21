/**
 * API Routes for the WhatsApp Web sidecar service.
 *
 * All routes require X-API-Secret header (enforced by middleware in index.js).
 * The main SAMAJ Flask app calls these endpoints to manage sessions and backups.
 */

function createRoutes(app, { sessionManager, backupService, r2, db, logger }) {
  // =========================================================================
  // SESSION / CONNECTION
  // =========================================================================

  /**
   * POST /api/session/connect
   * Start OTP-based WhatsApp login.
   * Body: { userId, phoneNumber }
   * Returns: { pairingCode, status }
   */
  app.post("/api/session/connect", async (req, res) => {
    try {
      const { userId, phoneNumber } = req.body;
      if (!userId || !phoneNumber) {
        return res
          .status(400)
          .json({ error: "userId and phoneNumber are required" });
      }

      const result = await sessionManager.connectWithOTP(userId, phoneNumber);
      res.json({
        pairingCode: result.pairingCode,
        status: result.status,
        message: result.pairingCode
          ? "Enter this code in WhatsApp > Settings > Linked Devices > Link a Device"
          : "Session already authenticated, reconnecting...",
      });
    } catch (err) {
      logger.error({ err: err.message }, "Connect error");
      res.status(500).json({ error: err.message });
    }
  });

  /**
   * GET /api/session/status/:userId
   * Get connection status for a user.
   */
  app.get("/api/session/status/:userId", (req, res) => {
    const status = sessionManager.getStatus(req.params.userId);
    res.json({ userId: req.params.userId, status });
  });

  /**
   * POST /api/session/disconnect
   * Disconnect and log out a user's WhatsApp session.
   * Body: { userId }
   */
  app.post("/api/session/disconnect", async (req, res) => {
    try {
      const { userId } = req.body;
      if (!userId) {
        return res.status(400).json({ error: "userId is required" });
      }
      await sessionManager.disconnect(userId);
      res.json({ success: true, message: "Disconnected" });
    } catch (err) {
      logger.error({ err: err.message }, "Disconnect error");
      res.status(500).json({ error: err.message });
    }
  });

  // =========================================================================
  // MESSAGING (Hybrid routing — personal follow-ups)
  // =========================================================================

  /**
   * POST /api/message/send
   * Send a personal message via the user's WhatsApp Web session.
   * Body: { userId, recipientPhone, text }
   */
  app.post("/api/message/send", async (req, res) => {
    try {
      const { userId, recipientPhone, text } = req.body;
      if (!userId || !recipientPhone || !text) {
        return res
          .status(400)
          .json({ error: "userId, recipientPhone, and text are required" });
      }

      const result = await sessionManager.sendMessage(
        userId,
        recipientPhone,
        text
      );
      res.json(result);
    } catch (err) {
      // If daily limit reached, signal to use Cloud API
      if (err.message.includes("Daily web send limit")) {
        return res.status(429).json({
          error: err.message,
          fallbackToCloudAPI: true,
        });
      }
      logger.error({ err: err.message }, "Send message error");
      res.status(500).json({ error: err.message });
    }
  });

  /**
   * GET /api/message/daily-stats/:userId
   * Get today's send count for rate limiting decisions.
   */
  app.get("/api/message/daily-stats/:userId", async (req, res) => {
    const today = new Date().toISOString().split("T")[0];
    const dailySendsCol = db.collection("wa_web_daily_sends");
    const record = await dailySendsCol.findOne({
      userId: req.params.userId,
      date: today,
    });
    const maxDaily = parseInt(process.env.MAX_DAILY_WEB_SENDS || "20", 10);

    res.json({
      userId: req.params.userId,
      date: today,
      sent: record?.count || 0,
      limit: maxDaily,
      remaining: maxDaily - (record?.count || 0),
    });
  });

  // =========================================================================
  // BACKUP
  // =========================================================================

  /**
   * POST /api/backup/run
   * Trigger a full backup for a user (contacts + groups + profile pics).
   * Body: { userId, includeProfilePics (optional, default true) }
   */
  app.post("/api/backup/run", async (req, res) => {
    try {
      const { userId, includeProfilePics = true } = req.body;
      if (!userId) {
        return res.status(400).json({ error: "userId is required" });
      }

      const sock = sessionManager.getSocket(userId);
      if (!sock) {
        return res.status(400).json({
          error: "No active WhatsApp session. Connect first.",
        });
      }

      // Run backup in background, return immediately
      const backupPromise = backupService.runFullBackup(sock, userId, {
        includeProfilePics,
        backupType: "manual",
      });

      // Don't await — let it run in background
      backupPromise.catch((err) => {
        logger.error({ userId, err: err.message }, "Background backup failed");
      });

      res.json({
        success: true,
        message: "Backup started in background",
        status: "running",
      });
    } catch (err) {
      logger.error({ err: err.message }, "Backup trigger error");
      res.status(500).json({ error: err.message });
    }
  });

  /**
   * GET /api/backup/status/:userId
   * Get backup status and stats for a user.
   */
  app.get("/api/backup/status/:userId", async (req, res) => {
    try {
      const status = await backupService.getBackupStatus(req.params.userId);
      res.json(status);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  /**
   * GET /api/backup/contacts/:userId
   * Export all backed-up contacts for a user.
   * Query: ?format=json|csv
   */
  app.get("/api/backup/contacts/:userId", async (req, res) => {
    try {
      const format = req.query.format || "json";
      const data = await backupService.exportContacts(
        req.params.userId,
        format
      );

      if (format === "csv") {
        res.setHeader("Content-Type", "text/csv");
        res.setHeader(
          "Content-Disposition",
          `attachment; filename="contacts_${req.params.userId}.csv"`
        );
        return res.send(data);
      }

      res.json({ contacts: data, total: data.length });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  /**
   * GET /api/backup/profile-pic/:userId/:phone
   * Get a signed URL for a contact's profile picture.
   */
  app.get("/api/backup/profile-pic/:userId/:phone", async (req, res) => {
    try {
      const url = await backupService.getContactProfilePicUrl(
        req.params.userId,
        req.params.phone
      );
      if (!url) {
        return res.status(404).json({ error: "No profile picture found" });
      }
      res.json({ url, expiresIn: 3600 });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // =========================================================================
  // ROUTING DECISION (for the hybrid approach)
  // =========================================================================

  /**
   * POST /api/route/decide
   * Determine whether a message should go via Web session or Cloud API.
   * Body: { userId, recipientPhone, messageType, recipientCount }
   * Returns: { channel: "web" | "cloud_api", reason }
   */
  app.post("/api/route/decide", async (req, res) => {
    try {
      const {
        userId,
        recipientPhone,
        messageType = "personal",
        recipientCount = 1,
      } = req.body;

      // Rule 1: Multiple recipients → Cloud API
      if (recipientCount > 1) {
        return res.json({
          channel: "cloud_api",
          reason: "Multiple recipients — use Cloud API for bulk sends",
        });
      }

      // Rule 2: Campaign/broadcast type → Cloud API
      if (messageType === "campaign" || messageType === "broadcast") {
        return res.json({
          channel: "cloud_api",
          reason: "Campaign/broadcast messages must use Cloud API",
        });
      }

      // Rule 3: No active web session → Cloud API
      const status = sessionManager.getStatus(userId);
      if (status !== "connected") {
        return res.json({
          channel: "cloud_api",
          reason: `No active web session (status: ${status})`,
        });
      }

      // Rule 4: Daily limit check
      const today = new Date().toISOString().split("T")[0];
      const dailySendsCol = db.collection("wa_web_daily_sends");
      const record = await dailySendsCol.findOne({ userId, date: today });
      const maxDaily = parseInt(process.env.MAX_DAILY_WEB_SENDS || "20", 10);

      if (record && record.count >= maxDaily) {
        return res.json({
          channel: "cloud_api",
          reason: `Daily web send limit reached (${maxDaily})`,
        });
      }

      // Rule 5: First contact check — if never interacted, use Cloud API
      const contactsCol = db.collection("wa_contact_backups");
      const knownContact = await contactsCol.findOne({
        userId,
        phone: recipientPhone?.replace(/[^0-9]/g, ""),
      });

      if (!knownContact) {
        return res.json({
          channel: "cloud_api",
          reason: "First contact — use Cloud API for initial outreach",
        });
      }

      // Default: use web session for personal follow-up
      return res.json({
        channel: "web",
        reason: "Personal follow-up via WhatsApp Web session",
        dailySendsRemaining: maxDaily - (record?.count || 0),
      });
    } catch (err) {
      logger.error({ err: err.message }, "Route decision error");
      res.status(500).json({ error: err.message });
    }
  });
}

module.exports = { createRoutes };
