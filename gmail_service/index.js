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
 * Reads previously authorized credentials from the save file.
 *
 * @return {Promise<OAuth2Client|null>}
 */
async function loadSavedCredentialsIfExist() {
    try {
        const content = await fs.readFile(TOKEN_PATH);
        const credentials = JSON.parse(content);
        return google.auth.fromJSON(credentials);
    } catch (err) {
        return null;
    }
}

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
    await fs.writeFile(TOKEN_PATH, payload);
}

/**
 * Load or request authorization to call APIs.
 *
 */
async function authorize() {
    let client = await loadSavedCredentialsIfExist();
    if (client) {
        // Check if the token is expired, and if so, refresh it
        const tokens = await client.getAccessToken();
        client.setCredentials(tokens);
        return client;
    }

    // If no client, or if client is unauthorized, re-authenticate
    const content = await fs.readFile(CREDENTIALS_PATH);
    const keys = JSON.parse(content);
    const key = keys.installed || keys.web;
    const client_id = key.client_id;
    const client_secret = key.client_secret;
    const redirect_uris = key.redirect_uris;

    const authClient = new google.auth.OAuth2(client_id, client_secret, redirect_uris ? redirect_uris[0] : 'http://localhost');

    const newClient = await authenticate({
        scopes: SCOPES,
        keyfilePath: CREDENTIALS_PATH,
    });

    authClient.setCredentials(newClient.credentials);

    if (authClient.credentials) {
        await saveCredentials(authClient);
    }
    return authClient;
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
