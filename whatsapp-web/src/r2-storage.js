/**
 * Cloudflare R2 Storage Client (S3-compatible)
 *
 * Handles profile picture uploads and pre-signed URL generation.
 */

const {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
} = require("@aws-sdk/client-s3");
const { getSignedUrl } = require("@aws-sdk/s3-request-presigner");

function createR2Client() {
  const accountId = process.env.R2_ACCOUNT_ID;
  const accessKeyId = process.env.R2_ACCESS_KEY_ID;
  const secretAccessKey = process.env.R2_SECRET_ACCESS_KEY;
  const bucketName = process.env.R2_BUCKET_NAME || "samaj-backups";

  if (!accountId || !accessKeyId || !secretAccessKey) {
    console.warn(
      "R2 credentials not configured. Profile picture backup will be disabled."
    );
    return createNullClient();
  }

  const client = new S3Client({
    region: "auto",
    endpoint: `https://${accountId}.r2.cloudflarestorage.com`,
    credentials: {
      accessKeyId,
      secretAccessKey,
    },
  });

  /**
   * Upload a profile picture to R2.
   * @param {string} userId - Owner user ID
   * @param {string} phone - Contact phone number (91XXXXXXXXXX)
   * @param {Buffer} imageBuffer - JPEG image data
   * @returns {string} The storage key
   */
  async function uploadProfilePic(userId, phone, imageBuffer) {
    const key = `wa-backups/${userId}/profile-pics/${phone}.jpg`;

    await client.send(
      new PutObjectCommand({
        Bucket: bucketName,
        Key: key,
        Body: imageBuffer,
        ContentType: "image/jpeg",
      })
    );

    return key;
  }

  /**
   * Get a pre-signed URL for a profile picture (expires in 1 hour).
   * @param {string} key - The R2 storage key
   * @returns {string} Signed URL
   */
  async function getProfilePicUrl(key) {
    const command = new GetObjectCommand({
      Bucket: bucketName,
      Key: key,
    });
    return getSignedUrl(client, command, { expiresIn: 3600 });
  }

  /**
   * Delete a profile picture from R2.
   * @param {string} key - The R2 storage key
   */
  async function deleteProfilePic(key) {
    await client.send(
      new DeleteObjectCommand({
        Bucket: bucketName,
        Key: key,
      })
    );
  }

  return {
    uploadProfilePic,
    getProfilePicUrl,
    deleteProfilePic,
    isEnabled: true,
  };
}

/**
 * Null client when R2 is not configured — operations are no-ops.
 */
function createNullClient() {
  return {
    uploadProfilePic: async () => null,
    getProfilePicUrl: async () => null,
    deleteProfilePic: async () => {},
    isEnabled: false,
  };
}

module.exports = { createR2Client };
