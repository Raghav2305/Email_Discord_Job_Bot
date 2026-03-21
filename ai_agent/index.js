// ai_agent/index.js
require('dotenv').config();

const { GoogleGenAI } = require('@google/genai');

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;

if (!GEMINI_API_KEY || GEMINI_API_KEY === 'YOUR_GEMINI_API_KEY_HERE') {
    throw new Error("GEMINI_API_KEY not set in .env file or is a placeholder.");
}

const ai = new GoogleGenAI({ apiKey: GEMINI_API_KEY });

async function processEmailWithAI(emailContent) {
    const prompt = `Analyze the following job-related email. Summarize its content, identify any key actions required from me (e.g., reply, apply, schedule interview), suggest actionable next steps, and propose a plan for responding or acting on this email. Format the output clearly.

Email Content:
"""
${emailContent}
"""

Please provide the output in the following format:
Summary: <summary of the email>
Required Actions: <list of actions, if any>
Suggested Next Steps: <detailed steps>
Proposed Plan: <a plan for how to approach this email>
`;

    try {
        const response = await ai.models.generateContent({
            model: 'gemini-2.5-flash',  // or 'gemini-2.5-flash-latest' for auto-updates
            contents: [{ role: 'user', parts: [{ text: prompt }] }]
        });

        // ← This is the fix
        const text = response.candidates?.[0]?.content?.parts?.[0]?.text || '';

        if (!text) {
            throw new Error('No text generated in response');
        }

        return text;
    } catch (error) {
        console.error('Error processing email with AI:', error);
        // Optional: log more details for debugging
        if (error.message?.includes('candidates') || error.message?.includes('parts')) {
            console.error('→ Response structure issue - check API key/model/quotas');
        }
        return 'Error: Could not process email with AI.';
    }
}

module.exports = {
    processEmailWithAI,
};