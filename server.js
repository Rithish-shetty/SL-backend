import express from 'express'
import cors from 'cors'
import { GoogleGenAI } from '@google/genai'
import 'dotenv/config'

const app = express()

app.use(cors())
app.use(express.json())

const ai = new GoogleGenAI({
    apiKey: process.env.GEMINI_API_KEY
})

// ─────────────────────────────────────────────
// TOKEN LIMIT CONFIG
// ─────────────────────────────────────────────
const PLANS = {
    free: {
        dailyTokenLimit: 3_000,   // ~30K tokens/day for free (ad) users
        label: 'Free'
    },
    pro_monthly: {
        dailyTokenLimit: 100_000,  // ₹149/month
        label: 'Pro Monthly'
    },
}

const WARN_AT_PERCENT = 0.80  // warn at 80% usage

// ─────────────────────────────────────────────
// IN-MEMORY TOKEN TRACKER
// { ip: { date: "2026-03-08", tokensUsed: 1234, plan: "free" } }
// ─────────────────────────────────────────────
const tokenTracker = new Map()

// Clean up old entries every hour to prevent memory leak
setInterval(() => {
    const today = getTodayDate()
    for (const [ip, data] of tokenTracker.entries()) {
        if (data.date !== today) {
            tokenTracker.delete(ip)
        }
    }
}, 60 * 60 * 1000)

function getTodayDate() {
    return new Date().toISOString().split('T')[0] // "2026-03-08"
}

function getClientIP(req) {
    return (
        req.headers['x-forwarded-for']?.split(',')[0]?.trim() ||
        req.headers['x-real-ip'] ||
        req.socket.remoteAddress ||
        'unknown'
    )
}

function getUserPlan(req) {
    // Later: replace this with real plan lookup from Firebase/DB using auth token
    // For now: read from request header (frontend sends it)
    const plan = req.headers['x-user-plan']
    if (plan && PLANS[plan]) return plan
    return 'free'
}

function getTokenRecord(ip) {
    const today = getTodayDate()
    const record = tokenTracker.get(ip)

    // New day or new user → reset
    if (!record || record.date !== today) {
        const fresh = { date: today, tokensUsed: 0, plan: 'free' }
        tokenTracker.set(ip, fresh)
        return fresh
    }
    return record
}

// Estimate tokens roughly before API call (100 chars ≈ 25 tokens)
function estimateTokens(text) {
    return Math.ceil((text?.length || 0) / 4)
}

// ─────────────────────────────────────────────
// CORE MIDDLEWARE: checkTokenLimit
// Call this before every AI route
// ─────────────────────────────────────────────
function checkTokenLimit(estimatedInputTokens = 500) {
    return (req, res, next) => {
        const ip = getClientIP(req)
        const plan = getUserPlan(req)
        const record = getTokenRecord(ip)

        // Update plan on record
        record.plan = plan

        const limit = PLANS[plan].dailyTokenLimit
        const used = record.tokensUsed
        const usagePercent = used / limit

        // ❌ BLOCKED — at or over 100%
        if (used >= limit) {
            const resetTime = getResetTimeMessage()
            return res.status(429).json({
                error: 'limit_reached',
                title: "Daily Limit Reached 🚫",
                message: `You've used all ${limit.toLocaleString()} tokens for today. Your limit resets ${resetTime}.`,
                upgrade_message: plan === 'free'
                    ? "Upgrade to Pro for up to 3x more daily usage — starting at just ₹149/monthS! 🚀"
                    : "Your limit resets at midnight. Come back tomorrow!",
                used,
                limit,
                percent: Math.round(usagePercent * 100),
                resets_at: getResetTimestamp(),
                plan: PLANS[plan].label
            })
        }

        // ⚠️ WARNING — at 80%
        if (usagePercent >= WARN_AT_PERCENT) {
            req.tokenWarning = {
                warning: 'limit_warning',
                title: "Approaching Daily Limit ⚠️",
                message: `You've used ${Math.round(usagePercent * 100)}% of your daily limit (${used.toLocaleString()} / ${limit.toLocaleString()} tokens).`,
                upgrade_message: plan === 'free'
                    ? "Upgrade to Pro to get more daily usage — from ₹149/month! 🚀"
                    : `You have ${(limit - used).toLocaleString()} tokens left today.`,
                used,
                limit,
                percent: Math.round(usagePercent * 100),
                plan: PLANS[plan].label
            }
        }

        next()
    }
}

