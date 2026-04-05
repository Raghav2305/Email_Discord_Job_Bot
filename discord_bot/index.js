// discord_bot/index.js
require('dotenv').config();
const fs = require('fs').promises;
const path = require('path');
const { Client, GatewayIntentBits, EmbedBuilder } = require('discord.js');
const { authorize, getMessages, createOrGetLabel, addLabelToMessage, markAsRead } = require('../gmail_service');
const { processEmailWithAI } = require('../ai_agent');
const { convert } = require('html-to-text');
const { discordLogger } = require('../logger');

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
        console.error("Error reading keywords config file:", error);
        return { keywords: [], exclude_keywords: [], exclude_senders: [] };
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

async function scanEmails(channel, maxResults = 10) {
    if (!channel) {
        discordLogger.error('scanEmails called without a channel');
        return;
    }
    await channel.send(`Scanning emails now... (max: ${maxResults} results)`);
    try {
        const { keywords, exclude_keywords, exclude_senders } = await getKeywordConfig();

        if (keywords.length === 0 && exclude_keywords.length === 0 && exclude_senders.length === 0) {
            discordLogger.warn('No keywords configured for email filtering');
            await channel.send("No keywords configured (positive or negative). Please add keywords using `!add_keyword <keyword>`.");
            return;
        }

        // Build positive query part
        const positiveQuery = keywords.length > 0
            ? `(${keywords.map(k => `subject:(${k}) OR from:(${k})`).join(' OR ')})`
            : '';

        // Build negative query part for keywords
        const negativeKeywordQuery = exclude_keywords.length > 0
            ? exclude_keywords.map(k => `-subject:(${k}) -from:(${k})`).join(' ')
            : '';
        
        // Build negative query part for senders
        const negativeSenderQuery = exclude_senders.length > 0
            ? exclude_senders.map(s => `-from:(${s})`).join(' ')
            : '';

        // Combine all parts into the final query
        let queryParts = ['is:unread'];
        if (positiveQuery) queryParts.push(positiveQuery);
        if (negativeKeywordQuery) queryParts.push(negativeKeywordQuery);
        if (negativeSenderQuery) queryParts.push(negativeSenderQuery);

        const finalQuery = queryParts.join(' ');

        await channel.send(`Using query: \`${finalQuery}\``);

        let auth;
        try {
            auth = await authorize();
        } catch (authError) {
            discordLogger.error('Gmail authorization failed', { error: authError.message });
            await channel.send('Failed to authenticate with Gmail. Please check your credentials.');
            await notifyOwner('Gmail authorization failed', authError.message);
            return;
        }

        let emails;
        try {
            emails = await getMessages(auth, finalQuery, maxResults);
        } catch (fetchError) {
            discordLogger.error('Failed to fetch emails from Gmail', { error: fetchError.message });
            await channel.send('Failed to fetch emails from Gmail.');
            await notifyOwner('Failed to fetch emails from Gmail', fetchError.message);
            return;
        }

        discordLogger.info('Emails fetched from Gmail', { count: emails.length, query: finalQuery });

        if (emails.length === 0) {
            await channel.send('No unread job-related emails found matching your keywords.');
            return;
        }

        discordLogger.debug('Fetched email details', { emails: emails.map(e => ({
            id: e.id,
            subject: e.payload.headers?.find(h => h.name === 'Subject')?.value || 'No Subject'
        })) });

        let processedCount = 0;
        let relevantCount = 0;
        let skippedCount = 0;

        for (const email of emails) {
            discordLogger.info('Processing email', { emailId: email.id });

            const emailBody = getTextFromEmailPart(email.payload);

            if (emailBody) {
                discordLogger.debug('Email body extracted', { emailId: email.id, bodyLength: emailBody.length });
                const aiResponse = await processEmailWithAI(emailBody);

                if (aiResponse.error) {
                    discordLogger.error('AI processing failed', { emailId: email.id, error: aiResponse.error });
                    await channel.send(`Error processing email: ${aiResponse.error}\nRaw Response: \`${aiResponse.raw_response}\``);
                    await notifyOwner(`AI failed to process email: ${aiResponse.error}`, `Email ID: ${email.id}`);
                    continue;
                }

                // AI-driven filtering: Only send to Discord if job_relevance_score is 5 or higher
                const MIN_JOB_RELEVANCE_SCORE = 5;
                if (aiResponse.job_relevance_score < MIN_JOB_RELEVANCE_SCORE) {
                    discordLogger.info('Skipping email - low relevance', {
                        emailId: email.id,
                        score: aiResponse.job_relevance_score,
                        reason: aiResponse.job_relevance_reason
                    });
                    skippedCount++;
                    // Get sender for tracking
                    const fromHeader = email.payload.headers?.find(h => h.name === 'From');
                    const sender = fromHeader ? fromHeader.value : 'Unknown';
                    const subjectHeader = email.payload.headers?.find(h => h.name === 'Subject');
                    const subject = subjectHeader ? subjectHeader.value : 'No Subject';

                    await addSkippedEmail(email.id, subject, sender, aiResponse);
                    await channel.send(`_Skipping an email due to low job relevance score (${aiResponse.job_relevance_score}). Reason: ${aiResponse.job_relevance_reason}_`);

                    // Still label and mark skipped emails as read so they're not reprocessed
                    try {
                        const labelId = await createOrGetLabel(auth, 'Processed by Bot');
                        await addLabelToMessage(auth, email.id, labelId);
                        await markAsRead(auth, email.id);
                        discordLogger.debug('Skipped email labeled and marked as read', { emailId: email.id });
                    } catch (labelError) {
                        discordLogger.warn('Failed to label/mark skipped email', { emailId: email.id, error: labelError.message });
                    }
                    continue;
                }

                relevantCount++;

                // Label the email as processed and mark as read
                try {
                    const labelId = await createOrGetLabel(auth, 'Processed by Bot');
                    await addLabelToMessage(auth, email.id, labelId);
                    await markAsRead(auth, email.id);
                    discordLogger.debug('Email labeled and marked as read', { emailId: email.id });
                } catch (labelError) {
                    discordLogger.warn('Failed to label/mark email', { emailId: email.id, error: labelError.message });
                }

                const embed = new EmbedBuilder()
                    .setColor(aiResponse.urgency_analysis?.is_urgent ? '#FF4500' : '#0099FF')
                    .setTitle(aiResponse.extracted_entities?.job_title || 'Job Opportunity')
                    .setAuthor({ name: aiResponse.extracted_entities?.company_name || 'N/A' })
                    .setDescription(aiResponse.summary || 'No summary available.')
                    .addFields(
                        { name: '📍 Location', value: aiResponse.extracted_entities?.location || 'N/A', inline: true },
                        { name: '💰 Salary', value: aiResponse.extracted_entities?.salary || 'N/A', inline: true },
                        { name: '🔥 Urgency', value: aiResponse.urgency_analysis?.reason || 'N/A', inline: false },
                        { name: '📊 AI Job Category', value: aiResponse.job_category || 'N/A', inline: false },
                        { name: '🎯 AI Relevance Score', value: `${aiResponse.job_relevance_score}/10 (${aiResponse.job_relevance_reason || 'No reason provided'})`, inline: false },
                        { name: '▶️ Next Action', value: `**Category:** ${aiResponse.next_action?.category}\n**Details:** ${aiResponse.next_action?.details}` },
                    )
                    .setTimestamp();


                
                if (aiResponse.draft_reply?.is_needed) {
                    embed.addFields({ name: '✉️ Suggested Reply', value: aiResponse.draft_reply.suggested_text });
                }

                await channel.send({ embeds: [embed] });
                processedCount++;
            } else {
                discordLogger.warn('Could not extract plaintext body', { emailId: email.id });
                skippedCount++;
            }
        }

        const summary = `Scan complete! **Processed:** ${processedCount} | **Relevant:** ${relevantCount} | **Skipped:** ${skippedCount}`;
        discordLogger.info('Email scan completed', { processed: processedCount, relevant: relevantCount, skipped: skippedCount });
        await channel.send(summary);
        await updateStats({ processed: processedCount, relevant: relevantCount, skipped: skippedCount });
        await channel.send('Finished scanning job-related emails.');

    } catch (error) {
        discordLogger.error('Error during email scan', { error: error.message, stack: error.stack });
        await updateStats({ processed: 0, relevant: 0, skipped: 0, error });
        await channel.send(`An error occurred while scanning emails: ${error.message}`);
        await notifyOwner(`Email scan failed: ${error.message}`, `Channel: ${channel.id}, Query: ${finalQuery || 'N/A'}`);
    }
}

client.on('messageCreate', async message => {
    if (message.author.bot) return;

    // A simple command parser
    const content = message.content.startsWith('!') ? message.content : '';
    const [command, ...args] = content.slice(1).trim().split(/\s+/);


    if (command === 'scan_emails') {
        const maxResults = args[0] ? parseInt(args[0], 10) : 10;
        if (isNaN(maxResults) || maxResults <= 0) {
            await message.reply("Please provide a valid number for max results.");
            return;
        }
        scanEmails(message.channel, maxResults);
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
        let config = await getKeywordConfig(); // Get full config
        const initialLength = config.keywords.length;
        config.keywords = config.keywords.filter(k => k.toLowerCase() !== keywordToRemove.toLowerCase());
        if (config.keywords.length < initialLength) {
            await _writeKeywordFile(config); // Save full config
            await message.reply(`Removed keyword: \`${keywordToRemove}\``);
        } else {
            await message.reply(`Keyword not found: \`${keywordToRemove}\``);
        }
    }
});

client.login(process.env.DISCORD_BOT_TOKEN);
