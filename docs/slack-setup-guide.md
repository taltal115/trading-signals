# Slack Setup Guide

**Date**: 2026-09-22  
**Status**: Setup Required

---

## Issue

The health check page shows Slack as "Not_configured" because the `SLACK_BOT_TOKEN` environment variable is missing.

---

## Solution

### 1. Get Your Slack Bot Token

You need to obtain a Slack Bot OAuth Token from your Slack workspace:

#### Option A: Existing Slack App
If you already have a Slack app/bot set up for this workspace:

1. Go to [Slack API Apps](https://api.slack.com/apps)
2. Select your app (or create a new one)
3. Go to **OAuth & Permissions** in the left sidebar
4. Copy the **Bot User OAuth Token** (starts with `xoxb-`)

#### Option B: Create New Slack App
If you don't have a Slack app yet:

1. Go to [Slack API Apps](https://api.slack.com/apps)
2. Click **Create New App** → **From scratch**
3. Name it (e.g., "Trading Signals Bot")
4. Select your workspace
5. Go to **OAuth & Permissions**
6. Under **Scopes** → **Bot Token Scopes**, add:
   - `chat:write` (required for posting messages)
   - `channels:read` (for channel name resolution)
   - `channels:join` (for auto-joining channels)
7. Click **Install to Workspace** at the top
8. Authorize the app
9. Copy the **Bot User OAuth Token** (starts with `xoxb-`)

### 2. Get Your Slack Channel ID (Optional but Recommended)

#### Get Channel ID:
1. In Slack Desktop, go to your desired channel (e.g., `#trading-signals`)
2. Click the channel name at the top
3. Scroll down and click **⋮ More** → **Copy channel ID**
4. The ID will look like `C0123456789`

**Note**: You can also use channel names like `#trading-signals`, but channel IDs are more reliable.

### 3. Configure for Local Development

Edit the `.env` file in the repository root:

```bash
# --- In /workspace/.env ---
SLACK_BOT_TOKEN=xoxb-your-token-here
SLACK_CHANNEL=C0123456789
SLACK_BOT_NAME=Trading Signals Bot
```

**Note**: The `.env` file is gitignored and will NOT be committed. Never commit API keys to git.

### 4. Configure for Cursor Cloud Agents

To use Slack in Cloud Agents (for automated runs):

1. Go to [Cursor Dashboard](https://cursor.com/agents) → **Cloud Agents** → **Secrets**
2. Add the following secrets:
   - `SLACK_BOT_TOKEN` = your bot token (from step 1)
   - `SLACK_CHANNEL` = your channel ID (from step 2)
   - `SLACK_BOT_NAME` = your bot name (optional)

These secrets will be injected as environment variables into Cloud Agent VMs.

### 5. Configure for Production (Cloud Run)

For the deployed backend on Cloud Run:

```bash
# Set environment variables via gcloud
gcloud run services update trading-signals-api \
  --region us-central1 \
  --update-env-vars SLACK_BOT_TOKEN=xoxb-your-token-here,SLACK_CHANNEL=C0123456789
```

Or via Cloud Console:
1. Go to Cloud Run → `trading-signals-api`
2. Click **Edit & Deploy New Revision**
3. Under **Variables & Secrets**, add:
   - `SLACK_BOT_TOKEN` = your bot token
   - `SLACK_CHANNEL` = your channel ID
4. Deploy the revision

---

## Testing the Connection

### Test 1: Run the Backend Locally

```bash
cd backend
npm install
npm run start:dev
```

Then check the health endpoint:
```bash
curl http://localhost:3000/api/health/status | jq '.categories[] | select(.name=="Messaging & Notifications")'
```

Expected output:
```json
{
  "name": "Messaging & Notifications",
  "critical": false,
  "integrations": [
    {
      "id": "slack",
      "name": "Slack",
      "key": "SLACK_BOT_TOKEN",
      "status": "healthy",
      "responseTime": 234,
      "lastChecked": "2026-09-22T21:00:00.000Z",
      "message": "OK"
    }
  ]
}
```

### Test 2: Send a Test Message

Use the Python Slack test script:

```bash
cd /workspace
source .venv/bin/activate  # or create venv if needed
python scripts/slack_test.py
```

This should post a test message to your configured channel.

### Test 3: Check the Dashboard

1. Start the backend (see Test 1)
2. Start the frontend:
   ```bash
   cd frontend
   npm install
   npm start
   ```
3. Open http://localhost:4200/health
4. Click the **Refresh** button
5. Verify Slack shows ✅ **Healthy**

---

## Troubleshooting

### "not_configured" Status
- **Cause**: `SLACK_BOT_TOKEN` is not set or is empty
- **Fix**: Set the token in `.env` (local), Cloud Run env vars (production), or Cursor Dashboard secrets (Cloud Agents)

### "Authentication failed" Message
- **Cause**: Invalid or expired bot token
- **Fix**: Regenerate the token in Slack API → OAuth & Permissions → Regenerate Token

### "channel_not_found" Error
- **Cause**: Bot is not a member of the channel, or channel ID/name is wrong
- **Fix**: 
  1. Invite the bot to the channel: `/invite @YourBotName` in Slack
  2. Or use the channel ID (recommended over names)
  3. Ensure bot has `channels:read` and `channels:join` scopes

### "Connection failed" or Timeout
- **Cause**: Network issues or Slack API is down
- **Fix**: 
  1. Check https://status.slack.com/
  2. Verify your network connection
  3. Check firewall rules if running on Cloud Run

---

## Default Configuration

From `config.yaml`:

```yaml
slack:
  enabled: true
  channel: "#trading-signals"
  post_top_n: 5
  min_confidence: 70
  require_ai_passed: true  # Only post BUY signals with ai_gate=passed
```

The environment variables `SLACK_BOT_TOKEN` and `SLACK_CHANNEL` override these settings.

---

## Related Files

- **Backend health check**: `backend/src/health/health.service.ts` (lines 422-450)
- **Python Slack notifier**: `src/signals_bot/notifiers/slack.py`
- **Test script**: `scripts/slack_test.py`
- **Config**: `config.yaml` (slack section, lines 153-160)
- **Environment template**: `.env.example`

---

## Security Notes

- ✅ **DO**: Store tokens in `.env` (gitignored), Cloud Run env vars, or Cursor Dashboard secrets
- ❌ **DON'T**: Commit tokens to git, share them in public channels, or hardcode them in code
- 🔄 **Rotate**: Regenerate tokens periodically for security
- 🔒 **Scope**: Only grant the minimum required OAuth scopes to your Slack app

---

## Next Steps

1. ✅ Get your Slack bot token (see step 1)
2. ✅ Add to `.env` file (for local development)
3. ✅ Add to Cursor Dashboard secrets (for Cloud Agents)
4. ✅ Test the connection (see Testing section)
5. ✅ Refresh the health page to verify ✅ **Healthy** status

---

**Once configured, the Slack connection will show as ✅ Healthy on the health check page.**
