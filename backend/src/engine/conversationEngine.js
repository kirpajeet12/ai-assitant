import { getOrCreateTicket, saveTicket } from "./services/ticketService.js";

/**
 * MAIN CONVERSATION ENGINE
 * This is the ONLY file controlling order flow
 */
export function conversationEngine(phone, userText) {
  const ticket = getOrCreateTicket(phone);
  const msg = userText.toLowerCase().trim();

  /* =========================
     SAFETY: CONFIRMED ORDER
  ========================= */
  if (ticket.confirmed) {
    return `Your order is already confirmed 👍  
Order number: ${ticket.id}`;
  }

  /* =========================
     START
  ========================= */
  if (!ticket.step || ticket.step === "START") {
    ticket.step = "MAIN_ITEM";
    saveTicket(ticket);
    return "Welcome to Pizza 64! What would you like to order today?";
  }

  /* =========================
     MAIN ITEM (PIZZA / WINGS)
  ========================= */
  if (ticket.step === "MAIN_ITEM") {
    ticket.items.push(userText);
    ticket.step = "ORDER_TYPE";
    saveTicket(ticket);

    return `Got it 👍  
Would you like **pickup or delivery**?`;
  }

  /* =========================
     PICKUP / DELIVERY
  ========================= */
  if (ticket.step === "ORDER_TYPE") {
    if (!msg.includes("pickup") && !msg.includes("delivery")) {
      return "Please tell me if this is **pickup or delivery**.";
    }

    ticket.orderType = msg.includes("delivery") ? "Delivery" : "Pickup";
    ticket.step = "SIDES";
    saveTicket(ticket);

    return `Perfect 👍  
Your ${ticket.orderType.toLowerCase()} order will be ready in about **20 minutes**.

Would you like to add **sides or drinks**?
We have **wings, garlic bread, fries, and cold drinks**.`;
  }

  /* =========================
     SIDES
  ========================= */
  if (ticket.step === "SIDES") {
    if (msg.includes("wing")) {
      ticket.pendingSide = "wings";
      ticket.step = "WINGS_QTY";
      saveTicket(ticket);

      return `Nice choice 😄  
How many wings would you like?
• 6 pcs  
• 10 pcs  
• 20 pcs`;
    }

    if (!msg.includes("no")) {
      ticket.items.push(userText);
    }

    ticket.step = "SUMMARY";
    saveTicket(ticket);
    return buildSummary(ticket);
  }

  /* =========================
     WINGS QUANTITY
  ========================= */
  if (ticket.step === "WINGS_QTY") {
    const qtyMatch = msg.match(/\d+/);
    if (!qtyMatch) {
      return "Please tell me how many wings you’d like (6, 10, or 20).";
    }

    ticket.items.push(`BBQ Wings (${qtyMatch[0]} pcs)`);
    ticket.pendingSide = null;
    ticket.step = "SUMMARY";
    saveTicket(ticket);

    return buildSummary(ticket);
  }

  /* =========================
     SUMMARY & CONFIRMATION
  ========================= */
  if (ticket.step === "SUMMARY") {
    if (msg.includes("yes") || msg.includes("confirm")) {
      ticket.confirmed = true;
      ticket.step = "CONFIRMED";
      saveTicket(ticket);

      return `✅ Order confirmed!

Your order number is **${ticket.id}**  
Please come to Pizza 64 in about **20 minutes**.

Thank you for ordering 🍕`;
    }

    if (msg.includes("no")) {
      ticket.step = "MAIN_ITEM";
      saveTicket(ticket);
      return "No problem 👍 What would you like to change?";
    }

    return "Please reply **Yes** to confirm or **No** to make changes.";
  }

  /* =========================
     FALLBACK
  ========================= */
  return "Sorry, I didn’t understand that. Please try again.";
}

/* =========================
   ORDER SUMMARY BUILDER
========================= */
function buildSummary(ticket) {
  return `
Here’s your order summary:

${ticket.items.map(i => `• ${i}`).join("\n")}

Order type: ${ticket.orderType}

Would you like to **confirm this order**?
(Reply Yes / No)
`;
}

// /**
//  * conversationEngine.js
//  * JSON-driven, multi-store, no hardcoding
//  */

// function norm(t) {
//   return String(t || "").trim();
// }
// function lower(t) {
//   return norm(t).toLowerCase();
// }
// function hasAny(t, arr) {
//   return arr.some(x => t.includes(x));
// }

// /* =========================
//    MENU HELPERS
// ========================= */

