/**
 * conversationEngine.js (SAFE CLEAN VERSION)
 * - Slot-filling script engine (no AI)
 * - Handles: menu / veg options / sides list
 * - Handles: add/change pizzas, add sides anytime, confirmation edits
 * - Prevents spice-loop by using awaiting state properly
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
  if (hasAny(t, ["pickup", "pick up", "picup", "carryout", "carry out", "takeaway", "take away"])) return "Pickup";
  if (hasAny(t, ["delivery", "deliver", "drop off", "dropoff"])) return "Delivery";
  return null;
}

function looksLikeAddress(text) {
  const s = norm(text);
  const hasNumber = /\d+/.test(s);
  const hasStreetWord = /(st|street|ave|avenue|rd|road|blvd|boulevard|dr|drive|way|lane|ln|unit|apt|suite|#)/i.test(s);
  return hasNumber && hasStreetWord;
}

function detectSize(text) {
  const t = lower(text);
  if (t.includes("large") || /\bl\b/.test(t)) return "Large";
  if (t.includes("medium") || /\bm\b/.test(t)) return "Medium";
  if (t.includes("small") || /\bs\b/.test(t)) return "Small";
  return null;
}

function detectQty(text) {
  const t = lower(text);
  const m = t.match(/\b(\d+)\b/);
  if (m) {
    const n = parseInt(m[1], 10);
    if (!Number.isNaN(n) && n > 0 && n < 50) return n;
  }
  if (t.includes("one ")) return 1;
  if (t.includes("two ")) return 2;
  if (t.includes("three ")) return 3;
  return null;
}

/**
 * Spice:
 * - supports: mild, medium, hot
 * - if user says "medium hot" => ambiguous
 */
function detectSpice(text) {
  const t = lower(text);
  const mild = hasAny(t, ["mild", "not spicy", "less spicy", "low spicy"]);
  const medium = hasAny(t, ["medium", "mid", "medium spicy"]);
  const hot = hasAny(t, ["hot", "spicy", "extra spicy", "very spicy"]);

  const hits = [mild ? "Mild" : null, medium ? "Medium" : null, hot ? "Hot" : null].filter(Boolean);
  if (hits.length === 1) return hits[0];
  if (hits.length > 1) return "__AMBIGUOUS__";
  return null;
}

function isAskingMenu(text) {
  const t = lower(text);
  return hasAny(t, ["menu", "what pizzas", "which pizzas", "pizza options", "pizza do you have", "available pizzas", "show menu"]);
}
function isAskingVeg(text) {
  const t = lower(text);
  return hasAny(t, ["veg", "veggie", "vegetarian", "veg options", "vegetarian pizzas"]);
}
function isAskingSides(text) {
  const t = lower(text);
  return hasAny(t, ["sides", "side options", "what sides", "which sides", "drinks", "what drinks", "addons", "add ons"]);
}
function isNoSides(text) {
  const t = lower(text);
  return hasAny(t, ["no sides", "no side", "without sides", "none", "no thanks", "dont want sides", "don't want sides"]);
}

/* =========================
   STORE MENU HELPERS
========================= */

function safeArray(x) {
  return Array.isArray(x) ? x : [];
}

