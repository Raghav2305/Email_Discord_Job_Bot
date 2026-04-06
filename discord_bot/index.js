// discord_bot/index.js
require('dotenv').config();
const fs = require('fs').promises;
const path = require('path');
const { Client, GatewayIntentBits, EmbedBuilder } = require('discord.js');
const { authorize, getMessages, createOrGetLabel, addLabelToMessage, markAsRead } = require('../gmail_service');
const { processEmailWithAI } = require('../ai_agent');
const { convert } = require('html-to-text');
const { discordLogger } = require('../logger');
const { labelAndMarkRead, createEmailEmbed, sendDigest, applyPreferences } = require('./scan');

const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
    ],
});

let scanInterval = null;
let botOwner = null; // Will be set when bot is ready
const KEYWORDS_PATH = path.join(process.cwd(), 'keywords.json');
const STATS_PATH = path.join(process.cwd(), 'stats.json');
const SKIPPED_PATH = path.join(process.cwd(), 'skipped_emails.json');
const PREFERENCES_PATH = path.join(process.cwd(), 'preferences.json');

/**
 * Send an error notification to the bot owner via DM.
 * @param {string} errorMessage - The error message to send
 * @param {string} context - Additional context about where the error occurred
 */
async function notifyOwner(errorMessage, context = '') {
    if (!botOwner) {
        discordLogger.warn('Cannot notify owner - bot owner not set');
        return;
    }

    try {
        const dmChannel = await botOwner.createDM();
        const embed = new EmbedBuilder()
            .setColor('#FF0000')
            .setTitle('⚠️ Bot Error Notification')
            .setDescription(`**Error:** ${errorMessage}`)
            .addFields({ name: 'Context', value: context || 'General error' })
            .setTimestamp();

        await dmChannel.send({ embeds: [embed] });
        discordLogger.info('Error notification sent to owner', { context });
    } catch (err) {
        discordLogger.error('Failed to send error notification to owner', { error: err.message });
    }
}

async function getKeywordConfig() {
    try {
        const data = await fs.readFile(KEYWORDS_PATH, 'utf8');
        const config = JSON.parse(data);
        return {
            keywords: config.keywords || [],
            exclude_keywords: config.exclude_keywords || [],
            exclude_senders: config.exclude_senders || [],
        };
    } catch (error) {
        discordLogger.warn('Could not read keywords config', { error: error.message });
        return { keywords: [], exclude_keywords: [], exclude_senders: [] };
    }
}

async function getPreferences() {
    try {
        const data = await fs.readFile(PREFERENCES_PATH, 'utf8');
        return JSON.parse(data);
    } catch (error) {
        discordLogger.warn('Could not read preferences, using defaults');
        return {
            remote_only: false,
            min_salary: null,
            preferred_locations: [],
            auto_reject_categories: ['Informational/Newsletter'],
            min_relevance_score: 5,
            preferred_companies: [],
            blacklist_companies: [],
        };
    }
}

async function savePreferences(prefs) {
    try {
        await fs.writeFile(PREFERENCES_PATH, JSON.stringify(prefs, null, 2));
        return true;
    } catch (error) {
        discordLogger.error('Failed to save preferences', { error: error.message });
        return false;
    }
    
}
     


async function _writeKeywordFile(config) {
    try {
        await fs.writeFile(KEYWORDS_PATH, JSON.stringify(config, null, 2));
    } catch (error) {
        console.error("Error writing keywords config file:", error);
    }
}

async function getStats() {
    try {
        const data = await fs.readFile(STATS_PATH, 'utf8');
        return JSON.parse(data);
    } catch (error) {
        discordLogger.warn('Could not read stats file, using defaults');
        return {
            last_scan_time: null,
            total_scans: 0,
            total_emails_processed: 0,
            total_emails_relevant: 0,
            total_emails_skipped: 0,
            last_error: null,
            last_error_time: null,
        };
    }
}