function getResetTimeMessage() {
    const now = new Date()
    const midnight = new Date()
    midnight.setUTCHours(24, 0, 0, 0)
    const hoursLeft = Math.ceil((midnight - now) / (1000 * 60 * 60))
    return `in ${hoursLeft} hour${hoursLeft !== 1 ? 's' : ''} (midnight UTC)`
}

function getResetTimestamp() {
    const midnight = new Date()
    midnight.setUTCHours(24, 0, 0, 0)
    return midnight.toISOString()
}

function consumeTokens(req, inputTokens, outputTokens) {
    const ip = getClientIP(req)
    const record = getTokenRecord(ip)
    const total = (inputTokens || 0) + (outputTokens || 0)
    record.tokensUsed += total
    console.log(`[Tokens] IP: ${ip} | Plan: ${record.plan} | Used: ${record.tokensUsed} | +${total} this call`)
    return record.tokensUsed
}

// ─────────────────────────────────────────────
// USAGE STATUS ENDPOINT
// Frontend can poll this to show usage bar
// ─────────────────────────────────────────────
app.get('/usage', (req, res) => {
    const ip = getClientIP(req)
    const plan = getUserPlan(req)
    const record = getTokenRecord(ip)
    record.plan = plan

    const limit = PLANS[plan].dailyTokenLimit
    const used = record.tokensUsed
    const percent = Math.round((used / limit) * 100)

    res.json({
        used,
        limit,
        percent,
        remaining: limit - used,
        plan: PLANS[plan].label,
        resets_at: getResetTimestamp(),
        status: used >= limit ? 'blocked' : used / limit >= WARN_AT_PERCENT ? 'warning' : 'ok'
    })
})

// ─────────────────────────────────────────────
// Simple in-memory cache
// ─────────────────────────────────────────────
const responseCache = new Map()

// ─────────────────────────────────────────────
// CHAT ENDPOINT
// ─────────────────────────────────────────────
app.post('/chat', checkTokenLimit(), async (req, res) => {
    try {
        const { message, persona, history = [] } = req.body

        if (!message || !message.trim()) {
            return res.status(400).json({ error: "Message cannot be empty" })
        }

        const contents = [
            { role: 'user', parts: [{ text: persona || 'You are a helpful assistant.' }] },
            { role: 'model', parts: [{ text: 'Understood. I will follow these instructions.' }] },
            ...history.slice(-6).map(msg => ({
                role: msg.role === 'user' ? 'user' : 'model',
                parts: [{ text: msg.content }],
            })),
            { role: 'user', parts: [{ text: message }] },
        ]

        const lastTurn = history.length > 0 ? history[history.length - 1]?.content?.slice(0, 40) : ''
        const cacheKey = `${(persona || '').slice(0, 80)}:${lastTurn}:${message}`

        if (responseCache.has(cacheKey)) {
            const cached = responseCache.get(cacheKey)
            if (Date.now() - cached.timestamp < 300000) {
                console.log(`Cache hit for: ${message.substring(0, 50)}`)
                const response = { reply: cached.reply }
                if (req.tokenWarning) response.token_warning = req.tokenWarning
                return res.json(response)
            }
            responseCache.delete(cacheKey)
        }

        const controller = new AbortController()
        const timeout = setTimeout(() => controller.abort(), 15000)

        try {
            const result = await ai.models.generateContent({
                model: "gemini-2.5-flash-lite",
                contents
            })

            clearTimeout(timeout)

            if (!result || !result.text) {
                throw new Error('No response from AI model')
            }

            const reply = result.text

            // Count actual tokens used
            const inputTokens = result.usageMetadata?.promptTokenCount || estimateTokens(message)
            const outputTokens = result.usageMetadata?.candidatesTokenCount || estimateTokens(reply)
            consumeTokens(req, inputTokens, outputTokens)

            responseCache.set(cacheKey, { reply, timestamp: Date.now() })
            if (responseCache.size > 100) {
                const firstKey = responseCache.keys().next().value
                responseCache.delete(firstKey)
            }

            const response = { reply }
            if (req.tokenWarning) response.token_warning = req.tokenWarning  // attach warning if near limit
            res.json(response)

        } catch (aiError) {
            clearTimeout(timeout)
            throw aiError
        }

    } catch (err) {
        console.error('Chat Error:', err)
        if (err.status === 429 || err.message?.includes('quota')) {
            return res.status(429).json({ error: "Server busy. Please wait a moment and try again." })
        }
        if (err.name === 'AbortError') {
            return res.status(504).json({ error: "Request timeout. Please try again." })
        }
        if (err.status === 401 || err.message?.includes('API key')) {
            return res.status(401).json({ error: "Authentication error." })
        }
        res.status(500).json({ error: "Failed to generate response.", details: err.message })
    }
})

