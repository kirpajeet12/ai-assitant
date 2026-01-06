/**
 * conversationEngine.js (DATA-DRIVEN)
 * Supports:
 * - pizzas (size + optional spice)
 * - wings (type + flavor)
 * - pastas/salads (no extra)
 * - sides/beverages (qty only)
 * - menu queries per category
 * - edits during confirmation
 */

function norm(t) { return String(t || "").trim(); }
function lower(t) { return norm(t).toLowerCase(); }
function hasAny(t, arr) { return arr.some(x => t.includes(x)); }

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

function detectSize(text, supportedSizes = ["Small","Medium","Large"]) {
  const t = lower(text);
  if (t.includes("large") || /\bl\b/.test(t)) return "Large";
  if (t.includes("medium") || /\bm\b/.test(t)) return "Medium";
  if (t.includes("small") || /\bs\b/.test(t)) return "Small";
  // keep strict to supported sizes
  return supportedSizes.includes("Large") || supportedSizes.includes("Medium") || supportedSizes.includes("Small")
    ? null
    : null;
}

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

function detectOrderType(text) {
  const t = lower(text);
  if (hasAny(t, ["pickup","pick up","picup","carryout","takeaway"])) return "Pickup";
  if (hasAny(t, ["delivery","deliver","drop off","dropoff"])) return "Delivery";
  return null;
}

