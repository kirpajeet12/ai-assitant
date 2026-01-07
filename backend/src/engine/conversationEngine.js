import { extractMeaning } from "../services/aiService.js";

/* =========================
   GREETING
========================= */
export function getGreetingText(store) {
  return (
    store?.conversation?.greeting ||
    "Welcome. What would you like to order?"
  );
}

/* =========================
   CONFIRMATION TEXT
========================= */
export function buildConfirmationText(store, session) {
  if (!session.items || session.items.length === 0) {
    return "I don’t see any items in your order yet. What would you like to order?";
  }

  const itemsText = session.items
    .map((i) => {
      const qty = i.qty || 1;
      const size = i.size ? `${i.size} ` : "";
      const spice = i.spice ? ` (${i.spice})` : "";
      return `${qty} ${size}${i.name}${spice}`.replace(/\s+/g, " ").trim();
    })
    .join(", ");

  return `Please confirm your order. Items: ${itemsText}. Is that correct?`;
}

/* =========================
   CORE ENGINE (GPT + RULES)
========================= */
export async function handleUserTurn(store, session, userText) {
  session.items = session.items || [];
  session.expecting = session.expecting || null;

  /* =========================
     1️⃣ GPT INTERPRETATION
  ========================= */
  const meaning = await extractMeaning(store, userText, session);

  /* =========================
     2️⃣ CONFIRMATION HANDLING
  ========================= */
  if (meaning.intent === "confirm_yes") {
    if (session.items.length === 0) {
      return { reply: "What would you like to order?", session };
    }
    session.completed = true;
    return {
      reply: "Perfect — your order is confirmed. Thank you!",
      session
    };
  }

  if (meaning.intent === "confirm_no") {
    session.confirming = false;
    session.items = [];
    return {
      reply: "No problem. What would you like to change or order instead?",
      session
    };
  }

  /* =========================
     3️⃣ MENU QUESTIONS
  ========================= */
  if (meaning.intent === "ask_menu") {
    return {
      reply: "We offer pizzas, pastas, wings, sides, salads, and beverages. What would you like?",
      session
    };
  }

  if (meaning.intent === "ask_sides") {
    const sides =
      store.menu?.sides?.map((s) => s.name).join(", ") ||
      "No sides available right now.";
    return {
      reply: `Sides available: ${sides}`,
      session
    };
  }

  /* =========================
     4️⃣ ADD ITEMS
  ========================= */
  if (meaning.intent === "add_item" && meaning.items.length > 0) {
    session.items = meaning.items.map((i) => ({
      name: i.name,
      qty: i.qty || 1,
      size: i.size || null,
      spice: i.spice || null,
      type: detectItemType(store, i.name),
      requiresSpice: i.spice !== null
    }));
  }

  /* =========================
     5️⃣ UPDATE MISSING SLOT
  ========================= */
  if (meaning.intent === "update_item" && session.items.length > 0) {
    const item = session.items[0]; // single-item flow for now
    if (meaning.itemUpdates?.size) item.size = meaning.itemUpdates.size;
    if (meaning.itemUpdates?.spice) item.spice = meaning.itemUpdates.spice;
    if (meaning.itemUpdates?.qty) item.qty = meaning.itemUpdates.qty;
  }

  /* =========================
     6️⃣ SLOT FILLING (RULED)
  ========================= */
  const item = session.items[0];

  if (!item) {
    return { reply: "What would you like to order?", session };
  }

  // Size ONLY for pizza
  if (item.type === "pizza" && !item.size) {
    session.expecting = "size";
    return {
      reply: `What size would you like for ${item.name}? Small, Medium, or Large?`,
      session
    };
  }

  // Spice ONLY if required
  if (item.requiresSpice && !item.spice) {
    session.expecting = "spice";
    return {
      reply: `What spice level would you like? Mild, Medium, or Hot?`,
      session
    };
  }

  /* =========================
     7️⃣ ORDER TYPE
  ========================= */
  if (meaning.intent === "set_order_type") {
    session.orderType = meaning.orderType;
  }

  if (!session.orderType) {
    session.expecting = "orderType";
    return {
      reply: "Pickup or delivery?",
      session
    };
  }

  /* =========================
     8️⃣ FINAL CONFIRMATION
  ========================= */
  session.confirming = true;
  session.expecting = null;
  return {
    reply: buildConfirmationText(store, session),
    session
  };
}

/* =========================
   HELPER: ITEM TYPE
========================= */
function detectItemType(store, itemName) {
  const name = itemName.toLowerCase();

  for (const cat of Object.keys(store.menu?.pizzas || {})) {
    if (store.menu.pizzas[cat].some((p) => p.name.toLowerCase() === name)) {
      return "pizza";
    }
  }

  if (store.menu?.pastas?.some((p) => p.name.toLowerCase() === name)) return "pasta";
  if (store.menu?.wings?.some((p) => p.name.toLowerCase() === name)) return "wings";
  if (store.menu?.sides?.some((p) => p.name.toLowerCase() === name)) return "side";

  return "other";
}

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