// function safeArray(x) {
//   return Array.isArray(x) ? x : [];
// }

// function normalizeMatch(s) {
//   return lower(s)
//     .replace(/pizza/g, "")
//     .replace(/[^a-z0-9\s]/g, "")
//     .replace(/\s+/g, " ")
//     .trim();
// }

// function flattenMenu(store) {
//   const out = [];

//   const push = (type, list) => {
//     for (const item of safeArray(list)) {
//       out.push({
//         type,
//         name: item.name,
//         aliases: safeArray(item.aliases).map(normalizeMatch),
//         config: item
//       });
//     }
//   };

//   const m = store.menu || {};
//   push("pizza", Object.values(m.pizzas || {}).flat());
//   push("pasta", m.pastas);
//   push("wings", m.wings);
//   push("side", m.sides);
//   push("beverage", m.beverages);
//   push("salad", m.salads);

//   return out;
// }

// /* =========================
//    EXTRACTION
// ========================= */

// function extractItems(store, text) {
//   const t = normalizeMatch(text);
//   const menu = flattenMenu(store);

//   const found = [];

//   for (const m of menu) {
//     if (m.aliases.some(a => t.includes(a))) {
//       found.push({
//         type: m.type,
//         name: m.name,
//         size: null,
//         spice: null,
//         toppings: [],
//         notes: [],
//         qty: 1
//       });
//     }
//   }
//   return found;
// }

// function detectSize(text) {
//   const t = lower(text);
//   if (t.includes("large")) return "Large";
//   if (t.includes("medium")) return "Medium";
//   if (t.includes("small")) return "Small";
//   return null;
// }

// function detectSpice(text) {
//   const t = lower(text);
//   if (t.includes("mild")) return "Mild";
//   if (t.includes("medium")) return "Medium";
//   if (t.includes("hot") || t.includes("spicy")) return "Hot";
//   return null;
// }

// function extractNotes(store, text) {
//   const rules = store.itemTypes?.pizza;
//   if (!rules?.allowedNotes) return [];

//   const t = lower(text);
//   return rules.allowedNotes.filter(n => t.includes(n));
// }

// function extractToppings(store, text) {
//   const t = lower(text);
//   return safeArray(store.menu?.toppings).filter(tp =>
//     t.includes(lower(tp.name))
//   ).map(tp => tp.name);
// }

// /* =========================
//    MAIN ENGINE
// ========================= */

// export function getGreetingText(store) {
//   return store.conversation?.greeting ||
//     "Welcome! What would you like to order?";
// }

// export function buildConfirmationText(store, session) {
//   const items = session.items.map((i, idx) => {
//     const parts = [
//       `${idx + 1}. ${i.size || ""} ${i.name}`,
//       i.spice ? `(${i.spice})` : "",
//       i.toppings.length ? `Toppings: ${i.toppings.join(", ")}` : "",
//       i.notes.length ? `Notes: ${i.notes.join(", ")}` : ""
//     ];
//     return parts.filter(Boolean).join(" ");
//   });

//   const timeMsg =
//     session.orderType === "Pickup"
//       ? `Pickup in ${store.conversation.pickupTimeMinutes} minutes.`
//       : `Delivery in ${store.conversation.deliveryTimeMinutes} minutes.`;

//   return `Please confirm your order:\n${items.join("\n")}\n${timeMsg}`;
// }

// export function handleUserTurn(store, session, text) {
//   const msg = lower(text);

//   /* 1️⃣ ADD ITEM (TOP PRIORITY) */
//   const items = extractItems(store, msg);
//   if (items.length) {
//     for (const item of items) {
//       item.size = detectSize(msg);
//       item.spice = detectSpice(msg);
//       item.notes = extractNotes(store, msg);
//       item.toppings = extractToppings(store, msg);
//       session.items.push(item);
//     }
//     return { reply: "Pickup or delivery?", session };
//   }

//   /* 2️⃣ ORDER TYPE */
//   if (hasAny(msg, ["pickup", "pick up"])) {
//     session.orderType = "Pickup";
//     return { reply: store.conversation.pickupMessage || "Would you like any sides or drinks?", session };
//   }

//   if (hasAny(msg, ["delivery", "deliver"])) {
//     session.orderType = "Delivery";
//     return { reply: "Please provide delivery address.", session };
//   }

//   /* 3️⃣ MENU QUESTIONS (ONLY IF NO ITEMS) */
//   if (hasAny(msg, ["menu", "what do you have", "options"])) {
//     return {
//       reply: "We offer pizzas, pastas, wings, sides, salads, and drinks.",
//       session
//     };
//   }

