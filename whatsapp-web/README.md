# SAMAJ WhatsApp Web Sidecar

Node.js service that manages WhatsApp Web sessions via [Baileys](https://github.com/WhiskeySockets/Baileys). Runs alongside the main Flask app to enable:

- **OTP-based login** — Users link their WhatsApp by entering a pairing code (no QR scan needed)
- **Contact & group backup** — Extracts all contacts and group participants to MongoDB
- **Profile picture backup** — Downloads and stores profile photos in Cloudflare R2
- **Hybrid messaging** — Routes personal follow-ups through the user's own WhatsApp number

## Setup

```bash
cd whatsapp-web
npm install
cp .env.example .env
# Edit .env with your R2 credentials and API secret
npm start
```

## Architecture

```
Flask App (port 5000)
    │
    │ HTTP calls to sidecar
    ▼
WhatsApp Web Service (port 3001)
    │
    ├── Session Manager (Baileys connections per user)
    ├── Backup Service (contacts, groups, profile pics)
    ├── R2 Storage (Cloudflare S3-compatible)
    └── Route Decision Engine (web vs cloud API)
```

## API Endpoints

All endpoints (except `/health`) require `X-API-Secret` header.

### Session
| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/api/session/connect` | Start OTP login |
| GET | `/api/session/status/:userId` | Get connection status |
| POST | `/api/session/disconnect` | Disconnect session |

### Messaging
| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/api/message/send` | Send personal message |
| GET | `/api/message/daily-stats/:userId` | Today's send count |
| POST | `/api/route/decide` | Get routing recommendation |

### Backup
| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/api/backup/run` | Trigger full backup |
| GET | `/api/backup/status/:userId` | Backup stats |
| GET | `/api/backup/contacts/:userId` | Export contacts |
| GET | `/api/backup/profile-pic/:userId/:phone` | Get profile pic URL |

## Rate Limits & Safety

- Max 20 personal messages/day per user via Web session (configurable)
- 2.5 second delay between profile picture fetches
- Auto-reconnect on disconnection (except for bans/logouts)
- Session auth persisted in `auth-sessions/` directory

## MongoDB Collections Created

- `wa_web_sessions` — Session state per user
- `wa_contact_backups` — Backed up contacts
- `wa_group_backups` — Backed up groups
- `wa_web_daily_sends` — Daily send counter
- `wa_backup_log` — Backup history/audit
