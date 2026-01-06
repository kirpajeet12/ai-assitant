/**
 * src/engine/conversationEngine.js
 *
 * Goal:
 * - Script/slot-filling (NOT random AI)
 * - Never miss required details:
 *   - pizza name
 *   - size
 *   - qty (default 1)
 *   - spice (only if required by that pizza)
 *   - pickup/delivery
 *   - address if delivery
 * - Natural flow:
 *   - user can ask menu / veg options / sides anytime
 *   - user can change order mid-way
 *   - user can add sides even after confirmation prompt
 *
 * IMPORTANT:
 * - This file MUST NOT have "return" at top-level.
 * - All returns must be inside functions.
 */

const ENGINE_VERSION = "1.0.1";

/* =========================
   TEXT HELPERS
========================= */

// Normalize (trim)
function norm(text) {
  return String(text || "").trim();
}

// Lowercase normalized
function lower(text) {
  return norm(text).toLowerCase();
}

// Check if text includes any phrase
function hasAny(t, arr) {
  return arr.some((x) => t.includes(x));
}

// Detect "done" meanings
function isDone(text) {
  const t = lower(text);
  return (
    t === "done" ||
    t === "finish" ||
    t === "finished" ||
    t.includes("that's all") ||
    t.includes("thats all") ||
    t.includes("nothing else") ||
    t.includes("no more") ||
    t.includes("all good")
  );
}

// Detect explicit "no sides"
function isNoSides(text) {
  const t = lower(text);
  return hasAny(t, [
    "no sides",
    "no side",
    "without sides",
    "none",
    "nothing",
    "no thanks",
    "dont want sides",
    "don't want sides"
  ]);
}

// Confirm YES
function isConfirmYes(text) {
  const t = lower(text);
  return (
    t === "yes" ||
    t === "y" ||
    t === "yeah" ||
    t === "yep" ||
    t === "correct" ||
    t === "right" ||
    t.includes("confirm") ||
    t.includes("that's right") ||
    t.includes("that is right")
  );
}

// Confirm NO
function isConfirmNo(text) {
  const t = lower(text);
  return (
    t === "no" ||
    t === "nope" ||
    t === "wrong" ||
    t === "incorrect" ||
    t.includes("not correct") ||
    t.includes("change") ||
    t.includes("edit")
  );
}

// Pickup vs Delivery
function detectOrderType(text) {
  const t = lower(text);

  if (/(pickup|pick\s*up|picup|carry\s*out|take\s*away)/i.test(t)) return "Pickup";
  if (/(delivery|deliver|drop\s*off|dropoff)/i.test(t)) return "Delivery";

  return null;
}

/**
 * Spice detection:
 * - Accepts "medium", "medium hot", "not spicy", "extra spicy"
 * - If multiple detected, returns "__AMBIGUOUS__"
 */
function detectSpice(text) {
  const t = lower(text);

  const mild = /(mild|not spicy|low spicy|less spicy)/i.test(t);
  const medium = /(medium|mid|medium spicy)/i.test(t);
  const hot = /(hot|spicy|extra spicy|very spicy)/i.test(t);

  const hits = [];
  if (mild) hits.push("Mild");
  if (medium) hits.push("Medium");
  if (hot) hits.push("Hot");

  if (hits.length === 1) return hits[0];
  if (hits.length > 1) return "__AMBIGUOUS__";
  return null;
}

// Size detection (word boundaries so it doesn't randomly match)
function detectSize(text) {
  const t = lower(text);

  if (/\blarge\b|\bl\b/.test(t)) return "Large";
  if (/\bmedium\b|\bm\b/.test(t)) return "Medium";
  if (/\bsmall\b|\bs\b/.test(t)) return "Small";

  return null;
}