//   /* 4️⃣ CONFIRMATION */
//   if (hasAny(msg, ["yes", "confirm", "correct"])) {
//     session.completed = true;
//     return { reply: "Perfect — your order is confirmed. Thank you!", session };
//   }

//   if (hasAny(msg, ["no", "change"])) {
//     session.items = [];
//     return { reply: "No problem. What would you like to change?", session };
//   }

//   return { reply: "What would you like to order?", session };
// }



// /**
//  * conversationEngine.js
//  * - Stable rule-based engine
//  * - Supports pizza, pasta, wings, sides
//  * - Adds upsell (sides/drinks)
//  * - Adds pickup / delivery timing message
//  */

// function norm(t) {
//   return String(t || "").trim();
// }
// function lower(t) {
//   return norm(t).toLowerCase();
// }
// function hasAny(t, arr) {
//   return arr.some((x) => t.includes(x));
// }

// /* =========================
//    BASIC DETECTORS
// ========================= */

// function isGreeting(text) {
//   return hasAny(lower(text), ["hi", "hello", "hey"]);
// }

// function isConfirmYes(text) {
//   return /^(yes|y|yeah|yep|confirm|correct|ok)$/i.test(lower(text));
// }

// function isConfirmNo(text) {
//   return hasAny(lower(text), ["no", "wrong", "change", "edit"]);
// }

// function detectOrderType(text) {
//   const t = lower(text);
//   if (hasAny(t, ["pickup", "pick up"])) return "Pickup";
//   if (hasAny(t, ["delivery", "deliver"])) return "Delivery";
//   return null;
// }

// function detectSize(text) {
//   const t = lower(text);
//   if (t.includes("large")) return "Large";
//   if (t.includes("medium")) return "Medium";
//   if (t.includes("small")) return "Small";
//   return null;
// }

// function detectQty(text) {
//   const m = lower(text).match(/\b(\d+)\b/);
//   return m ? parseInt(m[1], 10) : 1;
// }

// function detectSpice(text) {
//   const t = lower(text);
//   if (t.includes("mild")) return "Mild";
//   if (t.includes("medium")) return "Medium";
//   if (t.includes("hot") || t.includes("spicy")) return "Hot";
//   return null;
// }

// /* =========================
//    MENU HELPERS
// ========================= */

// function normalizeName(s) {
//   return lower(s)
//     .replace(/pizza/g, "")
//     .replace(/[^a-z0-9 ]/g, "")
//     .replace(/\s+/g, " ")
//     .trim();
// }

// function getAllItems(store) {
//   const out = [];

//   // pizzas
//   for (const cat of Object.keys(store.menu?.pizzas || {})) {
//     for (const p of store.menu.pizzas[cat]) {
//       out.push({
//         type: "pizza",
//         name: p.name,
//         requiresSpice: p.requiresSpice === true,
//         aliases: p.aliases || []
//       });
//     }
//   }

//   // pastas
//   for (const p of store.menu?.pastas || []) {
//     out.push({ type: "pasta", name: p.name, aliases: p.aliases || [] });
//   }

//   // wings
//   for (const w of store.menu?.wings || []) {
//     out.push({ type: "wings", name: w.name, aliases: w.aliases || [] });
//   }

//   // sides
//   for (const s of store.menu?.sides || []) {
//     out.push({ type: "side", name: s.name, aliases: s.aliases || [] });
//   }

//   return out;
// }

// function extractItems(store, text) {
//   const t = normalizeName(text);
//   const items = [];

//   for (const item of getAllItems(store)) {
//     const names = [
//       normalizeName(item.name),
//       ...item.aliases.map(normalizeName)
//     ];

//     if (names.some((n) => t.includes(n))) {
//       items.push({
//         name: item.name,
//         type: item.type,
//         qty: detectQty(text),
//         size: item.type === "pizza" ? detectSize(text) : null,
//         spice: item.requiresSpice ? detectSpice(text) : null,
//         requiresSpice: item.requiresSpice || false
//       });
//     }
//   }

//   return items;
// }

// /* =========================
//    MESSAGES
// ========================= */

// export function getGreetingText(store) {
//   return store?.conversation?.greeting || "What would you like to order?";
// }

// export function buildConfirmationText(store, session) {
//   const items = session.items
//     .map((i) => {
//       const size = i.size ? `${i.size} ` : "";
//       const spice = i.spice ? ` (${i.spice})` : "";
//       return `${i.qty} ${size}${i.name}${spice}`.replace(/\s+/g, " ").trim();
//     })
//     .join(", ");

