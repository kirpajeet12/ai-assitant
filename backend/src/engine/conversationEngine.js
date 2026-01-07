import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

/* =========================
   LOAD ENGINE RULES (JSON)
========================= */

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const ENGINE_RULES = JSON.parse(
  fs.readFileSync(path.join(__dirname, "conversationEngine.json"), "utf-8")
);

/* =========================
   BASIC HELPERS
========================= */

const norm = t => String(t || "").trim();
const lower = t => norm(t).toLowerCase();
const hasAny = (t, arr) => arr.some(x => t.includes(x));

/* =========================
   INTENT DETECTION (JSON)
========================= */

function detectIntent(text, intentKey) {
  return hasAny(lower(text), ENGINE_RULES.intents[intentKey] || []);
}

/* =========================
   CATEGORY DETECTION (JSON)
========================= */

function detectCategory(text) {
  const t = lower(text);
  for (const [cat, cfg] of Object.entries(ENGINE_RULES.categories)) {
    if (hasAny(t, cfg.keywords || [])) return cat;
  }
  return null;
}

/* =========================
   FILTER DETECTION (veg/chicken)
========================= */

function detectFilter(text) {
  const t = lower(text);
  for (const [filter, words] of Object.entries(ENGINE_RULES.filters)) {
    if (hasAny(t, words)) return filter;
  }
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
  if (t.includes("small")) return "Small";
  if (t.includes("medium")) return "Medium";
  if (t.includes("large")) return "Large";
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
   ITEM EXTRACTION (LOCKED)
========================= */

function extractItems(store, text, lockedCategory) {
  const t = normalizeForMatch(text);
  const menu = getMenuByCategory(store);
  const proteinFilter = detectFilter(text);

  const categories = lockedCategory ? [lockedCategory] : Object.keys(menu);
  const found = [];

  categories.forEach(cat => {
    const items = menu[cat] || [];

    items.forEach(item => {
      // veg/chicken filter INSIDE category
      if (proteinFilter === "veg" && item.veg === false) return;
      if (proteinFilter === "chicken" && item.veg === true) return;

      const aliases = [
        normalizeForMatch(item.name),
        ...(item.aliases || []).map(normalizeForMatch)
      ];

      if (aliases.some(a => a && t.includes(a))) {
        found.push({
          name: item.name,
          category: cat,
          qty: detectQty(text),
          size: cat === "pizzas" ? detectSize(text) : null,
          spice: item.requiresSpice ? detectSpice(text) : null,
          requiresSpice: item.requiresSpice === true
        });
      }
    });
  });

  return found;
}

/* =========================
   RESPONSES
========================= */

function listCategories(store) {
  return `We offer ${Object.keys(getMenuByCategory(store)).join(", ")}. What would you like to order?`;
}

function listCategory(store, category) {
  const items = getMenuByCategory(store)[category] || [];
  return items.length
    ? items.map(i => i.name).join(", ")
    : `No ${category} available right now.`;
}

/* =========================
   PUBLIC API
========================= */

export function getGreetingText(store) {
  return store?.conversation?.greeting || "Welcome! What would you like to order?";
}

export function buildConfirmationText(store, session) {
  const items = session.items.map(i =>
    `${i.qty} ${i.size ? i.size + " " : ""}${i.name}${i.spice ? " (" + i.spice + ")" : ""}`
  ).join(", ");

  return `Please confirm your order. Items: ${items}. Is that correct?`;
}

/* =========================
   MAIN ENGINE
========================= */

export function handleUserTurn(store, session, userText) {
  const text = norm(userText);

  /* 1️⃣ MENU */
  if (detectIntent(text, "menu")) {
    return { reply: listCategories(store), session };
  }

  /* 2️⃣ CONFIRMATION */
  if (session.confirming) {
    if (detectIntent(text, "confirm_yes")) {
      session.completed = true;
      return { reply: "Perfect — your order is confirmed. Thank you!", session };
    }
    if (detectIntent(text, "confirm_no")) {
      session.confirming = false;
      session.items = [];
      return { reply: "No problem. What would you like to change?", session };
    }
  }

  /* 3️⃣ CATEGORY BROWSING */
  const lockedCategory = detectCategory(text);
  if (lockedCategory && !session.items?.length) {
    return { reply: listCategory(store, lockedCategory), session };
  }

  /* 4️⃣ ITEM EXTRACTION (ONCE) */
  if (!session.items || session.items.length === 0) {
    const items = extractItems(store, text, lockedCategory);
    if (items.length) session.items = items;
  }

  /* 5️⃣ SLOT FILLING */
  for (const item of session.items || []) {
    const rules = ENGINE_RULES.categories[item.category];

    if (rules?.ask?.includes("size") && !item.size) {
      return { reply: `What size would you like for ${item.name}?`, session };
    }

    if (rules?.ask?.includes("spice") && item.requiresSpice && !item.spice) {
      return { reply: `What spice level for ${item.name}? Mild, Medium, or Hot?`, session };
    }
  }

  /* 6️⃣ ORDER TYPE */
  if (session.items?.length && !session.orderType) {
    if (hasAny(lower(text), ["pickup", "delivery"])) {
      session.orderType = lower(text).includes("delivery") ? "Delivery" : "Pickup";
    } else {
      return { reply: "Pickup or delivery?", session };
    }
  }

  /* 7️⃣ CONFIRM */
  if (session.items?.length) {
    session.confirming = true;
    return { reply: buildConfirmationText(store, session), session };
  }

  return { reply: "What would you like to order?", session };
}