async function updateStats({ processed, relevant, skipped, error = null }) {
    try {
        const stats = await getStats();
        stats.last_scan_time = new Date().toISOString();
        stats.total_scans++;
        stats.total_emails_processed += processed;
        stats.total_emails_relevant += relevant;
        stats.total_emails_skipped += skipped;
        if (error) {
            stats.last_error = error.message;
            stats.last_error_time = new Date().toISOString();
        }
        await fs.writeFile(STATS_PATH, JSON.stringify(stats, null, 2));
    } catch (err) {
        discordLogger.error('Failed to update stats', { error: err.message });
    }
}

async function addSkippedEmail(emailId, subject, sender, aiResponse) {
    try {
        let skipped = [];
        try {
            const data = await fs.readFile(SKIPPED_PATH, 'utf8');
            skipped = JSON.parse(data);
        } catch (e) {
            // File doesn't exist yet
        }
        skipped.unshift({
            emailId,
            subject,
            sender,
            score: aiResponse.job_relevance_score,
            reason: aiResponse.job_relevance_reason,
            category: aiResponse.job_category,
            timestamp: new Date().toISOString(),
        });
        // Keep only last 50 skipped emails
        skipped = skipped.slice(0, 50);
        await fs.writeFile(SKIPPED_PATH, JSON.stringify(skipped, null, 2));
    } catch (err) {
        discordLogger.error('Failed to track skipped email', { error: err.message });
    }
}

async function getSkippedEmails() {
    try {
        const data = await fs.readFile(SKIPPED_PATH, 'utf8');
        return JSON.parse(data);
    } catch (error) {
        return [];
    }
}

async function clearSkippedEmails() {
    try {
        await fs.writeFile(SKIPPED_PATH, JSON.stringify([], null, 2));
    } catch (err) {
        discordLogger.error('Failed to clear skipped emails', { error: err.message });
    }
}

client.once('ready', async () => {
    discordLogger.info(`Bot logged in as ${client.user.tag}`);

    // Find and store the bot owner (first user in a DM with the bot, or you can hardcode an ID)
    // For now, we'll try to get the owner from the application info
    try {
        const appInfo = await client.application.fetch();
        botOwner = appInfo.owner;
        if (botOwner) {
            discordLogger.info(`Bot owner identified: ${botOwner.tag}`);
        }
    } catch (err) {
        discordLogger.warn('Could not fetch bot owner', { error: err.message });
    }
});

/**
 * Recursively extracts the best plain text content from an email part.
 * Prioritizes text/plain over text/html. Converts HTML to text if only HTML is available.
 * @param {object} part The email part to process.
 * @returns {string} The extracted plain text.
 */
function getTextFromEmailPart(part) {
    if (!part) return '';

    // Decode base64 data
    const decodeBase64 = (data) => Buffer.from(data, 'base64').toString('utf8');

    if (part.mimeType === 'text/plain' && part.body && part.body.data) {
        return decodeBase64(part.body.data);
    }

    if (part.mimeType === 'text/html' && part.body && part.body.data) {
        // Convert HTML to text if no plain text part is found
        return convert(decodeBase64(part.body.data), {
            wordwrap: 130,
        });
    }

    if (part.mimeType.startsWith('multipart/') && part.parts) {
        let plainText = '';
        let htmlText = '';

        for (const subPart of part.parts) {
            if (subPart.mimeType === 'text/plain') {
                plainText += decodeBase64(subPart.body.data);
            } else if (subPart.mimeType === 'text/html') {
                htmlText += decodeBase64(subPart.body.data);
            } else if (subPart.mimeType.startsWith('multipart/')) {
                // Recursive call for nested multipart parts
                const nestedText = getTextFromEmailPart(subPart);
                if (subPart.mimeType.includes('plain')) { // A heuristic to prioritize plain text from nested parts
                    plainText += nestedText;
                } else {
                    htmlText += nestedText;
                }
            }
        }
        return plainText || (htmlText ? convert(htmlText, { wordwrap: 130 }) : '');
    }

    return '';
}

