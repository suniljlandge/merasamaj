/**
 * Backup Service — extracts contacts, groups, and profile pictures
 * from an active WhatsApp Web session and persists them.
 *
 * Runs as a background task after session connects, and on a daily schedule.
 */

const crypto = require("crypto");

const PROFILE_PIC_DELAY = parseInt(
  process.env.PROFILE_PIC_FETCH_DELAY_MS || "2500",
  10
);

function createBackupService(db, r2, logger) {
  const contactsCol = db.collection("wa_contact_backups");
  const groupsCol = db.collection("wa_group_backups");
  const backupLogCol = db.collection("wa_backup_log");

  // Ensure indexes
  (async () => {
    await contactsCol.createIndex({ userId: 1, phone: 1 }, { unique: true });
    await contactsCol.createIndex({ userId: 1 });
    await groupsCol.createIndex({ userId: 1, groupJid: 1 }, { unique: true });
    await backupLogCol.createIndex({ userId: 1, createdAt: -1 });
  })();

  /**
   * Run a full contact + group backup for a user.
   * @param {object} sock - Active Baileys socket
   * @param {string} userId - User ID
   * @param {object} options - { includeProfilePics: boolean, backupType: string }
   */
  async function runFullBackup(sock, userId, options = {}) {
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
      try {
        if (sock.contacts) {
          for (const [jid, contact] of Object.entries(sock.contacts)) {
            if (!jid.endsWith("@s.whatsapp.net")) continue;
            const phone = jid.replace("@s.whatsapp.net", "");
            if (phone && !phone.includes("-") && /^\d+$/.test(phone)) {
              contactPhones.add(phone);
            }
          }
        }
      } catch (chatErr) {
        logger.error({ userId, err: chatErr.message }, "Error fetching chat contacts");
      }

      logger.info({ userId, contactCount: contactPhones.size }, "Contacts collected");

      // Save each contact
      for (const phone of contactPhones) {
        try {
          const existing = await contactsCol.findOne({ userId, phone });
          if (existing) {
            await contactsCol.updateOne(
              { userId, phone },
              { $set: { lastSeenAt: new Date(), isActive: true } }
            );
            results.contacts.updated++;
          } else {
            await contactsCol.insertOne({
              userId,
              phone,
              pushName: null,
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

          // Upload to R2
          const key = await r2.uploadProfilePic(userId, contact.phone, buffer);

          // Update DB
          await contactsCol.updateOne(
            { userId, phone: contact.phone },
            {
              $set: {
                profilePicKey: key,
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
   */
  async function exportContacts(userId, format = "json") {
    const contacts = await contactsCol
      .find({ userId, isActive: true })
      .project({ _id: 0, phone: 1, pushName: 1, source: 1, firstSeenAt: 1, lastSeenAt: 1 })
      .sort({ lastSeenAt: -1 })
      .toArray();

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

    return contacts;
  }

  /**
   * Get a signed URL for a contact's profile picture.
   */
  async function getContactProfilePicUrl(userId, phone) {
    const contact = await contactsCol.findOne({ userId, phone });
    if (!contact?.profilePicKey) return null;
    return r2.getProfilePicUrl(contact.profilePicKey);
  }

  return {
    runFullBackup,
    getBackupStatus,
    exportContacts,
    getContactProfilePicUrl,
  };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

module.exports = { createBackupService };
