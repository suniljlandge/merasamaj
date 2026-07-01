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
      // Drop retry requests for messages older than 5 minutes — avoids
      // infinite Bad MAC retry storms after restarts for stale offline messages.
      maxMsgRetryCount: 1,
      getMessage: async () => undefined,
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
      maxMsgRetryCount: 1,
      getMessage: async () => undefined,
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
      maxMsgRetryCount: 1,
      getMessage: async () => undefined,
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
      const lidMappingsCol = db.collection("wa_lid_mappings");

      for (const contact of contacts) {
        const jid = contact.id || "";
        const lid = contact.lid || "";
        let phone = "";

        if (jid.endsWith("@s.whatsapp.net")) {
          phone = jid.replace("@s.whatsapp.net", "");
        } else if (jid.endsWith("@lid")) {
          // Contact itself is a LID — check if there's a phone number elsewhere
          if (contact.phone) {
            phone = contact.phone.replace(/[^0-9]/g, "");
          }
        }

        if (!phone || !/^\d+$/.test(phone)) continue;

        // Save contact. Only write pushName/verifiedName when present so a
        // nameless sync event can't overwrite a previously-captured name.
        const cName = contact.notify || contact.name || null;
        try {
          const $set = {
            userId,
            phone,
            lid: lid || (jid.endsWith("@lid") ? jid : null),
            source: "sync",
            lastSeenAt: new Date(),
            isActive: true,
          };
          if (cName) $set.pushName = cName;
          if (contact.verifiedName) $set.verifiedName = contact.verifiedName;

          await contactsCol.updateOne(
            { userId, phone },
            {
              $set,
              $setOnInsert: {
                firstSeenAt: new Date(),
                profilePicKey: null,
                profilePicHash: null,
                ...(cName ? {} : { pushName: null }),
              },
            },
            { upsert: true }
          );
        } catch (err) {
          if (err.code !== 11000) logger.error({ userId, phone, err: err.message }, "Contact upsert error");
        }

        // Save LID mapping if we have both LID and phone
        if (lid && phone) {
          const lidJid = lid.endsWith("@lid") ? lid : lid + "@lid";
          try {
            await lidMappingsCol.updateOne(
              { lid: lidJid },
              { $set: { lid: lidJid, phone, userId, name: cName, updatedAt: new Date() } },
              { upsert: true }
            );
          } catch {}
        }
        // Also map if jid is a LID and we resolved phone
        if (jid.endsWith("@lid") && phone) {
          try {
            await lidMappingsCol.updateOne(
              { lid: jid },
              { $set: { lid: jid, phone, userId, updatedAt: new Date() } },
              { upsert: true }
            );
          } catch {}
        }
      }
    });

    sock.ev.on("contacts.update", async (updates) => {
      for (const update of updates) {
        const jid = update.id || "";
        let phone = "";

        if (jid.endsWith("@s.whatsapp.net")) {
          phone = jid.replace("@s.whatsapp.net", "");
        } else if (jid.endsWith("@lid")) {
          // Resolve LID → phone via lid_mappings
          const mapping = await db.collection("wa_lid_mappings").findOne({ lid: jid });
          if (mapping) phone = mapping.phone;
        }

        if (!phone || !/^\d+$/.test(phone)) continue;

        const $set = { lastSeenAt: new Date() };
        if (update.notify) $set.pushName = update.notify;
        if (update.verifiedName) $set.verifiedName = update.verifiedName;

        if (!update.notify && !update.verifiedName) continue; // nothing to update

        try {
          await contactsCol.updateOne(
            { userId, phone },
            {
              $set: { userId, phone, isActive: true, ...$set },
              $setOnInsert: { firstSeenAt: new Date(), profilePicKey: null, profilePicHash: null },
            },
            { upsert: true }
          );
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
              const chatName = chat.name || null;
              const $setC = {
                userId,
                phone,
                source: "chat",
                lastSeenAt: new Date(),
                isActive: true,
              };
              if (chatName) $setC.pushName = chatName;
              await contactsCol.updateOne(
                { userId, phone },
                {
                  $set: $setC,
                  $setOnInsert: {
                    firstSeenAt: new Date(),
                    profilePicKey: null,
                    profilePicHash: null,
                    ...(chatName ? {} : { pushName: null }),
                  },
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
        } else if (jid.endsWith("@g.us")) {
          // Group message — extract LID→phone mapping from participant fields
          const participant = msg.key?.participant || "";
          const participantPn = msg.key?.participantPn || "";
          if (participant.endsWith("@lid") && participantPn.endsWith("@s.whatsapp.net")) {
            const resolvedPhone = participantPn.replace("@s.whatsapp.net", "");
            if (resolvedPhone && /^\d+$/.test(resolvedPhone)) {
              try {
                await db.collection("wa_lid_mappings").updateOne(
                  { lid: participant },
                  { $set: { lid: participant, phone: resolvedPhone, userId, updatedAt: new Date() } },
                  { upsert: true }
                );
                // Also update any messages stored under this LID
                const lidNum = participant.replace("@lid", "");
                await messagesCol.updateMany(
                  { userId, phone: lidNum },
                  { $set: { phone: resolvedPhone } }
                );
              } catch {}
              // Save group participant as a contact so they appear in the contact viewer
              if (msg.pushName) {
                try {
                  await contactsCol.updateOne(
                    { userId, phone: resolvedPhone },
                    {
                      $set: {
                        userId,
                        phone: resolvedPhone,
                        pushName: msg.pushName,
                        source: "group_message",
                        lastSeenAt: new Date(),
                        isActive: true,
                      },
                      $setOnInsert: {
                        firstSeenAt: new Date(),
                        profilePicKey: null,
                        profilePicHash: null,
                      },
                    },
                    { upsert: true }
                  );
                } catch {}
              }
            }
          } else if (participant.endsWith("@s.whatsapp.net") && msg.pushName) {
            // Non-LID group participant — save directly
            const resolvedPhone = participant.replace("@s.whatsapp.net", "");
            if (resolvedPhone && /^\d+$/.test(resolvedPhone)) {
              try {
                await contactsCol.updateOne(
                  { userId, phone: resolvedPhone },
                  {
                    $set: {
                      userId,
                      phone: resolvedPhone,
                      pushName: msg.pushName,
                      source: "group_message",
                      lastSeenAt: new Date(),
                      isActive: true,
                    },
                    $setOnInsert: {
                      firstSeenAt: new Date(),
                      profilePicKey: null,
                      profilePicHash: null,
                    },
                  },
                  { upsert: true }
                );
              } catch {}
            }
          }
          continue; // Don't store group messages as individual chats
        } else if (jid === "status@broadcast" || jid.endsWith("@broadcast")) {
          // Status update or broadcast list message — resolve sender from participantPn
          const participantPn = msg.key?.participantPn || msg.participant || "";
          const senderPhone = participantPn.endsWith("@s.whatsapp.net")
            ? participantPn.replace("@s.whatsapp.net", "")
            : "";
          if (senderPhone && /^\d+$/.test(senderPhone) && msg.pushName) {
            try {
              await contactsCol.updateOne(
                { userId, phone: senderPhone },
                {
                  $set: {
                    userId,
                    phone: senderPhone,
                    pushName: msg.pushName,
                    source: "broadcast_seen",
                    lastSeenAt: new Date(),
                    isActive: true,
                  },
                  $setOnInsert: {
                    firstSeenAt: new Date(),
                    profilePicKey: null,
                    profilePicHash: null,
                  },
                },
                { upsert: true }
              );
            } catch {}
          }
          continue; // Don't store status/broadcast messages themselves
        } else {
          continue; // Unknown JID format — skip
        }

        if (!phone) continue;

        try {
          await contactsCol.updateOne(
            { userId, phone },
            {
              $set: { userId, phone, source: "message", lastSeenAt: new Date(), isActive: true,
                ...(msg.pushName ? { pushName: msg.pushName } : {}) },
              $setOnInsert: { firstSeenAt: new Date(), profilePicKey: null, profilePicHash: null,
                ...(!msg.pushName ? { pushName: null } : {}) },
            },
            { upsert: true }
          );
        } catch {}

        // Store the message
        try {
          const msgContent = msg.message || {};

          // Skip protocol messages, reactions, and edits (they have no readable content)
          if (msgContent.protocolMessage || msgContent.reactionMessage ||
              msgContent.editedMessage || msgContent.pollUpdateMessage) {
            // Still fall through to LID mapping below
          } else {

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

          // Only store if there's actual content
          if (text || mediaType) {
          // Extract media metadata for on-demand download
          let mediaInfo = null;
          const mediaMsg = msgContent.imageMessage || msgContent.videoMessage ||
            msgContent.audioMessage || msgContent.documentMessage || msgContent.stickerMessage ||
            innerMsg.imageMessage || innerMsg.videoMessage ||
            innerMsg.audioMessage || innerMsg.documentMessage || innerMsg.stickerMessage;
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
          } // end if (text || mediaType)
          } // end else (not protocol message)
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
      const { chats: syncChats, contacts: syncContacts, messages: syncMessages, syncType, progress, isLatest } = data;
      logger.info(
        { userId, chats: syncChats?.length, contacts: syncContacts?.length, messages: syncMessages?.length, syncType, progress, isLatest },
        "History sync received"
      );

      // Process contacts from history
      if (syncContacts && syncContacts.length > 0) {
        for (const contact of syncContacts) {
          const jid = contact.id || "";
          if (!jid.endsWith("@s.whatsapp.net")) continue;
          const phone = jid.replace("@s.whatsapp.net", "");
          if (!phone || !/^\d+$/.test(phone)) continue;

          // Only write a name when this batch actually carries one — otherwise
          // a nameless batch (e.g. RECENT/chats) would wipe a name captured by
          // an earlier PUSH_NAME batch, leaving the contact "Unknown".
          const name = contact.notify || contact.name || null;
          const $set = {
            userId, phone,
            source: "history_sync",
            lastSeenAt: new Date(),
            isActive: true,
          };
          if (name) $set.pushName = name;

          try {
            await contactsCol.updateOne(
              { userId, phone },
              {
                $set,
                $setOnInsert: {
                  firstSeenAt: new Date(),
                  profilePicKey: null,
                  profilePicHash: null,
                  ...(name ? {} : { pushName: null }),
                },
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
        const nameUpdates = new Map(); // phone -> pushName (collect names from messages)
        for (const item of syncMessages) {
          const msg = item.message || item;
          const jid = msg.key?.remoteJid || "";
          if (!jid.endsWith("@s.whatsapp.net")) continue;
          const phone = jid.replace("@s.whatsapp.net", "");
          if (!phone || !/^\d+$/.test(phone)) continue;

          // Collect pushName from messages to update contacts
          if (msg.pushName && !msg.key?.fromMe) {
            nameUpdates.set(phone, msg.pushName);
          }

          const msgContent = msg.message || {};

          // Skip protocol messages, reactions, and edits (they have no readable content)
          if (msgContent.protocolMessage || msgContent.reactionMessage ||
              msgContent.editedMessage || msgContent.pollUpdateMessage) {
            continue;
          }

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

          // Skip empty stubs — messages with no text and no media content
          if (!text && !mediaType) continue;

          // Extract media metadata for on-demand download
          let mediaInfo = null;
          const mediaMsg = innerMsg.imageMessage || innerMsg.videoMessage ||
            innerMsg.audioMessage || innerMsg.documentMessage || innerMsg.stickerMessage ||
            msgContent.imageMessage || msgContent.videoMessage ||
            msgContent.audioMessage || msgContent.documentMessage || msgContent.stickerMessage;
          if (mediaMsg && mediaType) {
            mediaInfo = {
              mimetype: mediaMsg.mimetype || null,
              fileLength: mediaMsg.fileLength ? Number(mediaMsg.fileLength) : null,
              fileName: mediaMsg.fileName || null,
              _hasMedia: true,
            };
          }

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
                  mediaInfo,
                  mediaUrl: null,
                  timestamp: msg.messageTimestamp
                    ? new Date(Number(msg.messageTimestamp) * 1000)
                    : new Date(),
                  pushName: msg.pushName || null,
                  _rawMessage: mediaType ? JSON.stringify(msg) : null,
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

        // Update contact names from message pushNames
        if (nameUpdates.size > 0) {
          const nameBatch = [];
          for (const [phone, pushName] of nameUpdates) {
            nameBatch.push({
              updateOne: {
                filter: { userId, phone, $or: [{ pushName: null }, { pushName: "" }] },
                update: { $set: { pushName } },
              },
            });
          }
          try {
            await contactsCol.bulkWrite(nameBatch, { ordered: false });
            logger.info({ userId, count: nameUpdates.size }, "Updated contact names from history messages");
          } catch {}
        }
      }
    });

    // Periodic LID auto-resolver: every 5 minutes, check for new LID mappings
    // and update any messages stored under LIDs
    setInterval(async () => {
      try {
        const lidMappings = await db.collection("wa_lid_mappings").find({ userId }).toArray();
        for (const mapping of lidMappings) {
          const lidNum = mapping.lid.replace("@lid", "");
          const result = await messagesCol.updateMany(
            { userId, phone: lidNum },
            { $set: { phone: mapping.phone } }
          );
          if (result.modifiedCount > 0) {
            logger.info({ userId, lid: mapping.lid, phone: mapping.phone, moved: result.modifiedCount }, "Auto-resolved LID messages");
          }
        }
      } catch {}
    }, 5 * 60 * 1000);

    // Also try to resolve LIDs from sock.user.lid if available
    setTimeout(async () => {
      try {
        // Baileys sometimes stores contact-LID mappings internally
        if (sock.contacts) {
          const lidMappingsCol = db.collection("wa_lid_mappings");
          for (const [jid, contact] of Object.entries(sock.contacts)) {
            if (jid.endsWith("@s.whatsapp.net") && contact.lid) {
              const phone = jid.replace("@s.whatsapp.net", "");
              const lid = contact.lid.endsWith("@lid") ? contact.lid : contact.lid + "@lid";
              if (phone && /^\d+$/.test(phone)) {
                await lidMappingsCol.updateOne(
                  { lid },
                  { $set: { lid, phone, userId, updatedAt: new Date() } },
                  { upsert: true }
                );
              }
            }
          }
          const count = await lidMappingsCol.countDocuments({ userId });
          logger.info({ userId, mappings: count }, "LID mappings from sock.contacts");
        }
      } catch {}
    }, 30000); // 30 seconds after connect
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