//   return `Please confirm your order. Items: ${items}. Is that correct?`;
// }

// function buildFinalMessage(store, session) {
//   const info = store.storeInfo || {};

//   if (session.orderType === "Pickup") {
//     const mins = info.pickupTimeMinutes || 20;
//     const addr = info.address ? ` at ${info.address}` : "";
//     return `Perfect! Your pickup will be ready in about ${mins} minutes${addr}. Thank you!`;
//   }

//   if (session.orderType === "Delivery") {
//     const mins = info.deliveryTimeMinutes || 35;
//     return `Perfect! Your delivery will arrive in about ${mins} minutes. Thank you!`;
//   }

//   return "Perfect! Your order is confirmed. Thank you!";
// }

// /* =========================
//    CORE ENGINE
// ========================= */

// export async function handleUserTurn(store, session, userText) {
//   const text = norm(userText);
//   session.items = session.items || [];
//   session.upsellAsked = session.upsellAsked || false;

//   // Greeting
//   if (isGreeting(text) && session.items.length === 0) {
//     return {
//       reply:
//         "Hi! We offer pizzas, pastas, wings, sides, salads, and drinks. What would you like?",
//       session
//     };
//   }

//   // Confirmation
//   if (session.confirming) {
//     if (isConfirmYes(text)) {
//       if (!session.upsellAsked) {
//         session.upsellAsked = true;
//         session.confirming = false;
//         return {
//           reply: "Would you like any sides or drinks?",
//           session
//         };
//       }

//       session.completed = true;
//       return {
//         reply: buildFinalMessage(store, session),
//         session
//       };
//     }

//     if (isConfirmNo(text)) {
//       session.confirming = false;
//       session.items = [];
//       return { reply: "No problem. What would you like to change?", session };
//     }
//   }

//   // Extract items
//   const items = extractItems(store, text);
//   if (items.length > 0) {
//     session.items = items;
//   }

//   if (session.items.length === 0) {
//     return { reply: "What would you like to order?", session };
//   }

//   // Size (pizza only)
//   for (const it of session.items) {
//     if (it.type === "pizza" && !it.size) {
//       return {
//         reply: `What size would you like for ${it.name}?`,
//         session
//       };
//     }
//   }

//   // Spice
//   for (const it of session.items) {
//     if (it.requiresSpice && !it.spice) {
//       return {
//         reply: `What spice level for ${it.name}? Mild, Medium, or Hot?`,
//         session
//       };
//     }
//   }

//   // Order type
//   const ot = detectOrderType(text);
//   if (ot) session.orderType = ot;

//   if (!session.orderType) {
//     return { reply: "Pickup or delivery?", session };
//   }

//   // Confirm
//   session.confirming = true;
//   return { reply: buildConfirmationText(store, session), session };
// }


// import { extractMeaning } from "../services/aiService.js";

// /* =========================
//    GREETING
// ========================= */
// export function getGreetingText(store) {
//   return (
//     store?.conversation?.greeting ||
//     "Welcome. What would you like to order?"
//   );
// }

// /* =========================
//    CONFIRMATION TEXT
// ========================= */
// export function buildConfirmationText(store, session) {
//   if (!session.items || session.items.length === 0) {
//     return "I don’t see any items in your order yet. What would you like to order?";
//   }

//   const itemsText = session.items
//     .map((i) => {
//       const qty = i.qty || 1;
//       const size = i.size ? `${i.size} ` : "";
//       const spice = i.spice ? ` (${i.spice})` : "";
//       return `${qty} ${size}${i.name}${spice}`.replace(/\s+/g, " ").trim();
//     })
//     .join(", ");

//   return `Please confirm your order. Items: ${itemsText}. Is that correct?`;
// }

// /* =========================
//    CORE ENGINE (GPT + RULES)
// ========================= */
// export async function handleUserTurn(store, session, userText) {
//   session.items = session.items || [];
//   session.expecting = session.expecting || null;

//   /* =========================
//      1️⃣ GPT INTERPRETATION
//   ========================= */
//   const meaning = await extractMeaning(store, userText, session);

//   /* =========================
//      2️⃣ CONFIRMATION HANDLING
//   ========================= */
//   if (meaning.intent === "confirm_yes") {
//     if (session.items.length === 0) {
//       return { reply: "What would you like to order?", session };
//     }
//     session.completed = true;
//     return {
//       reply: "Perfect — your order is confirmed. Thank you!",
//       session
//     };
//   }

