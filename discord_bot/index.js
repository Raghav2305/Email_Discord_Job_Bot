// discord_bot/index.js
require('dotenv').config();
const { Client, GatewayIntentBits } = require('discord.js');
const { authorize, getMessages } = require('../gmail_service');
const { processEmailWithAI } = require('../ai_agent');

const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
    ],
});

client.once('ready', () => {
    console.log(`Logged in as ${client.user.tag}!`);
});

client.on('messageCreate', async message => {
    if (message.author.bot) return;

    if (message.content === '!scan_emails') {
        await message.reply('Scanning emails now...');
        try {
            const auth = await authorize();
            const emails = await getMessages(auth, 'is:unread subject:"job application" OR subject:"interview" OR subject:"job offer" OR from:linkedin.com');

            if (emails.length === 0) {
                await message.channel.send('No unread job-related emails found.');
                return;
            }

            for (const email of emails) {
                // Extract plaintext body
                let emailBody = '';
                if (email.payload && email.payload.parts) {
                    const part = email.payload.parts.find(p => p.mimeType === 'text/plain');
                    if (part && part.body && part.body.data) {
                        emailBody = Buffer.from(part.body.data, 'base64').toString('utf8');
                    }
                } else if (email.payload && email.payload.body && email.payload.body.data) {
                    emailBody = Buffer.from(email.payload.body.data, 'base64').toString('utf8');
                }

                if (emailBody) {
                    const aiResponse = await processEmailWithAI(emailBody);

                    // Split the response if it's too long for a single Discord message
                    const maxChunkSize = 1900;
                    if (aiResponse.length > maxChunkSize) {
                        await message.channel.send(`**Subject:** ${email.payload.headers.find(h => h.name === 'Subject').value}\n**From:** ${email.payload.headers.find(h => h.name === 'From').value}\n\n---`);
                        for (let i = 0; i < aiResponse.length; i += maxChunkSize) {
                            const chunk = aiResponse.substring(i, i + maxChunkSize);
                            await message.channel.send(chunk);
                        }
                    } else {
                        await message.channel.send(`**Subject:** ${email.payload.headers.find(h => h.name === 'Subject').value}\n**From:** ${email.payload.headers.find(h => h.name === 'From').value}\n\n${aiResponse}\n\n---`);
                    }
                }
            }
            await message.channel.send('Finished scanning job-related emails.');

        } catch (error) {
            console.error('Error during email scan:', error);
            await message.channel.send(`An error occurred while scanning emails: ${error.message}`);
        }
    }
});

client.login(process.env.DISCORD_BOT_TOKEN);
