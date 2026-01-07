
/**
 * conversationEngine.js (FIXED VERSION)
 * - Slot-filling script engine (no AI)
 * - FIX: prevents infinite sides loop
 */

function norm(text) {
  return String(text || "").trim();
}
function lower(text) {
  return norm(text).toLowerCase();
}
function hasAny(t, arr) {
  return arr.some((x) => t.includes(x));
}

/* =========================
   BASIC INTENT HELPERS
========================= */

function isConfirmYes(text) {
  const t = lower(text);
  return /^(yes|y|yeah|yep|correct|right|confirm|ok)$/i.test(t) || t.includes("confirm");
}

function isConfirmNo(text) {
  const t = lower(text);
  return /^(no|nope|wrong|incorrect)$/i.test(t) || t.includes("change") || t.includes("not correct");
}

function detectOrderType(text) {
  const t = lower(text);
  if (hasAny(t, ["pickup", "pick up", "carryout", "takeaway"])) return "Pickup";
  if (hasAny(t, ["delivery", "deliver", "drop off", "dropoff"])) return "Delivery";
  return null;
}

function looksLikeAddress(text) {
  const s = norm(text);
  return /\d+/.test(s) && /(st|street|ave|road|rd|blvd|drive|dr|lane|ln|apt|unit|#)/i.test(s);
}

function detectSize(text) {
  const t = lower(text);
  if (/\blarge\b/.test(t)) return "Large";
  if (/\bmedium\b/.test(t)) return "Medium";
  if (/\bsmall\b/.test(t)) return "Small";
  return null;
}

function detectQty(text) {
  const m = lower(text).match(/\b(\d+)\b/);
  if (m) return parseInt(m[1], 10);
  if (text.includes("one")) return 1;
  if (text.includes("two")) return 2;
  if (text.includes("three")) return 3;
  return null;
}

function detectSpice(text) {
  const t = lower(text);
  const mild = hasAny(t, ["mild", "less spicy"]);
  const medium = hasAny(t, ["medium"]);
  const hot = hasAny(t, ["hot", "spicy", "extra spicy"]);

  const hits = [mild && "Mild", medium && "Medium", hot && "Hot"].filter(Boolean);
  if (hits.length === 1) return hits[0];
  if (hits.length > 1) return "__AMBIGUOUS__";
  return null;
}

function isAskingMenu(text) {
  return hasAny(lower(text), ["menu", "what pizzas", "show menu"]);
}
function isAskingVeg(text) {
  return hasAny(lower(text), ["veg", "vegetarian"]);
}
function isAskingSides(text) {
  return hasAny(lower(text), ["sides", "drinks", "addons"]);
}
function isNoSides(text) {
  return hasAny(lower(text), ["no sides", "no side", "no thanks", "none"]);
}

/* =========================
   STORE MENU HELPERS
========================= */

function safeArray(x) {
  return Array.isArray(x) ? x : [];
}

function normalizeForMatch(s) {
  return lower(s)
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function getAllPizzas(store) {
  const out = [];
  const cats = store?.menu?.pizzas || {};
  for (const c of Object.keys(cats)) {
    for (const p of safeArray(cats[c])) out.push(p);
  }
  return out;
}

function getAllSides(store) {
  return [
    ...safeArray(store?.menu?.sides),
    ...safeArray(store?.menu?.beverages)
  ];
}

function listText(arr) {
  return arr.join(", ");
}

/* =========================
   PUBLIC API
========================= */

export function getGreetingText(store) {
  return store?.conversation?.greeting || "What would you like to order?";
}

export function buildConfirmationText(store, session) {
  const pizzas = session.items.map(
    (p, i) => `${i + 1}. ${p.qty} ${p.size} ${p.name}${p.spice ? ` (${p.spice})` : ""}`
  );

  const sides = session.sides?.length
    ? session.sides.map(s => `${s.qty} ${s.name}`).join(", ")
    : "No sides";

  return `Please confirm your order. ${pizzas.join(". ")}. Sides: ${sides}. Is that correct?`;
}

/* =========================
   MAIN ENGINE
========================= */

export function handleUserTurn(store, session, userText) {
  const text = norm(userText);

  /* menu questions */
  if (isAskingMenu(text)) return { reply: listText(getAllPizzas(store).map(p => p.name)), session };
  if (isAskingVeg(text)) return { reply: listText(getAllPizzas(store).filter(p => p.veg).map(p => p.name)), session };
  if (isAskingSides(text)) {
    session.sidesAsked = true;
    return { reply: listText(getAllSides(store).map(s => s.name)), session };
  }

  /* confirmation */
  if (session.confirming) {
    if (isConfirmYes(text)) {
      session.completed = true;
      return { reply: "Perfect — your order is confirmed. Thank you!", session };
    }
    if (isConfirmNo(text)) {
      session.confirming = false;
      session.sidesDone = false;
      session.sidesAsked = false;
      return { reply: "No problem — what would you like to change?", session };
    }
  }

  /* pizzas */
  if (!session.items) session.items = [];
  if (!session.items.length) {
    const pizzas = getAllPizzas(store).filter(p =>
      normalizeForMatch(text).includes(normalizeForMatch(p.name))
    );
    if (pizzas.length) {
      session.items.push({
        name: pizzas[0].name,
        qty: detectQty(text) || 1,
        size: detectSize(text),
        spice: null,
        requiresSpice: pizzas[0].requiresSpice
      });
    }
  }

  for (let i = 0; i < session.items.length; i++) {
    if (!session.items[i].size) {
      session.awaiting = { type: "size", itemIndex: i };
      return { reply: "Small, Medium, or Large?", session };
    }
    if (session.items[i].requiresSpice && !session.items[i].spice) {
      session.awaiting = { type: "spice", itemIndex: i };
      return { reply: "Mild, Medium, or Hot?", session };
    }
  }

  /* order type */
  if (!session.orderType) {
    const ot = detectOrderType(text);
    if (!ot) return { reply: "Pickup or delivery?", session };
    session.orderType = ot;
  }

  /* sides (FIXED LOOP) */
  if (isNoSides(text)) {
    session.sides = [];
    session.sidesDone = true;
  }

  if (!session.sidesDone) {
    if (!session.sidesAsked) {
      session.sidesAsked = true;
      return { reply: "Would you like any sides or drinks?", session };
    }
    session.sidesDone = true;
  }

  /* confirmation */
  session.confirming = true;
  return { reply: buildConfirmationText(store, session), session };
}

// /**
//  * conversationEngine.js (SAFE CLEAN VERSION)
//  * - Slot-filling script engine (no AI)
//  * - Handles: menu / veg options / sides list
//  * - Handles: add/change pizzas, add sides anytime, confirmation edits
//  * - Prevents spice-loop by using awaiting state properly
//  */

// function norm(text) {
//   return String(text || "").trim();
// }
// function lower(text) {
//   return norm(text).toLowerCase();
// }
// function hasAny(t, arr) {
//   return arr.some((x) => t.includes(x));
// }

// /* =========================
//    BASIC INTENT HELPERS
// ========================= */

// function isConfirmYes(text) {
//   const t = lower(text);
//   return /^(yes|y|yeah|yep|correct|right|confirm|ok)$/i.test(t) || t.includes("confirm");
// }

// function isConfirmNo(text) {
//   const t = lower(text);
//   return /^(no|nope|wrong|incorrect)$/i.test(t) || t.includes("change") || t.includes("not correct");
// }

// function detectOrderType(text) {
//   const t = lower(text);
//   if (hasAny(t, ["pickup", "pick up", "picup", "carryout", "carry out", "takeaway", "take away"])) return "Pickup";
//   if (hasAny(t, ["delivery", "deliver", "drop off", "dropoff"])) return "Delivery";
//   return null;
// }

// function looksLikeAddress(text) {
//   const s = norm(text);
//   const hasNumber = /\d+/.test(s);
//   const hasStreetWord = /(st|street|ave|avenue|rd|road|blvd|boulevard|dr|drive|way|lane|ln|unit|apt|suite|#)/i.test(s);
//   return hasNumber && hasStreetWord;
// }

// function detectSize(text) {
//   const t = lower(text);
//   if (t.includes("large") || /\bl\b/.test(t)) return "Large";
//   if (t.includes("medium") || /\bm\b/.test(t)) return "Medium";
//   if (t.includes("small") || /\bs\b/.test(t)) return "Small";
//   return null;
// }

// function detectQty(text) {
//   const t = lower(text);
//   const m = t.match(/\b(\d+)\b/);
//   if (m) {
//     const n = parseInt(m[1], 10);
//     if (!Number.isNaN(n) && n > 0 && n < 50) return n;
//   }
//   if (t.includes("one ")) return 1;
//   if (t.includes("two ")) return 2;
//   if (t.includes("three ")) return 3;
//   return null;
// }

// /**
//  * Spice:
//  * - supports: mild, medium, hot
//  * - if user says "medium hot" => ambiguous
//  */
// function detectSpice(text) {
//   const t = lower(text);
//   const mild = hasAny(t, ["mild", "not spicy", "less spicy", "low spicy"]);
//   const medium = hasAny(t, ["medium", "mid", "medium spicy"]);
//   const hot = hasAny(t, ["hot", "spicy", "extra spicy", "very spicy"]);

//   const hits = [mild ? "Mild" : null, medium ? "Medium" : null, hot ? "Hot" : null].filter(Boolean);
//   if (hits.length === 1) return hits[0];
//   if (hits.length > 1) return "__AMBIGUOUS__";
//   return null;
// }

// function isAskingMenu(text) {
//   const t = lower(text);
//   return hasAny(t, ["menu", "what pizzas", "which pizzas", "pizza options", "pizza do you have", "available pizzas", "show menu"]);
// }
// function isAskingVeg(text) {
//   const t = lower(text);
//   return hasAny(t, ["veg", "veggie", "vegetarian", "veg options", "vegetarian pizzas"]);
// }
// function isAskingSides(text) {
//   const t = lower(text);
//   return hasAny(t, ["sides", "side options", "what sides", "which sides", "drinks", "what drinks", "addons", "add ons"]);
// }
// function isNoSides(text) {
//   const t = lower(text);
//   return hasAny(t, ["no sides", "no side", "without sides", "none", "no thanks", "dont want sides", "don't want sides"]);
// }

// /* =========================
//    STORE MENU HELPERS
// ========================= */

// function safeArray(x) {
//   return Array.isArray(x) ? x : [];
// }

// function normalizeForMatch(s) {
//   return lower(s)
//     .replace(/['"]/g, "")
//     .replace(/[^a-z0-9\s]/g, " ")
//     .replace(/\s+/g, " ")
//     .trim();
// }

// function getAllPizzas(store) {
//   const menu = store?.menu || {};
//   const pizzasByCat = menu.pizzas || {};
//   const out = [];
//   for (const cat of Object.keys(pizzasByCat)) {
//     for (const p of safeArray(pizzasByCat[cat])) {
//       out.push({ category: cat, ...p });
//     }
//   }
//   return out;
// }

// function getAllSides(store) {
//   const menu = store?.menu || {};
//   const sides = safeArray(menu.sides);
//   const beverages = safeArray(menu.beverages);
//   return [...sides, ...beverages];
// }

// function listText(names, max = 20) {
//   const show = names.slice(0, max);
//   const more = names.length > max ? ` (+${names.length - max} more)` : "";
//   return show.join(", ") + more;
// }

// function listMenuReply(store) {
//   const pizzas = getAllPizzas(store).map((p) => p.name);
//   if (!pizzas.length) return "Menu is not configured for this store yet.";
//   return `Here are our pizzas: ${listText(pizzas)}.`;
// }

// function listVegReply(store) {
//   const veg = getAllPizzas(store).filter((p) => p.veg === true).map((p) => p.name);
//   if (!veg.length) return "I don’t see vegetarian pizzas listed for this store right now.";
//   return `Vegetarian options: ${listText(veg)}.`;
// }

// function listSidesReply(store) {
//   const sides = getAllSides(store).map((s) => s.name);
//   if (!sides.length) return "Sides/drinks are not configured for this store yet.";
//   return `Sides/drinks available: ${listText(sides)}.`;
// }

// /* =========================
//    EXTRACT ITEMS FROM TEXT
// ========================= */

// function buildPizzaIndex(store) {
//   const all = getAllPizzas(store);
//   return all.map((p) => {
//     const base = normalizeForMatch(p.name);
//     const noPizza = base.replace(/\bpizza\b/g, "").trim();
//     const aliases = [base, noPizza, ...safeArray(p.aliases).map(normalizeForMatch)].filter(Boolean);
//     return { ...p, _aliases: Array.from(new Set(aliases)) };
//   });
// }

// function extractPizzasFromText(store, text) {
//   const t = normalizeForMatch(text);
//   const idx = buildPizzaIndex(store);

//   const found = [];
//   for (const p of idx) {
//     const hit = p._aliases.some((a) => a && t.includes(a));
//     if (!hit) continue;

//     found.push({
//       name: p.name,
//       qty: detectQty(text) || 1,
//       size: detectSize(text) || null,
//       spice: null,
//       requiresSpice: p.requiresSpice === true
//     });
//   }

//   // merge duplicates
//   const merged = [];
//   for (const it of found) {
//     const existing = merged.find((x) => x.name === it.name && x.size === it.size);
//     if (existing) existing.qty += it.qty;
//     else merged.push(it);
//   }

//   return merged;
// }

// function extractSidesFromText(store, text) {
//   const t = normalizeForMatch(text);
//   const all = getAllSides(store);

//   const found = [];
//   for (const s of all) {
//     const aliases = [normalizeForMatch(s.name), ...safeArray(s.aliases).map(normalizeForMatch)].filter(Boolean);
//     const hit = aliases.some((a) => a && t.includes(a));
//     if (!hit) continue;

//     found.push({ name: s.name, qty: detectQty(text) || 1 });
//   }

//   // merge duplicates
//   const merged = [];
//   for (const it of found) {
//     const existing = merged.find((x) => x.name === it.name);
//     if (existing) existing.qty += it.qty;
//     else merged.push(it);
//   }

//   return merged;
// }

// /* =========================
//    PUBLIC API
// ========================= */

// export function getGreetingText(store) {
//   return (
//     store?.conversation?.greeting ||
//     "New session started. What would you like to order? You can ask: menu, veg options, or sides."
//   );
// }

// export function buildConfirmationText(store, session) {
//   const orderType = session.orderType || "Pickup";

//   const pizzas =
//     session.items?.length
//       ? session.items
//           .map((it, i) => {
//             const qty = it.qty || 1;
//             const size = it.size ? it.size : "";
//             const spice = it.spice ? ` (${it.spice})` : "";
//             return `${i + 1}. ${qty} ${size} ${it.name}${spice}`.replace(/\s+/g, " ").trim();
//           })
//           .join(". ")
//       : "No pizzas";

//   const sides =
//     session.sides?.length
//       ? session.sides.map((s) => `${s.qty || 1} ${s.name}`.replace(/\s+/g, " ").trim()).join(", ")
//       : "No sides";

//   const addressPart =
//     orderType === "Delivery" ? ` Delivery address: ${session.address || "(missing)"}.` : "";

//   return `Please confirm your order. Order type: ${orderType}.${addressPart} ${pizzas}. Sides: ${sides}. Is that correct?`;
// }

// export function handleUserTurn(store, session, userText) {
//   const text = norm(userText);

//   // menu / veg / sides questions anytime
//   if (isAskingMenu(text)) return { reply: listMenuReply(store), session };
//   if (isAskingVeg(text)) return { reply: listVegReply(store), session };
//   if (isAskingSides(text)) return { reply: listSidesReply(store), session };

//   // If confirming: accept yes/no or treat as edits
//   if (session.confirming) {
//     if (isConfirmYes(text)) {
//       session.completed = true;
//       return { reply: "Perfect — your order is confirmed. Thank you!", session };
//     }
//     if (isConfirmNo(text)) {
//       session.confirming = false;
//       session.awaiting = null;
//       return { reply: "No problem — what would you like to change?", session };
//     }
//     // treat anything else as an edit request
//     session.confirming = false;
//   }

//   // 1) resolve awaited slot
//   if (session.awaiting?.type === "orderType") {
//     const ot = detectOrderType(text);
//     if (!ot) return { reply: "Pickup or delivery?", session };
//     session.orderType = ot;
//     session.awaiting = null;
//   }

//   if (session.awaiting?.type === "address") {
//     if (!looksLikeAddress(text)) {
//       return { reply: "Please tell me the delivery address (example: 123 Main St, Surrey).", session };
//     }
//     session.address = text;
//     session.awaiting = null;
//   }

//   if (session.awaiting?.type === "size") {
//     const i = session.awaiting.itemIndex;
//     const size = detectSize(text);
//     if (!size) return { reply: "What size would you like? Small, Medium, or Large?", session };
//     if (session.items?.[i]) session.items[i].size = size;
//     session.awaiting = null;
//   }

//   if (session.awaiting?.type === "spice") {
//     const i = session.awaiting.itemIndex;
//     const spice = detectSpice(text);

//     if (spice === "__AMBIGUOUS__") {
//       return { reply: "Please choose ONE spice level: Mild, Medium, or Hot.", session };
//     }
//     if (!spice) return { reply: "What spice level would you like? Mild, Medium, or Hot?", session };
//     if (session.items?.[i]) session.items[i].spice = spice;
//     session.awaiting = null;
//   }

//   // 2) merge info from free text anytime
//   const ot = detectOrderType(text);
//   if (ot) session.orderType = ot;

//   // sides
//   if (isNoSides(text)) {
//     session.sides = [];
//     session.sidesDone = true;
//   } else {
//     const sides = extractSidesFromText(store, text);
//     if (sides.length) {
//       session.sides = session.sides || [];
//       for (const s of sides) {
//         const ex = session.sides.find((x) => x.name === s.name);
//         if (ex) ex.qty += s.qty || 1;
//         else session.sides.push({ name: s.name, qty: s.qty || 1 });
//       }
//     }
//   }

//   // pizzas
//   const pizzas = extractPizzasFromText(store, text);
//   const changing = hasAny(lower(text), ["change", "actually", "instead", "replace", "no i want"]);
//   if (pizzas.length) {
//     session.items = session.items || [];
//     if (changing || session.items.length === 0) {
//       session.items = pizzas;
//     } else {
//       for (const p of pizzas) {
//         const ex = session.items.find((x) => x.name === p.name && x.size === p.size);
//         if (ex) ex.qty += p.qty || 1;
//         else session.items.push(p);
//       }
//     }
//   }

//   // 3) slot filling
//   if (!session.items || session.items.length === 0) {
//     return { reply: "What would you like to order? (You can also ask: menu)", session };
//   }

//   for (let i = 0; i < session.items.length; i++) {
//     if (!session.items[i].size) {
//       session.awaiting = { type: "size", itemIndex: i };
//       return { reply: `What size would you like for ${session.items[i].name}? Small, Medium, or Large?`, session };
//     }
//   }

//   for (let i = 0; i < session.items.length; i++) {
//     if (session.items[i].requiresSpice && !session.items[i].spice) {
//       session.awaiting = { type: "spice", itemIndex: i };
//       return { reply: `What spice level for ${session.items[i].name}? Mild, Medium, or Hot?`, session };
//     }
//   }

//   if (!session.orderType) {
//     session.awaiting = { type: "orderType" };
//     return { reply: "Pickup or delivery?", session };
//   }

//   if (session.orderType === "Delivery" && !session.address) {
//     session.awaiting = { type: "address" };
//     return { reply: "What’s the delivery address?", session };
//   }

//   if (!session.sidesDone && (!session.sides || session.sides.length === 0)) {
//     return { reply: "Would you like any sides or drinks? (You can say: add coke / no sides / which sides are available)", session };
//   }

//   session.confirming = true;
//   return { reply: buildConfirmationText(store, session), session };
// }
