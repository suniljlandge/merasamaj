/**
 * UI Routes — serves the standalone web frontend and provides
 * authenticated UI endpoints that proxy to the internal sidecar APIs.
 *
 * Authentication: simple token-based auth using UI_PASSWORD env var.
 */

const crypto = require("crypto");
const path = require("path");
const fs = require("fs");

const UI_PASSWORD = process.env.UI_PASSWORD || "admin";
// Tokens are valid for 7 days
const TOKEN_EXPIRY_MS = 7 * 24 * 60 * 60 * 1000;
// Active tokens: Map<token, { createdAt }>
const activeTokens = new Map();

function createUIRoutes(app, { sessionManager, backupService, r2, db, logger }) {
  // =========================================================================
  // AUTH
  // =========================================================================

  app.post("/auth/login", (req, res) => {
    const { password } = req.body || {};
    if (password === UI_PASSWORD) {
      const token = crypto.randomBytes(32).toString("hex");
      activeTokens.set(token, { createdAt: Date.now() });
      res.json({ token });
    } else {
      res.status(401).json({ error: "Invalid password" });
    }
  });

  // Auth middleware for /ui/* routes
  function requireAuth(req, res, next) {
    const token = req.headers["x-auth-token"];
    if (!token || !activeTokens.has(token)) {
      return res.status(401).json({ error: "Unauthorized" });
    }
    const entry = activeTokens.get(token);
    if (Date.now() - entry.createdAt > TOKEN_EXPIRY_MS) {
      activeTokens.delete(token);
      return res.status(401).json({ error: "Token expired" });
    }
    next();
  }

  // =========================================================================
  // SESSION
  // =========================================================================

  // Get first available userId from DB (single-user mode for standalone)
  async function getActiveUserId() {
    const session = await db.collection("wa_web_sessions").findOne(
      {},
      { sort: { lastActiveAt: -1 }, projection: { userId: 1 } }
    );
    return session?.userId || "default";
  }

  app.get("/ui/status", requireAuth, async (req, res) => {
    try {
      const userId = await getActiveUserId();
      const status = sessionManager.getStatus(userId);
      res.json({ userId, status: status || "disconnected" });
    } catch (err) {
      res.json({ status: "unavailable", error: err.message });
    }
  });

  app.post("/ui/connect", requireAuth, async (req, res) => {
    try {
      const { phoneNumber } = req.body;
      if (!phoneNumber) return res.status(400).json({ error: "phoneNumber required" });
      // Clean phone
      let clean = phoneNumber.replace(/[^0-9]/g, "");
      if (clean.length === 10 && /^[6-9]/.test(clean)) clean = "91" + clean;
      // Use phone as userId for standalone
      const userId = clean;
      const result = await sessionManager.connectWithOTP(userId, clean);
      res.json(result);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post("/ui/connect-qr", requireAuth, async (req, res) => {
    try {
      const userId = await getActiveUserId();
      const targetId = userId === "default" ? "qr_user" : userId;
      const result = await sessionManager.connectWithQR(targetId);
      res.json(result);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.get("/ui/qr", requireAuth, async (req, res) => {
    try {
      const userId = await getActiveUserId();
      const qr = sessionManager.getQR(userId);
      const status = sessionManager.getStatus(userId);
      res.json({ qr, status });
    } catch (err) {
      res.json({ qr: null, status: "unavailable" });
    }
  });

  app.post("/ui/disconnect", requireAuth, async (req, res) => {
    try {
      const userId = await getActiveUserId();
      await sessionManager.disconnect(userId);
      res.json({ success: true });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // =========================================================================
  // SESSIONS OVERVIEW (all sessions like wa-backup dashboard)
  // =========================================================================

  app.get("/ui/sessions", requireAuth, async (req, res) => {
    try {
      const sessions = await db.collection("wa_web_sessions").find(
        {},
        { projection: { _id: 0, userId: 1, phoneNumber: 1, status: 1, connectedAt: 1, lastActiveAt: 1 } }
      ).toArray();

      // Enrich with live status and backup stats
      for (const s of sessions) {
        s.liveStatus = sessionManager.getStatus(s.userId) || s.status || "disconnected";
        const uid = s.userId;
        const contacts = await db.collection("wa_contact_backups").countDocuments({ userId: uid });
        const groups = await db.collection("wa_group_backups").countDocuments({ userId: uid });
        const lastLog = await db.collection("wa_backup_log").findOne(
          { userId: uid }, { sort: { createdAt: -1 } }
        );
        s.backupStats = {
          contacts,
          groups,
          lastBackup: lastLog?.createdAt || null,
          lastResults: lastLog?.results || null,
        };
      }

      res.json({ sessions, total: sessions.length });
    } catch (err) {
      res.json({ sessions: [], error: err.message });
    }
  });

  // Backup for a specific user (by userId param)
  app.post("/ui/backup/:userId", requireAuth, async (req, res) => {
    try {
      const { userId } = req.params;
      const { includeProfilePics = true } = req.body || {};

      const sock = sessionManager.getSocket(userId);
      if (!sock) {
        return res.status(400).json({ error: "No active session for this user" });
      }

      backupService.runFullBackup(sock, userId, {
        includeProfilePics,
        backupType: "manual_ui",
      }).catch((err) => {
        logger.error({ userId, err: err.message }, "UI-triggered backup failed");
      });

      res.json({ success: true, message: "Backup started" });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // Contacts for a specific user
  app.get("/ui/contacts/:userId", requireAuth, async (req, res) => {
    try {
      const { userId } = req.params;
      const data = await backupService.exportContacts(userId, "json");
      if (Array.isArray(data)) {
        res.json({ contacts: data, total: data.length });
      } else if (data && data.contacts) {
        res.json(data);
      } else {
        res.json({ contacts: [], total: 0 });
      }
    } catch (err) {
      res.json({ contacts: [], error: err.message });
    }
  });

  // Profile pics batch for a specific user
  app.post("/ui/profile-pics-batch/:userId", requireAuth, async (req, res) => {
    try {
      const { userId } = req.params;
      const { phones = [] } = req.body || {};
      const urls = await backupService.getContactProfilePicUrlsBatch(userId, phones);
      res.json({ urls });
    } catch (err) {
      res.json({ urls: {}, error: err.message });
    }
  });

  // Messages for a specific user + phone
  app.get("/ui/messages/:userId/:phone", requireAuth, async (req, res) => {
    try {
      const { userId, phone } = req.params;
      const limit = Math.min(parseInt(req.query.limit || "100", 10), 500);

      const phoneVariants = [phone];
      const lidMappings = await db.collection("wa_lid_mappings")
        .find({ userId, phone }).toArray();
      for (const mapping of lidMappings) {
        const lidNum = (mapping.lid || "").replace("@lid", "");
        if (lidNum && !phoneVariants.includes(lidNum)) phoneVariants.push(lidNum);
      }

      const messages = await db.collection("wa_messages")
        .find({
          userId,
          phone: phoneVariants.length === 1 ? phone : { $in: phoneVariants },
          $or: [
            { text: { $nin: [null, ""] } },
            { mediaType: { $ne: null } },
            { mediaUrl: { $nin: [null, ""] } },
          ],
        })
        .sort({ timestamp: -1 })
        .limit(limit)
        .toArray();

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
      res.json({ messages: [], error: err.message });
    }
  });

  // =========================================================================
  // BACKUP
  // =========================================================================

  app.post("/ui/backup", requireAuth, async (req, res) => {
    try {
      const userId = await getActiveUserId();
      const { includeProfilePics = true } = req.body || {};

      const sock = sessionManager.getSocket(userId);
      if (!sock) {
        return res.status(400).json({ error: "No active WhatsApp session" });
      }

      backupService.runFullBackup(sock, userId, {
        includeProfilePics,
        backupType: "manual_ui",
      }).catch((err) => {
        logger.error({ userId, err: err.message }, "UI-triggered backup failed");
      });

      res.json({ success: true, message: "Backup started" });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.get("/ui/backup-status", requireAuth, async (req, res) => {
    try {
      const userId = await getActiveUserId();
      const status = await backupService.getBackupStatus(userId);
      const running = backupService.isBackupRunning(userId);
      res.json({ ...status, running });
    } catch (err) {
      res.json({ running: false, error: err.message });
    }
  });

  // =========================================================================
  // CONTACTS
  // =========================================================================

  app.get("/ui/contacts", requireAuth, async (req, res) => {
    try {
      const userId = await getActiveUserId();
      const data = await backupService.exportContacts(userId, "json");
      if (Array.isArray(data)) {
        res.json({ contacts: data, total: data.length });
      } else if (data && data.contacts) {
        res.json(data);
      } else {
        res.json({ contacts: [], total: 0 });
      }
    } catch (err) {
      res.json({ contacts: [], error: err.message });
    }
  });

  app.get("/ui/contacts-export", requireAuth, async (req, res) => {
    try {
      const userId = await getActiveUserId();
      const format = req.query.format || "json";
      const data = await backupService.exportContacts(userId, format);

      if (format === "csv") {
        res.setHeader("Content-Type", "text/csv");
        res.setHeader("Content-Disposition", `attachment; filename="contacts_${userId}.csv"`);
        return res.send(data);
      }
      if (Array.isArray(data)) {
        res.json({ contacts: data, total: data.length });
      } else {
        res.json(data);
      }
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // =========================================================================
  // PROFILE PICTURES
  // =========================================================================

  app.post("/ui/profile-pics-batch", requireAuth, async (req, res) => {
    try {
      const userId = await getActiveUserId();
      const { phones = [] } = req.body || {};
      const urls = await backupService.getContactProfilePicUrlsBatch(userId, phones);
      res.json({ urls });
    } catch (err) {
      res.json({ urls: {}, error: err.message });
    }
  });

  app.get("/ui/profile-pic/:phone", requireAuth, async (req, res) => {
    try {
      const userId = await getActiveUserId();
      const url = await backupService.getContactProfilePicUrl(userId, req.params.phone);
      if (!url) return res.status(404).json({ error: "No profile picture" });
      res.json({ url, expiresIn: 3600 });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.get("/ui/profile-pic-history/:phone", requireAuth, async (req, res) => {
    try {
      const userId = await getActiveUserId();
      const history = await backupService.getProfilePicHistory(userId, req.params.phone);
      res.json({ history });
    } catch (err) {
      res.json({ history: [], error: err.message });
    }
  });

  // =========================================================================
  // MESSAGES / CHAT
  // =========================================================================

  app.get("/ui/messages/:phone", requireAuth, async (req, res) => {
    try {
      const userId = await getActiveUserId();
      const { phone } = req.params;
      const limit = Math.min(parseInt(req.query.limit || "100", 10), 500);

      // Build phone variants (handle LID mappings)
      const phoneVariants = [phone];
      const lidMappings = await db.collection("wa_lid_mappings")
        .find({ userId, phone }).toArray();
      for (const mapping of lidMappings) {
        const lidNum = (mapping.lid || "").replace("@lid", "");
        if (lidNum && !phoneVariants.includes(lidNum)) phoneVariants.push(lidNum);
      }

      const messages = await db.collection("wa_messages")
        .find({
          userId,
          phone: phoneVariants.length === 1 ? phone : { $in: phoneVariants },
          $or: [
            { text: { $nin: [null, ""] } },
            { mediaType: { $ne: null } },
            { mediaUrl: { $nin: [null, ""] } },
          ],
        })
        .sort({ timestamp: -1 })
        .limit(limit)
        .toArray();

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
      res.json({ messages: [], error: err.message });
    }
  });

  app.post("/ui/messages/fetch-history", requireAuth, async (req, res) => {
    try {
      const userId = await getActiveUserId();
      const { phone } = req.body || {};
      if (!phone) return res.status(400).json({ error: "phone required" });

      const sock = sessionManager.getSocket(userId);
      if (!sock) return res.status(400).json({ error: "No active session" });

      if (typeof sock.fetchMessageHistory !== "function") {
        return res.status(501).json({ error: "History fetch not supported by this library version" });
      }

      const oldestMsg = await db.collection("wa_messages")
        .findOne(
          { userId, phone },
          { sort: { timestamp: 1 }, projection: { odgId: 1, timestamp: 1, fromMe: 1 } }
        );

      if (!oldestMsg) {
        return res.status(404).json({ error: "No messages found to paginate from" });
      }

      const jid = phone + "@s.whatsapp.net";
      const msgKey = { remoteJid: jid, id: oldestMsg.odgId, fromMe: oldestMsg.fromMe || false };
      const msgTimestampMs = oldestMsg.timestamp
        ? new Date(oldestMsg.timestamp).getTime()
        : Date.now();

      const requestId = await sock.fetchMessageHistory(50, msgKey, msgTimestampMs);
      res.json({ success: true, requestId, oldestTimestamp: oldestMsg.timestamp });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post("/ui/messages/download-media", requireAuth, async (req, res) => {
    try {
      const userId = await getActiveUserId();
      const { phone, messageId } = req.body || {};
      if (!messageId) return res.status(400).json({ error: "messageId required" });

      const { downloadMediaMessage } = require("@whiskeysockets/baileys");
      const messagesCol = db.collection("wa_messages");

      const msgDoc = await messagesCol.findOne({ odgId: messageId, userId, phone });
      if (!msgDoc) return res.status(404).json({ error: "Message not found" });
      if (!msgDoc._rawMessage) return res.status(400).json({ error: "No media data available" });
      if (msgDoc.mediaUrl) return res.json({ url: msgDoc.mediaUrl, mediaType: msgDoc.mediaType });

      let rawMsg;
      try { rawMsg = JSON.parse(msgDoc._rawMessage); } catch { return res.status(400).json({ error: "Corrupt media data" }); }

      const buffer = await downloadMediaMessage(rawMsg, "buffer", {});
      if (!buffer || buffer.length === 0) return res.status(400).json({ error: "Failed to download media" });

      const uploadsDir = path.join(__dirname, "..", "uploads");
      fs.mkdirSync(uploadsDir, { recursive: true });

      const ext = msgDoc.mediaInfo?.mimetype
        ? "." + (msgDoc.mediaInfo.mimetype.split("/")[1]?.split(";")[0] || "bin")
        : ".bin";
      const filename = `${crypto.randomBytes(8).toString("hex")}${ext}`;
      fs.writeFileSync(path.join(uploadsDir, filename), buffer);

      const mediaUrl = `/uploads/${filename}`;
      await messagesCol.updateOne({ odgId: messageId, userId, phone }, { $set: { mediaUrl } });

      res.json({ url: mediaUrl, mediaType: msgDoc.mediaType, size: buffer.length });
    } catch (err) {
      logger.error({ err: err.message }, "Media download error");
      res.status(500).json({ error: "Download failed: " + err.message });
    }
  });

  // =========================================================================
  // SEND MESSAGE
  // =========================================================================

  app.post("/ui/send", requireAuth, async (req, res) => {
    try {
      const userId = await getActiveUserId();
      const { recipientPhone, text } = req.body || {};

      if (!recipientPhone || !text) {
        return res.status(400).json({ error: "recipientPhone and text are required" });
      }

      const result = await sessionManager.sendMessage(userId, recipientPhone, text);
      res.json({ success: true, ...result });
    } catch (err) {
      if (err.message && err.message.includes("Daily web send limit")) {
        return res.json({ channel: "cloud_api", reason: err.message });
      }
      res.status(500).json({ error: err.message });
    }
  });

  // =========================================================================
  // STATS
  // =========================================================================

  app.get("/ui/stats", requireAuth, async (req, res) => {
    try {
      const userId = await getActiveUserId();
      const today = new Date().toISOString().split("T")[0];
      const record = await db.collection("wa_web_daily_sends").findOne({ userId, date: today });
      const maxDaily = parseInt(process.env.MAX_DAILY_WEB_SENDS || "20", 10);
      res.json({
        sent: record?.count || 0,
        limit: maxDaily,
        remaining: maxDaily - (record?.count || 0),
      });
    } catch (err) {
      res.json({ sent: 0, limit: 20, remaining: 20 });
    }
  });

  // =========================================================================
  // TN (TRUE NAME) LOOKUP
  // =========================================================================

  app.get("/ui/tn-cache", requireAuth, async (req, res) => {
    try {
      const col = db.collection("tn_cache");
      const docs = await col.find({}, { projection: { mobile: 1, name: 1, _id: 0 } }).toArray();
      const cache = {};
      docs.forEach((d) => { if (d.name) cache[d.mobile] = d.name; });
      res.json({ cache });
    } catch (err) {
      res.json({ cache: {} });
    }
  });

  app.post("/ui/tn-batch", requireAuth, async (req, res) => {
    try {
      const { mobiles = [] } = req.body || {};
      if (!Array.isArray(mobiles) || mobiles.length === 0) {
        return res.status(400).json({ error: "mobiles must be a non-empty array" });
      }
      if (mobiles.length > 50) {
        return res.status(400).json({ error: "Maximum 50 numbers per batch" });
      }

      const results = [];
      const validMobiles = [];

      for (const raw of mobiles) {
        const mobile = String(raw).replace(/[^0-9]/g, "").slice(-10);
        if (!/^[6-9]\d{9}$/.test(mobile)) {
          results.push({ mobile, name: null, error: "invalid_format" });
        } else {
          validMobiles.push(mobile);
        }
      }

      if (!validMobiles.length) return res.json({ results });

      // Check cache first
      const col = db.collection("tn_cache");
      const cached = await col.find(
        { mobile: { $in: validMobiles } },
        { projection: { mobile: 1, name: 1, _id: 0 } }
      ).toArray();

      const cachedMap = new Map();
      cached.forEach((d) => { if (d.name) cachedMap.set(d.mobile, d.name); });

      const needLookup = [];
      for (const mobile of validMobiles) {
        if (cachedMap.has(mobile)) {
          results.push({ mobile, name: cachedMap.get(mobile), error: null, cached: true });
        } else {
          needLookup.push(mobile);
        }
      }

      // For uncached numbers, proxy to the main SAMAJ Flask app
      if (needLookup.length > 0) {
        const mainAppUrl = process.env.SAMAJ_APP_URL || "http://localhost:5000";
        const mainAppSecret = process.env.SAMAJ_APP_SECRET || "";

        try {
          const fetchResp = await fetch(`${mainAppUrl}/api/tn/batch-lookup`, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "X-Internal-Secret": mainAppSecret,
              "Cookie": `session=${process.env.SAMAJ_SESSION_COOKIE || ""}`,
            },
            body: JSON.stringify({ mobiles: needLookup }),
          });

          if (fetchResp.ok) {
            const data = await fetchResp.json();
            const batchResults = data.results || [];
            for (const r of batchResults) {
              results.push({ mobile: r.mobile, name: r.name, error: r.error, cached: false });
              if (r.name) {
                col.updateOne(
                  { mobile: r.mobile },
                  { $set: { mobile: r.mobile, name: r.name, resolvedAt: new Date() } },
                  { upsert: true }
                ).catch(() => {});
              }
            }
          } else {
            needLookup.forEach((m) => {
              results.push({ mobile: m, name: null, error: "lookup_service_unavailable" });
            });
          }
        } catch (proxyErr) {
          needLookup.forEach((m) => {
            results.push({ mobile: m, name: null, error: "lookup_service_unavailable" });
          });
        }
      }

      res.json({ results });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.get("/ui/tn-lookup", requireAuth, async (req, res) => {
    try {
      const mobile = (req.query.mobile || "").replace(/[^0-9]/g, "").slice(-10);
      if (!/^[6-9]\d{9}$/.test(mobile)) {
        return res.status(400).json({ error: "Invalid mobile number" });
      }

      const col = db.collection("tn_cache");
      const cached = await col.findOne({ mobile });
      if (cached && cached.name) {
        return res.json({ mobile, name: cached.name, cached: true });
      }

      // Proxy to main app
      const mainAppUrl = process.env.SAMAJ_APP_URL || "http://localhost:5000";
      try {
        const fetchResp = await fetch(`${mainAppUrl}/api/tn/lookup?mobile=${mobile}`, {
          headers: {
            "X-Internal-Secret": process.env.SAMAJ_APP_SECRET || "",
            "Cookie": `session=${process.env.SAMAJ_SESSION_COOKIE || ""}`,
          },
        });
        if (fetchResp.ok) {
          const data = await fetchResp.json();
          if (data.name) {
            col.updateOne(
              { mobile },
              { $set: { mobile, name: data.name, resolvedAt: new Date() } },
              { upsert: true }
            ).catch(() => {});
          }
          return res.json(data);
        }
      } catch {}

      res.json({ mobile, name: null, error: "lookup_service_unavailable" });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // =========================================================================
  // STATIC FILES
  // =========================================================================

  const uploadsDir = path.join(__dirname, "..", "uploads");
  if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir, { recursive: true });
  app.use("/uploads", require("express").static(uploadsDir));

  // Serve public frontend (must be last — catches all unmatched routes)
  const publicDir = path.join(__dirname, "..", "public");
  app.use(require("express").static(publicDir));

  // SPA fallback
  app.get("*", (req, res, next) => {
    if (req.path.startsWith("/api/") || req.path.startsWith("/ui/") || req.path.startsWith("/auth/")) {
      return next();
    }
    res.sendFile(path.join(publicDir, "index.html"));
  });
}

module.exports = { createUIRoutes };
