# Email Job to Discord Agent Bot System

This project is a bot that scans your Gmail for job-related emails, uses an AI agent to summarize them and suggest next steps, and sends the information to a Discord channel.

## Architecture

The system will consist of three main components:

1.  **Discord Bot:** A Node.js application using the `discord.js` library to interact with Discord.
2.  **Gmail Service:** A Node.js module that uses the Gmail API to fetch and read emails.
3.  **AI Agent:** A module that uses a large language model (LLM) to process email content, summarize it, and suggest actionable steps.

## Technology Stack

*   **Discord Bot:**
    *   Node.js
    *   `discord.js` library
*   **Gmail Integration:**
    *   Node.js
    *   Google APIs Node.js Client (`googleapis`)
*   **AI Agent:**
    *   Node.js
    *   An LLM API (e.g., Gemini)
    *   `axios` or `node-fetch` for making HTTP requests to the LLM API (will install later if needed)

## Project Structure

```
/
|-- discord_bot/
|   |-- index.js
|   |-- commands/
|   |   |-- scan.js
|-- gmail_service/
|   |-- index.js
|   |-- credentials.json
|   |-- token.json
|-- ai_agent/
|   |-- index.js
|-- .env
|-- package.json
|-- README.md
|-- node_modules/
```

## Setup Instructions

### 1. Discord Bot Setup

1.  Go to the [Discord Developer Portal](https://discord.com/developers/applications).
2.  Create a new application.
3.  Go to the "Bot" tab, click "Add Bot", and confirm.
4.  Copy the bot token and replace `YOUR_DISCORD_BOT_TOKEN_HERE` in your `.env` file with this token.
5.  Under "Privileged Gateway Intents", enable "PRESENCE INTENT", "SERVER MEMBERS INTENT", and "MESSAGE CONTENT INTENT".
6.  Go to the "OAuth2" -> "URL Generator" tab.
7.  Select `bot` scope and the following permissions: `Read Messages/View Channels`, `Send Messages`.
8.  Copy the generated URL and paste it into your browser to invite the bot to your server.

### 2. Google API Credentials Setup

1.  Go to the Google Cloud Console: [https://console.cloud.google.com/](https://console.cloud.google.com/)
2.  Select an existing project or create a new one.
3.  In the navigation menu, go to "APIs & Services" > "Credentials".
4.  Click "CREATE CREDENTIALS" and choose "OAuth client ID".
5.  Select "Desktop app" as the application type and give it a name.
6.  Click "CREATE".
7.  Download the JSON file. Rename it to `credentials.json` and place it in the `gmail_service` directory, replacing the placeholder file.
8.  Ensure that the Gmail API is enabled for your project. You can do this by searching for "Gmail API" in the API Library and enabling it.

### 3. Running the Bot

1.  Make sure you have Node.js installed.
2.  Install dependencies: `npm install`
3.  Update the `.env` file with your Discord bot token and Google API credentials.
4.  Run the Discord bot: `node discord_bot/index.js`
5.  For the first time, when the bot tries to access Gmail, a browser window will open asking you to authorize the application. Follow the prompts.

## Development Todos

*   Implement email fetching logic in `gmail_service/index.js`.
*   Develop the AI agent in `ai_agent/index.js` to summarize emails and suggest actions.
*   Integrate the Gmail service and AI agent with the Discord bot.
*   Add error handling and logging.
*   Implement continuous scanning (e.g., cron job or scheduled task).