// Quantity detection (digits + a few words)
function detectQty(text) {
  const t = lower(text);

  const m = t.match(/\b(\d+)\b/);
  if (m) {
    const n = parseInt(m[1], 10);
    if (!Number.isNaN(n) && n > 0 && n < 50) return n;
  }

  // Word qty
  if (/\bone\b|\ba\b|\ban\b/.test(t)) return 1;
  if (/\btwo\b/.test(t)) return 2;
  if (/\bthree\b/.test(t)) return 3;
  if (/\bfour\b/.test(t)) return 4;
  if (/\bfive\b/.test(t)) return 5;

  return null;
}

// User asking menu?
function isAskingMenu(text) {
  const t = lower(text);
  return hasAny(t, [
    "menu",
    "what pizzas",
    "which pizzas",
    "pizza options",
    "pizza do you have",
    "available pizzas",
    "show menu",
    "what do you have"
  ]);
}

// User asking veg?
function isAskingVegOptions(text) {
  const t = lower(text);
  return hasAny(t, ["veg", "veggie options", "vegetarian", "vegetarian pizzas", "veg pizzas"]);
}

// User asking sides?
function isAskingSides(text) {
  const t = lower(text);
  return hasAny(t, ["sides", "side options", "what sides", "which sides", "addons", "add ons", "drinks", "what drinks"]);
}