//   if (meaning.intent === "confirm_no") {
//     session.confirming = false;
//     session.items = [];
//     return {
//       reply: "No problem. What would you like to change or order instead?",
//       session
//     };
//   }

//   /* =========================
//      3️⃣ MENU QUESTIONS
//   ========================= */
//   if (meaning.intent === "ask_menu") {
//     return {
//       reply: "We offer pizzas, pastas, wings, sides, salads, and beverages. What would you like?",
//       session
//     };
//   }

//   if (meaning.intent === "ask_sides") {
//     const sides =
//       store.menu?.sides?.map((s) => s.name).join(", ") ||
//       "No sides available right now.";
//     return {
//       reply: `Sides available: ${sides}`,
//       session
//     };
//   }

//   /* =========================
//      4️⃣ ADD ITEMS
//   ========================= */
//   if (meaning.intent === "add_item" && meaning.items.length > 0) {
//     session.items = meaning.items.map((i) => ({
//       name: i.name,
//       qty: i.qty || 1,
//       size: i.size || null,
//       spice: i.spice || null,
//       type: detectItemType(store, i.name),
//       requiresSpice: i.spice !== null
//     }));
//   }

//   /* =========================
//      5️⃣ UPDATE MISSING SLOT
//   ========================= */
//   if (meaning.intent === "update_item" && session.items.length > 0) {
//     const item = session.items[0]; // single-item flow for now
//     if (meaning.itemUpdates?.size) item.size = meaning.itemUpdates.size;
//     if (meaning.itemUpdates?.spice) item.spice = meaning.itemUpdates.spice;
//     if (meaning.itemUpdates?.qty) item.qty = meaning.itemUpdates.qty;
//   }

//   /* =========================
//      6️⃣ SLOT FILLING (RULED)
//   ========================= */
//   const item = session.items[0];

//   if (!item) {
//     return { reply: "What would you like to order?", session };
//   }

//   // Size ONLY for pizza
//   if (item.type === "pizza" && !item.size) {
//     session.expecting = "size";
//     return {
//       reply: `What size would you like for ${item.name}? Small, Medium, or Large?`,
//       session
//     };
//   }

//   // Spice ONLY if required
//   if (item.requiresSpice && !item.spice) {
//     session.expecting = "spice";
//     return {
//       reply: `What spice level would you like? Mild, Medium, or Hot?`,
//       session
//     };
//   }

//   /* =========================
//      7️⃣ ORDER TYPE
//   ========================= */
//   if (meaning.intent === "set_order_type") {
//     session.orderType = meaning.orderType;
//   }

//   if (!session.orderType) {
//     session.expecting = "orderType";
//     return {
//       reply: "Pickup or delivery?",
//       session
//     };
//   }

//   /* =========================
//      8️⃣ FINAL CONFIRMATION
//   ========================= */
//   session.confirming = true;
//   session.expecting = null;
//   return {
//     reply: buildConfirmationText(store, session),
//     session
//   };
// }

// /* =========================
//    HELPER: ITEM TYPE
// ========================= */
// function detectItemType(store, itemName) {
//   const name = itemName.toLowerCase();

//   for (const cat of Object.keys(store.menu?.pizzas || {})) {
//     if (store.menu.pizzas[cat].some((p) => p.name.toLowerCase() === name)) {
//       return "pizza";
//     }
//   }

//   if (store.menu?.pastas?.some((p) => p.name.toLowerCase() === name)) return "pasta";
//   if (store.menu?.wings?.some((p) => p.name.toLowerCase() === name)) return "wings";
//   if (store.menu?.sides?.some((p) => p.name.toLowerCase() === name)) return "side";

//   return "other";
// }

// /**
//  * conversationEngine.js (FIXED & STABLE)
//  * - Category-aware (pizza / pasta / sides / wings)
//  * - No menu spam loops
//  * - No size asked for non-pizza items
//  * - Confirmation loop fixed
//  */

// /* =========================
//    HELPERS
// ========================= */

// const norm = (t) => String(t || "").trim();
// const lower = (t) => norm(t).toLowerCase();
// const hasAny = (t, arr) => arr.some((x) => t.includes(x));

// /* =========================
//    BASIC DETECTORS
// ========================= */

// function isConfirmYes(text) {
//   return /^(yes|y|yeah|yep|confirm|correct|ok)$/i.test(lower(text));
// }

