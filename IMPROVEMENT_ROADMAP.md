# Improvement Roadmap

This document outlines recommendations to transform the Email Job to Discord Bot from a prototype into a production-ready product.

---

## Current State Summary

**Core Functionality:**
- Scans Gmail for job-related emails using keyword-based filtering
- Uses Gemini AI to analyze and score email relevance (0-10)
- Sends formatted Discord embeds with summaries, urgency, and action items

**Tech Stack:**
- Node.js with `discord.js`, `googleapis`, `@google/genai`, `html-to-text`
- OAuth2 authentication for Gmail API
- JSON files for configuration (`keywords.json`, `token.json`)

---

## Critical Gaps to Address

### 1. Reliability & Error Handling
- [ ] No retry logic for failed API calls
- [ ] No tracking of processed emails (risk of duplicates)
- [ ] Silent failures on token write errors
- [ ] No health monitoring or uptime tracking

### 2. Security Concerns
- [ ] Credentials stored in `.env` file
- [ ] No rate limiting for Gmail/Gemini APIs
- [ ] No `.env.example` for safe sharing

### 3. User Experience Gaps
- [ ] No visibility into filtered/skipped emails
- [ ] Manual keyword management via Discord commands only
- [ ] No configuration UI
- [ ] No activity logs or history

---

## Feature Recommendations

### High Priority (Make it Usable)

| Feature | Description |
|---------|-------------|
| **Processed email tracking** | Mark emails as read/label after processing to prevent duplicates |
| **Digest mode** | Send one summary every X hours instead of per-email notifications |
| **Web dashboard** | React/Vue UI to manage keywords, view history, adjust settings |
| **Email preview for skipped items** | Show title/sender of low-relevance emails for manual review |
| **Discord action buttons** | "Mark as Done", "Snooze", "View Original" using Discord interactions |

### Medium Priority (Quality of Life)

| Feature | Description |
|---------|-------------|
| **Multiple channel support** | Send urgent emails to one channel, low-priority to another |
| **Email threading** | Group related emails (same conversation) together |
| **Custom AI prompts** | Let users customize AI criteria (e.g., "remote only", "min salary $X") |
| **Keyword suggestions** | AI analyzes processed emails and suggests new keywords |
| **Export functionality** | Export jobs to CSV/Notion/Airtable for tracking |

### Nice-to-Have (Polish)

| Feature | Description |
|---------|-------------|
| **Mobile notifications** | Push via Telegram/WhatsApp for urgent emails |
| **Application tracker integration** | Auto-create entries in Notion/Airtable |
| **Reply-from-Discord** | Send draft replies directly from Discord |
| **Smart scheduling** | Scan only during business hours, pause on weekends |
| **Multi-account support** | Monitor multiple Gmail accounts simultaneously |

---

## Architecture Improvements

### Current Architecture Issues

1. **No database** - No persistence beyond JSON files
2. **Single process** - If bot crashes, scanning stops
3. **No queue system** - Emails processed synchronously
4. **Tight coupling** - All three components are interdependent

### Recommended Target Architecture

```
┌─────────────────────────────────────────────────────────┐
│                     Frontend Layer                      │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐  │
│  │ Discord Bot  │  │ Web Dashboard│  │  Mobile App  │  │
│  └──────────────┘  └──────────────┘  └──────────────┘  │
└─────────────────────────────────────────────────────────┘
                          │
                          ▼
┌─────────────────────────────────────────────────────────┐
│                      API Layer                          │
│  ┌──────────────────────────────────────────────────┐   │
│  │  REST/GraphQL API (Express/Fastify)              │   │
│  └──────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────┘
                          │
                          ▼
┌─────────────────────────────────────────────────────────┐
│                    Background Workers                   │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐  │
│  │ Email Scanner│  │ AI Processor │  │  Notifier    │  │
│  └──────────────┘  └──────────────┘  └──────────────┘  │
└─────────────────────────────────────────────────────────┘
                          │
                          ▼
┌─────────────────────────────────────────────────────────┐
│                      Data Layer                         │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐  │
│  │  PostgreSQL  │  │    Redis     │  │  File Store  │  │
│  │  (Jobs,      │  │   (Queue,    │  │  (Email      │  │
│  │   Users)     │  │   Cache)     │  │   Bodies)    │  │
│  └──────────────┘  └──────────────┘  └──────────────┘  │
└─────────────────────────────────────────────────────────┘
```

### Specific Recommendations

- **SQLite/PostgreSQL** - Persistent storage for processed emails, settings, user preferences
- **Bull/BullMQ + Redis** - Job queuing with retry logic and scheduled scans
- **Docker container** - Easy deployment and environment consistency
- **Health check endpoint** - Monitor bot status

---

## Quick Wins (Low Effort, High Impact)

These can be implemented in a single session:

- [ ] Add `.env.example` with placeholder values
- [ ] Add email labeling - Mark processed emails with "Processed by Bot" label
- [ ] Add scan summary - "Processed X emails, Y relevant, Z skipped"
- [ ] Add error notifications - DM bot owner when API calls fail
- [ ] Add `!status` command - Show last scan time, emails processed, errors
- [ ] Add structured logging - Use `winston` or `pino`
- [ ] Add `!preview_skipped` command - See what got filtered out

---

## Implementation Priority

### Phase 1: Foundation (Week 1)
1. Processed email tracking (mark as read + label)
2. Scan summary and status command
3. Structured logging
4. `.env.example` and security cleanup

### Phase 2: Reliability (Week 2)
1. SQLite database integration
2. Retry logic with exponential backoff
3. Rate limiting for API calls

### Phase 3: User Experience (Week 3)
1. Digest mode
2. Skipped email preview
3. Discord action buttons

### Phase 4: Scaling (Week 4+)
1. Web dashboard
2. Queue system with BullMQ
3. Docker deployment

---

## Top 5 Recommendations to Start

1. **Processed email tracking** - Prevents duplicates, essential for reliability
2. **Digest mode** - Reduces Discord spam, significantly better UX
3. **SQLite database** - Proper persistence, enables all other features
4. **Web dashboard** - Makes configuration actually usable
5. **Retry logic with queue** - Makes it production-reliable

---

## Notes

- Keep the current modular structure (`discord_bot/`, `gmail_service/`, `ai_agent/`)
- Any database should be optional - keep JSON fallback for simple setups
- Consider adding a `CLAUDE.md` file for AI assistant context
