import "dotenv/config";
import express from "express";
import cors from "cors";
import path from "path";
import twilio from "twilio";
import { fileURLToPath } from "url";

import { getStoreByPhone } from "./services/storeService.js";
import { extractMeaning } from "./services/aiService.js";
import { nextQuestion } from "./engine/conversationEngine.js";
import { createTicket, getTicketsByStore } from "./services/ticketService.js";

/* =========================
   BASIC SETUP
========================= */

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(cors());
app.use(express.urlencoded({ extended: false }));
app.use(express.json());

// dashboard (static)
app.use("/dashboard", express.static(path.join(__dirname, "dashboard")));

const PORT = process.env.PORT || 10000;

/* =========================
   IN-MEMORY SESSIONS
========================= */
/**
 * sessions key:
 * - Twilio: callSid
 * - Chat UI: "chat:<sessionId>"
 */
const sessions = new Map();

/* =========================
   HELPERS: PARSING
========================= */

function normalizeText(s = "") {
  return String(s || "").trim();
}

function parseSize(text) {
  const t = text.toLowerCase();
  if (/\bsmall\b|\bsml\b/.test(t)) return "Small";
  if (/\bmedium\b|\bmed\b/.test(t)) return "Medium";
  if (/\blarge\b|\blrg\b/.test(t)) return "Large";
  return null;
}

function parseQty(text) {
  const t = text.toLowerCase().trim();

  // digits like "2", "2 pizzas", "qty 3"
  const m1 = t.match(/\b(\d+)\b/);
  if (m1) {
    const n = Number(m1[1]);
    if (Number.isFinite(n) && n > 0 && n <= 50) return n;
  }

  // simple number words
  const map = {
    one: 1, two: 2, three: 3, four: 4, five: 5,
    six: 6, seven: 7, eight: 8, nine: 9, ten: 10
  };
  for (const [w, n] of Object.entries(map)) {
    if (new RegExp(`\\b${w}\\b`).test(t)) return n;
  }

  // "a" / "an" → 1
  if (/\b(a|an|one)\b/.test(t)) return 1;

  return null;
}

/* =========================
   REQUIRED FIELDS GATE
========================= */
/**
 * We enforce: for each pizza item => size + qty must exist
 * before we let the flow go to sides/confirm.
 */

function ensureRequiredItemFields(session) {
  // if no items, nothing to enforce
  if (!Array.isArray(session.items) || session.items.length === 0) {
    session.pending = null;
    return;
  }

  // find first item missing size or qty
  for (let i = 0; i < session.items.length; i++) {
    const it = session.items[i] || {};
    const missingSize = !it.size || !String(it.size).trim();
    const missingQty = !it.qty || Number(it.qty) <= 0;

    if (missingSize) {
      session.pending = { type: "size", index: i };
      return;
    }
    if (missingQty) {
      session.pending = { type: "qty", index: i };
      return;
    }
  }

  // all good
  session.pending = null;
}

function pendingQuestion(store, session) {
  if (!session.pending) return null;

  const it = session.items[session.pending.index] || {};
  const name = it.name || "that pizza";

  if (session.pending.type === "size") {
    // If you have store-defined sizes, you can pull them here.
    return `What size would you like for ${name}? Small, Medium, or Large?`;
  }

  if (session.pending.type === "qty") {
    return `How many ${name} would you like?`;
  }

  return null;
}

function applyPendingAnswer(session, speech) {
  if (!session.pending) return { applied: false };

  const it = session.items?.[session.pending.index];
  if (!it) return { applied: false };

  if (session.pending.type === "size") {
    const size = parseSize(speech);
    if (!size) return { applied: false, error: "size" };
    it.size = size;
    return { applied: true };
  }

  if (session.pending.type === "qty") {
    const qty = parseQty(speech);
    if (!qty) return { applied: false, error: "qty" };
    it.qty = qty;
    return { applied: true };
  }

  return { applied: false };
}

/* =========================
   MENU / HELP INTENTS (optional but useful)
========================= */

function isMenuQuestion(text) {
  const t = text.toLowerCase();
  return (
    /\bmenu\b/.test(t) ||
    /\bwhat (pizza|pizzas)\b/.test(t) ||
    /\bwhat do you have\b/.test(t) ||
    /\bwhat are (the )?options\b/.test(t)
  );
}