// function isConfirmNo(text) {
//   return hasAny(lower(text), ["no", "wrong", "change", "edit"]);
// }

// function detectOrderType(text) {
//   const t = lower(text);
//   if (hasAny(t, ["pickup", "pick up", "carryout"])) return "Pickup";
//   if (hasAny(t, ["delivery", "deliver"])) return "Delivery";
//   return null;
// }

// function detectSize(text) {
//   const t = lower(text);
//   if (t.includes("large") || /\bl\b/.test(t)) return "Large";
//   if (t.includes("medium") || /\bm\b/.test(t)) return "Medium";
//   if (t.includes("small") || /\bs\b/.test(t)) return "Small";
//   return null;
// }

// function detectQty(text) {
//   const m = lower(text).match(/\b(\d+)\b/);
//   return m ? parseInt(m[1], 10) : 1;
// }

// function detectSpice(text) {
//   const t = lower(text);
//   if (hasAny(t, ["mild"])) return "Mild";
//   if (hasAny(t, ["medium"])) return "Medium";
//   if (hasAny(t, ["hot", "spicy"])) return "Hot";
//   return null;
// }

// /* =========================
//    MENU HELPERS
// ========================= */

// function normalizeName(s) {
//   return lower(s)
//     .replace(/pizza/g, "")
//     .replace(/[^a-z0-9 ]/g, "")
//     .replace(/\s+/g, " ")
//     .trim();
// }

// function getAllItems(store) {
//   const out = [];

//   const menu = store.menu || {};

//   // PIZZAS
//   for (const cat of Object.keys(menu.pizzas || {})) {
//     for (const p of menu.pizzas[cat]) {
//       out.push({
//         type: "pizza",
//         name: p.name,
//         requiresSpice: p.requiresSpice,
//         aliases: p.aliases || []
//       });
//     }
//   }

//   // PASTAS
//   for (const p of menu.pastas || []) {
//     out.push({ type: "pasta", name: p.name, aliases: p.aliases || [] });
//   }

//   // SIDES
//   for (const s of menu.sides || []) {
//     out.push({ type: "side", name: s.name, aliases: s.aliases || [] });
//   }

//   // WINGS
//   for (const w of menu.wings || []) {
//     out.push({ type: "wings", name: w.name, aliases: w.aliases || [] });
//   }

//   return out;
// }

// /* =========================
//    ITEM EXTRACTION (KEY FIX)
// ========================= */

// function extractItems(store, text) {
//   const t = normalizeName(text);
//   const items = [];

//   for (const item of getAllItems(store)) {
//     const names = [
//       normalizeName(item.name),
//       ...item.aliases.map(normalizeName)
//     ];

//     if (names.some((n) => t.includes(n))) {
//       items.push({
//         name: item.name,
//         type: item.type,
//         qty: detectQty(text),
//         size: item.type === "pizza" ? detectSize(text) : null,
//         spice: item.requiresSpice ? detectSpice(text) : null,
//         requiresSpice: item.requiresSpice || false
//       });
//     }
//   }

//   return items;
// }

// /* =========================
//    MENU QUESTIONS (SAFE)
// ========================= */

// function isMenuQuestion(text) {
//   return hasAny(lower(text), [
//     "menu",
//     "what you have",
//     "what do you have",
//     "what do you offer",
//     "anything else",
//     "show menu"
//   ]);
// }

// function listCategories(store) {
//   return "We offer pizzas, pastas, sides, wings, salads, and beverages. What would you like?";
// }

// function listCategory(store, key, label) {
//   const items = (store.menu[key] || []).map((x) => x.name);
//   return items.length ? `${label}: ${items.join(", ")}` : `No ${label.toLowerCase()} available.`;
// }

// /* =========================
//    PUBLIC API
// ========================= */

// export function getGreetingText(store) {
//   return store?.conversation?.greeting || "What would you like to order?";
// }

// export function buildConfirmationText(store, session) {
//   const items = session.items
//     .map((i) => {
//       const size = i.size ? `${i.size} ` : "";
//       const spice = i.spice ? ` (${i.spice})` : "";
//       return `${i.qty} ${size}${i.name}${spice}`.trim();
//     })
//     .join(", ");

//   return `Please confirm your order. Items: ${items}. Is that correct?`;
// }

// /* =========================
//    CORE ENGINE
// ========================= */

// export function handleUserTurn(store, session, userText) {
//   const text = norm(userText);

