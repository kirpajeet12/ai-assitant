/**
 * services/aiService.js
 *
 * Goal:
 * - Turn any user sentence into structured JSON
 * - Understand menu questions / done / yes/no / pickup/delivery / address
 * - Understand "medium" when bot asked size or spice (session.expecting)
 */

import OpenAI from "openai";

// Create client once
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

/**
 * Extract structured meaning from user speech.
 * @param {object} store - store config (menu/sides)
 * @param {string} text - user speech
 * @param {object} session - current session (expecting slot)
 */
export async function extractMeaning(store, text, session) {
  // Menu/sides from store config
  const menu = store?.menu || store?.conversation?.menu || [];
  const sides = store?.sides || store?.conversation?.sides || [];

  // What we asked last (so we interpret short answers properly)
  const expecting = session?.expecting || null;

  // Build system instructions
  const system = `
You are an order-taking assistant for a pizza store.
Return ONLY valid JSON. No extra text.

You must detect intents and extract order details.
Possible intents:
- "ask_menu" (user asks what pizzas are available)
- "ask_sides" (user asks what sides are available)
- "add_item" (user adds a pizza item)
- "update_item" (user answers a missing slot like size/spice/qty)
- "set_order_type" (pickup or delivery)
- "provide_address"
- "confirm_yes"
- "confirm_no"
- "done"
- "unknown"

Menu items: ${JSON.stringify(menu)}
Sides: ${JSON.stringify(sides)}

Spice levels allowed: ["Mild","Medium","Hot"]
Sizes allowed: ["Small","Medium","Large"]

IMPORTANT:
- If the user message is a SHORT answer and expecting="${expecting}",
  then map it into itemUpdates instead of creating a new pizza item.
  Example: expecting="spice" and user says "hot" => itemUpdates: { spice:"Hot" } and intent="update_item"
  Example: expecting="size" and user says "medium" => itemUpdates: { size:"Medium" } and intent="update_item"

- If user says BOTH "medium hot" or includes multiple spice levels, set:
  intent="unknown" and include a field "needsClarification": true

Return JSON shape exactly like:
{
  "intent": "add_item|update_item|ask_menu|ask_sides|set_order_type|provide_address|confirm_yes|confirm_no|done|unknown",
  "items": [{"name": "...", "qty": 1, "size": "Large|null", "spice": "Hot|null"}],
  "itemUpdates": {"qty": null, "size": null, "spice": null},
  "sides": [],
  "orderType": "Pickup|Delivery|null",
  "address": null,
  "customerName": null,
  "needsClarification": false
}
`.trim();

  // User message
  const user = `
User said: "${text}"
expecting slot: "${expecting}"
`.trim();

  // Call OpenAI
  const resp = await openai.chat.completions.create({
    model: process.env.OPENAI_MODEL || "gpt-4o-mini",
    temperature: 0,
    messages: [
      { role: "system", content: system },
      { role: "user", content: user }
    ]
  });

  // Raw model output (should be JSON)
  const content = resp.choices?.[0]?.message?.content || "";

  // Parse JSON safely
  let parsed;
  try {
    parsed = JSON.parse(content);
  } catch (e) {
    // If parsing fails, return a safe fallback
    return { intent: "unknown", items: [], itemUpdates: {}, sides: [], orderType: null, address: null, needsClarification: true, rawText: text };
  }

  // Attach rawText for the engine helper regex checks
  parsed.rawText = text;

  // Normalize a few fields to avoid crashing later
  if (!Array.isArray(parsed.items)) parsed.items = [];
  if (!parsed.itemUpdates || typeof parsed.itemUpdates !== "object") parsed.itemUpdates = {};
  if (!Array.isArray(parsed.sides)) parsed.sides = [];

  return parsed;
}
