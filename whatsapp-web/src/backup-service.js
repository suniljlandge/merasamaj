/**
 * Backup Service — extracts contacts, groups, and profile pictures
 * from an active WhatsApp Web session and persists them.
 *
 * Runs as a background task after session connects, and on a daily schedule.
 */

const crypto = require("crypto");
const { PutObjectCommand } = require("@aws-sdk/client-s3");

const PROFILE_PIC_DELAY = parseInt(
  process.env.PROFILE_PIC_FETCH_DELAY_MS || "2500",
  10
);

function createBackupService(db, r2, logger) {
  const contactsCol = db.collection("wa_contact_backups");
  const groupsCol = db.collection("wa_group_backups");
  const backupLogCol = db.collection("wa_backup_log");

  const profilePicHistoryCol = db.collection("wa_profile_pic_history");

  // Ensure indexes
  (async () => {
    await contactsCol.createIndex({ userId: 1, phone: 1 }, { unique: true });
    await contactsCol.createIndex({ userId: 1 });
    await groupsCol.createIndex({ userId: 1, groupJid: 1 }, { unique: true });
    await backupLogCol.createIndex({ userId: 1, createdAt: -1 });
    await profilePicHistoryCol.createIndex({ userId: 1, phone: 1, capturedAt: -1 });
    await profilePicHistoryCol.createIndex({ userId: 1, phone: 1, hash: 1 }, { unique: true });
  })();

  // Track running backup promises by userId
  const activeBackups = new Map();

  /**
   * Run a full contact + group backup for a user.
   * @param {object} sock - Active Baileys socket
   * @param {string} userId - User ID
   * @param {object} options - { includeProfilePics: boolean, backupType: string }
   */
  async function runFullBackup(sock, userId, options = {}) {
    const backupPromise = _doFullBackup(sock, userId, options);
    activeBackups.set(userId, backupPromise);
    backupPromise.finally(() => {
      activeBackups.delete(userId);
    });
    return backupPromise;
  }

  /**
   * Check if a backup is currently running for a user.
   */
  function isBackupRunning(userId) {
    return activeBackups.has(userId);
  }

  async function _doFullBackup(sock, userId, options = {}) {
    const {
      includeProfilePics = true,
      backupType = "manual",
    } = options;

    const startTime = Date.now();
    const results = {
      contacts: { added: 0, updated: 0, skipped: 0 },
      groups: { added: 0, updated: 0 },
      profilePics: { uploaded: 0, skipped: 0, failed: 0 },
    };

    logger.info({ userId, backupType }, "Starting full backup");

    // --- 1. Backup contacts from chats ---
    try {
      const contactPhones = new Set();

      // Method 1: Get all chats (individual + group conversations)
      try {
        const chats = await sock.groupFetchAllParticipating();
        
        // Extract from groups
        for (const [groupJid, group] of Object.entries(chats)) {
          // Save group
          await groupsCol.updateOne(
            { userId, groupJid },
            {
              $set: {
                userId,
                groupJid,
                groupName: group.subject || "Unknown Group",
                participantCount: group.participants?.length || 0,
                participants: (group.participants || []).map((p) => ({
                  phone: p.id.replace("@s.whatsapp.net", ""),
                  isAdmin:
                    p.admin === "admin" || p.admin === "superadmin",
                })),
                backedUpAt: new Date(),
              },
            },
            { upsert: true }
          );
          results.groups.added++;

          // Collect participant phones (skip LIDs and group JIDs)
          for (const p of group.participants || []) {
            const jid = p.id || "";
            // Only collect real phone numbers (@s.whatsapp.net), skip @lid and @g.us
            if (!jid.endsWith("@s.whatsapp.net")) continue;
            const phone = jid.replace("@s.whatsapp.net", "");
            if (phone && !phone.includes("-") && /^\d+$/.test(phone)) {
              contactPhones.add(phone);
            }
          }
        }
      } catch (groupErr) {
        logger.error({ userId, err: groupErr.message }, "Error fetching groups");
      }

      // Method 2: Get contacts from incoming/outgoing messages via sock.contacts
      const contactNames = new Map(); // phone -> name
      try {
        if (sock.contacts) {
          for (const [jid, contact] of Object.entries(sock.contacts)) {
            if (!jid.endsWith("@s.whatsapp.net")) continue;
            const phone = jid.replace("@s.whatsapp.net", "");
            if (phone && !phone.includes("-") && /^\d+$/.test(phone)) {
              contactPhones.add(phone);
              const name = contact.notify || contact.name || contact.verifiedName || null;
              if (name) contactNames.set(phone, name);
            }
          }
        }
      } catch (chatErr) {
        logger.error({ userId, err: chatErr.message }, "Error fetching chat contacts");
      }

      logger.info({ userId, contactCount: contactPhones.size, withNames: contactNames.size }, "Contacts collected");

      // Save each contact
      for (const phone of contactPhones) {
        try {
          const name = contactNames.get(phone) || null;
          const existing = await contactsCol.findOne({ userId, phone });
          if (existing) {
            const $set = { lastSeenAt: new Date(), isActive: true };
            // Update pushName if we have one and existing doesn't
            if (name && !existing.pushName) $set.pushName = name;
            await contactsCol.updateOne(
              { userId, phone },
              { $set }
            );
            results.contacts.updated++;
          } else {
            await contactsCol.insertOne({
              userId,
              phone,
              pushName: name,
              source: "group",
              profilePicKey: null,
              profilePicHash: null,
              profilePicUpdatedAt: null,
              firstSeenAt: new Date(),
              lastSeenAt: new Date(),
              isActive: true,
            });
            results.contacts.added++;
          }
        } catch (err) {
          if (err.code === 11000) {
            results.contacts.skipped++;
          } else {
            logger.error({ userId, phone, err: err.message }, "Contact save error");
          }
        }
      }
    } catch (err) {
      logger.error({ userId, err: err.message }, "Error fetching chats/groups");
    }

    // --- 2. Backup profile pictures ---
    if (includeProfilePics && r2.isEnabled) {
      const contacts = await contactsCol.find({ userId, isActive: true }).toArray();

      for (const contact of contacts) {
        try {
          await sleep(PROFILE_PIC_DELAY);

          const jid = contact.phone + "@s.whatsapp.net";
          let picUrl;
          try {
            picUrl = await sock.profilePictureUrl(jid, "image");
          } catch (picErr) {
            // 404 = no pic, 401 = privacy blocked
            results.profilePics.skipped++;
            continue;
          }

          if (!picUrl) {
            results.profilePics.skipped++;
            continue;
          }

          // Download image
          const response = await fetch(picUrl);
          if (!response.ok) {
            results.profilePics.failed++;
            continue;
          }
          const buffer = Buffer.from(await response.arrayBuffer());

          // Hash check — skip if unchanged
          const newHash = crypto
            .createHash("md5")
            .update(buffer)
            .digest("hex");

          if (contact.profilePicHash === newHash) {
            results.profilePics.skipped++;
            continue;
          }

          // Upload to R2 with timestamp-based key (preserves history)
          const timestamp = Date.now();
          const versionedKey = `wa-backups/${userId}/profile-pics/${contact.phone}/${timestamp}.jpg`;

          await r2.client.send(
            new PutObjectCommand({
              Bucket: r2.bucketName,
              Key: versionedKey,
              Body: buffer,
              ContentType: "image/jpeg",
            })
          );

          // Save to history collection
          try {
            await profilePicHistoryCol.insertOne({
              userId,
              phone: contact.phone,
              key: versionedKey,
              hash: newHash,
              capturedAt: new Date(),
            });
          } catch (dupErr) {
            // Duplicate hash — already have this version
            if (dupErr.code !== 11000) throw dupErr;
          }

          // Update contact with latest pic pointer
          await contactsCol.updateOne(
            { userId, phone: contact.phone },
            {
              $set: {
                profilePicKey: versionedKey,
                profilePicHash: newHash,
                profilePicUpdatedAt: new Date(),
              },
            }
          );

          results.profilePics.uploaded++;
        } catch (err) {
          results.profilePics.failed++;
          logger.error(
            { userId, phone: contact.phone, err: err.message },
            "Profile pic backup error"
          );
        }
      }
    }

    // --- 3. Log the backup ---
    try {
      const duration = Date.now() - startTime;
      await backupLogCol.insertOne({
        userId,
        backupType,
        results,
        durationMs: duration,
        createdAt: new Date(),
      });
      logger.info({ userId, results, durationMs: duration }, "Backup completed");
    } catch (logErr) {
      logger.error({ userId, err: logErr.message }, "Failed to write backup log");
    }

    return results;
  }

  /**
   * Get backup status/history for a user.
   */
  async function getBackupStatus(userId) {
    const lastBackup = await backupLogCol.findOne(
      { userId },
      { sort: { createdAt: -1 } }
    );

    const contactCount = await contactsCol.countDocuments({
      userId,
      isActive: true,
    });
    const groupCount = await groupsCol.countDocuments({ userId });

    return {
      lastBackup: lastBackup
        ? {
            type: lastBackup.backupType,
            completedAt: lastBackup.createdAt,
            results: lastBackup.results,
            durationMs: lastBackup.durationMs,
          }
        : null,
      totalContacts: contactCount,
      totalGroups: groupCount,
    };
  }

  /**
   * Export contacts as JSON array for a user.
   * Sorted: message contacts first, then those with profile pics, then rest.
   */
  async function exportContacts(userId, format = "json") {
    const contacts = await contactsCol
      .find({ userId, isActive: true })
      .project({ _id: 0, phone: 1, pushName: 1, source: 1, firstSeenAt: 1, lastSeenAt: 1, profilePicKey: 1 })
      .sort({ lastSeenAt: -1 })
      .toArray();

    // Sort: message/chat first, then has profile pic, then rest
    const priority = { message: 0, chat: 1, sync: 2, lid_resolved: 3, history_sync: 4, group: 5 };
    contacts.sort((a, b) => {
      const aPri = (priority[a.source] ?? 6);
      const bPri = (priority[b.source] ?? 6);
      // First: source priority (message > chat > sync > rest)
      if (aPri !== bPri) return aPri - bPri;
      // Second: has profile pic
      const aPic = a.profilePicKey ? 0 : 1;
      const bPic = b.profilePicKey ? 0 : 1;
      if (aPic !== bPic) return aPic - bPic;
      // Third: lastSeenAt descending
      return (b.lastSeenAt || 0) - (a.lastSeenAt || 0);
    });

    if (format === "csv") {
      const header = "phone,pushName,source,firstSeenAt\n";
      const rows = contacts
        .map(
          (c) =>
            `${c.phone},${(c.pushName || "").replace(/,/g, "")},${c.source},${c.firstSeenAt?.toISOString() || ""}`
        )
        .join("\n");
      return header + rows;
    }

    // For JSON, include hasProfilePic flag (don't resolve URLs here — too slow for 1000+ contacts)
    return contacts.map((c) => ({
      phone: c.phone,
      pushName: c.pushName,
      source: c.source,
      firstSeenAt: c.firstSeenAt,
      lastSeenAt: c.lastSeenAt,
      hasProfilePic: !!c.profilePicKey,
    }));
  }

  /**
   * Get a signed URL for a contact's profile picture (latest).
   */
  async function getContactProfilePicUrl(userId, phone) {
    const contact = await contactsCol.findOne({ userId, phone });
    if (!contact?.profilePicKey) return null;
    return r2.getProfilePicUrl(contact.profilePicKey);
  }

  /**
   * Get signed URLs for multiple contacts' profile pictures in one call.
   * Returns a map of phone -> url.
   */
  async function getContactProfilePicUrlsBatch(userId, phones) {
    const contacts = await contactsCol
      .find({ userId, phone: { $in: phones }, profilePicKey: { $ne: null } })
      .project({ phone: 1, profilePicKey: 1 })
      .toArray();

    const results = {};
    await Promise.all(
      contacts.map(async (c) => {
        try {
          results[c.phone] = await r2.getProfilePicUrl(c.profilePicKey);
        } catch {}
      })
    );
    return results;
  }

  /**
   * Get all historical profile pictures for a contact (newest first).
   * Returns signed URLs for each version.
   */
  async function getProfilePicHistory(userId, phone) {
    const history = await profilePicHistoryCol
      .find({ userId, phone })
      .sort({ capturedAt: -1 })
      .toArray();

    if (!history.length) {
      // Fallback: check if contact has a single legacy key (pre-history migration)
      const contact = await contactsCol.findOne({ userId, phone });
      if (contact?.profilePicKey) {
        const url = await r2.getProfilePicUrl(contact.profilePicKey);
        return url ? [{ url, capturedAt: contact.profilePicUpdatedAt || null }] : [];
      }
      return [];
    }

    const results = [];
    for (const entry of history) {
      try {
        const url = await r2.getProfilePicUrl(entry.key);
        results.push({ url, capturedAt: entry.capturedAt });
      } catch {
        // Skip entries where R2 object is missing
      }
    }
    return results;
  }

  return {
    runFullBackup,
    isBackupRunning,
    getBackupStatus,
    exportContacts,
    getContactProfilePicUrl,
    getContactProfilePicUrlsBatch,
    getProfilePicHistory,
  };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

module.exports = { createBackupService };
