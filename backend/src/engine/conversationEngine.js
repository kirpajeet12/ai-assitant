/**
 * conversationEngine.js
 * FINAL STABLE VERSION (NO LOOPS, NO CONFUSION)
 */

/* =========================
   BASIC HELPERS
========================= */

const norm = t => String(t || "").trim();
const lower = t => norm(t).toLowerCase();
const hasAny = (t, arr) => arr.some(x => t.includes(x));

/* =========================
   CONFIRMATION HELPERS
========================= */

function isConfirmYes(text) {
  const t = lower(text);
  return ["yes", "yep", "yeah", "correct", "confirm", "ok"].includes(t);
}

function isConfirmNo(text) {
  const t = lower(text);
  return ["no", "nope", "wrong", "change"].includes(t);
}

/* =========================
   INTENT DETECTION
========================= */

function isMenuQuestion(text) {
  const t = lower(text);
  return hasAny(t, [
    "menu",
    "what you have",
    "what do you have",
    "what do you offer",
    "anything else",
    "what else",
    "show menu"
  ]);
}

function detectStrongCategory(text) {
  const t = lower(text);

  if (t.includes("lasagna") || t.includes("pasta")) return "pastas";
  if (t.includes("wing")) return "wings";
  if (t.includes("side")) return "sides";
  if (t.includes("drink") || t.includes("beverage")) return "beverages";
  if (t.includes("salad")) return "salads";
  if (t.includes("pizza")) return "pizzas";

  return null;
}

function detectOrderType(text) {
  const t = lower(text);
  if (hasAny(t, ["pickup", "pick up", "takeaway"])) return "Pickup";
  if (hasAny(t, ["delivery", "deliver"])) return "Delivery";
  return null;
}

/* =========================
   VALUE EXTRACTION
========================= */

function detectQty(text) {
  const m = lower(text).match(/\b(\d+)\b/);
  return m ? parseInt(m[1], 10) : 1;
}

function detectSize(text) {
  const t = lower(text);
  if (t.includes("large")) return "Large";
  if (t.includes("medium")) return "Medium";
  if (t.includes("small")) return "Small";
  return null;
}

function detectSpice(text) {
  const t = lower(text);
  if (t.includes("mild")) return "Mild";
  if (t.includes("medium")) return "Medium";
  if (t.includes("hot")) return "Hot";
  return null;
}

/* =========================
   MENU HELPERS
========================= */

const safeArr = x => Array.isArray(x) ? x : [];

function normalizeForMatch(s) {
  return lower(s)
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function getMenuByCategory(store) {
  const m = store.menu || {};
  return {
    pizzas: Object.values(m.pizzas || {}).flat(),
    sides: safeArr(m.sides),
    wings: safeArr(m.wings),
    pastas: safeArr(m.pastas),
    salads: safeArr(m.salads),
    beverages: safeArr(m.beverages)
  };
}

/* =========================
   ITEM EXTRACTION (CATEGORY-LOCKED)
========================= */

function extractItems(store, text) {
  const t = normalizeForMatch(text);
  const menu = getMenuByCategory(store);

  const lockedCategory = detectStrongCategory(text);
  const categories = lockedCategory
    ? [lockedCategory]
    : Object.keys(menu);

  const found = [];

  categories.forEach(category => {
    const items = menu[category] || [];

    items.forEach(item => {
      const aliases = [
        normalizeForMatch(item.name),
        ...(item.aliases || []).map(normalizeForMatch)
      ];

      if (aliases.some(a => a && t.includes(a))) {
        found.push({
          name: item.name,
          category,
          qty: detectQty(text),
          size: category === "pizzas" ? detectSize(text) : null,
          spice: item.requiresSpice ? detectSpice(text) : null,
          requiresSpice: item.requiresSpice === true
        });
      }
    });
  });

  return found;
}

/* =========================
   MENU RESPONSES
========================= */

function listCategories(store) {
  const cats = Object.keys(getMenuByCategory(store));
  return `We offer ${cats.join(", ")}. What would you like to order?`;
}

function listCategory(store, category) {
  const items = getMenuByCategory(store)[category] || [];
  if (!items.length) return `No ${category} available right now.`;
  return items.map(i => i.name).join(", ");
}

/* =========================
   PUBLIC API
========================= */

export function getGreetingText(store) {
  return store?.conversation?.greeting || "Welcome! What would you like to order?";
}

export function buildConfirmationText(store, session) {
  const itemsText = session.items.map(i =>
    `${i.qty} ${i.size ? i.size + " " : ""}${i.name}${i.spice ? " (" + i.spice + ")" : ""}`
  ).join(", ");

  return `Please confirm your order. Items: ${itemsText}. Is that correct?`;
}

/* =========================
   MAIN CONVERSATION HANDLER
========================= */

export function handleUserTurn(store, session, userText) {
  const text = norm(userText);

  /* ✅ CONFIRMATION HANDLING (FIXES LOOP) */
  if (session.confirming) {
    if (isConfirmYes(text)) {
      session.completed = true;
      return {
        reply: "Perfect — your order is confirmed. Thank you!",
        session
      };
    }

    if (isConfirmNo(text)) {
      session.confirming = false;
      return {
        reply: "No problem. What would you like to change?",
        session
      };
    }

    return { reply: buildConfirmationText(store, session), session };
  }

  /* 1️⃣ MENU BROWSING */
  if (isMenuQuestion(text)) {
    return { reply: listCategories(store), session };
  }

  const lockedCategory = detectStrongCategory(text);
  if (lockedCategory && !extractItems(store, text).length) {
    return { reply: listCategory(store, lockedCategory), session };
  }

  /* 2️⃣ ITEM EXTRACTION */
  const items = extractItems(store, text);
  if (items.length) {
    session.items = items;
  }

  /* 3️⃣ ASK MISSING DETAILS */
  for (const item of session.items || []) {
    if (item.category === "pizzas" && !item.size) {
      return { reply: `What size would you like for ${item.name}?`, session };
    }

    if (item.requiresSpice && !item.spice) {
      return {
        reply: `What spice level for ${item.name}? Mild, Medium, or Hot?`,
        session
      };
    }
  }

  /* 4️⃣ ORDER TYPE */
  if (session.items?.length && !session.orderType) {
    const ot = detectOrderType(text);
    if (!ot) return { reply: "Pickup or delivery?", session };
    session.orderType = ot;
  }

  /* 5️⃣ CONFIRM (ONLY ONCE) */
  if (session.items?.length && !session.confirming) {
    session.confirming = true;
    return { reply: buildConfirmationText(store, session), session };
  }

  return { reply: "What would you like to order?", session };
}
