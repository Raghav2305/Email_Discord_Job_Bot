// gmail_service/index.js
const fs = require('fs').promises;
const path = require('path');
const process = require('process');
const { authenticate } = require('@google-cloud/local-auth');
const { google } = require('googleapis');

// If modifying these scopes, delete token.json.
const SCOPES = ['https://www.googleapis.com/auth/gmail.readonly'];
// The file token.json stores the user's access and refresh tokens, and is
// created automatically when the authorization flow completes for the first
// time.
const TOKEN_PATH = path.join(process.cwd(), 'gmail_service', 'token.json');
const CREDENTIALS_PATH = path.join(process.cwd(), 'gmail_service', 'credentials.json');

/**
 * Serializes credentials to a file compatible with GoogleAuth.fromJSON.
 *
 * @param {OAuth2Client} client
 * @return {Promise<void>}
 */
async function saveCredentials(client) {
    const payload = JSON.stringify({
        type: 'authorized_user',
        ...client.credentials,
    });
    try {
        await fs.writeFile(TOKEN_PATH, payload);
        console.log('[DEBUG] Credentials saved to token.json. Refresh token present:', !!client.credentials.refresh_token);
    } catch (error) {
        console.error('[DEBUG] Error saving credentials to token.json:', error);
    }
}

/**
 * Reads previously authorized credentials from the save file.
 *
 * @return {Promise<OAuth2Client|null>}
 */
async function authorize() {
    console.log('[DEBUG] Starting authorization process...');

    // Always load client configuration from credentials.json first
    const content = await fs.readFile(CREDENTIALS_PATH);
    const keys = JSON.parse(content);
    const key = keys.installed || keys.web;
    const client_id = key.client_id;
    const client_secret = key.client_secret;
    const redirect_uris = key.redirect_uris;

    const authClient = new google.auth.OAuth2(
        client_id,
        client_secret,
        redirect_uris ? redirect_uris[0] : 'http://localhost'
    );

    // Now try to load saved user tokens (access and refresh tokens)
    let loadedTokens = null;
    try {
        const tokenContent = await fs.readFile(TOKEN_PATH);
        loadedTokens = JSON.parse(tokenContent);
        console.log('[DEBUG] Successfully loaded tokens from token.json');
    } catch (err) {
        console.log('[DEBUG] No saved token file found or error reading token.json:', err.message);
    }

    if (loadedTokens && loadedTokens.refresh_token) {
        // If tokens are loaded and a refresh token is present, set them on the authClient
        authClient.setCredentials(loadedTokens);
        console.log('[DEBUG] Client credentials set from token.json. Attempting to refresh access token if needed...');
        // getAccessToken will refresh the token if expired and update authClient.credentials internally
        await authClient.getAccessToken();
        // Persist the potentially refreshed tokens to token.json
        await saveCredentials(authClient);
        console.log('[DEBUG] Authorization successful using saved credentials.');
        return authClient;
    } else {
        console.log('[DEBUG] No valid saved tokens found or refresh token missing. Initiating new authorization flow...');
        // If no valid saved tokens or refresh token is missing, proceed with new interactive authentication
        const newClient = await authenticate({
            scopes: SCOPES,
            keyfilePath: CREDENTIALS_PATH,
        });
        authClient.setCredentials(newClient.credentials); // Set the newly obtained credentials

        if (authClient.credentials) {
            await saveCredentials(authClient);
            console.log('[DEBUG] Initial authorization successful. Credentials saved.');
        }
        return authClient;
    }
}

/**
 * Lists the labels in the user's account.
 *
 * @param {google.auth.OAuth2} auth An authorized OAuth2 client.
 */
async function listLabels(auth) {
    const gmail = google.gmail({ version: 'v1', auth });
    const res = await gmail.users.labels.list({
        userId: 'me',
    });
    const labels = res.data.labels;
    if (!labels || labels.length === 0) {
        console.log('No labels found.');
        return;
    }
    console.log('Labels:');
    labels.forEach((label) => {
        console.log(`- ${label.name}`);
    });
}

/**
 * Get messages from the user's inbox based on a query.
 *
 * @param {google.auth.OAuth2} auth An authorized OAuth2 client.
 * @param {string} query The search query for emails (e.g., "subject:job application").
 * @return {Promise<Array<Object>>} A list of messages, each with its ID and payload.
 */
async function getMessages(auth, query) {
    const gmail = google.gmail({ version: 'v1', auth });
    const res = await gmail.users.messages.list({
        userId: 'me',
        q: query, // Apply the query here
        maxResults: 3, // Limit the number of messages to fetch for testing
    });
    const messages = res.data.messages;

    if (!messages || messages.length === 0) {
        console.log('No messages found matching the query.');
        return [];
    }

    const emailDetails = [];
    for (const message of messages) {
        const msg = await gmail.users.messages.get({
            userId: 'me',
            id: message.id,
            format: 'full', // Request the full message payload
        });
        emailDetails.push(msg.data);
    }
    return emailDetails;
}

// authorize().then(listLabels).catch(console.error);

module.exports = {
    authorize,
    getMessages,
};