//   /* ✅ Confirmation handling */
//   if (session.confirming) {
//     if (isConfirmYes(text)) {
//       session.completed = true;
//       return { reply: "Perfect — your order is confirmed. Thank you!", session };
//     }
//     if (isConfirmNo(text)) {
//       session.confirming = false;
//       session.items = [];
//       return { reply: "No problem. What would you like to change?", session };
//     }
//   }

//   /* ✅ Extract items FIRST (CRITICAL FIX) */
//   const items = extractItems(store, text);

//   /* ✅ Menu only if NO items */
//   if (isMenuQuestion(text) && items.length === 0) {
//     return { reply: listCategories(store), session };
//   }

//   /* ✅ Save items */
//   if (items.length) {
//     session.items = items;
//   }

//   /* ✅ Order type */
//   const ot = detectOrderType(text);
//   if (ot) session.orderType = ot;

//   /* ✅ Size missing (pizza only) */
//   for (let i = 0; i < (session.items || []).length; i++) {
//     const it = session.items[i];
//     if (it.type === "pizza" && !it.size) {
//       session.awaiting = { type: "size", index: i };
//       return { reply: `What size would you like for ${it.name}?`, session };
//     }
//   }

//   /* ✅ Spice missing */
//   for (let i = 0; i < (session.items || []).length; i++) {
//     const it = session.items[i];
//     if (it.requiresSpice && !it.spice) {
//       session.awaiting = { type: "spice", index: i };
//       return { reply: `What spice level for ${it.name}? Mild, Medium, or Hot?`, session };
//     }
//   }

//   /* ✅ Order type ask */
//   if (!session.orderType) {
//     return { reply: "Pickup or delivery?", session };
//   }

//   /* ✅ Final confirmation */
//   session.confirming = true;
//   return { reply: buildConfirmationText(store, session), session };
// }

// /**
//  * conversationEngine.js
//  * FINAL STABLE VERSION (NO LOOPS, NO CONFUSION)
//  */

// /* =========================
//    BASIC HELPERS
// ========================= */

// const norm = t => String(t || "").trim();
// const lower = t => norm(t).toLowerCase();
// const hasAny = (t, arr) => arr.some(x => t.includes(x));

// /* =========================
//    CONFIRMATION HELPERS
// ========================= */

// function isConfirmYes(text) {
//   const t = lower(text);
//   return ["yes", "yep", "yeah", "correct", "confirm", "ok"].includes(t);
// }

// function isConfirmNo(text) {
//   const t = lower(text);
//   return ["no", "nope", "wrong", "change"].includes(t);
// }

// /* =========================
//    INTENT DETECTION
// ========================= */

// function isMenuQuestion(text) {
//   const t = lower(text);
//   return hasAny(t, [
//     "menu",
//     "what you have",
//     "what do you have",
//     "what do you offer",
//     "anything else",
//     "what else",
//     "show menu"
//   ]);
// }

// function detectStrongCategory(text) {
//   const t = lower(text);

//   if (t.includes("lasagna") || t.includes("pasta")) return "pastas";
//   if (t.includes("wing")) return "wings";
//   if (t.includes("side")) return "sides";
//   if (t.includes("drink") || t.includes("beverage")) return "beverages";
//   if (t.includes("salad")) return "salads";
//   if (t.includes("pizza")) return "pizzas";

//   return null;
// }

// function detectOrderType(text) {
//   const t = lower(text);
//   if (hasAny(t, ["pickup", "pick up", "takeaway"])) return "Pickup";
//   if (hasAny(t, ["delivery", "deliver"])) return "Delivery";
//   return null;
// }

// /* =========================
//    VALUE EXTRACTION
// ========================= */

// function detectQty(text) {
//   const m = lower(text).match(/\b(\d+)\b/);
//   return m ? parseInt(m[1], 10) : 1;
// }

// function detectSize(text) {
//   const t = lower(text);
//   if (t.includes("large")) return "Large";
//   if (t.includes("medium")) return "Medium";
//   if (t.includes("small")) return "Small";
//   return null;
// }

// function detectSpice(text) {
//   const t = lower(text);
//   if (t.includes("mild")) return "Mild";
//   if (t.includes("medium")) return "Medium";
//   if (t.includes("hot")) return "Hot";
//   return null;
// }

// /* =========================
//    MENU HELPERS
// ========================= */

// const safeArr = x => Array.isArray(x) ? x : [];

// function normalizeForMatch(s) {
//   return lower(s)
//     .replace(/[^a-z0-9\s]/g, " ")
//     .replace(/\s+/g, " ")
//     .trim();
// }

