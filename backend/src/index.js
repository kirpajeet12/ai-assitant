
/**
 * index.js
 * - Twilio voice webhook: /twilio/voice + /twilio/step
 * - Web chat test API: /api/chat/step
 * - Web chat UI: /chat
 *
 * This version:
 * ✅ Keeps the same "mechanism" (sessions, ticket creation, nextQuestion engine)
 * ✅ Adds "confirm + ask missing slot" behavior
 * ✅ Supports "what pizzas do you have?" (menu intent)
 * ✅ Prevents spice-loop by tracking what we are currently asking (session.expecting)
 */

import "dotenv/config"; // Loads .env into process.env (OPENAI_API_KEY, etc.)

import express from "express"; // Web server framework
import cors from "cors"; // Allow browser UI to call backend
import path from "path"; // Handle filesystem paths
import twilio from "twilio"; // Twilio VoiceResponse
import { fileURLToPath } from "url"; // ESM-friendly __dirname
import crypto from "crypto"; // For generating IDs if needed

import { getStoreByPhone } from "./services/storeService.js"; // Your store lookup
import { extractMeaning } from "./services/aiService.js"; // AI parser (updated below)
import { nextAction } from "./engine/conversationEngine.js"; // Engine that decides next step (updated below)
import { createTicket, getTicketsByStore } from "./services/ticketService.js"; // Tickets

/* =========================
   BASIC SETUP
========================= */

// Build __dirname in ESM
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Create express app
const app = express();

// Enable CORS (needed for browser chat UI)
app.use(cors());

// Parse Twilio form-encoded body
app.use(express.urlencoded({ extended: false }));

// Parse JSON bodies (for browser chat API)
app.use(express.json());

// Serve static dashboard (your existing feature)
app.use("/dashboard", express.static(path.join(__dirname, "dashboard")));

// Serve the test chat UI (new)
app.use("/chat", express.static(path.join(__dirname, "public/chat")));

// Port
const PORT = process.env.PORT || 10000;

/* =========================
   IN-MEMORY SESSIONS
========================= */

/**
 * sessions Map:
 * - key = callSid for Twilio calls OR chat sessionId for browser chat
 * - value = session state
 */
const sessions = new Map();

/**
 * Create a fresh session object.
 * We track "expecting" so the AI can correctly interpret user answers like "medium".
 */
function newSession(store, caller) {
  return {
    store_id: store.id, // Which store
    caller, // Phone number or "web"
    items: [], // [{ name, size, qty, spice }]
    sides: [], // ["Coke", ...]
    orderType: null, // "Pickup" | "Delivery"
    address: null, // Delivery address
    customerName: null, // Optional (if you want)
    confirming: false, // Are we in final confirmation?
    expecting: null, // "size" | "spice" | "orderType" | "address" | null
    askedSidesOnce: false, // Prevent endless sides prompts
    lastBotText: "", // Useful for debugging
    createdAt: Date.now() // For possible cleanup
  };
}

/* =========================
   TWILIO ENTRY POINT
========================= */

app.post("/twilio/voice", (req, res) => {
  // Twilio sends `To` (your Twilio number) and `From` (caller)
  const store = getStoreByPhone(req.body.To);

  // Create Twilio response builder
  const twiml = new twilio.twiml.VoiceResponse();

  // If store config exists, use greeting; else fallback
  const greeting =
    store?.conversation?.greeting ||
    "Hi! Welcome. Would you like pickup or delivery?";

  // Speak greeting
  twiml.say({ voice: "alice", language: "en-CA" }, greeting);

  // Ask user for speech input and send it to /twilio/step
  twiml.gather({
    input: "speech",
    language: "en-CA",
    bargeIn: true,
    action: "/twilio/step",
    method: "POST"
  });

  // Return TwiML XML
  res.type("text/xml").send(twiml.toString());
});

/* =========================
   TWILIO STEP (SAFE)
========================= */