// Heuristic: address
function looksLikeAddress(text) {
  const t = norm(text);
  const hasNumber = /\d+/.test(t);
  const hasStreetWord = /(st|street|ave|avenue|rd|road|blvd|boulevard|dr|drive|way|lane|ln|unit|apt|suite|#)/i.test(t);
  return hasNumber && hasStreetWord;
}

/* =========================
   STORE MENU HELPERS
========================= */

function safeArray(x) {
  return Array.isArray(x) ? x : [];
}

// Flatten pizzas from store.menu.pizzas = { category: [ {name,...}, ... ] }
function getAllPizzaItems(store) {
  const menu = store?.menu || {};
  const pizzas = menu.pizzas || {};

  const categories = Object.keys(pizzas);
  const all = [];

  for (const cat of categories) {
    const arr = safeArray(pizzas[cat]);
    for (const p of arr) {
      all.push({
        category: cat,
        ...p
      });
    }
  }

  return all;
}

// Combine sides + beverages
function getAllSideItems(store) {
  const menu = store?.menu || {};
  const sides = safeArray(menu.sides);
  const beverages = safeArray(menu.beverages);
  return [...sides, ...beverages];
}

// List formatting
function formatList(names, max = 12) {
  const list = names.slice(0, max);
  const more = names.length > max ? ` (+${names.length - max} more)` : "";
  return list.join(", ") + more;
}

// Menu text
function listPizzasText(store) {
  const all = getAllPizzaItems(store);
  const names = all.map((p) => p.name);

  if (!names.length) {
    return "Menu is not loaded for this store yet. Please add pizzas inside the store JSON (store.menu.pizzas).";
  }

  return `Here are our pizzas: ${formatList(names, 20)}. Example: “2 large butter chicken pizzas” or “1 medium garden fresh”.`;
}

// Veg menu text
function listVegPizzasText(store) {
  const all = getAllPizzaItems(store);
  const veg = all.filter((p) => p.veg === true).map((p) => p.name);

  if (!veg.length) {
    return "I don’t see vegetarian pizzas listed for this store right now. Ask “menu” to hear everything.";
  }

  return `Vegetarian options: ${formatList(veg, 20)}.`;
}

// Sides text
function listSidesText(store) {
  const all = getAllSideItems(store);
  const names = all.map((s) => s.name);

  if (!names.length) {
    return "This store has no sides/drinks configured yet in store.menu.sides / store.menu.beverages.";
  }

  return `Sides/drinks available: ${formatList(names, 20)}.`;
}

/* =========================
   MATCHING USER TEXT → MENU
========================= */

// Normalize string for matching
function normalizeForMatch(s) {
  return lower(s)
    .replace(/['"]/g, "")
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// Build pizza index + aliases
function buildPizzaIndex(store) {
  const all = getAllPizzaItems(store);

  return all.map((p) => {
    const base = normalizeForMatch(p.name);
    const noPizza = base.replace(/\bpizza\b/g, "").trim();

    const aliases = [base, noPizza];

    // Include store-defined aliases if present
    for (const a of safeArray(p.aliases)) {
      aliases.push(normalizeForMatch(a));
    }

    const uniq = Array.from(new Set(aliases.filter(Boolean)));

    return {
      ...p,
      _aliases: uniq
    };
  });
}

// Extract pizzas mentioned in user text
function extractPizzasFromText(store, text) {
  const t = normalizeForMatch(text);
  const pizzas = buildPizzaIndex(store);

  const found = [];

  for (const p of pizzas) {
    const hit = p._aliases.some((a) => a && t.includes(a));
    if (!hit) continue;

    // Qty/size from same message
    const qty = detectQty(text) || 1;
    const size = detectSize(text) || null;

    found.push({
      name: p.name,
      category: p.category,
      qty,
      size,
      spice: null,
      requiresSpice: p.requiresSpice === true,
      veg: p.veg === true
    });
  }

  // Merge duplicates (same name + size)
  const merged = [];
  for (const item of found) {
    const existing = merged.find((x) => x.name === item.name && x.size === item.size);
    if (existing) existing.qty += item.qty;
    else merged.push(item);
  }

  return merged;
}

// Extract sides mentioned in user text
function extractSidesFromText(store, text) {
  const t = normalizeForMatch(text);
  const sideItems = getAllSideItems(store);

  const found = [];
  for (const s of sideItems) {
    const aliases = [
      normalizeForMatch(s.name),
      ...safeArray(s.aliases).map(normalizeForMatch)
    ].filter(Boolean);

    const hit = aliases.some((a) => a && t.includes(a));
    if (!hit) continue;

    found.push({
      name: s.name,
      qty: detectQty(text) || 1
    });
  }

  // Merge by name
  const merged = [];
  for (const item of found) {
    const existing = merged.find((x) => x.name === item.name);
    if (existing) existing.qty += item.qty;
    else merged.push(item);
  }

  return merged;
}

/* =========================
   EXPORTED: GREETING
========================= */

export function getGreetingText(store) {
  return (
    store?.conversation?.greeting ||
    "New session started. What would you like to order? You can ask: menu, veg options, or sides."
  );
}

/* =========================
   EXPORTED: CONFIRMATION TEXT
========================= */

export function buildConfirmationText(store, session) {
  const orderType = session.orderType || "Pickup";

  // Build pizza lines
  const itemsText = session.items.length
    ? session.items
        .map((it, idx) => {
          const qty = it.qty || 1;
          const size = it.size ? `${it.size}` : "";
          const spice = it.spice ? ` (${it.spice})` : "";
          return `${idx + 1}. ${qty} ${size} ${it.name}${spice}`.replace(/\s+/g, " ").trim();
        })
        .join(". ")
    : "No pizzas selected";

  // Build sides line
  const sidesText = session.sides.length
    ? session.sides
        .map((s) => `${s.qty || 1} ${s.name}`.replace(/\s+/g, " ").trim())
        .join(", ")
    : "No sides";

  // Address only if delivery
  const addressText =
    orderType === "Delivery"
      ? session.address
        ? ` Delivery address: ${session.address}.`
        : " Delivery address: (missing)."
      : "";

  return `Please confirm your order. Order type: ${orderType}.${addressText} ${itemsText}. Sides: ${sidesText}. Is that correct?`;
}

/* =========================
   EXPORTED: HANDLE USER TURN
========================= */

export function handleUserTurn(store, session, userText) {
  const text = norm(userText);

  // If store missing
  if (!store) {
    return { reply: "Sorry — I can’t find that store right now.", session };
  }

  // Always allow menu questions anytime (do NOT break the session)
  if (isAskingMenu(text)) {
    // Keep the session as-is; just answer
    return { reply: listPizzasText(store), session };
  }

  if (isAskingVegOptions(text)) {
    return { reply: listVegPizzasText(store), session };
  }

  if (isAskingSides(text)) {
    // If sides not configured, we still answer truthfully
    const msg = listSidesText(store);

    // If we were in the "ask sides" phase, follow with a prompt
    if (!session.sidesDone) {
      return { reply: `${msg} You can say: “add coke” or “no sides”.`, session };
    }

    return { reply: msg, session };
  }

  /**
   * If we are currently in confirmation stage:
   * - YES completes
   * - NO exits confirmation and allows edits
   * - Any other message is treated like an edit (add sides, change pizza, etc.)
   */
  if (session.confirming) {
    if (isConfirmYes(text)) {
      session.completed = true;
      return { reply: "Perfect — your order is confirmed. Thank you!", session };
    }

    if (isConfirmNo(text)) {
      session.confirming = false;
      session.awaiting = null;
      return {
        reply: "No problem — what would you like to change? (pizza, size, spice, sides, pickup/delivery)",
        session
      };
    }

    // Treat anything else as an edit
    session.confirming = false;
  }

  /* =========================
     1) Resolve awaited slot FIRST
     (but: if user clearly gives a NEW pizza in the same message,
     we will treat it as change, not as an answer to the old question)
  ========================= */

  // If awaiting something, but user mentions pizzas in same message,
  // we should allow changing order instead of forcing loop.
  const pizzasMentionedNow = extractPizzasFromText(store, text);
  const strongChangeSignal = hasAny(lower(text), ["change", "actually", "instead", "replace", "no i want", "no, i want"]);

  if (session.awaiting && pizzasMentionedNow.length && strongChangeSignal) {
    // Clear awaiting because user is changing order
    session.awaiting = null;
  }

  // Awaiting pickup/delivery
  if (session.awaiting?.type === "orderType") {
    const ot = detectOrderType(text);
    if (ot) {
      session.orderType = ot;
      session.awaiting = null;
    } else {
      return { reply: "Pickup or delivery?", session };
    }
  }

  // Awaiting address
  if (session.awaiting?.type === "address") {
    if (looksLikeAddress(text)) {
      session.address = text;
      session.awaiting = null;
    } else {
      return { reply: "Please tell me the delivery address (example: 123 Main St, Surrey).", session };
    }
  }

  // Awaiting size for an item
  if (session.awaiting?.type === "size") {
    const idx = session.awaiting.itemIndex;
    const size = detectSize(text);

    if (size && session.items[idx]) {
      session.items[idx].size = size;
      session.awaiting = null;
    } else {
      return { reply: "What size would you like? Small, Medium, or Large?", session };
    }
  }

  // Awaiting spice for an item
  if (session.awaiting?.type === "spice") {
    const idx = session.awaiting.itemIndex;
    const spice = detectSpice(text);

    if (spice === "__AMBIGUOUS__") {
      return { reply: "Got it — please choose ONE spice level: Mild, Medium, or Hot.", session };
    }

    if (spice && session.items[idx]) {
      session.items[idx].spice = spice;
      session.awaiting = null;
    } else {
      return { reply: "What spice level would you like? Mild, Medium, or Hot?", session };
    }
  }

  /* =========================
     2) Merge free-text info
  ========================= */

  // Order type can appear anytime
  const orderType = detectOrderType(text);
  if (orderType) session.orderType = orderType;

  // If user says "delivery" and gives an address in the same message
  if (session.orderType === "Delivery" && !session.address && looksLikeAddress(text)) {
    session.address = text;
  }

  // Sides can appear anytime
  const extractedSides = extractSidesFromText(store, text);
  if (extractedSides.length) {
    for (const s of extractedSides) {
      const existing = session.sides.find((x) => x.name === s.name);
      if (existing) existing.qty += s.qty || 1;
      else session.sides.push({ name: s.name, qty: s.qty || 1 });
    }
    // If they added sides, consider sides question handled
    session.sidesDone = true;
  }

  // Explicit "no sides"
  if (isNoSides(text)) {
    session.sides = [];
    session.sidesDone = true;
  }

  // Pizzas from text
  const extractedPizzas = pizzasMentionedNow.length ? pizzasMentionedNow : extractPizzasFromText(store, text);

  // If user signals change, replace pizzas
  const changingOrder = strongChangeSignal;

  if (extractedPizzas.length) {
    if (changingOrder || session.items.length === 0) {
      session.items = extractedPizzas.map((p) => ({
        name: p.name,
        qty: p.qty || 1,
        size: p.size || null,
        spice: null,
        requiresSpice: p.requiresSpice === true
      }));
    } else {
      // Merge into existing items
      for (const p of extractedPizzas) {
        const existing = session.items.find((x) => x.name === p.name && x.size === p.size);
        if (existing) existing.qty += p.qty || 1;
        else {
          session.items.push({
            name: p.name,
            qty: p.qty || 1,
            size: p.size || null,
            spice: null,
            requiresSpice: p.requiresSpice === true
          });
        }
      }
    }
  }

  // If user provides size alone and we have exactly 1 pizza missing size,
  // fill it automatically (prevents size loops).
  if (!extractedPizzas.length) {
    const sizeOnly = detectSize(text);
    if (sizeOnly) {
      const missingSizeIndexes = session.items
        .map((it, i) => ({ it, i }))
        .filter((x) => !x.it.size);

      if (missingSizeIndexes.length === 1) {
        session.items[missingSizeIndexes[0].i].size = sizeOnly;
      }
    }
  }

  // If user provides spice alone and we have exactly 1 pizza missing spice,
  // fill it automatically (prevents spice loops).
  const spiceOnly = detectSpice(text);
  if (spiceOnly && spiceOnly !== "__AMBIGUOUS__") {
    const missingSpiceIndexes = session.items
      .map((it, i) => ({ it, i }))
      .filter((x) => x.it.requiresSpice && !x.it.spice);

    if (missingSpiceIndexes.length === 1) {
      session.items[missingSpiceIndexes[0].i].spice = spiceOnly;
    }
  }

  /* =========================
     3) Next required question
  ========================= */

  // Must have at least 1 pizza
  if (!session.items.length) {
    return {
      reply: "What would you like to order? (You can say: “2 large butter chicken pizzas” or ask “menu”.)",
      session
    };
  }

  // Ensure every pizza has size
  for (let i = 0; i < session.items.length; i++) {
    if (!session.items[i].size) {
      session.awaiting = { type: "size", itemIndex: i };
      return {
        reply: `What size would you like for ${session.items[i].name}? Small, Medium, or Large?`,
        session
      };
    }
  }

  // Ensure spice for pizzas that require it
  for (let i = 0; i < session.items.length; i++) {
    if (session.items[i].requiresSpice && !session.items[i].spice) {
      session.awaiting = { type: "spice", itemIndex: i };
      return {
        reply: `What spice level for ${session.items[i].name}? Mild, Medium, or Hot?`,
        session
      };
    }
  }

  // Ensure pickup/delivery
  if (!session.orderType) {
    session.awaiting = { type: "orderType" };
    return { reply: "Pickup or delivery?", session };
  }

  // If delivery, ensure address
  if (session.orderType === "Delivery" && !session.address) {
    session.awaiting = { type: "address" };
    return { reply: "What’s the delivery address?", session };
  }

  // Ask sides once (only if sides exist in store config)
  const storeSidesCount = getAllSideItems(store).length;

  if (!session.sidesDone && session.sides.length === 0) {
    // If store has no sides configured, don't loop — just skip.
    if (storeSidesCount === 0) {
      session.sidesDone = true;
    } else {
      // If user says done here, treat as no sides
      if (isDone(text)) {
        session.sidesDone = true;
      } else {
        return {
          reply:
            "Would you like any sides or drinks? You can say: “add coke” or “no sides”. (You can also ask: “which sides are available?”)",
          session
        };
      }
    }
  }

  // Final confirmation
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
