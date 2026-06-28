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
   * POST /api/session/connect-qr
   * Start QR-code-based WhatsApp login.
   * Body: { userId }
   * Returns: { qr (base64 QR string or null), status }
   */
  app.post("/api/session/connect-qr", async (req, res) => {
    try {
      const { userId } = req.body;
      if (!userId) {
        return res.status(400).json({ error: "userId is required" });
      }
      const result = await sessionManager.connectWithQR(userId);
      res.json({
        qr: result.qr,
        status: result.status,
        message: result.qr
          ? "Scan this QR code with WhatsApp on your phone"
          : "Waiting for QR code...",
      });
    } catch (err) {
      logger.error({ err: err.message }, "QR connect error");
      res.status(500).json({ error: err.message });
    }
  });

  /**
   * GET /api/session/qr/:userId
   * Poll for the latest QR code string (for rendering on frontend).
   */
  app.get("/api/session/qr/:userId", (req, res) => {
    const qr = sessionManager.getQR(req.params.userId);
    const status = sessionManager.getStatus(req.params.userId);
    res.json({ qr, status });
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

  /**
   * POST /api/message/send-media
   * Send a media message (image/video/document) via WhatsApp Web.
   * Body: { userId, recipientPhone, caption, mediaUrl, mediaType }
   */
  app.post("/api/message/send-media", async (req, res) => {
    try {
      const { userId, recipientPhone, caption, mediaUrl, mediaType } = req.body;
      if (!userId || !recipientPhone || !mediaUrl) {
        return res.status(400).json({
          error: "userId, recipientPhone, and mediaUrl are required",
        });
      }

      const sock = sessionManager.getSocket(userId);
      if (!sock) {
        return res.status(400).json({ error: "No active session" });
      }

      const jid = recipientPhone.replace(/[^0-9]/g, "") + "@s.whatsapp.net";

      // Download media from URL
      const mediaResp = await fetch(mediaUrl);
      if (!mediaResp.ok) {
        return res.status(400).json({ error: "Failed to download media from URL" });
      }
      const buffer = Buffer.from(await mediaResp.arrayBuffer());

      // Determine message type
      let message = {};
      const type = (mediaType || "").toLowerCase();

      if (type === "image" || mediaUrl.match(/\.(jpg|jpeg|png|gif|webp)$/i)) {
        message = { image: buffer, caption: caption || "" };
      } else if (type === "video" || mediaUrl.match(/\.(mp4|mov|avi|mkv)$/i)) {
        message = { video: buffer, caption: caption || "" };
      } else {
        // Document (PDF, etc.)
        const fileName = mediaUrl.split("/").pop() || "document";
        message = { document: buffer, caption: caption || "", fileName };
      }

      await sock.sendMessage(jid, message);

      // Track daily sends
      const today = new Date().toISOString().split("T")[0];
      const dailySendsCol = db.collection("wa_web_daily_sends");
      await dailySendsCol.updateOne(
        { userId, date: today },
        { $inc: { count: 1 }, $set: { lastSentAt: new Date() } },
        { upsert: true }
      );

      res.json({ success: true, jid, mediaType: type, sentAt: new Date() });
    } catch (err) {
      logger.error({ err: err.message }, "Send media error");
      res.status(500).json({ error: err.message });
    }
  });

  // =========================================================================
  // CHAT MESSAGES
  // =========================================================================

  /**
   * GET /api/messages/:userId/:phone
   * Get chat messages for a contact. Returns last 100 messages sorted by time.
   */
  app.get("/api/messages/:userId/:phone", async (req, res) => {
    try {
      const { userId, phone } = req.params;
      const limit = Math.min(parseInt(req.query.limit || "100", 10), 500);

      const messages = await db.collection("wa_messages")
        .find({ userId, phone })
        .sort({ timestamp: -1 })
        .limit(limit)
        .toArray();

      // Reverse so oldest first (chat order)
      messages.reverse();

      res.json({
        messages: messages.map((m) => ({
          id: m.odgId,
          fromMe: m.fromMe,
          text: m.text,
          mediaType: m.mediaType,
          mediaInfo: m.mediaInfo || null,
          mediaUrl: m.mediaUrl || null,
          timestamp: m.timestamp,
          pushName: m.pushName,
        })),
        total: messages.length,
      });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  /**
   * POST /api/messages/download-media
   * Download media for a specific message on-demand.
   * Body: { userId, phone, messageId }
   * Returns: { url } (URL to the downloaded file served from uploads)
   */
  app.post("/api/messages/download-media", async (req, res) => {
    try {
      const { userId, phone, messageId } = req.body;
      if (!userId || !messageId) {
        return res.status(400).json({ error: "userId and messageId required" });
      }

      const { downloadMediaMessage } = require("@whiskeysockets/baileys");
      const messagesCol = db.collection("wa_messages");

      // Find the message
      const msgDoc = await messagesCol.findOne({ odgId: messageId, userId, phone });
      if (!msgDoc) {
        return res.status(404).json({ error: "Message not found" });
      }
      if (!msgDoc._rawMessage) {
        return res.status(400).json({ error: "No media data available (message too old or not a media message)" });
      }
      if (msgDoc.mediaUrl) {
        // Already downloaded
        return res.json({ url: msgDoc.mediaUrl, mediaType: msgDoc.mediaType });
      }

      // Parse stored raw message
      let rawMsg;
      try {
        rawMsg = JSON.parse(msgDoc._rawMessage);
      } catch {
        return res.status(400).json({ error: "Corrupt media data" });
      }

      // Download media using Baileys
      const buffer = await downloadMediaMessage(rawMsg, "buffer", {});
      if (!buffer || buffer.length === 0) {
        return res.status(400).json({ error: "Failed to download media (key may have expired)" });
      }

      // Save to uploads directory
      const fs = require("fs");
      const path = require("path");
      const crypto = require("crypto");

      const uploadsDir = path.join(__dirname, "..", "..", "uploads");
      fs.mkdirSync(uploadsDir, { recursive: true });

      const ext = msgDoc.mediaInfo?.mimetype
        ? "." + msgDoc.mediaInfo.mimetype.split("/")[1]?.split(";")[0] || "bin"
        : ".bin";
      const filename = `${crypto.randomBytes(8).toString("hex")}${ext}`;
      const filePath = path.join(uploadsDir, filename);
      fs.writeFileSync(filePath, buffer);

      // Generate URL
      const mediaUrl = `/api/wa-web/uploads/${filename}`;

      // Update message with URL so we don't re-download
      await messagesCol.updateOne(
        { odgId: messageId, userId, phone },
        { $set: { mediaUrl } }
      );

      res.json({ url: mediaUrl, mediaType: msgDoc.mediaType, size: buffer.length });
    } catch (err) {
      logger.error({ err: err.message }, "Media download error");
      res.status(500).json({ error: "Download failed: " + err.message });
    }
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

      let sock = sessionManager.getSocket(userId);
      if (!sock) {
        // Try to reconnect from saved auth state
        const status = sessionManager.getStatus(userId);
        if (status === "connected" || status === "reconnecting") {
          // Session thinks it's connected but socket is gone (after restart)
          await sessionManager.reconnect(userId, "");
          // Wait a moment for reconnection
          await new Promise((r) => setTimeout(r, 5000));
          sock = sessionManager.getSocket(userId);
        }
        if (!sock) {
          return res.status(400).json({
            error: "No active WhatsApp session. The session may need to be re-paired.",
          });
        }
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
   * GET /api/backup/running/:userId
   * Check if a backup is currently in progress for a user.
   */
  app.get("/api/backup/running/:userId", (req, res) => {
    const running = backupService.isBackupRunning(req.params.userId);
    res.json({ userId: req.params.userId, running });
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

  /**
   * POST /api/backup/profile-pics-batch
   * Get signed URLs for multiple contacts in one request.
   * Body: { userId, phones: ["91...","91...",...] }
   */
  app.post("/api/backup/profile-pics-batch", async (req, res) => {
    try {
      const { userId, phones } = req.body;
      if (!userId || !Array.isArray(phones)) {
        return res.status(400).json({ error: "userId and phones[] required" });
      }
      const urls = await backupService.getContactProfilePicUrlsBatch(userId, phones);
      res.json({ urls });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  /**
   * GET /api/backup/profile-pic-history/:userId/:phone
   * Get all historical profile pictures for a contact (newest first).
   */
  app.get("/api/backup/profile-pic-history/:userId/:phone", async (req, res) => {
    try {
      const history = await backupService.getProfilePicHistory(
        req.params.userId,
        req.params.phone
      );
      res.json({ history });
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
      // Only enforce if routing config says so
      const routingConfig = await db.collection("app_settings").findOne({ key: "wa_routing_config" });
      const enforceFirstContact = routingConfig?.rules?.forceCloudApiForFirstContact !== false;
      
      if (enforceFirstContact) {
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