async function scanEmails(channel, maxResults = 5, digestMode = false) {
    if (!channel) {
        discordLogger.error('scanEmails called without a channel');
        return;
    }

    const prefs = await getPreferences();
    await channel.send(`Scanning... (max: ${maxResults}, digest: ${digestMode ? 'ON' : 'OFF'})`);

    try {
        const { keywords, exclude_keywords, exclude_senders } = await getKeywordConfig();

        if (keywords.length === 0 && exclude_keywords.length === 0 && exclude_senders.length === 0) {
            discordLogger.warn('No keywords configured');
            await channel.send('No keywords configured. Use `!add_keyword` to add some.');
            return;
        }

        // Build Gmail query
        const positiveQuery = keywords.length > 0
            ? `(${keywords.map(k => `subject:(${k}) OR from:(${k})`).join(' OR ')})`
            : '';
        const negativeKeywordQuery = exclude_keywords.length > 0
            ? exclude_keywords.map(k => `-subject:(${k}) -from:(${k})`).join(' ')
            : '';
        const negativeSenderQuery = exclude_senders.length > 0
            ? exclude_senders.map(s => `-from:(${s})`).join(' ')
            : '';

        const queryParts = ['is:unread'];
        if (positiveQuery) queryParts.push(positiveQuery);
        if (negativeKeywordQuery) queryParts.push(negativeKeywordQuery);
        if (negativeSenderQuery) queryParts.push(negativeSenderQuery);

        const finalQuery = queryParts.join(' ');
        await channel.send(`Query: \`${finalQuery}\``);

        // Auth and fetch
        let auth;
        try {
            auth = await authorize();
        } catch (authError) {
            discordLogger.error('Gmail auth failed', { error: authError.message });
            await channel.send('Failed to authenticate with Gmail.');
            await notifyOwner('Gmail authorization failed', authError.message);
            return;
        }

        let emails;
        try {
            emails = await getMessages(auth, finalQuery, maxResults);
        } catch (fetchError) {
            discordLogger.error('Failed to fetch emails', { error: fetchError.message });
            await channel.send('Failed to fetch emails from Gmail.');
            await notifyOwner('Failed to fetch emails', fetchError.message);
            return;
        }

        discordLogger.info('Emails fetched', { count: emails.length });

        if (emails.length === 0) {
            await channel.send('No unread emails found.');
            return;
        }

        // Process all emails
        const relevantEmails = [];
        let skippedCount = 0;

        for (const email of emails) {
            discordLogger.info('Processing email', { emailId: email.id });

            const emailBody = getTextFromEmailPart(email.payload);
            if (!emailBody) {
                discordLogger.warn('Could not extract body', { emailId: email.id });
                skippedCount++;
                await labelAndMarkRead(auth, email.id);
                continue;
            }

            const aiResponse = await processEmailWithAI(emailBody);
            if (aiResponse.error) {
                discordLogger.error('AI failed', { emailId: email.id, error: aiResponse.error });
                skippedCount++;
                await labelAndMarkRead(auth, email.id);
                continue;
            }

            // Get email metadata
            const fromHeader = email.payload.headers?.find(h => h.name === 'From');
            const sender = fromHeader ? fromHeader.value : 'Unknown';
            const subjectHeader = email.payload.headers?.find(h => h.name === 'Subject');
            const subject = subjectHeader ? subjectHeader.value : 'No Subject';

            // Apply preferences-based filtering
            const { shouldReject, rejectReason } = applyPreferences(aiResponse, prefs);

            if (shouldReject) {
                discordLogger.info('Skipping (preferences)', { emailId: email.id, reason: rejectReason });
                skippedCount++;
                await addSkippedEmail(email.id, subject, sender, aiResponse);
                await labelAndMarkRead(auth, email.id);
                continue;
            }

            // Email passed all filters
            relevantEmails.push({ email, aiResponse, subject, sender });
            await labelAndMarkRead(auth, email.id);
        }

        // Send results based on mode
        if (digestMode && relevantEmails.length > 0) {
            await sendDigest(channel, relevantEmails);
        } else {
            for (const { aiResponse } of relevantEmails) {
                const embed = createEmailEmbed(aiResponse);
                await channel.send({ embeds: [embed] });
            }
        }

        // Summary
        const summary = `Done! **Relevant:** ${relevantEmails.length} | **Skipped:** ${skippedCount}`;
        discordLogger.info('Scan completed', { relevant: relevantEmails.length, skipped: skippedCount });
        await channel.send(summary);
        await updateStats({ processed: relevantEmails.length, relevant: relevantEmails.length, skipped: skippedCount });

        if (relevantEmails.length === 0) {
            await channel.send('No relevant emails matching your preferences.');
        }

    } catch (error) {
        discordLogger.error('Scan failed', { error: error.message, stack: error.stack });
        await updateStats({ processed: 0, relevant: 0, skipped: 0, error });
        await channel.send(`Error: ${error.message}`);
        await notifyOwner(`Scan failed: ${error.message}`, `Channel: ${channel.id}`);
    }
}

