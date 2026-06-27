/**
 * Session Manager — handles Baileys WhatsApp Web connections per user.
 *
 * Each user gets one active socket connection. Sessions are persisted in
 * MongoDB so they survive service restarts without requiring QR/OTP re-auth.
 */

const {
  default: makeWASocket,
  DisconnectReason,
  fetchLatestBaileysVersion,
} = require("@whiskeysockets/baileys");
const { Boom } = require("@hapi/boom");
const { useMongoDBAuthState, hasAuthState, clearAuthState } = require("./mongo-auth-state");

function createSessionManager(db, logger, { onConnected } = {}) {
  // Active sockets keyed by userId
  const activeSockets = new Map();
  // Connection status per user
  const connectionStatus = new Map();

  const sessionsCollection = db.collection("wa_web_sessions");
  const authCollection = db.collection("wa_auth_state");

  /**
   * Connect a user's WhatsApp session using OTP pairing code.
   * Returns the pairing code the user must enter on their phone.
   */
  async function connectWithOTP(userId, phoneNumber) {
    // Disconnect existing socket if any
    if (activeSockets.has(userId)) {
      const existing = activeSockets.get(userId);
      existing.end();
      activeSockets.delete(userId);
    }

    // Clear old auth state for fresh pairing
    await clearAuthState(authCollection, userId);
    logger.info({ userId }, "Cleared old auth state for fresh pairing");

    // Clear old auth state for fresh pairing
    await clearAuthState(authCollection, userId);
    logger.info({ userId }, "Cleared old auth state for fresh pairing");

    const { state, saveCreds } = await useMongoDBAuthState(authCollection, userId);
    const { version } = await fetchLatestBaileysVersion();

    const sock = makeWASocket({
      version,
      auth: state,
      printQRInTerminal: false,
      syncFullHistory: true,
      shouldSyncHistoryMessage: () => true,
      logger: logger.child({ module: "baileys", userId }),
    });

    // Store socket
    activeSockets.set(userId, sock);
    connectionStatus.set(userId, "connecting");

    // Handle credential updates
    sock.ev.on("creds.update", saveCreds);

    // Listen for contact and chat sync events (captures what web.whatsapp.com shows)
    attachContactListeners(sock, userId);

    // Handle connection updates
    sock.ev.on("connection.update", async (update) => {
      const { connection, lastDisconnect } = update;

      if (connection === "open") {
        connectionStatus.set(userId, "connected");
        await sessionsCollection.updateOne(
          { userId },
          {
            $set: {
              userId,
              phoneNumber,
              status: "connected",
              connectedAt: new Date(),
              lastActiveAt: new Date(),
            },
          },
          { upsert: true }
        );
        logger.info({ userId }, "WhatsApp session connected");

        // Send presence "available" to receive messages
        try {
          await sock.sendPresenceUpdate("available");
        } catch {}

        // Keep presence alive every 3 minutes
        startPresenceKeepAlive(userId, sock);

        // Auto-trigger background backup on connect
        if (onConnected) onConnected(userId, sock);
      }

      if (connection === "close") {
        const statusCode =
          lastDisconnect?.error instanceof Boom
            ? lastDisconnect.error.output.statusCode
            : null;

        const shouldReconnect =
          statusCode !== DisconnectReason.loggedOut &&
          statusCode !== DisconnectReason.forbidden;

        if (shouldReconnect) {
          connectionStatus.set(userId, "reconnecting");
          logger.info({ userId, statusCode }, "Reconnecting...");
          // Auto-reconnect after delay
          setTimeout(() => reconnect(userId, phoneNumber), 3000);
        } else {
          connectionStatus.set(userId, "disconnected");
          activeSockets.delete(userId);
          await sessionsCollection.updateOne(
            { userId },
            { $set: { status: "disconnected", disconnectedAt: new Date() } }
          );
          logger.warn({ userId, statusCode }, "Session logged out or banned");
        }
      }
    });

    // Request pairing code (OTP-based login)
    let pairingCode = null;
    if (!sock.authState.creds.registered) {
      // Wait for socket to be ready before requesting code
      await new Promise((resolve) => setTimeout(resolve, 3000));
      
      // Clean phone number: remove +, spaces, dashes — must be digits with country code
      const cleanNumber = phoneNumber.replace(/[^0-9]/g, "");
      logger.info({ userId, cleanNumber }, "Requesting pairing code");
      pairingCode = await sock.requestPairingCode(cleanNumber);
      logger.info({ userId, pairingCode }, "Pairing code generated");
    } else {
      connectionStatus.set(userId, "connected");
    }

    return { pairingCode, status: connectionStatus.get(userId) };
  }

  /**
   * Connect a user's WhatsApp session using QR code.
   * Returns immediately; QR data is emitted via connection.update events.
   * Poll /api/session/qr/:userId to get the latest QR string.
   */
  const pendingQRs = new Map(); // userId -> latest QR string

  async function connectWithQR(userId) {
    // Disconnect existing socket if any
    if (activeSockets.has(userId)) {
      const existing = activeSockets.get(userId);
      existing.end();
      activeSockets.delete(userId);
    }

    // Clear old auth state for fresh QR
    await clearAuthState(authCollection, userId);
    logger.info({ userId }, "Cleared old auth state for QR pairing");

    const { state, saveCreds } = await useMongoDBAuthState(authCollection, userId);
    const { version } = await fetchLatestBaileysVersion();

    const sock = makeWASocket({
      version,
      auth: state,
      printQRInTerminal: false,
      syncFullHistory: true,
      shouldSyncHistoryMessage: () => true,
      logger: logger.child({ module: "baileys", userId }),
    });

    activeSockets.set(userId, sock);
    connectionStatus.set(userId, "waiting_qr");

    sock.ev.on("creds.update", saveCreds);
    attachContactListeners(sock, userId);

    sock.ev.on("connection.update", async (update) => {
      const { connection, lastDisconnect, qr } = update;

      // QR code received — store it for polling
      if (qr) {
        pendingQRs.set(userId, qr);
        connectionStatus.set(userId, "waiting_qr");
        logger.info({ userId }, "QR code generated");
      }

      if (connection === "open") {
        pendingQRs.delete(userId);
        connectionStatus.set(userId, "connected");
        await sessionsCollection.updateOne(
          { userId },
          {
            $set: {
              userId,
              phoneNumber: "",
              status: "connected",
              connectedAt: new Date(),
              lastActiveAt: new Date(),
            },
          },
          { upsert: true }
        );
        logger.info({ userId }, "WhatsApp session connected via QR");
        if (onConnected) onConnected(userId, sock);
      }

      if (connection === "close") {
        pendingQRs.delete(userId);
        const statusCode =
          lastDisconnect?.error instanceof Boom
            ? lastDisconnect.error.output.statusCode
            : null;

        if (
          statusCode === DisconnectReason.loggedOut ||
          statusCode === DisconnectReason.forbidden
        ) {
          connectionStatus.set(userId, "disconnected");
          activeSockets.delete(userId);
          await sessionsCollection.updateOne(
            { userId },
            { $set: { status: "disconnected", disconnectedAt: new Date() } }
          );
        } else {
          connectionStatus.set(userId, "reconnecting");
          setTimeout(() => reconnect(userId, ""), 3000);
        }
      }
    });

    // Wait briefly for first QR to be generated
    await new Promise((resolve) => setTimeout(resolve, 2000));
    const qr = pendingQRs.get(userId) || null;

    return { qr, status: connectionStatus.get(userId) };
  }

  /**
   * Get the latest QR code string for a user (for polling).
   */
  function getQR(userId) {
    return pendingQRs.get(userId) || null;
  }

  /**
   * Reconnect an existing session (no OTP needed if auth state exists).
   */
  async function reconnect(userId, phoneNumber) {
    // Check if auth state exists in MongoDB
    const hasAuth = await hasAuthState(authCollection, userId);
    if (!hasAuth) {
      connectionStatus.set(userId, "disconnected");
      return;
    }

    const { state, saveCreds } = await useMongoDBAuthState(authCollection, userId);
    const { version } = await fetchLatestBaileysVersion();

    const sock = makeWASocket({
      version,
      auth: state,
      printQRInTerminal: false,
      syncFullHistory: true,
      shouldSyncHistoryMessage: () => true,
      logger: logger.child({ module: "baileys", userId }),
    });

    activeSockets.set(userId, sock);
    sock.ev.on("creds.update", saveCreds);
    attachContactListeners(sock, userId);

    sock.ev.on("connection.update", async (update) => {
      const { connection, lastDisconnect } = update;
      if (connection === "open") {
        connectionStatus.set(userId, "connected");
        await sessionsCollection.updateOne(
          { userId },
          {
            $set: {
              userId,
              phoneNumber: phoneNumber || "",
              status: "connected",
              connectedAt: new Date(),
              lastActiveAt: new Date(),
            },
          },
          { upsert: true }
        );
        logger.info({ userId }, "Session reconnected and saved to DB");

        // Trigger auto-backup on reconnect too
        if (onConnected) onConnected(userId, sock);
      }
      if (connection === "close") {
        const statusCode =
          lastDisconnect?.error instanceof Boom
            ? lastDisconnect.error.output.statusCode
            : null;
        if (
          statusCode === DisconnectReason.loggedOut ||
          statusCode === DisconnectReason.forbidden
        ) {
          connectionStatus.set(userId, "disconnected");
          activeSockets.delete(userId);
          await sessionsCollection.updateOne(
            { userId },
            { $set: { status: "disconnected", disconnectedAt: new Date() } }
          );
        } else {
          // Auto-reconnect on transient failures
          connectionStatus.set(userId, "reconnecting");
          setTimeout(() => reconnect(userId, phoneNumber), 5000);
        }
      }
    });
  }

  /**
   * Disconnect a user's session.
   */
  async function disconnect(userId) {
    const sock = activeSockets.get(userId);
    if (sock) {
      await sock.logout();
      activeSockets.delete(userId);
    }
    connectionStatus.set(userId, "disconnected");
    await sessionsCollection.updateOne(
      { userId },
      { $set: { status: "disconnected", disconnectedAt: new Date() } }
    );
  }

  /**
   * Get the socket for a connected user (for sending messages, fetching data).
   */
  function getSocket(userId) {
    return activeSockets.get(userId) || null;
  }

  /**
   * Get connection status for a user.
   */
  function getStatus(userId) {
    return connectionStatus.get(userId) || "disconnected";
  }

  /**
   * Get count of active connections.
   */
  function getActiveCount() {
    return activeSockets.size;
  }

  /**
   * Disconnect all sessions (for graceful shutdown).
   */
  async function disconnectAll() {
    for (const [userId, sock] of activeSockets.entries()) {
      try {
        sock.end();
      } catch (err) {
        logger.error({ userId, err }, "Error disconnecting session");
      }
    }
    activeSockets.clear();
  }

  /**
   * Restore sessions on service startup.
   */
  async function restoreSessions() {
    const sessions = await sessionsCollection
      .find({ status: "connected" })
      .toArray();
    for (const session of sessions) {
      try {
        await reconnect(session.userId, session.phoneNumber);
        logger.info({ userId: session.userId }, "Session restored");
      } catch (err) {
        logger.error({ userId: session.userId, err }, "Failed to restore session");
      }
    }
  }

  /**
   * Send a message via a user's WhatsApp Web session.
   * Used for personal follow-ups (hybrid routing).
   */
  async function sendMessage(userId, recipientPhone, text) {
    const sock = activeSockets.get(userId);
    if (!sock) {
      throw new Error("No active session for user");
    }

    const jid = recipientPhone.replace(/[^0-9]/g, "") + "@s.whatsapp.net";

    // Track daily sends
    const today = new Date().toISOString().split("T")[0];
    const dailySendsCol = db.collection("wa_web_daily_sends");
    const record = await dailySendsCol.findOne({ userId, date: today });
    const maxDaily = parseInt(process.env.MAX_DAILY_WEB_SENDS || "20", 10);

    if (record && record.count >= maxDaily) {
      throw new Error(
        `Daily web send limit reached (${maxDaily}). Use Cloud API instead.`
      );
    }

    await sock.sendMessage(jid, { text });

    // Increment daily counter
    await dailySendsCol.updateOne(
      { userId, date: today },
      { $inc: { count: 1 }, $set: { lastSentAt: new Date() } },
      { upsert: true }
    );

    return { success: true, jid, sentAt: new Date() };
  }

  /**
   * Keep WhatsApp presence "available" so messages are delivered to this device.
   */
  const presenceIntervals = new Map();

  function startPresenceKeepAlive(userId, sock) {
    // Clear any existing interval
    if (presenceIntervals.has(userId)) {
      clearInterval(presenceIntervals.get(userId));
    }

    const interval = setInterval(async () => {
      try {
        if (connectionStatus.get(userId) === "connected" && activeSockets.has(userId)) {
          await sock.sendPresenceUpdate("available");
        } else {
          clearInterval(interval);
          presenceIntervals.delete(userId);
        }
      } catch {
        // Socket might be dead
        clearInterval(interval);
        presenceIntervals.delete(userId);
      }
    }, 3 * 60 * 1000); // Every 3 minutes

    presenceIntervals.set(userId, interval);
  }

  /**
   * Attach event listeners to capture contacts, chats, and LID→phone mappings.
   * This is what makes the backup work like web.whatsapp.com's contact list.
   */
  function attachContactListeners(sock, userId) {
    const contactsCol = db.collection("wa_contact_backups");
    const chatsCol = db.collection("wa_chat_list");

    // Contacts synced from WhatsApp (name, phone, pushName)
    sock.ev.on("contacts.upsert", async (contacts) => {
      logger.info({ userId, count: contacts.length }, "Contacts upsert received");
      for (const contact of contacts) {
        const jid = contact.id || "";
        if (!jid.endsWith("@s.whatsapp.net")) continue;
        const phone = jid.replace("@s.whatsapp.net", "");
        if (!phone || !/^\d+$/.test(phone)) continue;

        try {
          await contactsCol.updateOne(
            { userId, phone },
            {
              $set: {
                userId,
                phone,
                pushName: contact.notify || contact.name || null,
                verifiedName: contact.verifiedName || null,
                source: "sync",
                lastSeenAt: new Date(),
                isActive: true,
              },
              $setOnInsert: { firstSeenAt: new Date(), profilePicKey: null, profilePicHash: null },
            },
            { upsert: true }
          );
        } catch (err) {
          if (err.code !== 11000) logger.error({ userId, phone, err: err.message }, "Contact upsert error");
        }
      }
    });

    sock.ev.on("contacts.update", async (updates) => {
      for (const update of updates) {
        const jid = update.id || "";
        if (!jid.endsWith("@s.whatsapp.net")) continue;
        const phone = jid.replace("@s.whatsapp.net", "");
        if (!phone || !/^\d+$/.test(phone)) continue;

        const $set = { lastSeenAt: new Date() };
        if (update.notify) $set.pushName = update.notify;
        if (update.verifiedName) $set.verifiedName = update.verifiedName;

        try {
          await contactsCol.updateOne({ userId, phone }, { $set });
        } catch {}
      }
    });

    // Chat list sync — captures individual and group chats like web.whatsapp.com sidebar
    sock.ev.on("chats.upsert", async (chats) => {
      logger.info({ userId, count: chats.length }, "Chats upsert received");
      for (const chat of chats) {
        const jid = chat.id || "";
        const isGroup = jid.endsWith("@g.us");
        const isIndividual = jid.endsWith("@s.whatsapp.net");
        if (!isGroup && !isIndividual) continue;

        try {
          await chatsCol.updateOne(
            { userId, jid },
            {
              $set: {
                userId,
                jid,
                name: chat.name || chat.subject || null,
                isGroup,
                unreadCount: chat.unreadCount || 0,
                lastMessageAt: chat.conversationTimestamp
                  ? new Date(chat.conversationTimestamp * 1000)
                  : null,
                updatedAt: new Date(),
              },
              $setOnInsert: { createdAt: new Date() },
            },
            { upsert: true }
          );

          // Also save individual chat contacts
          if (isIndividual) {
            const phone = jid.replace("@s.whatsapp.net", "");
            if (phone && /^\d+$/.test(phone)) {
              await contactsCol.updateOne(
                { userId, phone },
                {
                  $set: {
                    userId,
                    phone,
                    pushName: chat.name || null,
                    source: "chat",
                    lastSeenAt: new Date(),
                    isActive: true,
                  },
                  $setOnInsert: { firstSeenAt: new Date(), profilePicKey: null, profilePicHash: null },
                },
                { upsert: true }
              );
            }
          }
        } catch (err) {
          if (err.code !== 11000) logger.error({ userId, jid, err: err.message }, "Chat upsert error");
        }
      }
    });

    // Message events — capture contact and store message content
    const messagesCol = db.collection("wa_messages");

    sock.ev.on("messages.upsert", async (m) => {
      for (const msg of m.messages || []) {
        // Send read receipt for incoming messages to keep delivery active
        if (!msg.key?.fromMe && msg.key?.remoteJid) {
          try {
            await sock.readMessages([msg.key]);
          } catch {}
        }

        let jid = msg.key?.remoteJid || "";
        let phone = "";

        // Log all incoming messages for debugging
        if (!msg.key?.fromMe) {
          logger.info({ userId, jid, fromMe: false, id: msg.key?.id }, "Incoming message received");
        }

        if (jid.endsWith("@s.whatsapp.net")) {
          phone = jid.replace("@s.whatsapp.net", "");
        } else if (jid.endsWith("@lid")) {
          // LID message — try to resolve from participant_pn or lid_mappings
          const participantPn = msg.key?.participantPn || "";
          if (participantPn.endsWith("@s.whatsapp.net")) {
            phone = participantPn.replace("@s.whatsapp.net", "");
          } else {
            // Look up in lid_mappings collection
            const mapping = await db.collection("wa_lid_mappings").findOne({ lid: jid });
            if (mapping) {
              phone = mapping.phone;
            } else {
              // Also check remoteJid without @lid as a phone lookup
              const lidId = jid.replace("@lid", "");
              const mappingAlt = await db.collection("wa_lid_mappings").findOne({ lid: { $regex: lidId } });
              if (mappingAlt) phone = mappingAlt.phone;
            }
          }
          // Store LID mapping if we have participant_pn
          if (phone && jid.endsWith("@lid")) {
            try {
              await db.collection("wa_lid_mappings").updateOne(
                { lid: jid },
                { $set: { lid: jid, phone, userId, updatedAt: new Date() } },
                { upsert: true }
              );
            } catch {}
          }
          // If we still can't resolve, store under LID as phone (for debugging)
          if (!phone) {
            phone = jid.replace("@lid", "");
            logger.info({ userId, lid: jid, msg: "Unresolved LID message" });
          }
        } else {
          continue; // Skip group messages, status broadcasts
        }

        if (!phone) continue;

        try {
          await contactsCol.updateOne(
            { userId, phone },
            {
              $set: { userId, phone, source: "message", lastSeenAt: new Date(), isActive: true },
              $setOnInsert: { firstSeenAt: new Date(), pushName: null, profilePicKey: null, profilePicHash: null },
            },
            { upsert: true }
          );
        } catch {}

        // Store the message
        try {
          const msgContent = msg.message || {};
          // Handle nested message types (ephemeral, viewOnce, etc.)
          const innerMsg =
            msgContent.ephemeralMessage?.message ||
            msgContent.viewOnceMessage?.message ||
            msgContent.viewOnceMessageV2?.message ||
            msgContent.documentWithCaptionMessage?.message ||
            msgContent;
          const text =
            innerMsg.conversation ||
            innerMsg.extendedTextMessage?.text ||
            innerMsg.imageMessage?.caption ||
            innerMsg.videoMessage?.caption ||
            innerMsg.documentMessage?.caption ||
            innerMsg.buttonsResponseMessage?.selectedDisplayText ||
            innerMsg.listResponseMessage?.title ||
            msgContent.conversation ||
            msgContent.extendedTextMessage?.text ||
            "";
          const mediaType =
            (innerMsg.imageMessage || msgContent.imageMessage) ? "image" :
            (innerMsg.videoMessage || msgContent.videoMessage) ? "video" :
            (innerMsg.audioMessage || msgContent.audioMessage) ? "audio" :
            (innerMsg.documentMessage || msgContent.documentMessage) ? "document" :
            (innerMsg.stickerMessage || msgContent.stickerMessage) ? "sticker" :
            null;

          // Extract media metadata for on-demand download
          let mediaInfo = null;
          const mediaMsg = msgContent.imageMessage || msgContent.videoMessage ||
            msgContent.audioMessage || msgContent.documentMessage || msgContent.stickerMessage;
          if (mediaMsg && mediaType) {
            mediaInfo = {
              mimetype: mediaMsg.mimetype || null,
              fileLength: mediaMsg.fileLength ? Number(mediaMsg.fileLength) : null,
              fileName: mediaMsg.fileName || null,
              // Store the full message for later download via downloadMediaMessage
              _hasMedia: true,
            };
          }

          const msgDoc = {
            odgId: msg.key.id,
            userId,
            phone,
            fromMe: msg.key.fromMe || false,
            text: text || (mediaType ? `[${mediaType}]` : ""),
            mediaType,
            mediaInfo,
            mediaUrl: null, // Will be populated when user clicks download
            timestamp: msg.messageTimestamp
              ? new Date(Number(msg.messageTimestamp) * 1000)
              : new Date(),
            pushName: msg.pushName || null,
            // Store raw message for media download (needed by Baileys)
            _rawMessage: mediaType ? JSON.stringify(msg) : null,
          };

          await messagesCol.updateOne(
            { odgId: msg.key.id, userId, phone },
            { $set: msgDoc },
            { upsert: true }
          );
        } catch {}

        // Also capture LID → phone number mapping if available
        const participant = msg.key?.participant || "";
        const participantPn = msg.key?.participantPn || "";
        if (participant.endsWith("@lid") && participantPn.endsWith("@s.whatsapp.net")) {
          const realPhone = participantPn.replace("@s.whatsapp.net", "");
          if (realPhone && /^\d+$/.test(realPhone)) {
            try {
              await db.collection("wa_lid_mappings").updateOne(
                { lid: participant },
                { $set: { lid: participant, phone: realPhone, userId, updatedAt: new Date() } },
                { upsert: true }
              );
              await contactsCol.updateOne(
                { userId, phone: realPhone },
                {
                  $set: { userId, phone: realPhone, source: "lid_resolved", lastSeenAt: new Date(), isActive: true },
                  $setOnInsert: { firstSeenAt: new Date(), pushName: null, profilePicKey: null, profilePicHash: null },
                },
                { upsert: true }
              );
            } catch {}
          }
        }
      }
    });

    // History sync — Baileys v6 fires this with bulk chat/contact data
    sock.ev.on("messaging-history.set", async (data) => {
      const { chats: syncChats, contacts: syncContacts, messages: syncMessages } = data;
      logger.info({ userId, chats: syncChats?.length, contacts: syncContacts?.length, messages: syncMessages?.length }, "History sync received");

      // Process contacts from history
      if (syncContacts && syncContacts.length > 0) {
        for (const contact of syncContacts) {
          const jid = contact.id || "";
          if (!jid.endsWith("@s.whatsapp.net")) continue;
          const phone = jid.replace("@s.whatsapp.net", "");
          if (!phone || !/^\d+$/.test(phone)) continue;

          try {
            await contactsCol.updateOne(
              { userId, phone },
              {
                $set: {
                  userId, phone,
                  pushName: contact.notify || contact.name || null,
                  source: "history_sync",
                  lastSeenAt: new Date(),
                  isActive: true,
                },
                $setOnInsert: { firstSeenAt: new Date(), profilePicKey: null, profilePicHash: null },
              },
              { upsert: true }
            );
          } catch {}
        }
      }

      // Process chats from history
      if (syncChats && syncChats.length > 0) {
        for (const chat of syncChats) {
          const jid = chat.id || "";
          if (!jid.endsWith("@s.whatsapp.net") && !jid.endsWith("@g.us")) continue;

          try {
            await chatsCol.updateOne(
              { userId, jid },
              {
                $set: {
                  userId, jid,
                  name: chat.name || null,
                  isGroup: jid.endsWith("@g.us"),
                  updatedAt: new Date(),
                },
                $setOnInsert: { createdAt: new Date() },
              },
              { upsert: true }
            );
          } catch {}
        }
      }

      // Process messages from history sync
      if (syncMessages && syncMessages.length > 0) {
        const msgBatch = [];
        for (const item of syncMessages) {
          const msg = item.message || item;
          const jid = msg.key?.remoteJid || "";
          if (!jid.endsWith("@s.whatsapp.net")) continue;
          const phone = jid.replace("@s.whatsapp.net", "");
          if (!phone || !/^\d+$/.test(phone)) continue;

          const msgContent = msg.message || {};
          // Handle nested message types (ephemeral, viewOnce, etc.)
          const innerMsg =
            msgContent.ephemeralMessage?.message ||
            msgContent.viewOnceMessage?.message ||
            msgContent.viewOnceMessageV2?.message ||
            msgContent.documentWithCaptionMessage?.message ||
            msgContent;
          const text =
            innerMsg.conversation ||
            innerMsg.extendedTextMessage?.text ||
            innerMsg.imageMessage?.caption ||
            innerMsg.videoMessage?.caption ||
            innerMsg.documentMessage?.caption ||
            innerMsg.buttonsResponseMessage?.selectedDisplayText ||
            innerMsg.listResponseMessage?.title ||
            msgContent.conversation ||
            msgContent.extendedTextMessage?.text ||
            "";
          const mediaType =
            (innerMsg.imageMessage || msgContent.imageMessage) ? "image" :
            (innerMsg.videoMessage || msgContent.videoMessage) ? "video" :
            (innerMsg.audioMessage || msgContent.audioMessage) ? "audio" :
            (innerMsg.documentMessage || msgContent.documentMessage) ? "document" :
            (innerMsg.stickerMessage || msgContent.stickerMessage) ? "sticker" :
            null;

          msgBatch.push({
            updateOne: {
              filter: { odgId: msg.key?.id, userId, phone },
              update: {
                $set: {
                  odgId: msg.key?.id,
                  userId,
                  phone,
                  fromMe: msg.key?.fromMe || false,
                  text: text || (mediaType ? `[${mediaType}]` : ""),
                  mediaType,
                  timestamp: msg.messageTimestamp
                    ? new Date(Number(msg.messageTimestamp) * 1000)
                    : new Date(),
                  pushName: msg.pushName || null,
                },
              },
              upsert: true,
            },
          });
        }
        if (msgBatch.length > 0) {
          try {
            await messagesCol.bulkWrite(msgBatch, { ordered: false });
            logger.info({ userId, count: msgBatch.length }, "Stored history messages");
          } catch (err) {
            logger.error({ userId, err: err.message }, "Error storing history messages");
          }
        }
      }
    });
  }

  return {
    connectWithOTP,
    connectWithQR,
    getQR,
    reconnect,
    disconnect,
    getSocket,
    getStatus,
    getActiveCount,
    disconnectAll,
    restoreSessions,
    sendMessage,
  };
}

module.exports = { createSessionManager };