function looksLikeAddress(text) {
  const s = norm(text);
  const hasNumber = /\d+/.test(s);
  const hasStreetWord = /(st|street|ave|avenue|rd|road|blvd|boulevard|dr|drive|way|lane|ln|unit|apt|suite|#)/i.test(s);
  return hasNumber && hasStreetWord;
}

function isConfirmYes(text) {
  const t = lower(text);
  return /^(yes|y|yeah|yep|correct|right|confirm|ok)$/i.test(t) || t.includes("confirm");
}
function isConfirmNo(text) {
  const t = lower(text);
  return /^(no|nope|wrong|incorrect)$/i.test(t) || t.includes("change") || t.includes("not correct");
}
function isNoMore(text) {
  const t = lower(text);
  return hasAny(t, ["that's all","thats all","done","finish","no more","nothing else","all good"]);
}

/* =========================
   MENU FLATTENING + MATCHING
========================= */

function safeArray(x){ return Array.isArray(x) ? x : []; }

function normalizeForMatch(s) {
  return lower(s)
    .replace(/['"]/g, "")
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function flattenMenu(store) {
  const menu = store?.menu || {};
  const items = [];

  // PIZZAS: menu.pizzas is nested categories
  const pizzasByCat = menu.pizzas || {};
  for (const cat of Object.keys(pizzasByCat)) {
    for (const p of safeArray(pizzasByCat[cat])) {
      items.push({
        kind: "pizza",
        name: p.name,
        veg: !!p.veg,
        requiresSpice: !!p.requiresSpice,
        aliases: safeArray(p.aliases),
        category: cat
      });
    }
  }

  // SIDES
  for (const s of safeArray(menu.sides)) {
    items.push({ kind: "side", name: s.name, aliases: safeArray(s.aliases) });
  }

  // BEVERAGES
  for (const b of safeArray(menu.beverages)) {
    items.push({ kind: "beverage", name: b.name, aliases: safeArray(b.aliases) });
  }

  // PASTAS
  for (const p of safeArray(menu.pastas)) {
    items.push({ kind: "pasta", name: p.name, aliases: safeArray(p.aliases) });
  }

  // SALADS
  for (const s of safeArray(menu.salads)) {
    items.push({ kind: "salad", name: s.name, aliases: safeArray(s.aliases) });
  }

  // WINGS
  for (const w of safeArray(menu.wings)) {
    items.push({
      kind: "wings",
      name: w.name,
      aliases: safeArray(w.aliases),
      options: w.options || {}
    });
  }

  // build alias index
  return items.map(it => {
    const base = normalizeForMatch(it.name);
    const aliases = [
      base,
      ...safeArray(it.aliases).map(normalizeForMatch)
    ].filter(Boolean);
    return { ...it, _aliases: Array.from(new Set(aliases)) };
  });
}

function extractMatchedItems(store, text) {
  const t = normalizeForMatch(text);
  const all = flattenMenu(store);

  const qty = detectQty(text) || 1;
  const supportedSizes = store?.settings?.supportedSizes || ["Small","Medium","Large"];
  const size = detectSize(text, supportedSizes);

  const matched = [];
  for (const it of all) {
    const hit = it._aliases.some(a => a && t.includes(a));
    if (!hit) continue;

    const line = {
      kind: it.kind,
      name: it.name,
      qty,
      // pizza only:
      size: it.kind === "pizza" ? (size || null) : null,
      spice: null,
      requiresSpice: it.kind === "pizza" ? !!it.requiresSpice : false,
      options: {}
    };

    // wings: try detect type/flavor from same text
    if (it.kind === "wings") {
      const type = hasAny(lower(text), ["boneless"]) ? "Boneless"
        : hasAny(lower(text), ["traditional"]) ? "Traditional"
        : null;

      const flavors = safeArray(it.options?.flavor);
      const foundFlavor = flavors.find(f => lower(text).includes(f.toLowerCase())) || null;

      if (type) line.options.type = type;
      if (foundFlavor) line.options.flavor = foundFlavor;
    }

    matched.push(line);
  }

  // merge duplicates by (kind + name + size + options signature)
  const merged = [];
  for (const m of matched) {
    const key = JSON.stringify({
      kind: m.kind,
      name: m.name,
      size: m.size,
      options: m.options
    });
    const ex = merged.find(x => x._k === key);
    if (ex) ex.qty += m.qty;
    else merged.push({ ...m, _k: key });
  }
  return merged.map(({ _k, ...rest }) => rest);
}

/* =========================
   MENU QUESTION HANDLERS
========================= */

function isAskingMenu(text) {
  const t = lower(text);
  return hasAny(t, ["menu","what do you have","show menu","options"]);
}
function isAskingCategory(text, catWord) {
  const t = lower(text);
  return t.includes(catWord);
}

function listCategory(store, kind) {
  const all = flattenMenu(store).filter(x => x.kind === kind);
  const names = all.map(x => x.name);
  if (!names.length) return `No ${kind} items configured for this store yet.`;
  return `${kind.toUpperCase()} options: ${names.slice(0, 20).join(", ")}${names.length > 20 ? ` (+${names.length-20} more)` : ""}.`;
}

function listVegPizzas(store) {
  const all = flattenMenu(store).filter(x => x.kind === "pizza" && x.veg);
  const names = all.map(x => x.name);
  if (!names.length) return "No veg pizzas configured right now.";
  return `Veg pizzas: ${names.slice(0, 20).join(", ")}${names.length > 20 ? ` (+${names.length-20} more)` : ""}.`;
}

/* =========================
   PUBLIC API
========================= */

export function getGreetingText(store) {
  return store?.conversation?.greeting || "Welcome. What would you like to order?";
}

export function buildConfirmationText(store, session) {
  const orderType = session.orderType || "Pickup";
  const addr = orderType === "Delivery" ? ` Address: ${session.address || "(missing)"}.` : "";

  const lines = (session.lineItems || []).map((it, i) => {
    const qty = it.qty || 1;
    const size = it.kind === "pizza" && it.size ? ` ${it.size}` : "";
    const spice = it.kind === "pizza" && it.spice ? ` (${it.spice})` : "";

    let opt = "";
    if (it.kind === "wings") {
      const t = it.options?.type ? ` ${it.options.type}` : "";
      const f = it.options?.flavor ? ` ${it.options.flavor}` : "";
      opt = `${t}${f}`.trim();
      if (opt) opt = ` (${opt})`;
    }

    return `${i+1}. ${qty}${size} ${it.name}${spice}${opt}`.replace(/\s+/g," ").trim();
  }).join(". ");

  return `Please confirm your order. ${orderType}.${addr} ${lines || "No items"}. Is that correct?`;
}

export function handleUserTurn(store, session, userText) {
  const text = norm(userText);
  const t = lower(text);

  // init defaults
  session.lineItems = session.lineItems || [];
  session.awaiting = session.awaiting || null;

  // menu questions anytime
  if (isAskingMenu(text)) {
    return {
      reply: "You can ask: pizzas, wings, pastas, salads, sides, beverages, or veg options.",
      session
    };
  }
  if (isAskingCategory(text, "pizza")) return { reply: listCategory(store, "pizza"), session };
  if (isAskingCategory(text, "wings")) return { reply: listCategory(store, "wings"), session };
  if (isAskingCategory(text, "pasta")) return { reply: listCategory(store, "pasta"), session };
  if (isAskingCategory(text, "salad")) return { reply: listCategory(store, "salad"), session };
  if (isAskingCategory(text, "side")) return { reply: listCategory(store, "side"), session };
  if (isAskingCategory(text, "drink") || isAskingCategory(text, "beverage")) return { reply: listCategory(store, "beverage"), session };
  if (hasAny(t, ["veg","veggie","vegetarian"])) return { reply: listVegPizzas(store), session };

  // confirmation state
  if (session.confirming) {
    if (isConfirmYes(text)) {
      session.completed = true;
      return { reply: "Perfect — your order is confirmed. Thank you!", session };
    }
    if (isConfirmNo(text)) {
      session.confirming = false;
      session.awaiting = null;
      return { reply: "No problem — tell me the changes (you can add/remove items, change size/spice, or add wings/sides).", session };
    }
    // treat anything else as edit
    session.confirming = false;
  }

  // resolve awaited
  if (session.awaiting?.type === "orderType") {
    const ot = detectOrderType(text);
    if (!ot) return { reply: "Pickup or delivery?", session };
    session.orderType = ot;
    session.awaiting = null;
  }

  if (session.awaiting?.type === "address") {
    if (!looksLikeAddress(text)) return { reply: "Please tell me the delivery address (example: 123 Main St, Surrey).", session };
    session.address = text;
    session.awaiting = null;
  }

  if (session.awaiting?.type === "pizzaSize") {
    const idx = session.awaiting.index;
    const size = detectSize(text, store?.settings?.supportedSizes || ["Small","Medium","Large"]);
    if (!size) return { reply: "What size would you like? Small, Medium, or Large?", session };
    if (session.lineItems[idx]) session.lineItems[idx].size = size;
    session.awaiting = null;
  }

  if (session.awaiting?.type === "pizzaSpice") {
    const idx = session.awaiting.index;
    const spice = detectSpice(text);
    if (spice === "__AMBIGUOUS__") return { reply: "Please choose ONE spice level: Mild, Medium, or Hot.", session };
    if (!spice) return { reply: "What spice level? Mild, Medium, or Hot?", session };
    if (session.lineItems[idx]) session.lineItems[idx].spice = spice;
    session.awaiting = null;
  }

  if (session.awaiting?.type === "wingType") {
    const idx = session.awaiting.index;
    const typ = hasAny(t, ["boneless"]) ? "Boneless" : hasAny(t, ["traditional"]) ? "Traditional" : null;
    if (!typ) return { reply: "Wings: Boneless or Traditional?", session };
    if (session.lineItems[idx]) session.lineItems[idx].options.type = typ;
    session.awaiting = null;
  }

  if (session.awaiting?.type === "wingFlavor") {
    const idx = session.awaiting.index;
    const flavors = session.awaiting.flavors || [];
    const found = flavors.find(f => t.includes(f.toLowerCase())) || null;
    if (!found) return { reply: `Which flavor? ${flavors.join(", ")}.`, session };
    if (session.lineItems[idx]) session.lineItems[idx].options.flavor = found;
    session.awaiting = null;
  }

  // merge orderType anytime
  const ot = detectOrderType(text);
  if (ot) session.orderType = ot;

  // extract items from text
  const matched = extractMatchedItems(store, text);
  const changing = hasAny(t, ["change","actually","instead","replace","no i want"]);

  if (matched.length) {
    if (changing || session.lineItems.length === 0) {
      session.lineItems = matched;
    } else {
      // merge
      for (const m of matched) {
        const same = session.lineItems.find(x =>
          x.kind === m.kind &&
          x.name === m.name &&
          (x.size || null) === (m.size || null) &&
          JSON.stringify(x.options || {}) === JSON.stringify(m.options || {})
        );
        if (same) same.qty += m.qty || 1;
        else session.lineItems.push(m);
      }
    }
  }

  // if nothing selected yet
  if (session.lineItems.length === 0) {
    return { reply: "What would you like to order? (You can say: 2 large shahi paneer pizza, or 10pc wings, or ask: pizzas/wings/pastas)", session };
  }

  // slot filling per item
  for (let i = 0; i < session.lineItems.length; i++) {
    const it = session.lineItems[i];

    if (it.kind === "pizza") {
      if (!it.size) {
        session.awaiting = { type: "pizzaSize", index: i };
        return { reply: `What size for ${it.name}? Small, Medium, or Large?`, session };
      }
      if (it.requiresSpice && !it.spice) {
        session.awaiting = { type: "pizzaSpice", index: i };
        return { reply: `What spice level for ${it.name}? Mild, Medium, or Hot?`, session };
      }
    }

    if (it.kind === "wings") {
      const wingConfig = flattenMenu(store).find(x => x.kind === "wings" && x.name === it.name);
      const types = safeArray(wingConfig?.options?.type);
      const flavors = safeArray(wingConfig?.options?.flavor);

      if (types.length && !it.options?.type) {
        session.awaiting = { type: "wingType", index: i };
        return { reply: `For ${it.name}: Boneless or Traditional?`, session };
      }
      if (flavors.length && !it.options?.flavor) {
        session.awaiting = { type: "wingFlavor", index: i, flavors };
        return { reply: `For ${it.name}, which flavor? ${flavors.join(", ")}.`, session };
      }
    }
  }

  // order type required
  if (!session.orderType) {
    session.awaiting = { type: "orderType" };
    return { reply: "Pickup or delivery?", session };
  }

  if (session.orderType === "Delivery" && !session.address) {
    session.awaiting = { type: "address" };
    return { reply: "What’s the delivery address?", session };
  }

  // allow "no more" to go confirm
  if (isNoMore(text)) {
    session.confirming = true;
    return { reply: buildConfirmationText(store, session), session };
  }

  // if user didn’t add anything new, ask if they want anything else
  // (but don’t block—user can type new items)
  session.confirming = true;
  return { reply: buildConfirmationText(store, session), session };
}
