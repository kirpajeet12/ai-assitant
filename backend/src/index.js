/**
 * src/index.js
 * - Twilio Voice webhook + Web Chat test API + Dashboard static hosting
 * - Robust state machine so user can speak/type in any order
 */

import "dotenv/config";
import express from "express";
import cors from "cors";
import path from "path";
import twilio from "twilio";
import { fileURLToPath } from "url";
import crypto from "crypto";

// ✅ Import store + services you already have
import { getStoreByPhone } from "./services/storeService.js";
import { extractMeaning } from "./services/aiService.js";
import { createTicket, getTicketsByStore } from "./services/ticketService.js";

// ✅ IMPORTANT FIX: don’t import { nextQuestion } directly (your module may not export it)
// This prevents the Render crash: “does not provide an export named nextQuestion”
import * as conversationEngine from "./engine/conversationEngine.js";

/* =========================
   BASIC SETUP
========================= */

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(cors());
app.use(express.urlencoded({ extended: false }));
app.use(express.json());

// ✅ Serve dashboard folder BOTH ways:
// - /dashboard/chat.html
// - /chat.html  (fixes your “Cannot GET /chat.html”)
app.use("/dashboard", express.static(path.join(__dirname, "dashboard")));
app.use(express.static(path.join(__dirname, "dashboard"))); // ← enables /chat.html at root

// Optional: if you also have a public folder, keep this (safe if folder exists)
app.use(express.static(path.join(__dirname, "public")));

const PORT = process.env.PORT || 10000;

/* =========================
   IN-MEMORY SESSIONS
========================= */

const sessions = new Map();

/**
 * Build a “best effort” store from:
 * 1) Twilio To number
 * 2) DEFAULT_STORE_PHONE env
 */
function resolveStore({ toPhone } = {}) {
  const phone = toPhone || process.env.DEFAULT_STORE_PHONE;
  if (!phone) return null;
  return getStoreByPhone(phone);
}

/* =========================
   SMALL NLP HELPERS (FAST)
========================= */

/** Normalize user text safely */
function norm(text) {
  return String(text || "").trim();
}

/** Detect “no more / done / that’s all” */
function isDone(text) {
  return /(no$|no more|that's all|that’s all|thats all|done|finish|nothing else|nope)/i.test(
    norm(text).toLowerCase()
  );
}

/** Detect “no sides” */
function isNoSides(text) {
  return /(no sides|no side|without sides|none|nothing|no thanks|no thank you)/i.test(
    norm(text).toLowerCase()
  );
}

