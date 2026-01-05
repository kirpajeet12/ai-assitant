/**
 * src/index.js
 * - Twilio Voice webhook + Web Chat test API + Dashboard static hosting
 * - Fixes: sides/menu missing, "no sides" loop, "add coke" at confirmation
 */

import "dotenv/config";
import express from "express";
import cors from "cors";
import path from "path";
import twilio from "twilio";
import { fileURLToPath } from "url";
import crypto from "crypto";

import { getStoreByPhone } from "./services/storeService.js";
import { extractMeaning } from "./services/aiService.js";
import { createTicket, getTicketsByStore } from "./services/ticketService.js";

// Safe import (prevents Render crash if named export missing)
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

// Serve dashboard both ways:
// - /dashboard/chat.html
// - /chat.html
app.use("/dashboard", express.static(path.join(__dirname, "dashboard")));
app.use(express.static(path.join(__dirname, "dashboard")));
app.use(express.static(path.join(__dirname, "public")));

const PORT = process.env.PORT || 10000;

/* =========================
   IN-MEMORY SESSIONS
========================= */

const sessions = new Map();

/* =========================
   ENV FALLBACKS (IMPORTANT)
========================= */

// Example env you can set on Render:
// DEFAULT_MENU="Cheese Lovers,Pepperoni,Veggie Supreme,Butter Chicken,Shahi Paneer,Tandoori Chicken"
// DEFAULT_SIDES="Garlic Bread,Chicken Wings,Fries,Coke,Sprite"

