/**
 * conversationEngine.js (STABLE VERSION)
 * Fixes:
 * - Menu questions
 * - Category ordering (pasta, sides, etc.)
 * - No ghost sides
 * - Proper order reset
 */

function norm(t) { return String(t || "").trim(); }
function lower(t) { return norm(t).toLowerCase(); }

function hasAny(t, arr) {
  return arr.some(x => t.includes(x));
}

/* =========================
   INTENTS
========================= */

function isMenuQuestion(t) {
  return hasAny(lower(t), [
    "menu",
    "what do you have",
    "what are the things you offer",
    "what else",
    "anything else",
    "what do you offer"
  ]);
}

function isCategoryOnly(t, store) {
  const cats = Object.keys(store.menu || {});
  return cats.some(c => lower(t).includes(c));
}

function detectQty(t) {
  const m = lower(t).match(/\b(\d+)\b/);
  return m ? parseInt(m[1], 10) : null;
}

function detectSize(t) {
  const s = lower(t);
  if (s.includes("large")) return "Large";
  if (s.includes("medium")) return "Medium";
  if (s.includes("small")) return "Small";
  return null;
}

function detectOrderType(t) {
  const s = lower(t);
  if (s.includes("pickup")) return "Pickup";
  if (s.includes("delivery")) return "Delivery";
  return null;
}

/* =========================
   MENU HELPERS
========================= */

function normalizeMatch(s) {
  return lower(s).replace(/[^a-z0-9\s]/g, "");
}

function getAllItems(store) {
  const out = [];
  for (const cat of Object.keys(store.menu || {})) {
    const arr = Array.isArray(store.menu[cat]) ? store.menu[cat] : [];
    for (const i of arr) {
      out.push({ ...i, category: cat });
    }
  }
  return out;
}

function findItem(store, text) {
  const t = normalizeMatch(text);
  return getAllItems(store).find(i => {
    const names = [i.name, ...(i.aliases || [])];
    return names.some(n => t.includes(normalizeMatch(n)));
  });
}

/* =========================
   PUBLIC API
========================= */

export function getGreetingText(store) {
  return store.conversation?.greeting || "What would you like to order?";
}

export function buildConfirmationText(store, session) {
  const items =
    session.items.length
      ? session.items.map(i => `${i.qty} ${i.size ? i.size + " " : ""}${i.name}`).join(", ")
      : "No items";

  const sides =
    session.sides.length
      ? session.sides.map(s => `${s.qty} ${s.name}`).join(", ")
      : "No sides";

  return `Please confirm your order. Items: ${items}. Sides: ${sides}. Is that correct?`;
}

export function handleUserTurn(store, session, userText) {
  const text = norm(userText);

  /* Initialize */
  session.items ??= [];
  session.sides ??= [];

  /* MENU QUESTIONS */
  if (isMenuQuestion(text)) {
    const cats = Object.keys(store.menu);
    return {
      reply: `We offer: ${cats.join(", ")}. What would you like to order?`,
      session
    };
  }

  /* CONFIRMATION */
  if (session.confirming) {
    if (lower(text).startsWith("yes")) {
      session.completed = true;
      return { reply: "Perfect — your order is confirmed. Thank you!", session };
    }
    if (lower(text).startsWith("no")) {
      session.confirming = false;
      session.items = [];
      session.sides = [];
      return { reply: "No problem. What would you like to order instead?", session };
    }
  }

  /* ORDER TYPE */
  const ot = detectOrderType(text);
  if (ot) session.orderType = ot;

  /* ITEM MATCH */
  const item = findItem(store, text);
  if (item) {
    const qty = detectQty(text) || 1;
    const size = detectSize(text);

    if (item.category === "pizzas") {
      session.items.push({ name: item.name, qty, size });
    } else {
      session.sides.push({ name: item.name, qty });
    }
  }

  /* ASK SIZE IF PIZZA */
  const missingSize = session.items.find(i => !i.size);
  if (missingSize) {
    return { reply: "What size would you like? Small, Medium, or Large?", session };
  }

  /* ASK ORDER TYPE */
  if (!session.orderType) {
    return { reply: "Pickup or delivery?", session };
  }

  /* ASK SIDES ONCE */
  if (!session.sidesAsked) {
    session.sidesAsked = true;
    return { reply: "Would you like any sides or drinks?", session };
  }

  /* CONFIRM */
  session.confirming = true;
  return { reply: buildConfirmationText(store, session), session };
}
