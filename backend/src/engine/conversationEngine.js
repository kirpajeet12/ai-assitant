/**
 * conversationEngine.js (CATEGORY-DRIVEN, FIXED)
 * - Menu-driven conversation
 * - Supports pizzas, sides, snacks, pastas, drinks
 * - No infinite loops
 * - Users can order ANY item directly
 */

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
   INTENT HELPERS
========================= */

function isYes(t) {
  return /^(yes|y|yeah|yep|ok|confirm)$/i.test(lower(t));
}
function isNo(t) {
  return /^(no|nope|nah|not really)$/i.test(lower(t));
}

function detectQty(text) {
  const m = lower(text).match(/\b(\d+)\b/);
  if (m) return parseInt(m[1], 10);
  if (text.includes("one")) return 1;
  if (text.includes("two")) return 2;
  if (text.includes("three")) return 3;
  return null;
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
  if (t.includes("hot") || t.includes("spicy")) return "Hot";
  return null;
}

function detectOrderType(text) {
  const t = lower(text);
  if (t.includes("pickup")) return "Pickup";
  if (t.includes("delivery")) return "Delivery";
  return null;
}

/* =========================
   MENU HELPERS
========================= */

function normalizeMatch(s) {
  return lower(s).replace(/[^a-z0-9\s]/g, "");
}

function getAllMenuItems(store) {
  const menu = store?.menu || {};
  const items = [];

  for (const section of Object.keys(menu)) {
    const arr = Array.isArray(menu[section]) ? menu[section] : [];
    for (const item of arr) {
      items.push({
        section,
        ...item
      });
    }
  }
  return items;
}

function matchItem(store, text) {
  const t = normalizeMatch(text);
  return getAllMenuItems(store).find(item => {
    const names = [item.name, ...(item.aliases || [])];
    return names.some(n => normalizeMatch(n).includes(t) || t.includes(normalizeMatch(n)));
  });
}

/* =========================
   PUBLIC API
========================= */

export function getGreetingText(store) {
  return store?.conversation?.greeting || "Welcome! What would you like to order?";
}

export function buildConfirmationText(store, session) {
  const items =
    session.items?.length
      ? session.items.map(i => `${i.qty} ${i.name}`).join(", ")
      : "No items";

  const sides =
    session.sides?.length
      ? session.sides.map(s => `${s.qty} ${s.name}`).join(", ")
      : "No sides";

  return `Please confirm your order. Items: ${items}. Sides: ${sides}. Is that correct?`;
}

export function handleUserTurn(store, session, userText) {
  const text = norm(userText);

  /* confirmation */
  if (session.confirming) {
    if (isYes(text)) {
      session.completed = true;
      return { reply: "Perfect — your order is confirmed. Thank you!", session };
    }
    if (isNo(text)) {
      session.confirming = false;
      return { reply: "No problem. What would you like to change?", session };
    }
  }

  /* detect order type */
  const ot = detectOrderType(text);
  if (ot) session.orderType = ot;

  /* match menu item */
  const matched = matchItem(store, text);
  if (matched) {
    const qty = detectQty(text) || 1;

    if (matched.section === "pizzas") {
      session.items = session.items || [];
      session.items.push({
        name: matched.name,
        qty,
        size: detectSize(text),
        spice: detectSpice(text)
      });
    } else {
      session.sides = session.sides || [];
      session.sides.push({ name: matched.name, qty });
    }
  }

  /* ask missing size */
  const pizzaMissingSize = session.items?.find(i => !i.size);
  if (pizzaMissingSize) {
    return { reply: "What size would you like? Small, Medium, or Large?", session };
  }

  /* ask order type */
  if (!session.orderType) {
    return { reply: "Pickup or delivery?", session };
  }

  /* ask sides once */
  if (!session.sidesAsked) {
    session.sidesAsked = true;
    return { reply: "Would you like any sides or drinks?", session };
  }

  session.confirming = true;
  return { reply: buildConfirmationText(store, session), session };
}
  