function parseCsvEnv(name) {
  const raw = process.env[name];
  if (!raw) return [];
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

const FALLBACK_MENU = parseCsvEnv("DEFAULT_MENU");
const FALLBACK_SIDES = parseCsvEnv("DEFAULT_SIDES");

/* =========================
   STORE RESOLVER
========================= */

function resolveStore({ toPhone } = {}) {
  const phone = toPhone || process.env.DEFAULT_STORE_PHONE;
  if (!phone) return null;
  return getStoreByPhone(phone);
}

/* =========================
   TEXT HELPERS
========================= */

function norm(text) {
  return String(text || "").trim();
}

function isDone(text) {
  return /(no$|no more|that's all|that’s all|thats all|done|finish|nothing else|nope|all good)/i.test(
    norm(text).toLowerCase()
  );
}

function isNoSides(text) {
  return /(no sides|no side|without sides|none|nothing|no thanks|no thank you|dont want sides|don't want sides)/i.test(
    norm(text).toLowerCase()
  );
}

function isConfirmYes(text) {
  return /^(yes|yeah|yep|correct|right|that's right|that is right|confirm)$/i.test(norm(text));
}
function isConfirmNo(text) {
  return /^(no|nope|wrong|incorrect|change|not correct)$/i.test(norm(text));
}

function detectOrderType(text) {
  const t = norm(text).toLowerCase();
  if (/(pickup|pick up|picup|carryout|carry out|takeaway|take away)/i.test(t)) return "Pickup";
  if (/(delivery|deliver|drop off|dropoff)/i.test(t)) return "Delivery";
  return null;
}

function detectSpice(text) {
  const t = norm(text).toLowerCase();
  if (/^(mild|not spicy|low spicy)$/i.test(t)) return "Mild";
  if (/^(medium|mid|medium spicy)$/i.test(t)) return "Medium";
  if (/^(hot|spicy|extra spicy|very spicy)$/i.test(t)) return "Hot";
  return null;
}

function detectSize(text) {
  const t = norm(text).toLowerCase();
  if (/^(small|s)$/i.test(t)) return "Small";
  if (/^(medium|m)$/i.test(t)) return "Medium";
  if (/^(large|l)$/i.test(t)) return "Large";
  return null;
}

function isAskingMenu(text) {
  const t = norm(text).toLowerCase();
  return /(menu|what pizzas|which pizzas|pizza options|pizza do you have|available pizzas)/i.test(t);
}

function isAskingSides(text) {
  const t = norm(text).toLowerCase();
  return /(sides|side options|what sides|which sides|sided available|addons|add ons|drinks)/i.test(t);
}

/**
 * Detect sides from user message, even if store sides list is empty.
 * - If sides list exists: match by inclusion.
 * - If sides list missing: still detect common drinks (coke/sprite/etc).
 */
function extractSidesFromText(text, knownSides = []) {
  const t = norm(text).toLowerCase();
  const found = new Set();

  // Match from known sides list
  for (const s of knownSides) {
    const sLow = s.toLowerCase();
    if (sLow && t.includes(sLow)) found.add(s);
  }
/* =========================
   STORE MENU & SIDES HELPERS
========================= */

function getMenuList(store) {
  if (Array.isArray(store?.menu)) return store.menu;
  if (store?.menu && typeof store.menu === "object") return Object.keys(store.menu);
  if (Array.isArray(store?.data?.menu)) return store.data.menu;
  if (store?.conversation?.menu) return Object.keys(store.conversation.menu);
  return [];
}

function getSidesList(store) {
  // ✅ Reads sides from pizza64.json even if stored as an object
  if (Array.isArray(store?.sides)) return store.sides;
  if (store?.sides && typeof store.sides === "object") return Object.keys(store.sides);
  if (Array.isArray(store?.data?.sides)) return store.data.sides;
  if (store?.conversation?.sides) return Object.keys(store.conversation.sides);
  return [];
}

  // Fallback detection for common items
  const common = [
    "Coke",
    "Sprite",
    "Pepsi",
    "Water",
    "Fries",
    "Garlic Bread",
    "Wings",
    "Ranch"
  ];
  for (const c of common) {
    if (t.includes(c.toLowerCase())) found.add(c);
  }

  return Array.from(found);
}

/* =========================
   SESSION
========================= */

function makeSession({ id, store, from, to }) {
  return {
    id: id || crypto.randomUUID(),
    store_id: store?.id || null,
    caller: from || null,
    to: to || null,

    orderType: null,
    address: null,
    items: [],
    sides: [],
    notes: null,

    confirming: false,
    sidesAsked: false,

    awaiting: null, // "size" | "spice" | "address"
    awaitingItemIndex: null
  };
}

/* =========================
   STORE CONFIG READERS
========================= */

function getMenuList(store) {
  const menu =
    store?.menu ||
    store?.conversation?.menu ||
    store?.data?.menu ||
    store?.config?.menu ||
    [];
  const arr = Array.isArray(menu) ? menu : [];
  return arr.length ? arr : FALLBACK_MENU;
}

function getSidesList(store) {
  const sides =
    store?.sides ||
    store?.conversation?.sides ||
    store?.data?.sides ||
    store?.config?.sides ||
    [];
  const arr = Array.isArray(sides) ? sides : [];
  return arr.length ? arr : FALLBACK_SIDES;
}

function getGreeting(store) {
  return store?.conversation?.greeting || "Hi! Welcome 🙂 Pickup or delivery?";
}

function getSpiceLevels(store) {
  const levels = store?.conversation?.spiceLevels || store?.spiceLevels || ["Mild", "Medium", "Hot"];
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
   CORE FLOW
========================= */

async function handleUserTurn(store, session, rawText) {
  const text = norm(rawText);
  const knownSides = getSidesList(store);
  const menu = getMenuList(store);

  // 1) Menu / sides questions
  if (isAskingMenu(text)) {
    if (!menu.length) return "I don’t have the menu loaded yet. Please tell me what pizza you want.";
    return `Here are our pizzas: ${menu.join(", ")}. What would you like to order?`;
  }

  if (isAskingSides(text)) {
    if (!knownSides.length) {
      return "Sides aren’t configured yet in the store settings. You can still say: add coke / add fries, or say: no sides.";
    }
    return `Our sides are: ${knownSides.join(", ")}. Would you like any sides? (Or say: no sides)`;
  }

  // 2) If user says "no sides" at ANY time: lock it in and move on
  if (isNoSides(text)) {
    session.sides = [];
    session.sidesAsked = true;

    // If we were confirming, re-confirm immediately
    if (session.items.length && session.orderType) {
      session.confirming = true;
      return buildConfirmation(store, session);
    }

    return "Got it — no sides. What would you like next?";
  }

  // 3) If user is at confirmation and says "add coke", treat as edit + re-confirm
  // Also works outside confirmation.
  const mentionedSides = extractSidesFromText(text, knownSides);

  // Detect "add" intent OR user simply typed a side name
  const looksLikeSideAdd = /(add|also|include|with|and)\b/i.test(text) || mentionedSides.length > 0;

  if (looksLikeSideAdd && mentionedSides.length > 0) {
    const merged = new Set([...(session.sides || []), ...mentionedSides]);
    session.sides = Array.from(merged);
    session.sidesAsked = true;

    // If user was confirming or is done, go straight to confirmation
    if (session.items.length && session.orderType && (session.confirming || isDone(text))) {
      session.confirming = true;
      return `Got it — added ${mentionedSides.join(", ")}. ` + buildConfirmation(store, session);
    }

    return `Got it — added ${mentionedSides.join(", ")}. Anything else?`;
  }

  // 4) Confirm logic
  if (session.confirming) {
    if (isConfirmYes(text)) {
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

      sessions.delete(session.id);
      return "Your order is confirmed. Thank you!";
    }

    if (isConfirmNo(text)) {
      session.confirming = false;
      session.awaiting = null;
      session.awaitingItemIndex = null;
      return "No problem. Tell me what you want to change (pizza, size, spice, sides, pickup/delivery).";
    }

    // Anything else while confirming = treat as correction
    session.confirming = false;
  }

  // 5) Pickup/delivery anywhere
  const type = detectOrderType(text);
  if (type) session.orderType = type;

  // 6) Slot filling
  if (session.awaiting === "address") {
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
      return `Please say a spice level: ${getSpiceLevels(store).join(", ")}.`;
    }
  }

  // 7) AI extraction (best effort)
  let ai = null;
  try {
    ai = await extractMeaning(store, text);
  } catch (e) {
    console.error("AI extractMeaning error:", e);
  }

  if (ai && typeof ai === "object") {
    if (ai.orderType) session.orderType = ai.orderType;
    if (ai.address) session.address = ai.address;

    if (Array.isArray(ai.sides)) {
      session.sides = ai.sides;
      session.sidesAsked = true;
    }

    if (Array.isArray(ai.items) && ai.items.length) {
      session.items = ai.items.map((it) => ({
        name: it.name || it.pizza || it.item || "",
        qty: Number(it.qty || it.quantity || 1) || 1,
        size: it.size || null,
        spice: it.spice || null
      }));
    }
  }

  // 8) Decision / Next Question
  if (!session.orderType) return "Pickup or delivery?";

  if (session.orderType === "Delivery" && !session.address) {
    session.awaiting = "address";
    return "What’s the delivery address?";
  }

  if (!session.items.length) {
    const hint = menu.length ? ` You can say: 1 large ${menu[0]}.` : "";
    return `What would you like to order?${hint}`;
  }

  // Ensure each item has qty+size+spice
  for (let idx = 0; idx < session.items.length; idx++) {
    const it = session.items[idx];
    if (!it.qty) it.qty = 1;

    if (!it.size) {
      session.awaiting = "size";
      session.awaitingItemIndex = idx;
      return `What size for ${it.name || "that pizza"}? Small, Medium, or Large?`;
    }

    if (!it.spice) {
      session.awaiting = "spice";
      session.awaitingItemIndex = idx;
      return `What spice level for ${it.name || "that pizza"}? ${getSpiceLevels(store).join(", ")}?`;
    }
  }

  // Ask sides once (but if user says "that's all" we confirm immediately)
  if (!session.sidesAsked) {
    session.sidesAsked = true;

    if (isDone(text)) {
      session.confirming = true;
      return buildConfirmation(store, session);
    }

    if (!knownSides.length) {
      return "Would you like any sides? (You can say: add coke / add fries, or say: no sides)";
    }

    return `Would you like any sides? Available: ${knownSides.join(", ")}. (Or say: no sides)`;
  }

  // If user says done, confirm
  if (isDone(text)) {
    session.confirming = true;
    return buildConfirmation(store, session);
  }

  // Optional engine hook
  const maybeNext =
    typeof conversationEngine?.nextQuestion === "function"
      ? conversationEngine.nextQuestion(store, session)
      : (typeof conversationEngine?.default === "function" ? conversationEngine.default(store, session) : null);

  if (typeof maybeNext === "string" && maybeNext && maybeNext !== "confirm") {
    return maybeNext;
  }

  session.confirming = true;
  return buildConfirmation(store, session);
}

/* =========================
   TWILIO VOICE
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

app.post("/twilio/step", async (req, res) => {
  try {
    const store = resolveStore({ toPhone: req.body.To });
    if (!store) return res.sendStatus(404);

    const sessionId = req.body.CallSid;
    const speech = norm(req.body.SpeechResult);

    if (!sessions.has(sessionId)) {
      const s = makeSession({ id: sessionId, store, from: req.body.From, to: req.body.To });
      sessions.set(sessionId, s);
    }

    const session = sessions.get(sessionId);

    if (!speech) return respondTwilio(res, "Sorry, I didn’t catch that. Please say it again.");

    const reply = await handleUserTurn(store, session, speech);
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

app.post("/api/chat/start", (req, res) => {
  const storePhone = req.body?.storePhone || process.env.DEFAULT_STORE_PHONE;
  const store = resolveStore({ toPhone: storePhone });
  if (!store) {
    return res.status(400).json({ error: "Store not found. Set DEFAULT_STORE_PHONE or send storePhone." });
  }

  const session = makeSession({ store, from: req.body?.from || "web-user", to: storePhone });
  sessions.set(session.id, session);

  res.json({
    sessionId: session.id,
    message: "New session started. What would you like to order?"
  });
});

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

  // If confirmed, session may be deleted
  if (!sessions.has(sessionId)) {
    return res.json({ message: reply });
  }

  res.json({ message: reply });
});

/* =========================
   DASHBOARD API
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
  console.log("🧪 Web chat test: /chat.html (or /dashboard/chat.html)");
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