app.post("/twilio/step", async (req, res) => {
  try {
    // Identify store by Twilio number
    const store = getStoreByPhone(req.body.To);

    // If no store found, stop
    if (!store) return res.sendStatus(404);

    // Call SID = session key for Twilio calls
    const callSid = req.body.CallSid;

    // Speech from Twilio speech recognition
    const speech = (req.body.SpeechResult || "").trim();

    // Create a session if it doesn't exist yet
    if (!sessions.has(callSid)) {
      sessions.set(callSid, newSession(store, req.body.From));
    }

    // Get session reference
    const session = sessions.get(callSid);

    // Handle silence / empty speech
    if (!speech) {
      return respondTwilio(res, store, session, "Sorry, I didn’t catch that. Please say it again.");
    }

    // Ask AI to extract meaning (we pass session.expecting so "medium" can map correctly)
    const ai = await extractMeaning(store, speech, session);

    // If AI failed, ask user to repeat
    if (!ai || typeof ai !== "object") {
      return respondTwilio(res, store, session, "Sorry, I didn’t understand. Could you say that again?");
    }

    // Apply AI result into our session state
    applyAiToSession(session, ai);

    // If user confirms in this turn, finalize
    const handledConfirmation = tryHandleConfirmation(store, session, speech);
    if (handledConfirmation) {
      // tryHandleConfirmation already responded
      sessions.delete(callSid);
      return respondTwilio(res, store, session, handledConfirmation);
    }

    // Decide next bot action (confirm+ask-missing logic is inside engine)
    const action = nextAction(store, session, ai);

    // Store what we are expecting next (prevents loops & helps AI)
    session.expecting = action.expecting || null;

    // If the engine says "confirm", switch to confirming mode
    if (action.kind === "confirm") {
      session.confirming = true;
    }

    // Speak the reply and gather next user input
    return respondTwilio(res, store, session, action.text);
  } catch (err) {
    console.error("❌ Twilio step error:", err);

    // Fail-safe TwiML response
    const twiml = new twilio.twiml.VoiceResponse();
    twiml.say("Sorry, something went wrong. Please try again.");
    res.type("text/xml").send(twiml.toString());
  }
});

/* =========================
   WEB CHAT TEST API (NEW)
========================= */

/**
 * POST /api/chat/step
 * Body:
 * {
 *   "sessionId": "uuid-string",
 *   "storePhone": "+1xxxxxxxxxx",   // IMPORTANT: must match store lookup logic
 *   "message": "i want 1 large shahi paneer"
 * }
 *
 * Returns:
 * { reply: "text...", session: {...} }
 */
app.post("/api/chat/step", async (req, res) => {
  try {
    // Read incoming fields
    const sessionId = (req.body.sessionId || "").trim();
    const storePhone = (req.body.storePhone || "").trim();
    const message = (req.body.message || "").trim();

    // Basic validation
    if (!sessionId) return res.status(400).json({ error: "Missing sessionId" });
    if (!storePhone) return res.status(400).json({ error: "Missing storePhone" });
    if (!message) return res.status(400).json({ error: "Missing message" });

    // Find store by phone (same as Twilio `To`)
    const store = getStoreByPhone(storePhone);
    if (!store) return res.status(404).json({ error: "Store not found for that phone" });

    // Create session if missing
    if (!sessions.has(sessionId)) {
      sessions.set(sessionId, newSession(store, "web"));
    }

    // Get session
    const session = sessions.get(sessionId);

    // Parse user message with AI
    const ai = await extractMeaning(store, message, session);

    // If AI failed
    if (!ai || typeof ai !== "object") {
      return res.json({ reply: "Sorry, I didn’t understand. Try again?", session });
    }

    // Apply AI fields into session
    applyAiToSession(session, ai);

    // Handle confirmation (yes/no) if in confirming phase
    const confirmText = tryHandleConfirmation(store, session, message);
    if (confirmText) {
      // Order is saved, clear session
      sessions.delete(sessionId);
      return res.json({ reply: confirmText, session: null, done: true });
    }

    // Decide next action
    const action = nextAction(store, session, ai);

    // Save expecting slot
    session.expecting = action.expecting || null;

    // Save confirming state
    if (action.kind === "confirm") session.confirming = true;

    // Respond to browser
    return res.json({ reply: action.text, session });
  } catch (err) {
    console.error("❌ Chat step error:", err);
    return res.status(500).json({ error: "Server error" });
  }
});

/* =========================
   DASHBOARD API
========================= */

