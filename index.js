import express from 'express';
import { GoogleGenAI } from "@google/genai";
import cors from 'cors';
import multer from 'multer';
import fs from 'fs';
import 'dotenv/config';

const app = express();
const upload = multer({ dest: 'uploads/' });

// Initialize Google Gemini AI with your API key
const ai = new GoogleGenAI({
    apiKey: process.env.GEMINI_API_KEY
});

app.use(cors());
app.use(express.json());

app.post('/chat', async (req, res) => {
    try {
        const { message, persona } = req.body; 
        
        console.log(`Teacher Persona: ${persona ? 'Active' : 'Default'}`);
        console.log("User asked:", message);

        // Create the full prompt with persona
        const fullPrompt = `${persona || "You are a helpful assistant."}\n\nUser: ${message}`;

        const result = await ai.models.generateContent({
            model: "gemini-3-flash-preview",
            contents: fullPrompt  // Fixed: was "constent", should be "contents"
        });

        res.json({ reply: result.text });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: "Gemini API error: " + err.message });
    }
});

// Endpoint for text processing (flashcard generation)
app.post('/process-text', async (req, res) => {
    try {
        const { text } = req.body;
        
        if (!text) {
            return res.status(400).json({ error: "No text provided" });
        }

        console.log('Processing text, length:', text.length);

        const prompt = `You are a flashcard generator. Create 5-10 question and answer flashcards from the given text. 

CRITICAL: You MUST respond with ONLY a valid JSON array in this exact format: [{"q":"question here","a":"answer here"}]

Do not include:
- Any explanatory text before or after the JSON
- Markdown code blocks or backticks
- Any other formatting
Just output the raw JSON array directly. Create flashcards from this text: ${text}`;

        const result = await ai.models.generateContent({
            model: "gemini-3-flash-preview",
            contents: prompt
        });

        let content = result.text.trim();

        console.log('Raw AI response:', content);

        // Clean up the response - remove markdown formatting
        content = content.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
        
        // Try to extract JSON array if response has extra text
        const jsonMatch = content.match(/\[[\s\S]*\]/);
        if (jsonMatch) {
            content = jsonMatch[0];
        }

        console.log('Cleaned content:', content);

        // Parse flashcards
        const flashcards = JSON.parse(content);
        
        if (!Array.isArray(flashcards) || flashcards.length === 0) {
            throw new Error('Invalid flashcards format');
        }

        console.log('Generated flashcards:', flashcards.length);
        res.json({ flashcards });

    } catch (err) {
        console.error('Error details:', err);
        res.status(500).json({ 
            error: "Failed to process text",
            details: err.message 
        });
    }
});

/**
 * Challenge Mode: Quiz Generation Endpoint
 */
app.post('/generate-quiz', async (req, res) => {
    try {
        const { topic } = req.body;
        
        if (!topic) {
            return res.status(400).json({ error: "No topic provided" });
        }

        console.log(`Generating quiz for topic: ${topic}`);

        const prompt = `You are a quiz generator. Create 5 multiple choice questions about the topic: ${topic}. 
CRITICAL: You MUST respond with ONLY a valid JSON array in this exact format: 
[
  {
    "question": "question text here",
    "options": ["option1", "option2", "option3", "option4"],
    "correct": "the exact string of the correct option"
  }
]
Do not include markdown code blocks, backticks, or any explanatory text. Just output the raw JSON array.`;

        const result = await ai.models.generateContent({
            model: "gemini-3-flash-preview", 
            contents: [{ role: 'user', parts: [{ text: prompt }] }],
        });

        let content = result.text.trim();

        console.log('Raw AI Quiz Response:', content);

        // Standard cleanup for AI JSON responses
        content = content.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
        
        // Use Regex to ensure we only get the JSON array portion
        const jsonMatch = content.match(/\[[\s\S]*\]/);
        if (jsonMatch) {
            content = jsonMatch[0];
        }

        const questions = JSON.parse(content);
        
        if (!Array.isArray(questions) || questions.length === 0) {
            throw new Error('AI returned an empty or invalid quiz format');
        }

        console.log(`Successfully generated ${questions.length} questions for ${topic}`);
        res.json({ questions });

    } catch (err) {
        console.error('Quiz Generation Error:', err);
        res.status(500).json({ 
            error: "Failed to generate quiz",
            details: err.message 
        });
    }
});

app.listen(3000, '0.0.0.0', () => {
    console.log('Server is live at http://10.149.35.207:3000');
});