client.on('messageCreate', async message => {
    if (message.author.bot) return;

    // A simple command parser
    const content = message.content.startsWith('!') ? message.content : '';
    const [command, ...args] = content.slice(1).trim().split(/\s+/);


    if (command === 'help') {
        const helpText = [
            '**Email Bot Commands**',
            '',
            '**Scanning**',
            '`!scan_emails [max] [digest]` - Scan now (max: 5, digest: off)',
            '`!start_scan <hours> [max]` - Auto-scan every X hours',
            '`!stop_scan` - Stop automatic scanning',
            '',
            '**Info**',
            '`!status` - Show bot stats',
            '`!preview_skipped [limit]` - View skipped emails',
            '`!clear_skipped` - Clear skipped list',
            '`!prefs` - Show your preferences',
            '',
            '**Keywords**',
            '`!add_keyword <text>` - Add a keyword',
            '`!remove_keyword <text>` - Remove a keyword',
            '',
            '**Preferences**',
            '`!set_pref <name> <value>` - Set a preference',
        ].join('\n');
        await message.channel.send(helpText);
    }

    if (command === 'scan_emails') {
        const maxResults = args[0] ? parseInt(args[0], 10) : 5;
        const digestMode = args[1] === 'digest' || args[1] === 'true';
        if (isNaN(maxResults) || maxResults <= 0) {
            await message.reply('Please provide a valid number for max results.');
            return;
        }
        scanEmails(message.channel, maxResults, digestMode);
    }

    if (command === 'start_scan') {
        if (scanInterval) {
            await message.reply('Automatic scanning is already running.');
            return;
        }
        const intervalHours = args[0] ? parseInt(args[0], 10) : 3;
        const maxResults = args[1] ? parseInt(args[1], 10) : 10;
        if (isNaN(intervalHours) || intervalHours <= 0) {
            await message.reply("Please provide a valid number of hours for the interval.");
            return;
        }
        if (isNaN(maxResults) || maxResults <= 0) {
            await message.reply("Please provide a valid number for max results.");
            return;
        }
        await message.reply(`Starting automatic email scanning every ${intervalHours} hour(s) (max ${maxResults} results per scan).`);
        discordLogger.info('Starting automatic email scanning', { intervalHours, maxResults });
        scanEmails(message.channel, maxResults);
        scanInterval = setInterval(() => scanEmails(message.channel, maxResults), intervalHours * 60 * 60 * 1000);
    }

    if (command === 'stop_scan') {
        if (scanInterval) {
            clearInterval(scanInterval);
            scanInterval = null;
            discordLogger.info('Stopped automatic email scanning');
            await message.reply('Stopped automatic email scanning.');
        } else {
            await message.reply('Automatic scanning is not running.');
        }
    }

    if (command === 'list_keywords') {
        const { keywords, exclude_keywords, exclude_senders } = await getKeywordConfig();
        let reply = '**Current Keywords:**\n';
        if (keywords.length > 0) {
            reply += `**Positive:**\n- ${keywords.join('\n- ')}\n`;
        } else {
            reply += 'No positive keywords configured.\n';
        }
        if (exclude_keywords.length > 0) {
            reply += `**Excluded (keywords):**\n- ${exclude_keywords.join('\n- ')}\n`;
        } else {
            reply += 'No excluded keywords configured.\n';
        }
        if (exclude_senders.length > 0) {
            reply += `**Excluded (senders):**\n- ${exclude_senders.join('\n- ')}\n`;
        } else {
            reply += 'No excluded senders configured.\n';
        }
        await message.channel.send(reply);
    }

    if (command === 'status') {
        const stats = await getStats();
        const lastScan = stats.last_scan_time
            ? new Date(stats.last_scan_time).toLocaleString()
            : 'Never';
        const lastError = stats.last_error
            ? `${stats.last_error} (${new Date(stats.last_error_time).toLocaleString()})`
            : 'None';

        const reply = [
            '**Bot Status**',
            `**Last Scan:** ${lastScan}`,
            `**Total Scans:** ${stats.total_scans}`,
            `**Total Emails Processed:** ${stats.total_emails_processed}`,
            `**Total Relevant:** ${stats.total_emails_relevant}`,
            `**Total Skipped:** ${stats.total_emails_skipped}`,
            `**Last Error:** ${lastError}`,
        ].join('\n');
        await message.channel.send(reply);
    }

    if (command === 'preview_skipped') {
        const skipped = await getSkippedEmails();
        const limit = args[0] ? parseInt(args[0], 10) : 10;

        if (skipped.length === 0) {
            await message.reply('No skipped emails to show.');
            return;
        }

        const toShow = skipped.slice(0, Math.min(limit, skipped.length));

        // Compact format: just title, score/category, and reason
        const lines = [
            `**Recently Skipped Emails** (showing ${toShow.length} of ${skipped.length}):`,
            '',
            ...toShow.map((email, i) => {
                return `**${i + 1}.** ${email.subject}\n   \u2022 Score: ${email.score}/10 (${email.category})\n   \u2022 Reason: ${email.reason}`;
            }),
            '',
            `_Use !clear_skipped to reset_`,
        ];

        const reply = lines.join('\n');

        // Split if still too long
        if (reply.length <= 2000) {
            await message.channel.send(reply);
        } else {
            const mid = Math.floor(reply.length / 2);
            await message.channel.send(reply.slice(0, mid) + '... (continued)');
            await message.channel.send('...(continued)\n\n' + reply.slice(mid));
        }
    }

    if (command === 'clear_skipped') {
        await clearSkippedEmails();
        await message.reply('Cleared the skipped emails list.');
    }

    if (command === 'add_keyword') {
        const keywordToAdd = args.join(" ");
        if (!keywordToAdd) {
            await message.reply("Please provide a keyword to add.");
            return;
        }
        let config = await getKeywordConfig(); // Get full config
        if (!config.keywords.includes(keywordToAdd)) {
            config.keywords.push(keywordToAdd);
            await _writeKeywordFile(config); // Save full config
            await message.reply(`Added keyword: \`${keywordToAdd}\``);
        } else {
            await message.reply(`Keyword already exists: \`${keywordToAdd}\``);
        }
    }

    if (command === 'remove_keyword') {
        const keywordToRemove = args.join(" ");
        if (!keywordToRemove) {
            await message.reply("Please provide a keyword to remove.");
            return;
        }
        let config = await getKeywordConfig();
        const initialLength = config.keywords.length;
        config.keywords = config.keywords.filter(k => k.toLowerCase() !== keywordToRemove.toLowerCase());
        if (config.keywords.length < initialLength) {
            await _writeKeywordFile(config);
            await message.reply(`Removed keyword: \`${keywordToRemove}\``);
        } else {
            await message.reply(`Keyword not found: \`${keywordToRemove}\``);
        }
    }

    if (command === 'prefs') {
        const prefs = await getPreferences();
        const reply = [
            '**Your Preferences**',
            '',
            `**Min Relevance Score:** ${prefs.min_relevance_score}`,
            `**Remote Only:** ${prefs.remote_only ? 'Yes' : 'No'}`,
            `**Min Salary:** ${prefs.min_salary || 'Not set'}`,
            `**Preferred Locations:** ${prefs.preferred_locations.length > 0 ? prefs.preferred_locations.join(', ') : 'Not set'}`,
            `**Auto-Reject Categories:** ${prefs.auto_reject_categories?.join(', ') || 'None'}`,
            `**Blacklisted Companies:** ${prefs.blacklist_companies?.join(', ') || 'None'}`,
            `**Preferred Companies:** ${prefs.preferred_companies?.join(', ') || 'None'}`,
            '',
            '_Use `!set_pref <name> <value>` to change_',
        ].join('\n');
        await message.channel.send(reply);
    }

    if (command === 'set_pref') {
        if (args.length < 2) {
            await message.reply('Usage: `!set_pref <name> <value>`\nExample: `!set_pref remote_only true`');
            return;
        }

        const prefName = args[0];
        const prefValue = args.slice(1).join(' ');
        const prefs = await getPreferences();

        // Validate and set the preference
        switch (prefName) {
            case 'remote_only':
                prefs.remote_only = prefValue.toLowerCase() === 'true';
                break;
            case 'min_relevance_score':
                const score = parseInt(prefValue, 10);
                if (isNaN(score) || score < 0 || score > 10) {
                    await message.reply('Min relevance score must be 0-10.');
                    return;
                }
                prefs.min_relevance_score = score;
                break;
            case 'min_salary':
                if (prefValue.toLowerCase() === 'none' || prefValue === 'null') {
                    prefs.min_salary = null;
                } else {
                    const salary = parseInt(prefValue, 10);
                    if (isNaN(salary)) {
                        await message.reply('Min salary must be a number or "none".');
                        return;
                    }
                    prefs.min_salary = salary;
                }
                break;
            case 'preferred_locations':
                if (prefValue.toLowerCase() === 'none' || prefValue === 'clear') {
                    prefs.preferred_locations = [];
                } else {
                    prefs.preferred_locations = prefValue.split(',').map(s => s.trim());
                }
                break;
            case 'auto_reject_categories':
                if (prefValue.toLowerCase() === 'none' || prefValue === 'clear') {
                    prefs.auto_reject_categories = [];
                } else {
                    prefs.auto_reject_categories = prefValue.split(',').map(s => s.trim());
                }
                break;
            case 'blacklist_companies':
                if (prefValue.toLowerCase() === 'none' || prefValue === 'clear') {
                    prefs.blacklist_companies = [];
                } else {
                    prefs.blacklist_companies = prefValue.split(',').map(s => s.trim());
                }
                break;
            case 'preferred_companies':
                if (prefValue.toLowerCase() === 'none' || prefValue === 'clear') {
                    prefs.preferred_companies = [];
                } else {
                    prefs.preferred_companies = prefValue.split(',').map(s => s.trim());
                }
                break;
            default:
                await message.reply(`Unknown preference: ${prefName}\nValid: remote_only, min_relevance_score, min_salary, preferred_locations, auto_reject_categories, blacklist_companies, preferred_companies`);
                return;
        }

        if (await savePreferences(prefs)) {
            await message.reply(`Set \`${prefName}\` to \`${prefValue}\``);
        } else {
            await message.reply('Failed to save preference.');
        }
    }
});

client.login(process.env.DISCORD_BOT_TOKEN);
