/**
 * engine/conversationEngine.js
 *
 * Core rule (your requirement):
 * ✅ When user gives an item, bot repeats it (confirmation) + asks next missing slot.
 * ✅ If user asks menu, bot answers menu.
 * ✅ If user says "done/no more", move to order confirmation.
 * ✅ Prevent loops by tracking session.expecting (size/spice/orderType/address).
 */

const DEFAULT_SIZES = ["Small", "Medium", "Large"];
const DEFAULT_SPICE = ["Mild", "Medium", "Hot"];

/**
 * Decide what to do next.
 * @returns { kind: "say"|"confirm", text: string, expecting?: string|null }
 */
export function nextAction(store, session, ai) {
  // Load menu + sides from store config (fallback to empty arrays)
  const menu = store?.menu || store?.conversation?.menu || [];
  const sides = store?.sides || store?.conversation?.sides || [];

  // Determine intent if AI provided it
  const intent = (ai?.intent || "").toLowerCase();

  // 1) If user asked for menu
  if (intent === "ask_menu" || looksLikeMenuQuestion(ai?.rawText)) {
    if (!menu.length) {
      return {
        kind: "say",
        text: "We’re still setting up the menu for this store. What pizza would you like?"
      };
    }

    return {
      kind: "say",
      text: `We have: ${menu.join(", ")}. What would you like to order?`
    };
  }

  // 2) If user asked for sides list
  if (intent === "ask_sides") {
    if (!sides.length) {
      return {
        kind: "say",
        text: "We have a few sides available. What would you like to add?"
      };
    }

    return {
      kind: "say",
      text: `Sides include: ${sides.join(", ")}. Would you like to add any sides?`
    };
  }

  // 3) If user said they are done / no more items
  if (intent === "done" || looksLikeDone(ai?.rawText)) {
    // If no items at all, ask for item
    if (session.items.length === 0) {
      return {
        kind: "say",
        text: "Sure — what pizza would you like to order?",
        expecting: null
      };
    }

    // If items exist, go to confirmation
    return {
      kind: "confirm",
      text: buildFullConfirmation(session),
      expecting: null
    };
  }

  // 4) If no items yet, ask for first item
  if (session.items.length === 0) {
    return {
      kind: "say",
      text: "What would you like to order? You can say something like: 1 large pepperoni.",
      expecting: null
    };
  }

  // Active item = last item in the order (most recent)
  const item = session.items[session.items.length - 1];

  // 5) If size missing, ask size (repeat what we know)
  if (!item.size) {
    return {
      kind: "say",
      text: `Got it — ${describeItem(item)}. What size would you like: ${DEFAULT_SIZES.join(", ")}?`,
      expecting: "size"
    };
  }

  // 6) If spice missing, ask spice (repeat what we know)
  // You can disable spice requirement per store if you want later.
  if (!item.spice) {
    return {
      kind: "say",
      text: `Got it — ${describeItem(item)}. What spice level would you like: ${DEFAULT_SPICE.join(", ")}?`,
      expecting: "spice"
    };
  }

  // 7) Ask pickup/delivery if missing (repeat full order so far)
  if (!session.orderType) {
    return {
      kind: "say",
      text: `Got it — ${summarizeOrder(session)}. Is this for pickup or delivery?`,
      expecting: "orderType"
    };
  }

  // 8) If delivery, need address
  if (session.orderType === "Delivery" && !session.address) {
    return {
      kind: "say",
      text: `Got it — ${summarizeOrder(session)}. What’s the delivery address?`,
      expecting: "address"
    };
  }

  // 9) Ask about sides once (optional)
  if (!session.askedSidesOnce) {
    session.askedSidesOnce = true;

    if (sides.length) {
      return {
        kind: "say",
        text: `Would you like any sides? We have: ${sides.join(", ")}.`,
        expecting: null
      };
    }

    return {
      kind: "say",
      text: "Would you like to add any sides?",
      expecting: null
    };
  }

  // 10) If we have everything, go to confirmation
  return {
    kind: "confirm",
    text: buildFullConfirmation(session),
    expecting: null
  };
}

/* =========================
   HELPERS
========================= */

function describeItem(item) {
  // Builds: "1 Large Shahi Paneer pizza"
  const qty = item.qty || 1;
  const size = item.size ? `${item.size}` : "";
  const name = item.name || "pizza";
  const spice = item.spice ? ` (${item.spice})` : "";
  return `${qty} ${size} ${name}${spice}`.replace(/\s+/g, " ").trim();
}

function summarizeOrder(session) {
  // "1 Large Shahi Paneer (Hot), 1 Medium Pepperoni (Mild)"
  const parts = session.items.map((i) => {
    const qty = i.qty || 1;
    const size = i.size || "";
    const name = i.name || "pizza";
    const spice = i.spice ? ` (${i.spice})` : "";
    return `${qty} ${size} ${name}${spice}`.replace(/\s+/g, " ").trim();
  });

  return parts.join(", ");
}

function buildFullConfirmation(session) {
  const orderLine = summarizeOrder(session);

  const sidesLine = session.sides.length
    ? ` Sides: ${session.sides.join(", ")}.`
    : "";

  const typeLine =
    session.orderType === "Delivery"
      ? ` Delivery to: ${session.address || "address not provided yet"}.`
      : ` ${session.orderType || "Pickup"}.`;

  return `Please confirm your order: ${orderLine}.${sidesLine}${typeLine} Is that correct?`;
}

function looksLikeDone(text) {
  const t = String(text || "").toLowerCase().trim();
  return /(no more|that's all|thats all|done|finish|nothing else|complete)/i.test(t);
}

function looksLikeMenuQuestion(text) {
  const t = String(text || "").toLowerCase().trim();
  return /(menu|what pizzas|what pizza|what do you have|options|choices)/i.test(t);
}
