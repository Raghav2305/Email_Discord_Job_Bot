// discord_bot/index.js
require('dotenv').config();
const fs = require('fs').promises;
const path = require('path');
const { Client, GatewayIntentBits, EmbedBuilder } = require('discord.js');
const { authorize, getMessages } = require('../gmail_service');
const { processEmailWithAI } = require('../ai_agent');
const { convert } = require('html-to-text'); // Import html-to-text

const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
    ],
});

let scanInterval = null;
const KEYWORDS_PATH = path.join(process.cwd(), 'keywords.json');

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

client.once('ready', () => {
    console.log(`Logged in as ${client.user.tag}!`);
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

async function scanEmails(channel) {
    if (!channel) {
        console.error("ScanEmails was called without a channel.");
        return;
    }
    await channel.send('Scanning emails now...');
    try {
        const { keywords, exclude_keywords, exclude_senders } = await getKeywordConfig();

        if (keywords.length === 0 && exclude_keywords.length === 0 && exclude_senders.length === 0) {
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

        const auth = await authorize();
        const emails = await getMessages(auth, finalQuery);

        console.log(`[DIAGNOSTIC] Found ${emails.length} email(s) matching the query.`);

        if (emails.length === 0) {
            await channel.send('No unread job-related emails found matching your keywords.');
            return;
        }

        console.log('[DEBUG] Fetched Email Details:');
        emails.forEach(email => {
            const subjectHeader = email.payload.headers.find(header => header.name === 'Subject');
            const subject = subjectHeader ? subjectHeader.value : 'No Subject';
            console.log(`- ID: ${email.id}, Subject: "${subject}"`);
        });

        for (const email of emails) {
            console.log(`[DIAGNOSTIC] Processing email ID: ${email.id}`);
            
            const emailBody = getTextFromEmailPart(email.payload);

            if (emailBody) {
                console.log(`[DIAGNOSTIC] Successfully extracted email body for ID: ${email.id}`);
                const aiResponse = await processEmailWithAI(emailBody);

                if (aiResponse.error) {
                    await channel.send(`Error processing email: ${aiResponse.error}\nRaw Response: \`${aiResponse.raw_response}\``);
                    continue;
                }

                // AI-driven filtering: Only send to Discord if job_relevance_score is 5 or higher
                const MIN_JOB_RELEVANCE_SCORE = 5;
                if (aiResponse.job_relevance_score < MIN_JOB_RELEVANCE_SCORE) {
                    console.log(`[DIAGNOSTIC] Skipping email ID: ${email.id} due to low job relevance score (${aiResponse.job_relevance_score}). Reason: ${aiResponse.job_relevance_reason}`);
                    await channel.send(`_Skipping an email due to low job relevance score (${aiResponse.job_relevance_score}). Reason: ${aiResponse.job_relevance_reason}_`);
                    continue; // Skip sending this email to Discord
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
            } else {
                 console.log(`[DIAGNOSTIC] Could not extract plaintext body for email ID: ${email.id}. Skipping.`);
            }
        }
        await channel.send('Finished scanning job-related emails.');

    } catch (error) {
        console.error('Error during email scan:', error);
        await channel.send(`An error occurred while scanning emails: ${error.message}`);
    }
}

client.on('messageCreate', async message => {
    if (message.author.bot) return;

    // A simple command parser
    const content = message.content.startsWith('!') ? message.content : '';
    const [command, ...args] = content.slice(1).trim().split(/\s+/);


    if (command === 'scan_emails') {
        scanEmails(message.channel);
    }

    if (command === 'start_scan') {
        if (scanInterval) {
            await message.reply('Automatic scanning is already running.');
            return;
        }
        const intervalHours = args[0] ? parseInt(args[0], 10) : 3;
        if (isNaN(intervalHours) || intervalHours <= 0) {
            await message.reply("Please provide a valid number of hours for the interval.");
            return;
        }
        await message.reply(`Starting automatic email scanning every ${intervalHours} hour(s).`);
        scanEmails(message.channel); // Scan immediately on start
        scanInterval = setInterval(() => scanEmails(message.channel), intervalHours * 60 * 60 * 1000);
    }

    if (command === 'stop_scan') {
        if (scanInterval) {
            clearInterval(scanInterval);
            scanInterval = null;
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