// ─────────────────────────────────────────────
// PROCESS TEXT (Flashcards)
// ─────────────────────────────────────────────
app.post('/process-text', checkTokenLimit(), async (req, res) => {
    try {
        const { text } = req.body

        if (!text || !text.trim()) {
            return res.status(400).json({ error: "No text provided" })
        }

        const prompt = `You are a flashcard generator. Create 5-10 question and answer flashcards from the given text. 
CRITICAL: Respond with ONLY a valid JSON array in this exact format: [{"q":"question here","a":"answer here"}]
No explanatory text, no markdown, no code blocks. Just the raw JSON array.
Text: ${text}`

        const controller = new AbortController()
        const timeout = setTimeout(() => controller.abort(), 20000)

        try {
            const result = await ai.models.generateContent({
                model: "gemini-2.5-flash-lite",
                contents: prompt
            })

            clearTimeout(timeout)

            let content = result.text.trim()
            content = content.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim()
            const jsonMatch = content.match(/\[[\s\S]*\]/)
            if (jsonMatch) content = jsonMatch[0]
            const flashcards = JSON.parse(content)

            if (!Array.isArray(flashcards) || flashcards.length === 0) {
                throw new Error('Invalid flashcards format')
            }

            const inputTokens = result.usageMetadata?.promptTokenCount || estimateTokens(text)
            const outputTokens = result.usageMetadata?.candidatesTokenCount || estimateTokens(content)
            consumeTokens(req, inputTokens, outputTokens)

            const response = { flashcards }
            if (req.tokenWarning) response.token_warning = req.tokenWarning
            res.json(response)

        } catch (aiError) {
            clearTimeout(timeout)
            throw aiError
        }

    } catch (err) {
        console.error('Process-text error:', err)
        res.status(500).json({ error: "Failed to process text", details: err.message })
    }
})

// ─────────────────────────────────────────────
// GENERATE QUIZ
// ─────────────────────────────────────────────
app.post('/generate-quiz', checkTokenLimit(), async (req, res) => {
    try {
        const { topic, fromNotes } = req.body

        if (!topic || !topic.trim()) {
            return res.status(400).json({ error: "No topic provided" })
        }

        const prompt = fromNotes
            ? `You are a quiz generator. Create 5 multiple choice questions based ONLY on the following study notes.
CRITICAL: Respond with ONLY a valid JSON array:
[{"question":"...","options":["...","...","...","..."],"correct":"exact string of correct option"}]
No markdown, no code blocks, no extra text. Just raw JSON.
Notes: ${topic}`
            : `You are a quiz generator. Create 5 multiple choice questions about: ${topic}.
CRITICAL: Respond with ONLY a valid JSON array:
[{"question":"...","options":["...","...","...","..."],"correct":"exact string of correct option"}]
No markdown, no code blocks, no extra text. Just raw JSON.`

        const controller = new AbortController()
        const timeout = setTimeout(() => controller.abort(), 20000)

        try {
            const result = await ai.models.generateContent({
                model: "gemini-2.5-flash-lite",
                contents: [{ role: 'user', parts: [{ text: prompt }] }],
            })

            clearTimeout(timeout)

            let content = result.text.trim()
            content = content.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim()
            const jsonMatch = content.match(/\[[\s\S]*\]/)
            if (jsonMatch) content = jsonMatch[0]
            const questions = JSON.parse(content)

            if (!Array.isArray(questions) || questions.length === 0) {
                throw new Error('AI returned an empty or invalid quiz format')
            }

            const inputTokens = result.usageMetadata?.promptTokenCount || estimateTokens(topic)
            const outputTokens = result.usageMetadata?.candidatesTokenCount || estimateTokens(content)
            consumeTokens(req, inputTokens, outputTokens)

            const response = { questions }
            if (req.tokenWarning) response.token_warning = req.tokenWarning
            res.json(response)

        } catch (aiError) {
            clearTimeout(timeout)
            throw aiError
        }

    } catch (err) {
        console.error('Quiz generation error:', err)
        res.status(500).json({ error: "Failed to generate quiz", details: err.message })
    }
})

// ─────────────────────────────────────────────
// HEALTH CHECK
// ─────────────────────────────────────────────
app.get('/health', (req, res) => {
    res.json({ status: 'ok', timestamp: new Date(), active_ips: tokenTracker.size })
})

const PORT = process.env.PORT || 3001

app.listen(PORT, '0.0.0.0', () => {
    console.log(`Server running at http://192.168.1.9:${PORT}`)
})