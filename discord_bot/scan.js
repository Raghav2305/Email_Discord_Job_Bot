// Helper functions for email scanning with digest mode and preferences

const { EmbedBuilder } = require('discord.js');
const { discordLogger } = require('../logger');
const { createOrGetLabel, addLabelToMessage, markAsRead } = require('../gmail_service');

/**
 * Label and mark email as read (silently fails if scopes missing)
 */
async function labelAndMarkRead(auth, messageId) {
    try {
        const labelId = await createOrGetLabel(auth, 'Processed by Bot');
        await addLabelToMessage(auth, messageId, labelId);
        await markAsRead(auth, messageId);
        discordLogger.debug('Email labeled and marked as read', { messageId });
    } catch (err) {
        discordLogger.debug('Could not label/mark email', { messageId, error: err.message });
    }
}

/**
 * Creates a Discord embed for an email
 */
function createEmailEmbed(aiResponse) {
    const embed = new EmbedBuilder()
        .setColor(aiResponse.urgency_analysis?.is_urgent ? '#FF4500' : '#0099FF')
        .setTitle(aiResponse.extracted_entities?.job_title || 'Job Opportunity')
        .setAuthor({ name: aiResponse.extracted_entities?.company_name || 'N/A' })
        .setDescription(aiResponse.summary || 'No summary available.')
        .addFields(
            { name: '📍 Location', value: aiResponse.extracted_entities?.location || 'N/A', inline: true },
            { name: '💰 Salary', value: aiResponse.extracted_entities?.salary || 'N/A', inline: true },
            { name: '🔥 Urgency', value: aiResponse.urgency_analysis?.reason || 'N/A', inline: false },
            { name: '📊 Category', value: aiResponse.job_category || 'N/A', inline: true },
            { name: '🎯 Score', value: `${aiResponse.job_relevance_score}/10`, inline: true },
            { name: '▶️ Next Action', value: `**${aiResponse.next_action?.category}**\n${aiResponse.next_action?.details}` },
        )
        .setTimestamp();

    if (aiResponse.draft_reply?.is_needed) {
        embed.addFields({ name: '✉️ Suggested Reply', value: aiResponse.draft_reply.suggested_text });
    }

    return embed;
}

/**
 * Sends a digest of all relevant emails in one message
 */
async function sendDigest(channel, relevantEmails) {
    const urgent = relevantEmails.filter(e => e.aiResponse.urgency_analysis?.is_urgent);
    const normal = relevantEmails.filter(e => !e.aiResponse.urgency_analysis?.is_urgent);

    const lines = [
        '📧 **Job Email Digest**',
        `**${relevantEmails.length} relevant emails found**`,
        '',
    ];

    if (urgent.length > 0) {
        lines.push('🔥 **URGENT**');
        for (const { subject, aiResponse } of urgent) {
            const company = aiResponse.extracted_entities?.company_name || 'Unknown';
            const title = aiResponse.extracted_entities?.job_title || 'N/A';
            lines.push(`• **${title}** at ${company}`);
        }
        lines.push('');
    }

    if (normal.length > 0) {
        lines.push('📌 **NORMAL**');
        for (const { subject, aiResponse } of normal) {
            const company = aiResponse.extracted_entities?.company_name || 'Unknown';
            const title = aiResponse.extracted_entities?.job_title || 'N/A';
            lines.push(`• **${title}** at ${company}`);
        }
    }

    lines.push('');
    lines.push('_Use `!scan_emails` without digest mode to see full details_');

    const digestText = lines.join('\n');

    // Split if too long
    if (digestText.length <= 2000) {
        await channel.send(digestText);
    } else {
        const mid = Math.floor(digestText.length / 2);
        await channel.send(digestText.slice(0, mid) + '... (continued)');
        await channel.send('...(continued)\n\n' + digestText.slice(mid));
    }
}

/**
 * Apply preferences-based filtering to an AI response
 * Returns { shouldReject, rejectReason }
 */
function applyPreferences(aiResponse, prefs) {
    // Check minimum relevance score
    if (aiResponse.job_relevance_score < prefs.min_relevance_score) {
        return {
            shouldReject: true,
            rejectReason: `Low relevance score (${aiResponse.job_relevance_score} < ${prefs.min_relevance_score})`,
        };
    }

    // Check auto-reject categories
    if (prefs.auto_reject_categories?.includes(aiResponse.job_category)) {
        return {
            shouldReject: true,
            rejectReason: `Category '${aiResponse.job_category}' is auto-rejected`,
        };
    }

    // Check blacklist companies
    if (prefs.blacklist_companies?.length > 0) {
        const company = aiResponse.extracted_entities?.company_name?.toLowerCase() || '';
        if (prefs.blacklist_companies.some(c => company.includes(c.toLowerCase()))) {
            return {
                shouldReject: true,
                rejectReason: `Company '${aiResponse.extracted_entities?.company_name}' is blacklisted`,
            };
        }
    }

    // Check min salary (if set and salary was extracted)
    if (prefs.min_salary && aiResponse.extracted_entities?.salary !== 'N/A') {
        const salaryMatch = aiResponse.extracted_entities.salary.match(/(\d+)/);
        if (salaryMatch && parseInt(salaryMatch[1], 10) < prefs.min_salary) {
            return {
                shouldReject: true,
                rejectReason: `Salary below minimum (${aiResponse.extracted_entities.salary})`,
            };
        }
    }

    // Check preferred locations (if set)
    if (prefs.preferred_locations?.length > 0 && aiResponse.extracted_entities?.location !== 'N/A') {
        const location = aiResponse.extracted_entities.location.toLowerCase();
        const isRemote = location.includes('remote');
        const matchesPreferred = prefs.preferred_locations.some(loc => location.includes(loc.toLowerCase()));

        if (prefs.remote_only && !isRemote && !matchesPreferred) {
            return {
                shouldReject: true,
                rejectReason: `Location '${aiResponse.extracted_entities.location}' doesn't match (remote_only: ${prefs.remote_only})`,
            };
        }
    }

    return { shouldReject: false, rejectReason: '' };
}

module.exports = {
    labelAndMarkRead,
    createEmailEmbed,
    sendDigest,
    applyPreferences,
};
