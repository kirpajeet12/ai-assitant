import OpenAI from "openai";

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
});

/**
 * Interpret user intent safely
 * AI does NOT change state
 * AI does NOT reply to user
 */
export async function interpretIntent(userText, session) {
  try {
    const prompt = `
You are an intent classifier for a food ordering voice assistant.

Return ONLY valid JSON.
Do NOT add explanations.
Do NOT add text outside JSON.

Possible intents:
- ASK_MENU
- ORDER_ITEM
- CHANGE_ORDER
- COMPLAINT
- CONFIRM_YES
- CONFIRM_NO
- UNKNOWN

User message:
"${userText}"

JSON format:
{
  "intent": "...",
  "emotion": "neutral | frustrated | angry",
  "confidence": 0.0
}
`;

    const response = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      temperature: 0,
      messages: [
        { role: "system", content: "You classify intent only." },
        { role: "user", content: prompt }
      ]
    });

    const raw = response.choices[0]?.message?.content || "{}";

    // 🔒 HARD SAFETY: parse JSON only
    const parsed = JSON.parse(raw);

    return {
      intent: parsed.intent || "UNKNOWN",
      emotion: parsed.emotion || "neutral",
      confidence: parsed.confidence || 0.5
    };
  } catch (err) {
    console.error("AI intent error:", err);

    // 🔁 FALLBACK: rules-only mode
    return {
      intent: "UNKNOWN",
      emotion: "neutral",
      confidence: 0
    };
  }
}