function normalizeForMatch(s) {
  return lower(s)
    .replace(/['"]/g, "")
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function getAllPizzas(store) {
  const menu = store?.menu || {};
  const pizzasByCat = menu.pizzas || {};
  const out = [];
  for (const cat of Object.keys(pizzasByCat)) {
    for (const p of safeArray(pizzasByCat[cat])) {
      out.push({ category: cat, ...p });
    }
  }
  return out;
}

function getAllSides(store) {
  const menu = store?.menu || {};
  const sides = safeArray(menu.sides);
  const beverages = safeArray(menu.beverages);
  return [...sides, ...beverages];
}

function listText(names, max = 20) {
  const show = names.slice(0, max);
  const more = names.length > max ? ` (+${names.length - max} more)` : "";
  return show.join(", ") + more;
}

function listMenuReply(store) {
  const pizzas = getAllPizzas(store).map((p) => p.name);
  if (!pizzas.length) return "Menu is not configured for this store yet.";
  return `Here are our pizzas: ${listText(pizzas)}.`;
}

function listVegReply(store) {
  const veg = getAllPizzas(store).filter((p) => p.veg === true).map((p) => p.name);
  if (!veg.length) return "I don’t see vegetarian pizzas listed for this store right now.";
  return `Vegetarian options: ${listText(veg)}.`;
}

function listSidesReply(store) {
  const sides = getAllSides(store).map((s) => s.name);
  if (!sides.length) return "Sides/drinks are not configured for this store yet.";
  return `Sides/drinks available: ${listText(sides)}.`;
}

/* =========================
   EXTRACT ITEMS FROM TEXT
========================= */

function buildPizzaIndex(store) {
  const all = getAllPizzas(store);
  return all.map((p) => {
    const base = normalizeForMatch(p.name);
    const noPizza = base.replace(/\bpizza\b/g, "").trim();
    const aliases = [base, noPizza, ...safeArray(p.aliases).map(normalizeForMatch)].filter(Boolean);
    return { ...p, _aliases: Array.from(new Set(aliases)) };
  });
}

function extractPizzasFromText(store, text) {
  const t = normalizeForMatch(text);
  const idx = buildPizzaIndex(store);

  const found = [];
  for (const p of idx) {
    const hit = p._aliases.some((a) => a && t.includes(a));
    if (!hit) continue;

    found.push({
      name: p.name,
      qty: detectQty(text) || 1,
      size: detectSize(text) || null,
      spice: null,
      requiresSpice: p.requiresSpice === true
    });
  }

  // merge duplicates
  const merged = [];
  for (const it of found) {
    const existing = merged.find((x) => x.name === it.name && x.size === it.size);
    if (existing) existing.qty += it.qty;
    else merged.push(it);
  }

  return merged;
}

function extractSidesFromText(store, text) {
  const t = normalizeForMatch(text);
  const all = getAllSides(store);

  const found = [];
  for (const s of all) {
    const aliases = [normalizeForMatch(s.name), ...safeArray(s.aliases).map(normalizeForMatch)].filter(Boolean);
    const hit = aliases.some((a) => a && t.includes(a));
    if (!hit) continue;

    found.push({ name: s.name, qty: detectQty(text) || 1 });
  }

  // merge duplicates
  const merged = [];
  for (const it of found) {
    const existing = merged.find((x) => x.name === it.name);
    if (existing) existing.qty += it.qty;
    else merged.push(it);
  }

  return merged;
}

/* =========================
   PUBLIC API
========================= */

export function getGreetingText(store) {
  return (
    store?.conversation?.greeting ||
    "New session started. What would you like to order? You can ask: menu, veg options, or sides."
  );
}

export function buildConfirmationText(store, session) {
  const orderType = session.orderType || "Pickup";

  const pizzas =
    session.items?.length
      ? session.items
          .map((it, i) => {
            const qty = it.qty || 1;
            const size = it.size ? it.size : "";
            const spice = it.spice ? ` (${it.spice})` : "";
            return `${i + 1}. ${qty} ${size} ${it.name}${spice}`.replace(/\s+/g, " ").trim();
          })
          .join(". ")
      : "No pizzas";

  const sides =
    session.sides?.length
      ? session.sides.map((s) => `${s.qty || 1} ${s.name}`.replace(/\s+/g, " ").trim()).join(", ")
      : "No sides";

  const addressPart =
    orderType === "Delivery" ? ` Delivery address: ${session.address || "(missing)"}.` : "";

  return `Please confirm your order. Order type: ${orderType}.${addressPart} ${pizzas}. Sides: ${sides}. Is that correct?`;
}

export function handleUserTurn(store, session, userText) {
  const text = norm(userText);

  // menu / veg / sides questions anytime
  if (isAskingMenu(text)) return { reply: listMenuReply(store), session };
  if (isAskingVeg(text)) return { reply: listVegReply(store), session };
  if (isAskingSides(text)) return { reply: listSidesReply(store), session };

  // If confirming: accept yes/no or treat as edits
  if (session.confirming) {
    if (isConfirmYes(text)) {
      session.completed = true;
      return { reply: "Perfect — your order is confirmed. Thank you!", session };
    }
    if (isConfirmNo(text)) {
      session.confirming = false;
      session.awaiting = null;
      return { reply: "No problem — what would you like to change?", session };
    }
    // treat anything else as an edit request
    session.confirming = false;
  }

  // 1) resolve awaited slot
  if (session.awaiting?.type === "orderType") {
    const ot = detectOrderType(text);
    if (!ot) return { reply: "Pickup or delivery?", session };
    session.orderType = ot;
    session.awaiting = null;
  }

  if (session.awaiting?.type === "address") {
    if (!looksLikeAddress(text)) {
      return { reply: "Please tell me the delivery address (example: 123 Main St, Surrey).", session };
    }
    session.address = text;
    session.awaiting = null;
  }

  if (session.awaiting?.type === "size") {
    const i = session.awaiting.itemIndex;
    const size = detectSize(text);
    if (!size) return { reply: "What size would you like? Small, Medium, or Large?", session };
    if (session.items?.[i]) session.items[i].size = size;
    session.awaiting = null;
  }

  if (session.awaiting?.type === "spice") {
    const i = session.awaiting.itemIndex;
    const spice = detectSpice(text);

    if (spice === "__AMBIGUOUS__") {
      return { reply: "Please choose ONE spice level: Mild, Medium, or Hot.", session };
    }
    if (!spice) return { reply: "What spice level would you like? Mild, Medium, or Hot?", session };
    if (session.items?.[i]) session.items[i].spice = spice;
    session.awaiting = null;
  }

  // 2) merge info from free text anytime
  const ot = detectOrderType(text);
  if (ot) session.orderType = ot;

  // sides
  if (isNoSides(text)) {
    session.sides = [];
    session.sidesDone = true;
  } else {
    const sides = extractSidesFromText(store, text);
    if (sides.length) {
      session.sides = session.sides || [];
      for (const s of sides) {
        const ex = session.sides.find((x) => x.name === s.name);
        if (ex) ex.qty += s.qty || 1;
        else session.sides.push({ name: s.name, qty: s.qty || 1 });
      }
    }
  }

  // pizzas
  const pizzas = extractPizzasFromText(store, text);
  const changing = hasAny(lower(text), ["change", "actually", "instead", "replace", "no i want"]);
  if (pizzas.length) {
    session.items = session.items || [];
    if (changing || session.items.length === 0) {
      session.items = pizzas;
    } else {
      for (const p of pizzas) {
        const ex = session.items.find((x) => x.name === p.name && x.size === p.size);
        if (ex) ex.qty += p.qty || 1;
        else session.items.push(p);
      }
    }
  }

  // 3) slot filling
  if (!session.items || session.items.length === 0) {
    return { reply: "What would you like to order? (You can also ask: menu)", session };
  }

  for (let i = 0; i < session.items.length; i++) {
    if (!session.items[i].size) {
      session.awaiting = { type: "size", itemIndex: i };
      return { reply: `What size would you like for ${session.items[i].name}? Small, Medium, or Large?`, session };
    }
  }

  for (let i = 0; i < session.items.length; i++) {
    if (session.items[i].requiresSpice && !session.items[i].spice) {
      session.awaiting = { type: "spice", itemIndex: i };
      return { reply: `What spice level for ${session.items[i].name}? Mild, Medium, or Hot?`, session };
    }
  }

  if (!session.orderType) {
    session.awaiting = { type: "orderType" };
    return { reply: "Pickup or delivery?", session };
  }

  if (session.orderType === "Delivery" && !session.address) {
    session.awaiting = { type: "address" };
    return { reply: "What’s the delivery address?", session };
  }

  if (!session.sidesDone && (!session.sides || session.sides.length === 0)) {
    return { reply: "Would you like any sides or drinks? (You can say: add coke / no sides / which sides are available)", session };
  }

  session.confirming = true;
  return { reply: buildConfirmationText(store, session), session };
}


// /* =========================================================
//    engine/conversationEngine.js
//    Config-driven conversation engine (multi-store)
//    - Uses store.json (menu/sides/rules)
//    - Slot-filling: qty, size, spice, orderType, address
//    - Handles intents: menu, sides, change order, add items/sides
// ========================================================= */

// /* =========================
//    TEXT HELPERS
// ========================= */

// /**
//  * Normalize any input into a clean string.
//  * - Prevents crashes if input is undefined/null.
//  */
// function norm(text) {
//   return String(text || "").trim();
// }

// /**
//  * Lowercase normalized string for comparisons.
//  */
// function low(text) {
//   return norm(text).toLowerCase();
// }

// /**
//  * Detect "I'm done / that's all" kinds of phrases.
//  */
// function isDone(text) {
//   const t = low(text);
//   return /(no more|that's all|that’s all|thats all|done|finish|nothing else|nope|all good|complete)/i.test(t);
// }

// /**
//  * Detect explicit "no sides" style messages.
//  */
// function isNoSides(text) {
//   const t = low(text);
//   return /(no sides|no side|without sides|none|nothing|no thanks|no thank you|dont want sides|don't want sides)/i.test(t);
// }

// /**
//  * Detect confirmation yes.
//  */
// function isConfirmYes(text) {
//   return /^(yes|yeah|yep|correct|right|that's right|that’s right|that is right|confirm|confirmed)$/i.test(norm(text));
// }

// /**
//  * Detect confirmation no.
//  */
// function isConfirmNo(text) {
//   return /^(no|nope|wrong|incorrect|not correct|change|edit|modify)$/i.test(norm(text));
// }

// /**
//  * Detect if user is trying to change/replace order.
//  * Examples:
//  * - "no i ordered butter chicken"
//  * - "actually make it 2 large pepperoni"
//  * - "change it to ..."
//  */
// function isChangingOrder(text) {
//   const t = low(text);
//   return /(actually|change|instead|no i ordered|no, i ordered|not that|remove that|replace|update the order)/i.test(t);
// }

// /**
//  * Detect order type from free text.
//  */
// function detectOrderType(text) {
//   const t = low(text);
//   if (/(pickup|pick up|picup|carryout|carry out|takeaway|take away)/i.test(t)) return "Pickup";
//   if (/(delivery|deliver|drop off|dropoff)/i.test(t)) return "Delivery";
//   return null;
// }

// /**
//  * Detect spice from free text.
//  * Allows "medium hot" by picking the *last* match in text.
//  */
// function detectSpice(text, spiceLevels = ["Mild", "Medium", "Hot"]) {
//   const t = low(text);

//   // Map common words to canonical spice levels
//   const map = {
//     mild: "Mild",
//     "not spicy": "Mild",
//     low: "Mild",
//     medium: "Medium",
//     mid: "Medium",
//     hot: "Hot",
//     spicy: "Hot",
//     "extra spicy": "Hot",
//     "very spicy": "Hot"
//   };

//   // Find matches in order they appear; keep the last one
//   let found = null;

//   // Check explicit keywords first
//   for (const key of Object.keys(map)) {
//     if (t.includes(key)) found = map[key];
//   }

//   // If store provides custom spiceLevels, ensure it’s one of them
//   if (found && Array.isArray(spiceLevels) && spiceLevels.length) {
//     const allowed = new Set(spiceLevels.map((s) => String(s)));
//     if (!allowed.has(found)) return null;
//   }

//   return found;
// }

// /**
//  * Detect size from free text.
//  * Allows shorthand: s/m/l.
//  */
// function detectSize(text, sizes = ["Small", "Medium", "Large"]) {
//   const t = low(text);

//   // If store defines sizes, use them as source of truth
//   const allowed = new Set((sizes || []).map((s) => low(s)));

//   // Simple common mapping
//   const candidates = [
//     { re: /\bsmall\b|\bs\b/i, val: "Small" },
//     { re: /\bmedium\b|\bm\b/i, val: "Medium" },
//     { re: /\blarge\b|\bl\b/i, val: "Large" }
//   ];

//   for (const c of candidates) {
//     if (c.re.test(t)) {
//       // If store sizes are custom, only accept if present
//       if (allowed.size && !allowed.has(low(c.val))) continue;
//       return c.val;
//     }
//   }

//   return null;
// }

// /**
//  * Detect a quantity number from the text.
//  * - "2 large ..." -> 2
//  * - "one large ..." -> 1 (supports small set of words)
//  */
// function detectQty(text) {
//   const t = low(text);

//   // Digits first
//   const m = t.match(/\b(\d+)\b/);
//   if (m) return Math.max(1, parseInt(m[1], 10));

//   // Small word support
//   const wordMap = {
//     one: 1,
//     two: 2,
//     three: 3,
//     four: 4,
//     five: 5
//   };

//   for (const w of Object.keys(wordMap)) {
//     if (new RegExp(`\\b${w}\\b`, "i").test(t)) return wordMap[w];
//   }

//   return null;
// }

// /**
//  * User asks menu?
//  */
// function isAskingMenu(text) {
//   const t = low(text);
//   return /(menu|what pizzas|which pizzas|pizza options|pizza do you have|available pizzas|what do you have)/i.test(t);
// }

// /**
//  * User asks sides?
//  */
// function isAskingSides(text) {
//   const t = low(text);
//   return /(sides|side options|what sides|which sides|sides available|addons|add ons|drinks|what drinks)/i.test(t);
// }

// /**
//  * Extract sides mentioned in user message.
//  * - First try matching store sides
//  * - Then fallback to common items
//  */
// function extractSidesFromText(text, knownSides = []) {
//   const t = low(text);
//   const found = new Set();

//   // Match store sides by inclusion
//   for (const s of knownSides || []) {
//     const sLow = low(s);
//     if (sLow && t.includes(sLow)) found.add(String(s));
//   }

//   // Fallback detection for common items
//   const common = ["Coke", "Sprite", "Pepsi", "Water", "Fries", "Garlic Bread", "Wings", "Ranch"];
//   for (const c of common) {
//     if (t.includes(low(c))) found.add(c);
//   }

//   return Array.from(found);
// }

// /* =========================
//    MENU MATCHING
// ========================= */

// /**
//  * Build a flat list of menu matchers from store config.
//  * Each matcher has:
//  * - name (canonical)
//  * - aliases (strings)
//  */
// function getMenuMatchers(store) {
//   const menu = Array.isArray(store?.menu) ? store.menu : [];

//   return menu
//     .filter((m) => m && m.name)
//     .map((m) => {
//       const aliases = new Set();

//       // Include name itself as an alias
//       aliases.add(String(m.name));

//       // Include custom aliases
//       if (Array.isArray(m.aliases)) {
//         for (const a of m.aliases) aliases.add(String(a));
//       }

//       return {
//         name: String(m.name),
//         requires: Array.isArray(m.requires) ? m.requires : ["qty", "size"], // safe default
//         aliases: Array.from(aliases)
//       };
//     });
// }

// /**
//  * Find which pizza items are mentioned in text.
//  * Returns array of canonical item objects (name + requires).
//  */
// function findItemsInText(store, text) {
//   const t = low(text);
//   const matchers = getMenuMatchers(store);

//   const found = [];

//   for (const m of matchers) {
//     for (const alias of m.aliases) {
//       const a = low(alias);
//       if (!a) continue;

//       // simple contains match
//       if (t.includes(a)) {
//         found.push({ name: m.name, requires: m.requires });
//         break;
//       }
//     }
//   }

//   // Deduplicate by name
//   const seen = new Set();
//   return found.filter((x) => {
//     if (seen.has(x.name)) return false;
//     seen.add(x.name);
//     return true;
//   });
// }

// /* =========================
//    OUTPUT BUILDERS
// ========================= */

// /**
//  * List pizzas for the store.
//  */
// function buildMenuText(store) {
//   const menu = Array.isArray(store?.menu) ? store.menu : [];
//   if (!menu.length) return "Menu is not set for this store yet.";

//   const names = menu.map((m) => m.name).filter(Boolean);
//   return `Here are our pizzas: ${names.join(", ")}.`;
// }

// /**
//  * List sides for the store.
//  */
// function buildSidesText(store) {
//   const sides = Array.isArray(store?.sides) ? store.sides : [];
//   if (!sides.length) return "We don’t have sides listed right now.";
//   return `Available sides: ${sides.join(", ")}.`;
// }

// /* =========================
//    SESSION MUTATION
// ========================= */

// /**
//  * Ensure required session fields exist.
//  * (Avoid undefined errors across Twilio + chat.)
//  */
// function ensureSessionShape(session) {
//   if (!session.items) session.items = [];
//   if (!session.sides) session.sides = [];
//   if (typeof session.confirming !== "boolean") session.confirming = false;
//   if (typeof session.sidesAsked !== "boolean") session.sidesAsked = false;
//   if (!session.orderType) session.orderType = null;
//   if (!session.address) session.address = null;
// }

// /**
//  * Merge/Upsert an item into session.items.
//  * - If item exists by name, update missing fields
//  * - If not exists, create it
//  */
// function upsertItem(session, itemName, patch) {
//   const idx = session.items.findIndex((i) => low(i.name) === low(itemName));

//   if (idx === -1) {
//     session.items.push({
//       name: itemName,
//       qty: patch.qty ?? null,
//       size: patch.size ?? null,
//       spice: patch.spice ?? null
//     });
//     return;
//   }

//   const existing = session.items[idx];

//   // Only overwrite if patch has value
//   if (patch.qty != null) existing.qty = patch.qty;
//   if (patch.size) existing.size = patch.size;
//   if (patch.spice) existing.spice = patch.spice;
// }

// /**
//  * If user is answering a slot question (size/spice/qty),
//  * apply it to the most recent incomplete item.
//  */
// function applySlotToLatestIncompleteItem(store, session, text) {
//   const sizes = store?.sizes || ["Small", "Medium", "Large"];
//   const spiceLevels = store?.spiceLevels || ["Mild", "Medium", "Hot"];

//   const size = detectSize(text, sizes);
//   const spice = detectSpice(text, spiceLevels);
//   const qty = detectQty(text);

//   // Find the last item that still has missing fields
//   for (let i = session.items.length - 1; i >= 0; i--) {
//     const it = session.items[i];

//     // Apply qty if missing
//     if (qty != null && (it.qty == null || it.qty === 0)) {
//       it.qty = qty;
//       return true;
//     }

//     // Apply size if missing
//     if (size && !it.size) {
//       it.size = size;
//       return true;
//     }

//     // Apply spice if missing
//     if (spice && !it.spice) {
//       it.spice = spice;
//       return true;
//     }
//   }

//   return false;
// }

// /* =========================
//    PUBLIC API
// ========================= */

// /**
//  * Apply user input into the session.
//  * Returns a string if you should reply immediately (menu/sides/help),
//  * otherwise returns null and engine will continue normally.
//  *
//  * IMPORTANT:
//  * - Call this in index.js BEFORE calling nextQuestion()
//  */
// export function applyUserInput(store, session, text, ai = null) {
//   ensureSessionShape(session);

//   const userText = norm(text);

//   // Store raw for debugging
//   session.lastUserText = userText;

//   // If user says "yes/no" during confirm phase, let index.js handle ticketing
//   // BUT we still allow them to ask sides/menu or modify order here.
//   if (session.confirming) {
//     // If they asked menu/sides while confirming, answer it.
//     if (isAskingMenu(userText)) return buildMenuText(store);
//     if (isAskingSides(userText)) return buildSidesText(store);

//     // If they try to change/add something while confirming, exit confirm mode.
//     if (isChangingOrder(userText) || findItemsInText(store, userText).length || extractSidesFromText(userText, store?.sides).length) {
//       session.confirming = false;
//     }
//   }

//   // Direct questions always work
//   if (isAskingMenu(userText)) return buildMenuText(store);
//   if (isAskingSides(userText)) return buildSidesText(store);

//   // Order type detection
//   const ot = detectOrderType(userText);
//   if (ot) session.orderType = ot;

//   // If delivery and user typed an address-like thing, capture it
//   // (Basic heuristic: has a number + street-ish word)
//   if (session.orderType === "Delivery" && !session.address) {
//     const t = low(userText);
//     if (/\b\d{1,5}\b/.test(t) && /(st|street|ave|avenue|rd|road|blvd|boulevard|way|dr|drive|lane|ln)\b/i.test(t)) {
//       session.address = userText;
//     }
//   }

//   // Handle "no sides"
//   if (isNoSides(userText)) {
//     session.sides = [];
//     session.sidesAsked = true; // important: prevents sides loop
//   }

//   // Merge sides from text
//   const sideHits = extractSidesFromText(userText, store?.sides || []);
//   if (sideHits.length) {
//     // Add unique sides
//     const set = new Set(session.sides.map((s) => String(s)));
//     for (const s of sideHits) set.add(String(s));
//     session.sides = Array.from(set);

//     // If they added sides, we consider sides asked/handled
//     session.sidesAsked = true;
//   }

//   // Decide whether to replace order or add to it
//   const replaceOrder = isChangingOrder(userText);

//   // Find pizzas mentioned
//   const pizzas = findItemsInText(store, userText);

//   // Extract common slots from the same message
//   const qty = detectQty(userText);
//   const size = detectSize(userText, store?.sizes || ["Small", "Medium", "Large"]);
//   const spice = detectSpice(userText, store?.spiceLevels || ["Mild", "Medium", "Hot"]);

//   if (pizzas.length) {
//     // If user is changing order, replace pizzas (but keep orderType unless they changed it)
//     if (replaceOrder) {
//       session.items = [];
//     }

//     // Upsert each detected pizza
//     for (const p of pizzas) {
//       upsertItem(session, p.name, {
//         qty: qty ?? 1, // default 1 if they mentioned an item
//         size: size ?? null,
//         spice: spice ?? null
//       });

//       // Save requires per item name for later missing-check
//       if (!session.itemRequirements) session.itemRequirements = {};
//       session.itemRequirements[p.name] = p.requires;
//     }
//   } else {
//     // No pizza detected; maybe they are answering the engine's last question
//     // Apply size/spice/qty to the most recent incomplete item.
//     applySlotToLatestIncompleteItem(store, session, userText);
//   }

//   // If they said "done", we push towards confirmation (but engine will confirm only if nothing missing)
//   if (isDone(userText)) {
//     session.doneSignal = true;
//   } else {
//     session.doneSignal = false;
//   }

//   return null;
// }

// /**
//  * Decide the next question based on session state.
//  * Returns:
//  * - a string prompt, or
//  * - "confirm" when ready to confirm the order
//  */
// export function nextQuestion(store, session) {
//   ensureSessionShape(session);

//   const convo = store?.conversation || {};
//   const sizes = store?.sizes || ["Small", "Medium", "Large"];
//   const spiceLevels = store?.spiceLevels || ["Mild", "Medium", "Hot"];
//   const sides = Array.isArray(store?.sides) ? store.sides : [];

//   // 1) Ask pickup/delivery first (if store wants it)
//   if (convo.askOrderType && !session.orderType) {
//     return convo.orderTypePrompt || "Pickup or delivery?";
//   }

//   // 2) If delivery, collect required delivery fields
//   const deliveryReq = store?.requirements?.delivery || [];
//   if (session.orderType === "Delivery") {
//     if (deliveryReq.includes("address") && !session.address) {
//       return "What is the delivery address?";
//     }
//   }

//   // 3) Must have at least one item
//   if (!session.items.length) {
//     return convo.greeting || "What would you like to order?";
//   }

//   // 4) Slot filling per item (qty/size/spice)
//   for (const it of session.items) {
//     const requires =
//       (session.itemRequirements && session.itemRequirements[it.name]) ||
//       // fallback: find in store.menu
//       (getMenuMatchers(store).find((m) => m.name === it.name)?.requires || ["qty", "size"]);

//     // qty
//     if (requires.includes("qty") && (it.qty == null || it.qty === 0)) {
//       return `How many ${it.name} pizzas would you like?`;
//     }

//     // size
//     if (requires.includes("size") && !it.size) {
//       return `What size for ${it.name}? ${sizes.join(", ")}?`;
//     }

//     // spice
//     if (requires.includes("spice") && !it.spice) {
//       return `What spice level for ${it.name}? ${spiceLevels.join(", ")}?`;
//     }
//   }

//   // 5) Ask sides exactly once (prevents sides loop)
//   if (!session.sidesAsked) {
//     session.sidesAsked = true;

//     // If store has sides, show them (this fixes your “no sides listed” bug)
//     if (sides.length) {
//       return `Would you like any sides? ${buildSidesText(store)} (You can also say: no sides)`;
//     }

//     return "Would you like any sides? (You can also say: no sides)";
//   }

//   // 6) If user signaled done OR we've already asked sides, we can confirm
//   // (But only confirm when everything required is collected)
//   return "confirm";
// }
