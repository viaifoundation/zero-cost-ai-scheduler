import { Hono } from 'hono'

type Env = {
  CHAT_HISTORY: KVNamespace
  CAL_API_KEY: string
  GROQ_API_KEY: string
  MISTRAL_API_KEY?: string
}

const app = new Hono<{ Bindings: Env }>()

// Simple health check
app.get('/', (c) => c.text('Zero-Cost AI Scheduler Backend – Running!'))

// Main chat endpoint
app.post('/api/chat', async (c) => {
  const { message, sessionId = 'default', userTimezone = 'UTC' } = await c.req.json()

  if (!message || typeof message !== 'string') {
    return c.json({ error: 'Message is required' }, 400)
  }

  const kv = c.env.CHAT_HISTORY

  // Load conversation history
  const historyKey = `chat:${sessionId}`
  const rawHistory = await kv.get(historyKey)
  const history = rawHistory ? JSON.parse(rawHistory) : []

  // Inject current time context (critical for temporal reasoning)
  const now = new Date()
  const utcTime = now.toISOString()
  const userTime = now.toLocaleString('en-US', { timeZone: userTimezone })

  const systemPrompt = `You are a helpful scheduling assistant.
Current UTC time: ${utcTime}
User timezone: ${userTimezone}
User local time: ${userTime}

You can check availability and book meetings using Cal.com.
Respond naturally but when action is needed, output structured JSON only.

Available actions:
- check_availability: { startWindow: string (ISO date), endWindow: string (ISO date) }
- book_meeting: { start: string (ISO), end: string (ISO), name: string, email: string, title?: string }

If you need more info from the user, ask conversationally.`

  // Build messages for Groq
  const messages = [
    { role: 'system', content: systemPrompt },
    ...history,
    { role: 'user', content: message }
  ]

  // Call Groq (Llama 3 70B)
  const groqResponse = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${c.env.GROQ_API_KEY}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      model: 'llama3-70b-8192',
      messages,
      temperature: 0.7,
      max_tokens: 1024
    })
  })

  if (!groqResponse.ok) {
    // Fallback to Mistral (if key exists)
    if (c.env.MISTRAL_API_KEY) {
      // Implement Mistral fallback here later
    }
    return c.json({ error: 'Inference failed' }, 500)
  }

  const groqData = await groqResponse.json()
  const assistantMessage = groqData.choices[0]?.message?.content || 'Sorry, I could not respond.'

  // Save updated history
  const updatedHistory = [...history, { role: 'user', content: message }, { role: 'assistant', content: assistantMessage }]
  await kv.put(historyKey, JSON.stringify(updatedHistory), { expirationTtl: 86400 }) // 24h TTL

  return c.json({
    response: assistantMessage,
    sessionId
  })
})

export default app