/** Detect confirmation yes/no */
function isConfirmYes(text) {
  return /^(yes|yeah|yep|correct|right|that's right|that is right|confirm)$/i.test(norm(text));
}
function isConfirmNo(text) {
  return /^(no|nope|wrong|incorrect|change|not correct)$/i.test(norm(text));
}

/** Detect order type from raw text */
function detectOrderType(text) {
  const t = norm(text).toLowerCase();
  if (/(pickup|pick up|carryout|carry out|takeaway|take away)/i.test(t)) return "Pickup";
  if (/(delivery|deliver|drop off|dropoff)/i.test(t)) return "Delivery";
  return null;
}

/** Detect spice from raw text (when user just says “medium”, etc.) */
function detectSpice(text) {
  const t = norm(text).toLowerCase();
  if (/^(mild|not spicy|low spicy)$/i.test(t)) return "Mild";
  if (/^(medium|mid|medium spicy)$/i.test(t)) return "Medium";
  if (/^(hot|spicy|extra spicy|very spicy)$/i.test(t)) return "Hot";
  return null;
}

/** Detect size from raw text */
function detectSize(text) {
  const t = norm(text).toLowerCase();
  if (/^(small|s)$/i.test(t)) return "Small";
  if (/^(medium|m)$/i.test(t)) return "Medium";
  if (/^(large|l)$/i.test(t)) return "Large";
  return null;
}

/** Quick “menu/sides” question detection */
function isAskingMenu(text) {
  const t = norm(text).toLowerCase();
  return /(menu|what pizzas|which pizzas|pizza options|pizza do you have|available pizzas)/i.test(t);
}
function isAskingSides(text) {
  const t = norm(text).toLowerCase();
  return /(sides|side options|what sides|which sides|sided available|addons|add ons)/i.test(t);
}

/* =========================
   SESSION SHAPE
========================= */

function makeSession({ store, from, to }) {
  return {
    id: crypto.randomUUID(),
    store_id: store?.id || null,
    caller: from || null,
    to: to || null,

    // order data
    orderType: null, // "Pickup" | "Delivery"
    address: null,
    items: [], // [{ name, qty, size, spice }]
    sides: [], // ["Garlic Bread", ...]
    notes: null,

    // flow flags
    confirming: false,
    sidesAsked: false,

    // “slot-filling” control (prevents loops like spice repeating)
    awaiting: null, // "size" | "spice" | "address" | null
    awaitingItemIndex: null
  };
}

/* =========================
   STORE CONFIG READERS
   (works even if your store schema differs)
========================= */

function getMenuList(store) {
  // Try common shapes:
  // store.menu, store.conversation.menu, store.data.menu, etc.
  const menu =
    store?.menu ||
    store?.conversation?.menu ||
    store?.data?.menu ||
    store?.config?.menu ||
    [];
  return Array.isArray(menu) ? menu : [];
}

function getSidesList(store) {
  const sides =
    store?.sides ||
    store?.conversation?.sides ||
    store?.data?.sides ||
    store?.config?.sides ||
    [];
  return Array.isArray(sides) ? sides : [];
}

function getGreeting(store) {
  return (
    store?.conversation?.greeting ||
    "Hi! Welcome 🙂 Pickup or delivery?"
  );
}

function getSpiceLevels(store) {
  // If you ever want store-specific spice levels, support it:
  const levels =
    store?.conversation?.spiceLevels ||
    store?.spiceLevels ||
    ["Mild", "Medium", "Hot"];
  return Array.isArray(levels) ? levels : ["Mild", "Medium", "Hot"];
}

/* =========================
   CONFIRMATION TEXT
========================= */

function formatItem(i) {
  const qty = i?.qty ? `${i.qty}` : "1";
  const size = i?.size ? ` ${i.size}` : "";
  const name = i?.name ? ` ${i.name}` : "";
  const spice = i?.spice ? ` (${i.spice})` : "";
  return `${qty}${size}${name}${spice}`.trim();
}

function buildConfirmation(store, session) {
  const itemsText = session.items.length
    ? session.items.map((i, idx) => `${idx + 1}. ${formatItem(i)}`).join(". ")
    : "No items";

  const sidesText = session.sides.length
    ? ` Sides: ${session.sides.join(", ")}.`
    : " No sides.";

  const typeText = session.orderType ? ` Order type: ${session.orderType}.` : "";
  const addrText =
    session.orderType === "Delivery" && session.address
      ? ` Delivery address: ${session.address}.`
      : "";

  return `Please confirm your order.${typeText} ${itemsText}.${sidesText}${addrText} Is that correct?`;
}

/* =========================
   CORE FLOW ENGINE (WORKS FOR CHAT + VOICE)
========================= */

async function handleUserTurn(store, session, rawText) {
  const text = norm(rawText);

  // 1) handle menu/sides questions (don’t break the ordering flow)
  if (isAskingMenu(text)) {
    const menu = getMenuList(store);
    if (!menu.length) return "I don’t have the menu loaded yet. Please tell me what pizza you want.";
    return `Here are our pizzas: ${menu.join(", ")}. What would you like to order?`;
  }

  if (isAskingSides(text)) {
    const sides = getSidesList(store);
    if (!sides.length) return "We don’t have sides listed right now. Would you like any sides? (You can also say: no sides)";
    return `Our sides are: ${sides.join(", ")}. Would you like any sides? (Or say: no sides)`;
  }

  // 2) if confirming, treat yes/no properly
  if (session.confirming) {
    if (isConfirmYes(text)) {
      // ✅ finalize ticket
      await Promise.resolve(
        createTicket({
          store_id: store.id,
          caller: session.caller,
          items: session.items,
          sides: session.sides,
          orderType: session.orderType || "Pickup",
          address: session.orderType === "Delivery" ? session.address : null
        })
      );

      // Reset session end (caller will start fresh)
      sessions.delete(session.id);
      return "Your order is confirmed. Thank you!";
    }

    if (isConfirmNo(text)) {
      session.confirming = false;
      session.awaiting = null;
      session.awaitingItemIndex = null;
      return "No problem. Tell me what you want to change (pizza, size, spice, sides, pickup/delivery).";
    }

    // If user says something else while confirming, treat it as correction input
    session.confirming = false;
  }

  // 3) allow pickup/delivery anywhere
  const type = detectOrderType(text);
  if (type) session.orderType = type;

  // 4) slot-filling: if we’re waiting for a specific thing, try to fill it FIRST
  if (session.awaiting === "address") {
    // accept whatever they say as address (basic)
    session.address = text;
    session.awaiting = null;
    session.awaitingItemIndex = null;
  }

  if (session.awaiting === "size") {
    const size = detectSize(text);
    if (size && session.awaitingItemIndex != null) {
      session.items[session.awaitingItemIndex].size = size;
      session.awaiting = null;
      session.awaitingItemIndex = null;
    } else {
      return "Please say a size: Small, Medium, or Large.";
    }
  }

  if (session.awaiting === "spice") {
    const spice = detectSpice(text);
    if (spice && session.awaitingItemIndex != null) {
      session.items[session.awaitingItemIndex].spice = spice;
      session.awaiting = null;
      session.awaitingItemIndex = null;
    } else {
      const levels = getSpiceLevels(store);
      return `Please say a spice level: ${levels.join(", ")}.`;
    }
  }

  // 5) call your AI meaning extractor (but keep it safe)
  let ai = null;
  try {
    ai = await extractMeaning(store, text);
  } catch (e) {
    console.error("AI extractMeaning error:", e);
  }

  // 6) merge AI results if present
  if (ai && typeof ai === "object") {
    // If AI provides orderType
    if (ai.orderType) session.orderType = ai.orderType;

    // If AI provides address
    if (ai.address) session.address = ai.address;

    // If AI provides sides (array)
    if (Array.isArray(ai.sides)) {
      session.sides = ai.sides;
      session.sidesAsked = true;
    }

    // If AI provides items
    if (Array.isArray(ai.items) && ai.items.length) {
      // Normalize items so we never get “undefined”
      session.items = ai.items.map((it) => ({
        name: it.name || it.pizza || it.item || "",
        qty: Number(it.qty || it.quantity || 1) || 1,
        size: it.size || null,
        spice: it.spice || null
      }));
    }

    // If AI gives “done” signal
    if (ai.done === true) {
      // we’ll just continue to next step checks below
    }
  }

  // 7) If user explicitly says "no sides"
  if (isNoSides(text)) {
    session.sides = [];
    session.sidesAsked = true;
  }

  // 8) If user says “done/that’s all”, move forward (don’t ask for another pizza)
  const userDone = isDone(text);

  // 9) NEXT STEP DECISION (state machine)
  // If orderType missing, ask it
  if (!session.orderType) {
    return "Pickup or delivery?";
  }

  // If delivery, ensure address
  if (session.orderType === "Delivery" && !session.address) {
    session.awaiting = "address";
    return "What’s the delivery address?";
  }

  // If no items yet, ask what pizza
  if (!session.items.length) {
    const menu = getMenuList(store);
    const hint = menu.length ? ` You can say: 1 large ${menu[0]}.` : "";
    return `What would you like to order?${hint}`;
  }

  // Ensure every item has qty + size + spice (if required)
  for (let idx = 0; idx < session.items.length; idx++) {
    const it = session.items[idx];

    if (!it.qty) it.qty = 1;

    // Ask size if missing
    if (!it.size) {
      session.awaiting = "size";
      session.awaitingItemIndex = idx;
      return `What size for ${it.name || "that pizza"}? Small, Medium, or Large?`;
    }

    // Ask spice if missing (your pizzas need it)
    if (!it.spice) {
      session.awaiting = "spice";
      session.awaitingItemIndex = idx;
      const levels = getSpiceLevels(store);
      return `What spice level for ${it.name || "that pizza"}? ${levels.join(", ")}?`;
    }
  }

  // Ask sides once after items are complete, unless user is already “done”
  if (!session.sidesAsked) {
    session.sidesAsked = true;
    const sides = getSidesList(store);
    if (!sides.length) return "Would you like any sides? (Or say: no sides)";
    return `Would you like any sides? Available: ${sides.join(", ")}. (Or say: no sides)`;
  }

  // If user isn’t done and they might want more items, optionally ask
  // BUT if they said “done”, skip straight to confirmation
  if (!userDone && !session.confirming) {
    // If your old engine exists, let it override (optional)
    const maybeNext =
      typeof conversationEngine?.nextQuestion === "function"
        ? conversationEngine.nextQuestion(store, session)
        : (typeof conversationEngine?.default === "function"
            ? conversationEngine.default(store, session)
            : null);

    // If your engine wants to ask “add more?” let it, otherwise we confirm
    if (typeof maybeNext === "string" && maybeNext && maybeNext !== "confirm") {
      return maybeNext;
    }
  }

  // Confirm
  session.confirming = true;
  return buildConfirmation(store, session);
}

/* =========================
   TWILIO ENTRY POINT
========================= */

app.post("/twilio/voice", (req, res) => {
  const store = resolveStore({ toPhone: req.body.To });
  if (!store) return res.sendStatus(404);

  const twiml = new twilio.twiml.VoiceResponse();

  twiml.say({ voice: "alice", language: "en-CA" }, getGreeting(store));

  twiml.gather({
    input: "speech",
    language: "en-CA",
    bargeIn: true,
    action: "/twilio/step",
    method: "POST"
  });

  res.type("text/xml").send(twiml.toString());
});

/* =========================
   TWILIO STEP
========================= */

app.post("/twilio/step", async (req, res) => {
  try {
    const store = resolveStore({ toPhone: req.body.To });
    if (!store) return res.sendStatus(404);

    const callSid = req.body.CallSid;
    const speech = norm(req.body.SpeechResult);

    // session per call
    if (!sessions.has(callSid)) {
      const s = makeSession({ store, from: req.body.From, to: req.body.To });
      // Use callSid as key so Twilio continues the same session
      sessions.set(callSid, s);
    }

    const session = sessions.get(callSid);

    // silence protection
    if (!speech) {
      return respondTwilio(res, "Sorry, I didn’t catch that. Please say it again.");
    }

    const reply = await handleUserTurn(store, session, speech);

    // If we deleted session by session.id on confirm, also delete callSid mapping
    if (!sessions.has(session.id) && sessions.has(callSid)) {
      sessions.delete(callSid);
    }

    return respondTwilio(res, reply);
  } catch (err) {
    console.error("❌ Twilio step error:", err);
    const twiml = new twilio.twiml.VoiceResponse();
    twiml.say("Sorry, something went wrong. Please try again.");
    res.type("text/xml").send(twiml.toString());
  }
});

/* =========================
   WEB CHAT TEST API
========================= */

/**
 * Start chat session:
 * POST /api/chat/start
 * body: { storePhone?: "+1...", from?: "web-user" }
 */
app.post("/api/chat/start", (req, res) => {
  const storePhone = req.body?.storePhone || process.env.DEFAULT_STORE_PHONE;
  const store = resolveStore({ toPhone: storePhone });
  if (!store) return res.status(400).json({ error: "Store not found. Set DEFAULT_STORE_PHONE or send storePhone." });

  const session = makeSession({ store, from: req.body?.from || "web-user", to: storePhone });
  sessions.set(session.id, session);

  res.json({
    sessionId: session.id,
    message: "New session started. What would you like to order?"
  });
});

/**
 * Send message:
 * POST /api/chat/message
 * body: { sessionId, text }
 */
app.post("/api/chat/message", async (req, res) => {
  const sessionId = req.body?.sessionId;
  const text = norm(req.body?.text);

  if (!sessionId || !sessions.has(sessionId)) {
    return res.status(400).json({ error: "Invalid sessionId. Start with /api/chat/start" });
  }

  const session = sessions.get(sessionId);
  const store = resolveStore({ toPhone: session.to }) || resolveStore({});
  if (!store) return res.status(400).json({ error: "Store not found." });

  if (!text) return res.json({ message: "Please type something." });

  const reply = await handleUserTurn(store, session, text);

  // if confirmed → handleUserTurn deletes session.id
  if (!sessions.has(session.id)) {
    sessions.delete(sessionId);
  }

  res.json({ message: reply });
});

/* =========================
   DASHBOARD API (YOUR EXISTING)
========================= */

app.get("/api/stores/:id/tickets", (req, res) => {
  res.json(getTicketsByStore(req.params.id));
});

/* =========================
   TWILIO HELPER
========================= */

function respondTwilio(res, text) {
  const twiml = new twilio.twiml.VoiceResponse();

  twiml.say({ voice: "alice", language: "en-CA" }, text);

  twiml.gather({
    input: "speech",
    language: "en-CA",
    bargeIn: true,
    action: "/twilio/step",
    method: "POST"
  });

  res.type("text/xml").send(twiml.toString());
}

/* =========================
   SERVER
========================= */

app.listen(PORT, () => {
  console.log("🚀 Store AI running on port", PORT);
  console.log("🧪 Web chat test: /chat.html  (or /dashboard/chat.html)");
});

//version 1 

// import "dotenv/config";
// import express from "express";
// import cors from "cors";
// import path from "path";
// import twilio from "twilio";
// import { fileURLToPath } from "url";

// import { getStoreByPhone } from "./services/storeService.js";
// import { extractMeaning } from "./services/aiService.js";
// import { nextQuestion } from "./engine/conversationEngine.js";
// import { createTicket, getTicketsByStore } from "./services/ticketService.js";

// /* =========================
//    BASIC SETUP
// ========================= */

// const __filename = fileURLToPath(import.meta.url);
// const __dirname = path.dirname(__filename);

// const app = express();
// app.use(cors());
// app.use(express.urlencoded({ extended: false }));
// app.use(express.json());

// // dashboard (static)
// app.use(
//   "/dashboard",
//   express.static(path.join(__dirname, "dashboard"))
// );

// const PORT = process.env.PORT || 10000;

// /* =========================
//    IN-MEMORY SESSIONS
// ========================= */

// const sessions = new Map();

// /* =========================
//    TWILIO ENTRY POINT
// ========================= */

// app.post("/twilio/voice", (req, res) => {
//   const store = getStoreByPhone(req.body.To);
//   const twiml = new twilio.twiml.VoiceResponse();

//   twiml.say(
//     { voice: "alice", language: "en-CA" },
//     store?.conversation?.greeting ||
//       "Hi, how can I help you today?"
//   );

//   twiml.gather({
//     input: "speech",
//     language: "en-CA",
//     bargeIn: true,
//     action: "/twilio/step",
//     method: "POST"
//   });

//   res.type("text/xml").send(twiml.toString());
// });

// /* =========================
//    TWILIO STEP (SAFE)
// ========================= */

// app.post("/twilio/step", async (req, res) => {
//   try {
//     const store = getStoreByPhone(req.body.To);
//     if (!store) return res.sendStatus(404);

//     const callSid = req.body.CallSid;
//     const speech = (req.body.SpeechResult || "").trim();

//     // create session if missing
//     if (!sessions.has(callSid)) {
//       sessions.set(callSid, {
//         store_id: store.id,
//         caller: req.body.From,
//         items: [],
//         sides: [],
//         orderType: null,
//         address: null,
//         confirming: false,
//         sidesAsked: false
//       });
//     }

//     const session = sessions.get(callSid);

//     // silence protection
//     if (!speech) {
//       return respond(
//         res,
//         "Sorry, I didn’t catch that. Please say it again."
//       );
//     }

//     const ai = await extractMeaning(store, speech);

//     // AI safety
//     if (!ai || typeof ai !== "object") {
//       return respond(
//         res,
//         "Sorry, I didn’t understand that. Could you repeat?"
//       );
//     }

//     // merge order type
//     if (ai.orderType) {
//       session.orderType = ai.orderType;
//     }

//     // merge items (always respect latest)
//     if (Array.isArray(ai.items) && ai.items.length > 0) {
//       session.items = ai.items;
//       session.confirming = false;
//     }

//     // merge sides safely
//     if (Array.isArray(ai.sides)) {
//       session.sides = ai.sides;
//     }

//     // ask next question
//     const q = nextQuestion(store, session);
//     const question =
//       typeof q === "string" && q.length
//         ? q
//         : "Is there anything else I can help you with?";

//     // confirmation phase
//     if (question === "confirm" && !session.confirming) {
//       session.confirming = true;
//       return respond(
//         res,
//         buildConfirmation(store, session)
//       );
//     }

//     // user confirms
//     if (session.confirming && /^(yes|yeah|correct)$/i.test(speech)) {
//       createTicket({
//         store_id: store.id,
//         caller: session.caller,
//         items: session.items,
//         sides: session.sides,
//         orderType: session.orderType || "Pickup",
//         address: session.address || null
//       });

//       sessions.delete(callSid);
//       return respond(
//         res,
//         "Your order is confirmed. Thank you!"
//       );
//     }

//     // user rejects confirmation → loop
//     if (session.confirming && /^(no|wrong)$/i.test(speech)) {
//       session.confirming = false;
//       return respond(
//         res,
//         "No problem. Please tell me the correct order."
//       );
//     }

//     return respond(res, question);

//   } catch (err) {
//     console.error("❌ Twilio step error:", err);
//     const twiml = new twilio.twiml.VoiceResponse();
//     twiml.say(
//       "Sorry, something went wrong. Please try again."
//     );
//     res.type("text/xml").send(twiml.toString());
//   }
// });

// /* =========================
//    DASHBOARD API
// ========================= */

// app.get("/api/stores/:id/tickets", (req, res) => {
//   res.json(getTicketsByStore(req.params.id));
// });

// /* =========================
//    HELPERS
// ========================= */

// function respond(res, text) {
//   const twiml = new twilio.twiml.VoiceResponse();
//   twiml.say({ voice: "alice", language: "en-CA" }, text);
//   twiml.gather({
//     input: "speech",
//     language: "en-CA",
//     bargeIn: true,
//     action: "/twilio/step",
//     method: "POST"
//   });
//   res.type("text/xml").send(twiml.toString());
// }

// function buildConfirmation(store, session) {
//   const items = session.items
//     .map(
//       (i, idx) =>
//         `${idx + 1}. ${i.qty || 1} ${i.size || ""} ${i.name}`
//     )
//     .join(". ");

//   const sides = session.sides.length
//     ? ` Sides: ${session.sides.join(", ")}.`
//     : "";

//   return `Please confirm your order. ${items}.${sides} Is that correct?`;
// }

// /* =========================
//    SERVER
// ========================= */

// app.listen(PORT, () => {
//   console.log("🚀 Store AI running on port", PORT);
// });
