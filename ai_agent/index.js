// ai_agent/index.js
require('dotenv').config();

const { GoogleGenAI } = require('@google/genai');

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;

if (!GEMINI_API_KEY || GEMINI_API_KEY === 'YOUR_GEMINI_API_KEY_HERE') {
    throw new Error("GEMINI_API_KEY not set in .env file or is a placeholder.");
}

const ai = new GoogleGenAI({ apiKey: GEMINI_API_KEY });

async function processEmailWithAI(emailContent) {
    const prompt = `Analyze the following job-related email and respond ONLY with a valid JSON object. Do not add any text before or after the JSON.

The JSON object should have the following structure:
{
  "summary": "A concise, one-paragraph summary of the email's purpose and key content.",
  "extracted_entities": {
    "company_name": "The name of the primary company mentioned, or 'N/A' if not found.",
    "job_title": "The job title mentioned, or 'N/A' if not found.",
    "location": "The job location mentioned, or 'N/A' if not found.",
    "salary": "The salary or compensation mentioned, or 'N/A' if not found."
  },
  "urgency_analysis": {
    "is_urgent": "A boolean (true/false) indicating if the email requires a timely response (e.g., interview invitation, limited-time offer).",
    "reason": "A brief explanation for the urgency."
  },
  "next_action": {
    "category": "Classify the primary action required. Choose one of: 'APPLY', 'SCHEDULE_INTERVIEW', 'REPLY', 'INFO_UPDATE', 'AWAITING_RESPONSE', 'NO_ACTION_NEEDED'.",
    "details": "A detailed, step-by-step plan for the user to take next."
  },
  "draft_reply": {
    "is_needed": "A boolean (true/false) indicating if a reply is recommended.",
    "suggested_text": "If a reply is needed, provide a concise, professional draft. Otherwise, 'N/A'."
  }
}

Email Content:
"""
${emailContent}
"""
`;

    try {
        const response = await ai.models.generateContent({
            model: 'gemini-2.5-flash',  // or 'gemini-2.5-flash-latest' if you prefer auto-updates
            contents: [
                { role: 'user', parts: [{ text: prompt }] }
            ],
            // Optional: force JSON-like behavior (helps a lot with structured output)
            generationConfig: {
                responseMimeType: 'application/json'
            }
        });

        // Safely extract text — this is the standard shape in @google/genai
        let text = response.candidates?.[0]?.content?.parts?.[0]?.text || '';

        if (!text) {
            throw new Error('No content generated in response');
        }

        // Clean common markdown fences the model sometimes adds despite instructions
        text = text.replace(/```json/g, '').replace(/```/g, '').trim();

        // Parse to object
        const structuredResponse = JSON.parse(text);

        return structuredResponse;

    } catch (error) {
        console.error('Error processing email with AI:', error);

        if (error instanceof SyntaxError) {
            return {
                error: "Failed to parse AI response as JSON. The model may have returned malformed output.",
                raw_response: error.message,
                // Optional: you could log the raw text here if you capture it before parse
            };
        }

        return {
            error: 'Could not process email with AI.',
            details: error.message
        };
    }
}

module.exports = {
    processEmailWithAI,
};