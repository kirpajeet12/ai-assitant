/**
 * conversationEngine.js
 * FINAL FIXED VERSION
 * - Uses store.menu ONLY (no JSON file access)
 * - Category-driven behavior
 * - Pasta never triggers pizza
 * - Size only for pizza
 * - Strong category locking (lasagna fix)
 */

/* =========================
   BASIC HELPERS
========================= */

const norm = t => String(t || "").trim();
const lower = t => norm(t).toLowerCase();
const hasAny = (t, arr) => arr.some(x => t.includes(x));

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

/**
 * STRONG CATEGORY LOCK
 * If one of these is detected,
 * ONLY that category is searched
 */
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

/**
 * Menu comes ONLY from store.menu
 */
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
   ITEM EXTRACTION (FINAL FIX)
========================= */

function extractItems(store, text) {
  const t = normalizeForMatch(text);
  const menu = getMenuByCategory(store);

  const lockedCategory = detectStrongCategory(text);
  const categoriesToSearch = lockedCategory
    ? [lockedCategory]
    : Object.keys(menu);

  const found = [];

  categoriesToSearch.forEach(category => {
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
  return store?.conversation?.greeting ||
    "Welcome! What would you like to order?";
}

export function buildConfirmationText(store, session) {
  const itemsText = session.items.map(i =>
    `${i.qty} ${i.size ? i.size + " " : ""}${i.name}${i.spice ? " (" + i.spice + ")" : ""}`
  ).join(", ");

  return `Please confirm your order. Items: ${itemsText}. Is that correct?`;
}

/* =========================
   MAIN HANDLER
========================= */

export function handleUserTurn(store, session, userText) {
  const text = norm(userText);

  // 1️⃣ Menu browsing
  if (isMenuQuestion(text)) {
    return { reply: listCategories(store), session };
  }

  const lockedCategory = detectStrongCategory(text);
  if (lockedCategory && !extractItems(store, text).length) {
    return { reply: listCategory(store, lockedCategory), session };
  }

  // 2️⃣ Extract items
  const items = extractItems(store, text);
  if (items.length) {
    session.items = items;
  }

  // 3️⃣ Ask missing info
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

  // 4️⃣ Order type
  if (session.items?.length && !session.orderType) {
    const ot = detectOrderType(text);
    if (!ot) return { reply: "Pickup or delivery?", session };
    session.orderType = ot;
  }

  // 5️⃣ Confirmation
  if (session.items?.length) {
    return { reply: buildConfirmationText(store, session), session };
  }

  return { reply: "What would you like to order?", session };
}
