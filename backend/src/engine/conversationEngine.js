/**
 * conversationEngine.js (FIXED + BROWSE-FIRST VERSION)
 * - Menu browsing ALWAYS handled before order flow
 * - Users can ask pizzas / sides / pasta / wings directly
 * - No auto pickup/delivery until items exist
 * - No ghost items
 */

/* =========================
   BASIC HELPERS
========================= */

function norm(t) {
  return String(t || "").trim();
}
function lower(t) {
  return norm(t).toLowerCase();
}
function hasAny(t, arr) {
  return arr.some(x => t.includes(x));
}

/* =========================
   MENU / INFO QUESTIONS (CRITICAL FIX)
========================= */

function isMenuQuestion(text) {
  const t = lower(text);
  return hasAny(t, [
    "menu",
    "what you have",
    "what do you have",
    "what do you offer",
    "what are the things you offer",
    "anything else",
    "what else",
    "other than pizza",
    "show menu"
  ]);
}

function isCategoryQuestion(text) {
  const t = lower(text);
  return hasAny(t, [
    "sides",
    "drinks",
    "pasta",
    "pastas",
    "wings",
    "salads",
    "beverages"
  ]);
}

/* =========================
   ORDER HELPERS
========================= */

function detectOrderType(text) {
  const t = lower(text);
  if (hasAny(t, ["pickup", "pick up", "takeaway"])) return "Pickup";
  if (hasAny(t, ["delivery", "deliver"])) return "Delivery";
  return null;
}

function detectSize(text) {
  const t = lower(text);
  if (t.includes("large")) return "Large";
  if (t.includes("medium")) return "Medium";
  if (t.includes("small")) return "Small";
  return null;
}

function detectQty(text) {
  const m = lower(text).match(/\b(\d+)\b/);
  if (m) return parseInt(m[1], 10);
  return 1;
}

function detectSpice(text) {
  const t = lower(text);
  if (t.includes("mild")) return "Mild";
  if (t.includes("medium")) return "Medium";
  if (t.includes("hot")) return "Hot";
  return null;
}

/* =========================
   MENU BUILDERS
========================= */

function safeArr(x) {
  return Array.isArray(x) ? x : [];
}

function normalizeForMatch(s) {
  return lower(s)
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function getAllMenuItems(store) {
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
   ITEM EXTRACTION
========================= */

function extractItemsFromText(store, text) {
  const t = normalizeForMatch(text);
  const menu = getAllMenuItems(store);

  const results = [];

  Object.entries(menu).forEach(([category, items]) => {
    items.forEach(item => {
      const aliases = [
        normalizeForMatch(item.name),
        ...(item.aliases || []).map(normalizeForMatch)
      ];

      if (aliases.some(a => t.includes(a))) {
        results.push({
          name: item.name,
          category,
          qty: detectQty(text),
          size: detectSize(text),
          spice: item.requiresSpice ? detectSpice(text) : null,
          requiresSpice: item.requiresSpice === true
        });
      }
    });
  });

  return results;
}

/* =========================
   MENU RESPONSES
========================= */

function listCategories(store) {
  const m = store.menu || {};
  const cats = Object.keys(m).filter(k => safeArr(m[k]).length || typeof m[k] === "object");
  return `We offer ${cats.join(", ")}. What would you like to order?`;
}

function listCategory(store, category) {
  const menu = getAllMenuItems(store);
  const items = menu[category] || [];
  if (!items.length) return `No ${category} available right now.`;
  return `${category}: ${items.map(i => i.name).join(", ")}`;
}

/* =========================
   PUBLIC API
========================= */

export function getGreetingText(store) {
  return store?.conversation?.greeting ||
    "Welcome! What would you like to order?";
}

export function buildConfirmationText(store, session) {
  const items =
    session.items.length
      ? session.items.map(i =>
          `${i.qty} ${i.size ? i.size + " " : ""}${i.name}${i.spice ? " (" + i.spice + ")" : ""}`
        ).join(", ")
      : "No items";

  const sides =
    session.sides.length
      ? session.sides.map(s => `${s.qty} ${s.name}`).join(", ")
      : "No sides";

  return `Please confirm your order. Items: ${items}. Sides: ${sides}. Is that correct?`;
}

export function handleUserTurn(store, session, userText) {
  const text = norm(userText);

  /* 🔴 FIX 1: MENU QUESTIONS FIRST */
  if (isMenuQuestion(text)) {
    return { reply: listCategories(store), session };
  }

  if (isCategoryQuestion(text)) {
    if (text.includes("pasta")) return { reply: listCategory(store, "pastas"), session };
    if (text.includes("wing")) return { reply: listCategory(store, "wings"), session };
    if (text.includes("side")) return { reply: listCategory(store, "sides"), session };
    if (text.includes("drink")) return { reply: listCategory(store, "beverages"), session };
  }

  /* 🔴 FIX 2: ITEM EXTRACTION */
  const found = extractItemsFromText(store, text);

  if (found.length) {
    session.items = [];
    session.sides = [];

    found.forEach(i => {
      if (i.category === "sides" || i.category === "beverages") {
        session.sides.push({ name: i.name, qty: i.qty });
      } else {
        session.items.push(i);
      }
    });
  }

  /* 🔴 FIX 3: ASK FOR SIZE / SPICE ONLY IF ITEM EXISTS */
  for (let i = 0; i < session.items.length; i++) {
    if (!session.items[i].size) {
      return { reply: `What size would you like for ${session.items[i].name}?`, session };
    }
    if (session.items[i].requiresSpice && !session.items[i].spice) {
      return { reply: `What spice level for ${session.items[i].name}? Mild, Medium, or Hot?`, session };
    }
  }

  /* 🔴 FIX 4: ORDER TYPE ONLY AFTER ITEMS */
  if (session.items.length && !session.orderType) {
    const ot = detectOrderType(text);
    if (!ot) return { reply: "Pickup or delivery?", session };
    session.orderType = ot;
  }

  /* 🔴 FIX 5: CONFIRMATION */
  if (session.items.length) {
    session.confirming = true;
    return { reply: buildConfirmationText(store, session), session };
  }

  return { reply: "What would you like to order?", session };
}
