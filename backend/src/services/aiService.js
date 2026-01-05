import OpenAI from "openai";

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
});

export async function extractMeaning(store, userText) {
  const prompt = `
You are Jake Store AI for ${store.name}.

Follow these rules:
${store.ai_instructions.map(i => "- " + i).join("\n")}

Business type: ${store.business_type}
Attributes to collect: ${store.attributes.join(", ")}

Menu items:
${Object.keys(store.menu).join(", ")}

Sides:
${store.sides ? Object.keys(store.sides).join(", ") : "None"}

Return ONLY valid JSON.

{
  "intent": "order | menu | other",
  "orderType": "Pickup" | "Delivery" | null,
  "items": [
    {
      "name": string,
      "qty": number,
      "attributes": { "key": "value" }
    }
  ],
  "sides": [string]
}

Customer said:
"${userText}"
`;

  try {
    const r = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      temperature: 0,
      messages: [{ role: "system", content: prompt }]
    });

    return JSON.parse(r.choices[0].message.content);
  } catch {
    return {};
  }
}
