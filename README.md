# Email Job to Discord Agent Bot System

A smart bot that scans your Gmail for job-related emails, uses AI to analyze and score their relevance, and sends formatted notifications to Discord with summaries and actionable next steps.

---

## Features

### Core Functionality
- **Gmail Integration** - Scans unread emails using customizable keyword filters
- **AI-Powered Analysis** - Uses Google Gemini to analyze emails and extract:
  - Company name, job title, location, salary
  - Urgency assessment
  - Job relevance score (0-10)
  - Suggested next actions
  - Draft replies
- **Smart Filtering** - Only shows emails with relevance score ≥5/10 to reduce noise
- **Discord Notifications** - Rich embeds with color-coded urgency (orange = urgent, blue = normal)
- **Email Labeling** - Automatically labels processed emails and marks them as read

### Bot Commands

| Command | Description |
|---------|-------------|
| `!help` | Show all available commands |
| `!scan_emails [max]` | Scan emails now (default: 5 results) |
| `!start_scan <hours> [max]` | Auto-scan every X hours |
| `!stop_scan` | Stop automatic scanning |
| `!status` | Show bot statistics |
| `!preview_skipped [limit]` | View recently skipped emails |
| `!clear_skipped` | Clear skipped emails list |
| `!list_keywords` | Show all configured keywords |
| `!add_keyword <text>` | Add a new keyword |
| `!remove_keyword <text>` | Remove a keyword |

### Additional Features
- **Structured Logging** - All activity logged to `/logs/` with winston
- **Error Notifications** - Bot owner receives DMs on critical failures
- **Stats Tracking** - Persistent statistics in `stats.json`
- **Skipped Email History** - Last 50 skipped emails tracked for review
- **Configurable Limits** - Control max results per scan to avoid spam

---

## Architecture

```
┌─────────────────┐     ┌─────────────────┐     ┌─────────────────┐
│   Discord Bot   │────▶│   Gmail Service │────▶│    AI Agent     │
│   (discord.js)  │     │   (googleapis)  │     │   (Gemini API)  │
└─────────────────┘     └─────────────────┘     └─────────────────┘
        │                       │                       │
        ▼                       ▼                       ▼
   Discord Server          Gmail API            AI Analysis &
   Notifications           (OAuth2)               Scoring
```

### Tech Stack
- **Runtime:** Node.js
- **Discord:** `discord.js` v14
- **Gmail:** `googleapis`, `@google-cloud/local-auth`
- **AI:** `@google/genai` (Gemini 3.1 Flash Lite)
- **Logging:** `winston`
- **Utilities:** `html-to-text`, `dotenv`

---

## Setup Instructions

### 1. Discord Bot Setup

1. Go to [Discord Developer Portal](https://discord.com/developers/applications)
2. Create a new application
3. Go to **Bot** → **Add Bot**
4. Copy the bot token to `.env`
5. Enable these under **Privileged Gateway Intents**:
   - PRESENCE INTENT
   - SERVER MEMBERS INTENT
   - MESSAGE CONTENT INTENT
6. Go to **OAuth2** → **URL Generator**
   - Select `bot` scope
   - Add permissions: `Read Messages`, `Send Messages`
7. Use the generated URL to invite the bot

### 2. Google API Credentials

1. Go to [Google Cloud Console](https://console.cloud.google.com/)
2. Create/select a project
3. Enable **Gmail API**
4. Go to **APIs & Services** → **Credentials**
5. Create **OAuth Client ID** → Desktop app
6. Download JSON, rename to `credentials.json`, place in `gmail_service/`

### 3. Gemini API Key

1. Go to [Google AI Studio](https://aistudio.google.com/apikey)
2. Create an API key
3. Add to `.env`

### 4. Environment Setup

1. Copy `.env.example` to `.env`
2. Fill in your credentials:
   ```
   DISCORD_BOT_TOKEN=your_token_here
   GOOGLE_CLIENT_ID=your_client_id
   GOOGLE_CLIENT_SECRET=your_client_secret
   GOOGLE_REDIRECT_URI=http://localhost
   GEMINI_API_KEY=your_api_key
   ```

### 5. Install & Run

```bash
npm install
node discord_bot/index.js
```

On first run, a browser window will open to authorize Gmail access.

---

## Configuration

### Keywords (`keywords.json`)

```json
{
  "keywords": ["job application", "interview", "linkedin", "recruiter"],
  "exclude_keywords": ["order", "newsletter", "promotion"],
  "exclude_senders": ["noreply@zomato.com"]
}
```

### Adjusting Scan Limits

- Default: 5 emails per scan
- Change via command: `!scan_emails 10`
- Or modify default in `gmail_service/index.js`

---

## Project Structure

```
/
├── discord_bot/
│   └── index.js          # Main bot with commands
├── gmail_service/
│   ├── index.js          # Gmail API integration
│   ├── credentials.json  # OAuth2 config (gitignored)
│   └── token.json        # User tokens (gitignored)
├── ai_agent/
│   └── index.js          # Gemini AI processor
├── logger.js             # Centralized winston logging
├── keywords.json         # Filter configuration
├── stats.json            # Bot statistics
├── skipped_emails.json   # Skipped email history
├── .env                  # Environment variables
├── .env.example          # Template for .env
├── package.json
└── logs/                 # Log files (gitignored)
```

---

## Future Scope / Roadmap

See `IMPROVEMENT_ROADMAP.md` for detailed plans. Planned enhancements:

### Phase 1: Foundation
- [x] Processed email tracking (labeling)
- [x] Scan summary
- [x] Structured logging
- [x] `.env.example`

### Phase 2: Reliability
- [ ] SQLite database for persistence
- [ ] Retry logic with exponential backoff
- [ ] Rate limiting for API calls

### Phase 3: User Experience
- [ ] Digest mode (batch notifications)
- [ ] Discord action buttons on embeds
- [ ] Web dashboard for configuration

### Phase 4: Scaling
- [ ] Queue system (BullMQ + Redis)
- [ ] Multi-account support
- [ ] Application tracker integration (Notion/Airtable)
- [ ] Mobile notifications (Telegram/WhatsApp)

---

## Troubleshooting

### "Insufficient authentication scopes" error
Delete `gmail_service/token.json` and restart the bot to re-authorize with the new `gmail.modify` scope.

### "No messages found"
Check your keywords in `keywords.json` and ensure you have unread emails matching them.

### Discord API errors
Ensure MESSAGE CONTENT INTENT is enabled in Discord Developer Portal.

---


