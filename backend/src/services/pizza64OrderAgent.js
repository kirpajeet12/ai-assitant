import OpenAI from "openai";
import { env } from "../config/env.js";

const openai = new OpenAI({
  apiKey: env.openai.apiKey,
});

// Small demo menu. You can expand with real Pizza 64 items later.
const PIZZA64_MENU = {
  currency: "CAD",
  items: [
    {
      sku: "CHEESE_LOVERS_MED",
      name: "Cheese Lovers Pizza",
      category: "Specialty Pizza",
      basePrice: 14.99,
      sizes: ["small", "medium", "large"],
    },
    {
      sku: "HAWAIIAN_MED",
      name: "Hawaiian Pizza",
      category: "Specialty Pizza",
      basePrice: 16.25,
      sizes: ["small", "medium", "large"],
    },
    {
      sku: "TANDOORI_CHICKEN_MED",
      name: "Tandoori Chicken Pizza",
      category: "Signature Pizza",
      basePrice: 21.25,
      sizes: ["small", "medium", "large"],
    },
    {
      sku: "BUTTER_CHICKEN_MED",
      name: "Butter Chicken Pizza",
      category: "Gourmet Pizza",
      basePrice: 22.5,
      sizes: ["small", "medium", "large"],
    },
    {
      sku: "GARLIC_BREAD",
      name: "Garlic Bread",
      category: "Side",
      basePrice: 5.5,
    },
    {
      sku: "COKE_2L",
      name: "2L Coke",
      category: "Beverage",
      basePrice: 4.0,
    },
  ],
};

const SYSTEM_PROMPT = `
You are an AI phone assistant taking orders for a Pizza 64 store in Surrey, BC.

Goals:
- Take accurate food orders.
- Support only normal Pizza 64 style items (no crazy customizations).
- Ask follow-up questions when needed (size, quantity, pickup vs delivery, etc.).
- Enforce business rules.

Always return a JSON object:

{
  "order": {
    "type": "pickup" | "delivery",
    "customer": {
      "name": "string",
      "phone": "string",
      "address": "string | null"
    },
    "items": [
      {
        "sku": "string from menu.sku",
        "name": "string",
        "size": "small|medium|large|null",
        "quantity": number,
        "unitPrice": number,
        "notes": "string | null"
      }
    ],
    "notes": "string | null",
    "currency": "CAD",
    "estimatedTotal": number,
    "flags": {
      "largeOrder": boolean,
      "requiresManagerApproval": boolean,
      "hasImpossibleCustomization": boolean
    }
  }
}

Menu:

${JSON.stringify(PIZZA64_MENU, null, 2)}

Rules:
- Ask if it's pickup or delivery.
- If delivery, you MUST collect full address.
- If more than 20 pizzas, set largeOrder=true and requiresManagerApproval=true.
- Do NOT accept insane things like 25 kg cheese. If customer asks that, keep it normal and set hasImpossibleCustomization=true.
- Only use items from the menu. If they ask something else, choose the closest matching item.
- estimatedTotal = rough subtotal (no tax).

Return ONLY the JSON.
`;

export async function buildPizza64OrderFromText(transcriptText) {
  if (!env.openai.apiKey) {
    throw new Error("OPENAI_API_KEY is not set");
  }

  const userContent = `
Customer said (call transcript):

${transcriptText}

From this, infer the final confirmed order following the JSON schema.
If name or address is missing, guess or leave null.
`;

  const response = await openai.chat.completions.create({
    model: "gpt-4.1-mini",
    response_format: { type: "json_object" },
    messages: [
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user", content: userContent },
    ],
  });

  const raw = response.choices[0].message.content;
  const parsed = JSON.parse(raw);
  return parsed;
}
