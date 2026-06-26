/**
 * MongoDB-backed auth state for Baileys.
 * Replaces useMultiFileAuthState — stores creds and keys in MongoDB
 * so sessions persist across deploys without needing a filesystem volume.
 */

const { proto } = require("@whiskeysockets/baileys");
const { initAuthCreds, BufferJSON } = require("@whiskeysockets/baileys");

function useMongoDBAuthState(collection, sessionId) {
  const docId = (type, id) => `${sessionId}:${type}:${id || "default"}`;

  async function readData(type, id) {
    const doc = await collection.findOne({ _id: docId(type, id) });
    if (!doc || !doc.data) return null;
    return JSON.parse(doc.data, BufferJSON.reviver);
  }

  async function writeData(type, id, value) {
    const data = JSON.stringify(value, BufferJSON.replacer);
    await collection.updateOne(
      { _id: docId(type, id) },
      { $set: { _id: docId(type, id), data, sessionId, type, updatedAt: new Date() } },
      { upsert: true }
    );
  }

  async function removeData(type, id) {
    await collection.deleteOne({ _id: docId(type, id) });
  }

  async function getAuthState() {
    // Load creds
    let creds = await readData("creds", "creds");
    if (!creds) {
      creds = initAuthCreds();
    }

    return {
      state: {
        creds,
        keys: {
          get: async (type, ids) => {
            const result = {};
            for (const id of ids) {
              const value = await readData(type, id);
              if (value) {
                if (type === "app-state-sync-key") {
                  result[id] = proto.Message.AppStateSyncKeyData.fromObject(value);
                } else {
                  result[id] = value;
                }
              }
            }
            return result;
          },
          set: async (data) => {
            for (const [type, entries] of Object.entries(data)) {
              for (const [id, value] of Object.entries(entries)) {
                if (value) {
                  await writeData(type, id, value);
                } else {
                  await removeData(type, id);
                }
              }
            }
          },
        },
      },
      saveCreds: async () => {
        await writeData("creds", "creds", creds);
      },
    };
  }

  return getAuthState();
}

/**
 * Check if auth state exists for a session in MongoDB.
 */
async function hasAuthState(collection, sessionId) {
  const doc = await collection.findOne({ _id: `${sessionId}:creds:creds` });
  return !!doc;
}

/**
 * Clear all auth state for a session from MongoDB.
 */
async function clearAuthState(collection, sessionId) {
  await collection.deleteMany({ sessionId });
}

module.exports = { useMongoDBAuthState, hasAuthState, clearAuthState };