function buildMenuReply(store) {
  // Try multiple possible shapes safely
  const pizzas =
    store?.menu?.pizzas ||
    store?.menu?.pizza ||
    store?.menu ||
    store?.conversation?.menu ||
    null;

  if (Array.isArray(pizzas) && pizzas.length) {
    return `Here are our pizzas: ${pizzas.join(", ")}. What would you like?`;
  }

  return "I can help you order. Tell me the pizza name and size, like: 1 large pepperoni.";
}

/* =========================
   TWILIO ENTRY POINT
========================= */

app.post("/twilio/voice", (req, res) => {
  const store = getStoreByPhone(req.body.To);
  const twiml = new twilio.twiml.VoiceResponse();

  twiml.say(
    { voice: "alice", language: "en-CA" },
    store?.conversation?.greeting || "Hi! Pickup or delivery?"
  );

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
   TWILIO STEP (SAFE)
========================= */

app.post("/twilio/step", async (req, res) => {
  try {
    const store = getStoreByPhone(req.body.To);
    if (!store) return res.sendStatus(404);

    const callSid = req.body.CallSid;
    const speech = normalizeText(req.body.SpeechResult);

    // create session if missing
    if (!sessions.has(callSid)) {
      sessions.set(callSid, {
        store_id: store.id,
        caller: req.body.From,
        items: [],
        sides: [],
        orderType: null,
        address: null,
        confirming: false,
        sidesAsked: false,
        pending: null
      });
    }

    const session = sessions.get(callSid);

    // silence protection
    if (!speech) {
      return respond(res, "Sorry, I didn’t catch that. Please say it again.");
    }

    // If we are waiting for size/qty, try to apply it BEFORE calling AI
    if (session.pending) {
      const r = applyPendingAnswer(session, speech);
      if (r.applied) {
        ensureRequiredItemFields(session);
        const pq = pendingQuestion(store, session);
        if (pq) return respond(res, pq);

        // continue normal flow now that required fields are satisfied
      } else {
        if (r.error === "size") return respond(res, "Please say Small, Medium, or Large.");
        if (r.error === "qty") return respond(res, "Please say a number like 1, 2, or 3.");
      }
    }

    // Handle menu question
    if (isMenuQuestion(speech)) {
      return respond(res, buildMenuReply(store));
    }

    // AI extraction
    const ai = await extractMeaning(store, speech);

    // AI safety
    if (!ai || typeof ai !== "object") {
      return respond(res, "Sorry, I didn’t understand that. Could you repeat?");
    }

    // merge order type
    if (ai.orderType) session.orderType = ai.orderType;

    // merge items
    if (Array.isArray(ai.items) && ai.items.length > 0) {
      session.items = ai.items;
      session.confirming = false;
    }

    // merge sides
    if (Array.isArray(ai.sides)) session.sides = ai.sides;

    // ✅ enforce required fields (size/qty) BEFORE nextQuestion()
    ensureRequiredItemFields(session);
    const pq = pendingQuestion(store, session);
    if (pq) return respond(res, pq);

    // ask next question
    const q = nextQuestion(store, session);
    const question =
      typeof q === "string" && q.length
        ? q
        : "Is there anything else I can help you with?";

    // confirmation phase
    if (question === "confirm" && !session.confirming) {
      session.confirming = true;
      return respond(res, buildConfirmation(store, session));
    }

    // user confirms
    if (session.confirming && /^(yes|yeah|correct|yep)$/i.test(speech)) {
      createTicket({
        store_id: store.id,
        caller: session.caller,
        items: session.items,
        sides: session.sides,
        orderType: session.orderType || "Pickup",
        address: session.address || null
      });

      sessions.delete(callSid);
      return respond(res, "Your order is confirmed. Thank you!");
    }

    // user rejects confirmation → loop
    if (session.confirming && /^(no|wrong|nope)$/i.test(speech)) {
      session.confirming = false;
      return respond(res, "No problem. Please tell me the correct order.");
    }

    return respond(res, question);
  } catch (err) {
    console.error("❌ Twilio step error:", err);
    const twiml = new twilio.twiml.VoiceResponse();
    twiml.say("Sorry, something went wrong. Please try again.");
    res.type("text/xml").send(twiml.toString());
  }
});

/* =========================
   CHAT TEST API (WEB UI)
========================= */

app.post("/api/chat/step", async (req, res) => {
  try {
    const sessionId = normalizeText(req.body.sessionId);
    const storePhone = normalizeText(req.body.storePhone);
    const message = normalizeText(req.body.message);

    if (!sessionId) return res.status(400).json({ error: "Missing sessionId" });
    if (!storePhone) return res.status(400).json({ error: "Missing storePhone" });
    if (!message) return res.status(400).json({ error: "Missing message" });

    const store = getStoreByPhone(storePhone);
    if (!store) return res.status(404).json({ error: "Store not found for that phone" });

    const key = `chat:${sessionId}`;

    if (!sessions.has(key)) {
      sessions.set(key, {
        store_id: store.id,
        caller: "web-chat",
        items: [],
        sides: [],
        orderType: null,
        address: null,
        confirming: false,
        sidesAsked: false,
        pending: null
      });
    }

    const session = sessions.get(key);

    // pending size/qty gate first
    if (session.pending) {
      const r = applyPendingAnswer(session, message);
      if (r.applied) {
        ensureRequiredItemFields(session);
        const pq = pendingQuestion(store, session);
        if (pq) return res.json({ reply: pq });
      } else {
        if (r.error === "size") return res.json({ reply: "Please say Small, Medium, or Large." });
        if (r.error === "qty") return res.json({ reply: "Please say a number like 1, 2, or 3." });
      }
    }

    if (isMenuQuestion(message)) {
      return res.json({ reply: buildMenuReply(store) });
    }

    const ai = await extractMeaning(store, message);
    if (!ai || typeof ai !== "object") {
      return res.json({ reply: "Sorry, I didn’t understand that. Could you repeat?" });
    }

    if (ai.orderType) session.orderType = ai.orderType;
    if (Array.isArray(ai.items) && ai.items.length > 0) {
      session.items = ai.items;
      session.confirming = false;
    }
    if (Array.isArray(ai.sides)) session.sides = ai.sides;

    // enforce size/qty before moving ahead
    ensureRequiredItemFields(session);
    const pq = pendingQuestion(store, session);
    if (pq) return res.json({ reply: pq });

    const q = nextQuestion(store, session);
    const question =
      typeof q === "string" && q.length
        ? q
        : "Is there anything else I can help you with?";

    if (question === "confirm" && !session.confirming) {
      session.confirming = true;
      return res.json({ reply: buildConfirmation(store, session) });
    }

    if (session.confirming && /^(yes|yeah|correct|yep)$/i.test(message)) {
      createTicket({
        store_id: store.id,
        caller: session.caller,
        items: session.items,
        sides: session.sides,
        orderType: session.orderType || "Pickup",
        address: session.address || null
      });

      sessions.delete(key);
      return res.json({ reply: "Your order is confirmed. Thank you!" });
    }

    if (session.confirming && /^(no|wrong|nope)$/i.test(message)) {
      session.confirming = false;
      return res.json({ reply: "No problem. Please tell me the correct order." });
    }

    return res.json({ reply: question });
  } catch (err) {
    console.error("❌ Chat step error:", err);
    return res.status(500).json({ error: "Server error" });
  }
});

/* =========================
   DASHBOARD API
========================= */

app.get("/api/stores/:id/tickets", (req, res) => {
  res.json(getTicketsByStore(req.params.id));
});

/* =========================
   HELPERS
========================= */

function respond(res, text) {
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

function buildConfirmation(store, session) {
  const items = (session.items || [])
    .map((i, idx) => {
      const qty = i.qty || 1;
      const size = i.size || "";
      const name = i.name || "item";
      return `${idx + 1}. ${qty} ${size} ${name}`.replace(/\s+/g, " ").trim();
    })
    .join(". ");

  const sides = session.sides?.length
    ? ` Sides: ${session.sides.join(", ")}.`
    : "";

  const type = session.orderType ? ` Order type: ${session.orderType}.` : "";

  return `Please confirm your order. ${items}.${sides}${type} Is that correct?`;
}

/* =========================
   SERVER
========================= */

app.listen(PORT, () => {
  console.log("🚀 Store AI running on port", PORT);
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
