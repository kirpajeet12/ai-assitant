/**
 * services/aiService.js
 *
 * Goal:
 * - Turn any user sentence into structured JSON using OpenAI
 * - Understand menu questions / sides questions / done / yes-no / pickup-delivery / address
 * - Understand short answers like "medium" depending on session.expecting
 */

import OpenAI from "openai";

/* =========================
   OPENAI CLIENT
========================= */

// Create the OpenAI client once (re-used for all requests)
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

/* =========================
   SMALL HELPERS
========================= */

/**
 * Always return an array (never crash if undefined/null).
 * @param {any} x
 * @returns {Array}
 */
function safeArray(x) {
  return Array.isArray(x) ? x : [];
}

/**
 * Flatten pizzas from store.menu.pizzas (which is grouped by category).
 * Your JSON format:
 * menu.pizzas = { specialty: [...], signature: [...], gourmet: [...], seasonal: [...] }
 * @param {object} store
 * @returns {Array<{name:string, veg:boolean, requiresSpice:boolean, aliases?:string[]}>}
 */
function getAllPizzasForPrompt(store) {
  // Read the pizzas object safely
  const pizzasByCat = store?.menu?.pizzas || {};

  // Collect all pizzas into one flat list
  const out = [];

  // Loop over categories in pizzasByCat
  for (const cat of Object.keys(pizzasByCat)) {
    // Each category contains an array of pizza objects
    for (const p of safeArray(pizzasByCat[cat])) {
      // Push only the fields the model needs (keeps prompt smaller)
      out.push({
        name: p?.name || "",
        veg: p?.veg === true,
        requiresSpice: p?.requiresSpice === true,
        aliases: safeArray(p?.aliases)
      });
    }
  }

  // Return the flattened list
  return out.filter((p) => p.name);
}

/**
 * Flatten “sides/drinks/etc” from your JSON.
 * In your config you have:
 * menu.sides, menu.beverages, menu.wings, menu.pastas, menu.salads
 * @param {object} store
 * @returns {Array<{name:string, aliases?:string[]}>}
 */
function getAllSidesForPrompt(store) {
  // Pull lists safely from the store menu
  const sides = safeArray(store?.menu?.sides);
  const beverages = safeArray(store?.menu?.beverages);
  const wings = safeArray(store?.menu?.wings);
  const pastas = safeArray(store?.menu?.pastas);
  const salads = safeArray(store?.menu?.salads);

  // Combine them so "ask_sides" can include drinks + wings etc
  const combined = [...sides, ...beverages, ...wings, ...pastas, ...salads];

  // Normalize shape so the model sees consistent fields
  return combined
    .map((x) => ({
      name: x?.name || "",
      aliases: safeArray(x?.aliases)
    }))
    .filter((x) => x.name);
}

/**
 * If model returns extra text, try to extract the first JSON object block.
 * @param {string} s
 * @returns {string}
 */
function extractFirstJsonObject(s) {
  // Find the first '{' and last '}' and slice
  const start = s.indexOf("{");
  const end = s.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) return s;
  return s.slice(start, end + 1);
}

/* =========================
   MAIN FUNCTION
========================= */

/**
 * Extract structured meaning from user speech.
 * @param {object} store  - store config (menu/sides)
 * @param {string} text   - user speech
 * @param {object} session - current session (expecting slot)
 */
export async function extractMeaning(store, text, session) {
  // Build a clean pizza list for the prompt (instead of dumping whole menu object)
  const pizzas = getAllPizzasForPrompt(store);

  // Build a clean “sides/drinks/etc” list for the prompt
  const sides = getAllSidesForPrompt(store);

  // What we asked last (so we interpret short answers properly)
  const expecting = session?.expecting || null;

  // System instructions
  const system = `
You are an order-taking assistant for a pizza store.
Return ONLY valid JSON. No extra text.

You must detect intents and extract order details.
Possible intents:
- "ask_menu" (user asks what pizzas are available)
- "ask_sides" (user asks what sides/drinks are available)
- "add_item" (user adds a pizza item)
- "update_item" (user answers a missing slot like size/spice/qty)
- "set_order_type" (pickup or delivery)
- "provide_address"
- "confirm_yes"
- "confirm_no"
- "done"
- "unknown"

Pizzas: ${JSON.stringify(pizzas)}
Sides/drinks/etc: ${JSON.stringify(sides)}

Spice levels allowed: ["Mild","Medium","Hot"]
Sizes allowed: ["Small","Medium","Large"]

IMPORTANT:
- If the user message is a SHORT answer and expecting="${expecting}",
  then map it into itemUpdates instead of creating a new pizza item.
  Example: expecting="spice" and user says "hot" => itemUpdates: { spice:"Hot" } and intent="update_item"
  Example: expecting="size" and user says "medium" => itemUpdates: { size:"Medium" } and intent="update_item"

- If user says BOTH "medium hot" or includes multiple spice levels, set:
  intent="unknown" and include "needsClarification": true

Return JSON shape exactly like:
{
  "intent": "add_item|update_item|ask_menu|ask_sides|set_order_type|provide_address|confirm_yes|confirm_no|done|unknown",
  "items": [{"name": "...", "qty": 1, "size": "Large|null", "spice": "Hot|null"}],
  "itemUpdates": {"qty": null, "size": null, "spice": null},
  "sides": [{"name":"...", "qty": 1}],
  "orderType": "Pickup|Delivery|null",
  "address": null,
  "customerName": null,
  "needsClarification": false
}
`.trim();

  // User message
  const user = `
User said: "${String(text || "")}"
expecting slot: "${String(expecting || "")}"
`.trim();

  // Call OpenAI (Chat Completions)
  const resp = await openai.chat.completions.create({
    model: process.env.OPENAI_MODEL || "gpt-4o-mini",
    temperature: 0,
    messages: [
      { role: "system", content: system },
      { role: "user", content: user }
    ]
  });

  // Raw model output (should be JSON)
  const rawContent = resp.choices?.[0]?.message?.content || "";

  // Try parsing JSON safely (also handles extra text)
  let parsed;
  try {
    const maybeJson = extractFirstJsonObject(rawContent);
    parsed = JSON.parse(maybeJson);
  } catch (e) {
    // Safe fallback if parsing fails
    return {
      intent: "unknown",
      items: [],
      itemUpdates: { qty: null, size: null, spice: null },
      sides: [],
      orderType: null,
      address: null,
      customerName: null,
      needsClarification: true,
      rawText: text
    };
  }

  // Attach rawText for any extra engine checks
  parsed.rawText = text;

  // Normalize fields to avoid crashes later
  if (!Array.isArray(parsed.items)) parsed.items = [];
  if (!parsed.itemUpdates || typeof parsed.itemUpdates !== "object") {
    parsed.itemUpdates = { qty: null, size: null, spice: null };
  }
  if (!Array.isArray(parsed.sides)) parsed.sides = [];

  return parsed;
}
