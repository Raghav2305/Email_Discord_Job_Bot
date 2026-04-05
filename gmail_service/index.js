// gmail_service/index.js
const fs = require('fs').promises;
const path = require('path');
const process = require('process');
const { authenticate } = require('@google-cloud/local-auth');
const { google } = require('googleapis');
const { gmailLogger } = require('../logger');

// If modifying these scopes, delete token.json.
// Using gmail.modify instead of gmail.readonly to allow labeling and marking emails as read
const SCOPES = ['https://www.googleapis.com/auth/gmail.modify'];
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
        gmailLogger.info('Credentials saved to token.json', { hasRefreshToken: !!client.credentials.refresh_token });
    } catch (error) {
        gmailLogger.error('Error saving credentials to token.json', { error: error.message });
    }
}

/**
 * Reads previously authorized credentials from the save file.
 *
 * @return {Promise<OAuth2Client|null>}
 */
async function authorize() {
    gmailLogger.info('Starting authorization process...');

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
        gmailLogger.info('Successfully loaded tokens from token.json');
    } catch (err) {
        gmailLogger.info('No saved token file found or error reading token.json', { error: err.message });
    }

    if (loadedTokens && loadedTokens.refresh_token) {
        authClient.setCredentials(loadedTokens);
        gmailLogger.info('Client credentials set from token.json, refreshing access token if needed...');
        await authClient.getAccessToken();
        await saveCredentials(authClient);
        gmailLogger.info('Authorization successful using saved credentials.');
        return authClient;
    } else {
        gmailLogger.info('No valid saved tokens found, initiating new authorization flow...');
        const newClient = await authenticate({
            scopes: SCOPES,
            keyfilePath: CREDENTIALS_PATH,
        });
        authClient.setCredentials(newClient.credentials);

        if (authClient.credentials) {
            await saveCredentials(authClient);
            gmailLogger.info('Initial authorization successful, credentials saved.');
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
        gmailLogger.info('No labels found.');
        return;
    }
    gmailLogger.info('Labels retrieved', { count: labels.length });
    labels.forEach((label) => {
        gmailLogger.debug(`- ${label.name}`);
    });
}

/**
 * Get messages from the user's inbox based on a query.
 *
 * @param {google.auth.OAuth2} auth An authorized OAuth2 client.
 * @param {string} query The search query for emails (e.g., "subject:job application").
 * @param {number} maxResults Maximum number of messages to return (default: 10, max: 500).
 * @return {Promise<Array<Object>>} A list of messages, each with its ID and payload.
 */
async function getMessages(auth, query, maxResults = 5) {
    const gmail = google.gmail({ version: 'v1', auth });
    const res = await gmail.users.messages.list({
        userId: 'me',
        q: query,
        maxResults: Math.min(maxResults, 500), // Gmail API max is 500
    });
    const messages = res.data.messages;

    if (!messages || messages.length === 0) {
        gmailLogger.info('No messages found matching the query', { query });
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

/**
 * Creates or gets a label in the user's Gmail account.
 *
 * @param {google.auth.OAuth2} auth An authorized OAuth2 client.
 * @param {string} labelName The name of the label to create.
 * @return {Promise<string>} The label ID.
 */
async function createOrGetLabel(auth, labelName) {
    const gmail = google.gmail({ version: 'v1', auth });

    // First, try to find existing label
    const res = await gmail.users.labels.list({ userId: 'me' });
    const existingLabel = res.data.labels?.find(label => label.name === labelName);

    if (existingLabel) {
        gmailLogger.info('Found existing label', { labelName, labelId: existingLabel.id });
        return existingLabel.id;
    }

    // Create new label
    try {
        const createRes = await gmail.users.labels.create({
            userId: 'me',
            requestBody: {
                name: labelName,
                labelListVisibility: 'labelShow',
                messageListVisibility: 'show',
            },
        });
        gmailLogger.info('Created new Gmail label', { labelName, labelId: createRes.data.id });
        return createRes.data.id;
    } catch (error) {
        gmailLogger.error('Failed to create Gmail label', { labelName, error: error.message });
        throw error;
    }
}

/**
 * Adds a label to a specific email message.
 *
 * @param {google.auth.OAuth2} auth An authorized OAuth2 client.
 * @param {string} messageId The message ID to label.
 * @param {string} labelId The label ID to add.
 */
async function addLabelToMessage(auth, messageId, labelId) {
    const gmail = google.gmail({ version: 'v1', auth });

    try {
        await gmail.users.messages.modify({
            userId: 'me',
            id: messageId,
            requestBody: {
                addLabelIds: [labelId],
            },
        });
        gmailLogger.debug('Label added to message', { messageId, labelId });
    } catch (error) {
        gmailLogger.error('Failed to add label to message', { messageId, labelId, error: error.message });
        throw error;
    }
}

/**
 * Marks a message as read by removing the UNREAD label.
 *
 * @param {google.auth.OAuth2} auth An authorized OAuth2 client.
 * @param {string} messageId The message ID to mark as read.
 */
async function markAsRead(auth, messageId) {
    const gmail = google.gmail({ version: 'v1', auth });

    try {
        await gmail.users.messages.modify({
            userId: 'me',
            id: messageId,
            requestBody: {
                removeLabelIds: ['UNREAD'],
            },
        });
        gmailLogger.debug('Message marked as read', { messageId });
    } catch (error) {
        gmailLogger.error('Failed to mark message as read', { messageId, error: error.message });
        throw error;
    }
}

module.exports = {
    authorize,
    getMessages,
    createOrGetLabel,
    addLabelToMessage,
    markAsRead,
};