app.get("/api/stores/:id/tickets", (req, res) => {
  // Your existing endpoint
  res.json(getTicketsByStore(req.params.id));
});

/* =========================
   APPLY AI → SESSION
========================= */

/**
 * Merge AI result into session safely.
 * This supports:
 * - adding new items
 * - updating last item with size/spice if user answered "medium" to a question
 * - updating orderType/address/sides
 */
function applyAiToSession(session, ai) {
  // Merge order type if present
  if (ai.orderType) {
    session.orderType = ai.orderType;
  }

  // Merge address if present
  if (ai.address) {
    session.address = ai.address;
  }

  // Merge customer name if present (optional)
  if (ai.customerName) {
    session.customerName = ai.customerName;
  }

  // Merge sides (append unique)
  if (Array.isArray(ai.sides) && ai.sides.length > 0) {
    const set = new Set(session.sides);
    for (const s of ai.sides) set.add(s);
    session.sides = Array.from(set);
  }

  // If AI gave NEW items with names, append them
  if (Array.isArray(ai.items) && ai.items.length > 0) {
    for (const item of ai.items) {
      // Ignore junk
      if (!item || !item.name) continue;

      // Normalize fields
      const normalized = {
        name: String(item.name),
        qty: Number(item.qty || 1),
        size: item.size || null,
        spice: item.spice || null
      };

      // Add to order
      session.items.push(normalized);
    }

    // If new item added, we are not confirming anymore
    session.confirming = false;
  }

  /**
   * If the AI returned "itemUpdates" (like size/spice without a new item),
   * apply it to the LAST item (active item).
   */
  if (ai.itemUpdates && session.items.length > 0) {
    const last = session.items[session.items.length - 1];

    // Apply only if present
    if (ai.itemUpdates.qty) last.qty = Number(ai.itemUpdates.qty);
    if (ai.itemUpdates.size) last.size = ai.itemUpdates.size;
    if (ai.itemUpdates.spice) last.spice = ai.itemUpdates.spice;

    // If user is providing updates, stop confirming
    session.confirming = false;
  }
}

/* =========================
   CONFIRMATION HANDLING
========================= */

/**
 * Handles "yes/no" when we are in confirming mode.
 * Returns a string to speak if handled, else null.
 */
function tryHandleConfirmation(store, session, rawText) {
  // If we are not confirming, nothing to do
  if (!session.confirming) return null;

  // Normalize input
  const text = String(rawText || "").trim().toLowerCase();

  // YES patterns
  const isYes = /^(yes|yeah|yep|correct|that's right|thats right|confirm)$/i.test(text);

  // NO patterns
  const isNo = /^(no|nope|wrong|change|not correct)$/i.test(text);

  // If user confirmed
  if (isYes) {
    // Create the ticket/order
    createTicket({
      store_id: store.id,
      caller: session.caller,
      items: session.items,
      sides: session.sides,
      orderType: session.orderType || "Pickup",
      address: session.orderType === "Delivery" ? (session.address || null) : null,
      customerName: session.customerName || null
    });

    // Tell user done
    return "Perfect — your order is confirmed. Thank you!";
  }

  // If user rejected
  if (isNo) {
    // Exit confirmation mode
    session.confirming = false;

    // Ask them to correct
    return "No problem. Tell me what you’d like to change.";
  }

  // If unclear (user said something else), keep them in confirm mode and ask again
  return "Please say yes to confirm or no to change the order.";
}

/* =========================
   TWILIO RESPONDER
========================= */

/**
 * Twilio response helper: say + gather
 */
function respondTwilio(res, store, session, text) {
  // Save last bot text (debugging)
  session.lastBotText = text;

  // Build TwiML
  const twiml = new twilio.twiml.VoiceResponse();

  // Speak
  twiml.say({ voice: "alice", language: "en-CA" }, text);

  // Listen again
  twiml.gather({
    input: "speech",
    language: "en-CA",
    bargeIn: true,
    action: "/twilio/step",
    method: "POST"
  });

  // Send XML
  res.type("text/xml").send(twiml.toString());
}

/* =========================
   SERVER
========================= */

app.listen(PORT, () => {
  console.log("🚀 Store AI running on port", PORT);
  console.log("🧪 Test chat UI: http://localhost:" + PORT + "/chat");
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
