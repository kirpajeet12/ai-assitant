
import "dotenv/config";
import express from "express";
import cors from "cors";
import path from "path";
import twilio from "twilio";
import { fileURLToPath } from "url";

import { getStoreByPhone } from "./services/storeService.js";
import { extractMeaning } from "./services/aiService.js";
import { nextQuestion } from "./engine/conversationEngine.js";
import { calculateTotal } from "./engine/pricingEngine.js";
import { formatForKitchen } from "./engine/printEngine.js";
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

app.use("/dashboard", express.static(path.join(__dirname, "dashboard")));

const PORT = process.env.PORT || 10000;

/* =========================
   SESSIONS
========================= */

const sessions = new Map();

/* =========================
   TWILIO ENTRY
========================= */

app.post("/twilio/voice", (req, res) => {
  const store = getStoreByPhone(req.body.To);
  const twiml = new twilio.twiml.VoiceResponse();

  twiml.say(
    { voice: "alice", language: "en-CA" },
    store?.conversation?.greeting || "Hi, how can I help you today?"
  );

  twiml.gather({
    input: "speech",
    bargeIn: true,
    speechTimeout: "auto",
    action: "/twilio/step",
    method: "POST"
  });

  res.type("text/xml").send(twiml.toString());
});

/* =========================
   TWILIO + CHAT LOGIC
========================= */

async function handleMessage(store, session, text) {
  const speech = text.toLowerCase();

  /* ---------- MENU QUESTIONS ---------- */
  if (/what.*pizza|pizza.*have|menu|types.*pizza/i.test(speech)) {
    return `We have ${Object.keys(store.menu).join(", ")}.`;
  }

  if (/what.*side|side.*available/i.test(speech)) {
    return `We have ${Object.keys(store.sides).join(", ")}.`;
  }

  /* ---------- NO SIDES ---------- */
  if (/no sides|without sides|nothing extra/i.test(speech)) {
    session.sides = [];
    return "Alright, no sides.";
  }

  /* ---------- AI EXTRACTION ---------- */
  const ai = await extractMeaning(store, text);
  if (!ai || typeof ai !== "object") {
    return "Sorry, I didn’t understand that. Could you repeat?";
  }

  if (ai.orderType) session.orderType = ai.orderType;

  if (Array.isArray(ai.items) && ai.items.length) {
    session.items = ai.items.map(i => ({
      ...i,
      size: i.size || "Medium" // fallback safety
    }));
    session.confirming = false;
  }

  if (Array.isArray(ai.sides)) {
    session.sides = ai.sides;
  }

  if (ai.address) session.address = ai.address;

  /* ---------- NEXT QUESTION ---------- */
  const q = nextQuestion(store, session);

  if (q === "confirm") {
    const missingSize = session.items.some(i => !i.size);
    if (missingSize) return "What size would you like?";

    session.confirming = true;
    return buildConfirmation(session);
  }

  return q || "How can I help you?";
}

/* =========================
   TWILIO STEP
========================= */

app.post("/twilio/step", async (req, res) => {
  try {
    const store = getStoreByPhone(req.body.To);
    if (!store) return res.sendStatus(404);

    const callSid = req.body.CallSid;
    const text = (req.body.SpeechResult || "").trim();

    if (!sessions.has(callSid)) {
      sessions.set(callSid, {
        store_id: store.id,
        caller: req.body.From,
        items: [],
        sides: [],
        orderType: null,
        address: null,
        confirming: false
      });
    }

    const session = sessions.get(callSid);

    if (!text) {
      return respond(res, "Sorry, I didn’t catch that. Please say it again.");
    }

    if (session.confirming && /^(yes|confirm|correct)$/i.test(text)) {
      const pricing = calculateTotal(store, session);

      const ticket = {
        store_id: store.id,
        caller: session.caller,
        items: session.items,
        sides: session.sides,
        orderType: session.orderType || "Pickup",
        address: session.address || null,
        pricing,
        print: formatForKitchen(store, session, pricing)
      };

      createTicket(ticket);
      sessions.delete(callSid);

      return respond(
        res,
        `Order confirmed. Your total is $${pricing.total}. Thank you!`
      );
    }

    if (session.confirming && /^(no|wrong)$/i.test(text)) {
      session.confirming = false;
      return respond(res, "No problem. Please tell me the correct order.");
    }

    const reply = await handleMessage(store, session, text);
    return respond(res, reply);

  } catch (err) {
    console.error("❌ Twilio error:", err);
    const twiml = new twilio.twiml.VoiceResponse();
    twiml.say("Sorry, something went wrong. Please try again.");
    res.type("text/xml").send(twiml.toString());
  }
});

/* =========================
   CHAT API (TESTING)
========================= */

app.post("/chat", async (req, res) => {
  try {
    const { sessionId, message, toPhone } = req.body;
    const store = getStoreByPhone(toPhone);
    if (!store) return res.json({ reply: "Store not found." });

    if (!sessions.has(sessionId)) {
      sessions.set(sessionId, {
        store_id: store.id,
        caller: "CHAT",
        items: [],
        sides: [],
        orderType: null,
        address: null,
        confirming: false
      });
    }

    const session = sessions.get(sessionId);
    const reply = await handleMessage(store, session, message);

    if (session.confirming && /^(yes|confirm|correct)$/i.test(message)) {
      const pricing = calculateTotal(store, session);
      createTicket({
        store_id: store.id,
        caller: "CHAT",
        items: session.items,
        sides: session.sides,
        orderType: session.orderType || "Pickup",
        address: session.address || null,
        pricing
      });
      sessions.delete(sessionId);
      return res.json({ reply: `✅ Order confirmed. Total $${pricing.total}` });
    }

    return res.json({ reply });

  } catch (e) {
    console.error(e);
    res.json({ reply: "Something went wrong." });
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
    bargeIn: true,
    speechTimeout: "auto",
    action: "/twilio/step",
    method: "POST"
  });
  res.type("text/xml").send(twiml.toString());
}

function buildConfirmation(session) {
  const items = session.items
    .map((i, idx) => `${idx + 1}. ${i.qty || 1} ${i.size} ${i.name}`)
    .join(". ");

  const sides = session.sides.length
    ? ` Sides: ${session.sides.join(", ")}.`
    : "";

  return `Please confirm your order. ${items}.${sides} Is that correct?`;
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