// function getMenuByCategory(store) {
//   const m = store.menu || {};
//   return {
//     pizzas: Object.values(m.pizzas || {}).flat(),
//     sides: safeArr(m.sides),
//     wings: safeArr(m.wings),
//     pastas: safeArr(m.pastas),
//     salads: safeArr(m.salads),
//     beverages: safeArr(m.beverages)
//   };
// }

// /* =========================
//    ITEM EXTRACTION (CATEGORY-LOCKED)
// ========================= */

// function extractItems(store, text) {
//   const t = normalizeForMatch(text);
//   const menu = getMenuByCategory(store);

//   const lockedCategory = detectStrongCategory(text);
//   const categories = lockedCategory
//     ? [lockedCategory]
//     : Object.keys(menu);

//   const found = [];

//   categories.forEach(category => {
//     const items = menu[category] || [];

//     items.forEach(item => {
//       const aliases = [
//         normalizeForMatch(item.name),
//         ...(item.aliases || []).map(normalizeForMatch)
//       ];

//       if (aliases.some(a => a && t.includes(a))) {
//         found.push({
//           name: item.name,
//           category,
//           qty: detectQty(text),
//           size: category === "pizzas" ? detectSize(text) : null,
//           spice: item.requiresSpice ? detectSpice(text) : null,
//           requiresSpice: item.requiresSpice === true
//         });
//       }
//     });
//   });

//   return found;
// }

// /* =========================
//    MENU RESPONSES
// ========================= */

// function listCategories(store) {
//   const cats = Object.keys(getMenuByCategory(store));
//   return `We offer ${cats.join(", ")}. What would you like to order?`;
// }

// function listCategory(store, category) {
//   const items = getMenuByCategory(store)[category] || [];
//   if (!items.length) return `No ${category} available right now.`;
//   return items.map(i => i.name).join(", ");
// }

// /* =========================
//    PUBLIC API
// ========================= */

// export function getGreetingText(store) {
//   return store?.conversation?.greeting || "Welcome! What would you like to order?";
// }

// export function buildConfirmationText(store, session) {
//   const itemsText = session.items.map(i =>
//     `${i.qty} ${i.size ? i.size + " " : ""}${i.name}${i.spice ? " (" + i.spice + ")" : ""}`
//   ).join(", ");

//   return `Please confirm your order. Items: ${itemsText}. Is that correct?`;
// }

// /* =========================
//    MAIN CONVERSATION HANDLER
// ========================= */

// export function handleUserTurn(store, session, userText) {
//   const text = norm(userText);

//   /* ✅ CONFIRMATION HANDLING (FIXES LOOP) */
//   if (session.confirming) {
//     if (isConfirmYes(text)) {
//       session.completed = true;
//       return {
//         reply: "Perfect — your order is confirmed. Thank you!",
//         session
//       };
//     }

//     if (isConfirmNo(text)) {
//       session.confirming = false;
//       return {
//         reply: "No problem. What would you like to change?",
//         session
//       };
//     }

//     return { reply: buildConfirmationText(store, session), session };
//   }

//   /* 1️⃣ MENU BROWSING */
//   if (isMenuQuestion(text)) {
//     return { reply: listCategories(store), session };
//   }

//   const lockedCategory = detectStrongCategory(text);
//   if (lockedCategory && !extractItems(store, text).length) {
//     return { reply: listCategory(store, lockedCategory), session };
//   }

//   /* 2️⃣ ITEM EXTRACTION */
//   const items = extractItems(store, text);
//   if (items.length) {
//     session.items = items;
//   }

//   /* 3️⃣ ASK MISSING DETAILS */
//   for (const item of session.items || []) {
//     if (item.category === "pizzas" && !item.size) {
//       return { reply: `What size would you like for ${item.name}?`, session };
//     }

//     if (item.requiresSpice && !item.spice) {
//       return {
//         reply: `What spice level for ${item.name}? Mild, Medium, or Hot?`,
//         session
//       };
//     }
//   }

//   /* 4️⃣ ORDER TYPE */
//   if (session.items?.length && !session.orderType) {
//     const ot = detectOrderType(text);
//     if (!ot) return { reply: "Pickup or delivery?", session };
//     session.orderType = ot;
//   }

//   /* 5️⃣ CONFIRM (ONLY ONCE) */
//   if (session.items?.length && !session.confirming) {
//     session.confirming = true;
//     return { reply: buildConfirmationText(store, session), session };
//   }

//   return { reply: "What would you like to order?", session };
// }
