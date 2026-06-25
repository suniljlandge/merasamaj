/**
 * Session Manager — handles Baileys WhatsApp Web connections per user.
 *
 * Each user gets one active socket connection. Sessions are persisted in
 * MongoDB so they survive service restarts without requiring QR/OTP re-auth.
 */

const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
} = require("@whiskeysockets/baileys");
const { Boom } = require("@hapi/boom");
const path = require("path");
const fs = require("fs");

const AUTH_DIR = path.join(__dirname, "..", "auth-sessions");

function createSessionManager(db, logger, { onConnected } = {}) {
  // Active sockets keyed by userId
  const activeSockets = new Map();
  // Connection status per user
  const connectionStatus = new Map();

  const sessionsCollection = db.collection("wa_web_sessions");

  /**
   * Get or create auth state directory for a user.
   */
  function getAuthDir(userId) {
    const dir = path.join(AUTH_DIR, userId);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    return dir;
  }

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

    // Clear old auth state to force fresh pairing
    const authDir = getAuthDir(userId);
    const credsFile = path.join(authDir, "creds.json");
    if (fs.existsSync(credsFile)) {
      // Remove all auth files to start fresh
      const files = fs.readdirSync(authDir);
      for (const file of files) {
        fs.unlinkSync(path.join(authDir, file));
      }
      logger.info({ userId }, "Cleared old auth state for fresh pairing");
    }

    const { state, saveCreds } = await useMultiFileAuthState(authDir);
    const { version } = await fetchLatestBaileysVersion();

    const sock = makeWASocket({
      version,
      auth: state,
      printQRInTerminal: false,
      logger: logger.child({ module: "baileys", userId }),
    });

    // Store socket
    activeSockets.set(userId, sock);
    connectionStatus.set(userId, "connecting");

    // Handle credential updates
    sock.ev.on("creds.update", saveCreds);

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
    const authDir = getAuthDir(userId);
    const credsFile = path.join(authDir, "creds.json");
    if (fs.existsSync(credsFile)) {
      const files = fs.readdirSync(authDir);
      for (const file of files) {
        fs.unlinkSync(path.join(authDir, file));
      }
      logger.info({ userId }, "Cleared old auth state for QR pairing");
    }

    const { state, saveCreds } = await useMultiFileAuthState(authDir);
    const { version } = await fetchLatestBaileysVersion();

    const sock = makeWASocket({
      version,
      auth: state,
      printQRInTerminal: false,
      logger: logger.child({ module: "baileys", userId }),
    });

    activeSockets.set(userId, sock);
    connectionStatus.set(userId, "waiting_qr");

    sock.ev.on("creds.update", saveCreds);

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
    const authDir = getAuthDir(userId);
    if (!fs.existsSync(path.join(authDir, "creds.json"))) {
      connectionStatus.set(userId, "disconnected");
      return;
    }

    const { state, saveCreds } = await useMultiFileAuthState(authDir);
    const { version } = await fetchLatestBaileysVersion();

    const sock = makeWASocket({
      version,
      auth: state,
      printQRInTerminal: false,
      logger: logger.child({ module: "baileys", userId }),
    });

    activeSockets.set(userId, sock);
    sock.ev.on("creds.update", saveCreds);

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
