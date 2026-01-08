/**
 * src/index.js
 *
 * What this file does:
 * 1) Twilio Voice endpoints
 * 2) Web chat endpoints
 * 3) Dashboard static hosting
 *
 * IMPORTANT:
 * - Voice + web chat use SAME conversation engine
 */

import "dotenv/config";
import express from "express";
import cors from "cors";
import path from "path";
import twilio from "twilio";
import { fileURLToPath } from "url";
import crypto from "crypto";
import fs from "fs";


// Services
import { getStoreByPhone } from "./services/storeService.js";
import { createTicket, getTicketsByStore } from "./services/ticketService.js";

// Engine (NOW ASYNC)
import {
  getGreetingText,
  handleUserTurn,
  buildConfirmationText
} from "./engine/conversationEngine.js";

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

//====================
function getStoreById(storeId) {
  try {
    const storePath = path.join(__dirname, "data", "stores", `${storeId}.json`);
    if (!fs.existsSync(storePath)) return null;
    return JSON.parse(fs.readFileSync(storePath, "utf-8"));
  } catch {
    return null;
  }
}


/* =========================
   IN-MEMORY SESSIONS
========================= */

const voiceSessions = new Map();
const chatSessions = new Map();

const DEFAULT_STORE_PHONE = (process.env.DEFAULT_STORE_PHONE || "").trim();

/* =========================
   PHONE NORMALIZATION
========================= */

function normalizePhone(input) {
  const raw = String(input || "").trim();
  if (!raw) return "";

  const digits = raw.replace(/[^\d+]/g, "");
  if (digits.startsWith("+")) return digits;
  if (/^1\d{10}$/.test(digits)) return `+${digits}`;
  if (/^\d{10}$/.test(digits)) return `+1${digits}`;
  return digits;
}

function safeGetStoreByPhone(phoneMaybe) {
  const phone =
    normalizePhone(phoneMaybe) || normalizePhone(DEFAULT_STORE_PHONE);
  if (!phone) return null;
  return getStoreByPhone(phone);
}

/* =========================
   TWILIO: CALL START
========================= */

app.post("/twilio/voice", (req, res) => {
  const toPhone = req.body.To;
  const fromPhone = req.body.From;
  const callSid = req.body.CallSid;

  const store = safeGetStoreByPhone(toPhone);
  const twiml = new twilio.twiml.VoiceResponse();

  if (store && !voiceSessions.has(callSid)) {
    voiceSessions.set(callSid, {
      store_id: store.id,
      store_phone: normalizePhone(toPhone),
      caller: normalizePhone(fromPhone),
      orderType: null,
      address: null,
      customerName: null,
      items: [],
      sides: [],
      awaiting: null,
      confirming: false,
      completed: false
    });
  }

  const greeting = store
    ? getGreetingText(store)
    : "Hi! This store is not configured yet.";

  twiml.say({ voice: "alice", language: "en-CA" }, greeting);

  twiml.gather({
    input: "speech",
    language: "en-CA",
    bargeIn: true,
    action: "/twilio/step",
    method: "POST"
  });

  return res.type("text/xml").send(twiml.toString());
});

/* =========================
   TWILIO: STEP (FIXED)
========================= */

app.post("/twilio/step", async (req, res) => {
  try {
    const toPhone = req.body.To;
    const fromPhone = req.body.From;
    const callSid = req.body.CallSid;

    const existingSession = voiceSessions.get(callSid);
    const storePhone =
      existingSession?.store_phone ||
      normalizePhone(toPhone) ||
      normalizePhone(DEFAULT_STORE_PHONE);

    const store = storePhone ? getStoreByPhone(storePhone) : null;

    if (!store) {
      return twilioRespond(res, "Sorry, this store is not configured yet.");
    }

    if (!voiceSessions.has(callSid)) {
      voiceSessions.set(callSid, {
        store_id: store.id,
        store_phone: storePhone,
        caller: normalizePhone(fromPhone),
        orderType: null,
        address: null,
        customerName: null,
        items: [],
        sides: [],
        awaiting: null,
        confirming: false,
        completed: false
      });
    }

    const session = voiceSessions.get(callSid);
    const speech = String(req.body.SpeechResult || "").trim();

    if (!speech) {
      return twilioRespond(res, "Sorry, I did not catch that.");
    }

    // ✅ FIX: await async engine
    const result = await handleUserTurn(store, session, speech);

    if (result.session.completed) {
      const summary = buildConfirmationText(store, result.session);

      createTicket({
        store_id: store.id,
        caller: session.caller,
        items: result.session.items,
        sides: result.session.sides,
        orderType: result.session.orderType || "Pickup",
        address: result.session.address || null,
        summary
      });

      voiceSessions.delete(callSid);

      const twiml = new twilio.twiml.VoiceResponse();
      twiml.say({ voice: "alice", language: "en-CA" }, result.reply);
      twiml.hangup();

      return res.type("text/xml").send(twiml.toString());
    }

    return twilioRespond(res, result.reply);
  } catch (err) {
    console.error("Twilio step error:", err);
    return twilioRespond(res, "Sorry, something went wrong.");
  }
});

/* =========================
   WEB CHAT: START
========================= */

app.post("/api/chat/start", (req, res) => {
  const storePhone =
    normalizePhone(req.body.storePhone) ||
    normalizePhone(DEFAULT_STORE_PHONE);

  const store = safeGetStoreByPhone(storePhone);
  if (!store) {
    return res.status(404).json({ error: "Store not found." });
  }

  const sessionId = crypto.randomBytes(16).toString("hex");

  const session = {
    store_id: store.id,
    store_phone: storePhone,
    caller: String(req.body.from || "web-user"),
    orderType: null,
    address: null,
    customerName: null,
    items: [],
    sides: [],
    awaiting: null,
    confirming: false,
    completed: false
  };

  chatSessions.set(sessionId, { store, session });

  return res.json({
    sessionId,
    message: getGreetingText(store)
  });
});

/* =========================
   WEB CHAT: MESSAGE (FIXED)
========================= */

app.post("/api/chat/message", async (req, res) => {
  const sessionId = String(req.body.sessionId || "");
  const text = String(req.body.text || "").trim();

  if (!sessionId || !chatSessions.has(sessionId)) {
    return res.status(400).json({ error: "Invalid sessionId." });
  }
  if (!text) {
    return res.status(400).json({ error: "Empty message." });
  }

  const { store, session } = chatSessions.get(sessionId);

  // ✅ FIX: await async engine
  const result = await handleUserTurn(store, session, text);

  if (result.session.completed) {
    const summary = buildConfirmationText(store, result.session);

    createTicket({
      store_id: store.id,
      caller: session.caller,
      items: result.session.items,
      sides: result.session.sides,
      orderType: result.session.orderType || "Pickup",
      address: result.session.address || null,
      summary
    });

    chatSessions.delete(sessionId);

    return res.json({
      message: result.reply || "Perfect — your order is confirmed."
    });
  }

  return res.json({ message: result.reply });
});

/* =========================
   DASHBOARD API
========================= */

/* =========================
   DASHBOARD API (SECURED)
========================= */

app.get("/api/tickets/:storeId", (req, res) => {
  const { storeId } = req.params;
  const { token } = req.query;

  // Load store config by ID
  const store = getStoreById(storeId);

  if (!store) {
    return res.status(404).json({ error: "Store not found" });
  }

  // Validate dashboard token
  if (!token || store.dashboardToken !== token) {
    return res.status(401).json({ error: "Invalid dashboard token" });
  }

  // Return tickets
  return res.json(getTicketsByStore(storeId));
});

/* =========================
   TWILIO HELPER
========================= */

function twilioRespond(res, text) {
  const twiml = new twilio.twiml.VoiceResponse();
  twiml.say({ voice: "alice", language: "en-CA" }, text);
  twiml.gather({
    input: "speech",
    language: "en-CA",
    bargeIn: true,
    action: "/twilio/step",
    method: "POST"
  });
  return res.type("text/xml").send(twiml.toString());
}

/* =========================
   START SERVER
========================= */

app.listen(PORT, () => {
  console.log("🚀 Store AI running on port", PORT);
});

// /**
//  * src/index.js
//  *
//  * What this file does:
//  * 1) Twilio Voice endpoints:
//  *    - POST /twilio/voice  (call starts)
//  *    - POST /twilio/step   (each user speech turn)
//  * 2) Web chat testing endpoints:
//  *    - POST /api/chat/start
//  *    - POST /api/chat/message
//  * 3) Dashboard static hosting:
//  *    - /dashboard/*
//  *
//  * IMPORTANT:
//  * - Both voice + web chat use the SAME conversation engine.
//  * - That means behavior is consistent during testing.
//  */

// import "dotenv/config"; // Loads .env variables
// import express from "express"; // Web server
// import cors from "cors"; // Allow cross-origin calls
// import path from "path"; // Paths
// import twilio from "twilio"; // Twilio helper to build TwiML
// import { fileURLToPath } from "url"; // For __dirname in ESM
// import crypto from "crypto"; // Create random chat session ids

// // Your services
// import { getStoreByPhone } from "./services/storeService.js";
// import { createTicket, getTicketsByStore } from "./services/ticketService.js";

// // Our engine (script/slot-filling)
// import {
//   getGreetingText,
//   handleUserTurn,
//   buildConfirmationText
// } from "./engine/conversationEngine.js";

// /* =========================
//    BASIC SETUP
// ========================= */

// // ESM-safe __dirname
// const __filename = fileURLToPath(import.meta.url);
// const __dirname = path.dirname(__filename);

// // Create express app
// const app = express();

// // Allow local testing + dashboard access
// app.use(cors());

// // Twilio sends URL-encoded body
// app.use(express.urlencoded({ extended: false }));

// // Dashboard/chat uses JSON
// app.use(express.json());

// // Static dashboard folder
// app.use("/dashboard", express.static(path.join(__dirname, "dashboard")));

// // Port from Render (or local)
// const PORT = process.env.PORT || 10000;

// /* =========================
//    IN-MEMORY SESSIONS
// ========================= */

// /**
//  * Voice sessions:
//  * - key: CallSid
//  * - value: session object
//  */
// const voiceSessions = new Map();

// /**
//  * Chat sessions:
//  * - key: sessionId
//  * - value: { store, session }
//  */
// const chatSessions = new Map();

// /**
//  * Default store phone for chat testing
//  * - if user leaves storePhone empty in chat UI, we use this.
//  */
// const DEFAULT_STORE_PHONE = (process.env.DEFAULT_STORE_PHONE || "").trim();

// /* =========================
//    PHONE NORMALIZATION
// ========================= */

// /**
//  * Normalize phone so your store lookup works more reliably.
//  * Example:
//  * - "+1 (604) 123-4567" -> "+16041234567"
//  * - "16041234567"       -> "+16041234567" (if looks like NA number)
//  */
// function normalizePhone(input) {
//   const raw = String(input || "").trim();
//   if (!raw) return "";

//   // Keep digits + leading plus
//   const digits = raw.replace(/[^\d+]/g, "");

//   // If it already starts with + and has digits, keep it
//   if (digits.startsWith("+")) return digits;

//   // If it looks like 11 digits starting with 1, treat as +1...
//   if (/^1\d{10}$/.test(digits)) return `+${digits}`;

//   // If it looks like 10 digits, treat as North America +1
//   if (/^\d{10}$/.test(digits)) return `+1${digits}`;

//   // Otherwise just return digits (better than nothing)
//   return digits;
// }

// /* =========================
//    STORE LOOKUP
// ========================= */

// function safeGetStoreByPhone(phoneMaybe) {
//   // Use provided phone if present; else fallback to DEFAULT_STORE_PHONE
//   const phone = normalizePhone(phoneMaybe) || normalizePhone(DEFAULT_STORE_PHONE);

//   // If still empty, we cannot lookup
//   if (!phone) return null;

//   // Your storeService should match based on phone
//   return getStoreByPhone(phone);
// }

// /* =========================
//    TWILIO: CALL START
// ========================= */

// app.post("/twilio/voice", (req, res) => {
//   // Twilio usually provides To/From/CallSid
//   const toPhone = req.body.To; // store number
//   const fromPhone = req.body.From; // caller
//   const callSid = req.body.CallSid; // unique call id

//   // Find store config
//   const store = safeGetStoreByPhone(toPhone);

//   // Build TwiML response
//   const twiml = new twilio.twiml.VoiceResponse();

//   // Create voice session if store is found
//   if (store && !voiceSessions.has(callSid)) {
//     voiceSessions.set(callSid, {
//       store_id: store.id,
//       store_phone: normalizePhone(toPhone),
//       caller: normalizePhone(fromPhone),

//       // Order state
//       orderType: null,     // "Pickup" | "Delivery"
//       address: null,       // required for delivery
//       customerName: null,  // optional
//       items: [],           // pizzas
//       sides: [],           // sides/drinks

//       // Flow control
//       awaiting: null,      // e.g. { type: "size", itemIndex: 0 }
//       confirming: false,   // true when we are asking final confirm
//       completed: false     // true after confirmed
//     });
//   }

//   // If store not found, still respond gracefully
//   const greeting = store
//     ? getGreetingText(store)
//     : "Hi! This store is not configured yet. Please contact the shop owner.";

//   twiml.say({ voice: "alice", language: "en-CA" }, greeting);

//   // Gather speech
//   twiml.gather({
//     input: "speech",
//     language: "en-CA",
//     bargeIn: true,
//     action: "/twilio/step",
//     method: "POST"
//   });

//   return res.type("text/xml").send(twiml.toString());
// });

// /* =========================
//    TWILIO: STEP
// ========================= */

// app.post("/twilio/step", (req, res) => {
//   try {
//     const toPhone = req.body.To;        // may be missing on Gather
//     const fromPhone = req.body.From;
//     const callSid = req.body.CallSid;

//     // Reuse store phone saved at call start
//     const existingSession = voiceSessions.get(callSid);

//     const storePhone =
//       existingSession?.store_phone ||
//       normalizePhone(toPhone) ||
//       normalizePhone(DEFAULT_STORE_PHONE);

//     const store = storePhone ? getStoreByPhone(storePhone) : null;

//     if (!store) {
//       return twilioRespond(res, "Sorry, this store is not configured yet.");
//     }

//     // Ensure session exists
//     if (!voiceSessions.has(callSid)) {
//       voiceSessions.set(callSid, {
//         store_id: store.id,
//         store_phone: storePhone,
//         caller: normalizePhone(fromPhone),

//         orderType: null,
//         address: null,
//         customerName: null,
//         items: [],
//         sides: [],
//         awaiting: null,
//         confirming: false,
//         completed: false
//       });
//     }

//     const session = voiceSessions.get(callSid);

//     // User speech
//     const speech = String(req.body.SpeechResult || "").trim();

//     if (!speech) {
//       return twilioRespond(res, "Sorry, I did not catch that. Please say it again.");
//     }

//     // Pass turn to conversation engine
//     const result = handleUserTurn(store, session, speech);

//     // If order completed, create ticket and hang up
//     if (result.session.completed) {
//       const summary = buildConfirmationText(store, result.session);

//       createTicket({
//         store_id: store.id,
//         caller: session.caller,
//         items: result.session.items,
//         sides: result.session.sides,
//         orderType: result.session.orderType || "Pickup",
//         address: result.session.address || null,
//         summary
//       });

//       voiceSessions.delete(callSid);

//       const twiml = new twilio.twiml.VoiceResponse();
//       twiml.say(
//         { voice: "alice", language: "en-CA" },
//         result.reply || "Perfect - your order is confirmed. Thank you!"
//       );
//       twiml.hangup();

//       return res.type("text/xml").send(twiml.toString());
//     }

//     // Continue conversation
//     return twilioRespond(res, result.reply);

//   } catch (err) {
//     console.error("Twilio step error:", err);

//     const twiml = new twilio.twiml.VoiceResponse();
//     twiml.say(
//       { voice: "alice", language: "en-CA" },
//       "Sorry, something went wrong. Please try again."
//     );
//     twiml.hangup();

//     return res.type("text/xml").send(twiml.toString());
//   }
// });

  
// /* =========================
//    WEB CHAT: START
// ========================= */

// app.post("/api/chat/start", (req, res) => {
//   // Store phone can be typed in UI; if empty, fallback to env default
//   const storePhone = normalizePhone(req.body.storePhone) || normalizePhone(DEFAULT_STORE_PHONE);

//   const store = safeGetStoreByPhone(storePhone);
//   if (!store) {
//     return res.status(404).json({
//       error:
//         "Store not found. Put the correct store phone in the chat box or set DEFAULT_STORE_PHONE in .env."
//     });
//   }

//   // Make sessionId
//   const sessionId = crypto.randomBytes(16).toString("hex");

//   // New chat session state
//   const session = {
//     store_id: store.id,
//     store_phone: storePhone,
//     caller: String(req.body.from || "web-user"),
//     orderType: null,
//     address: null,
//     customerName: null,
//     items: [],
//     sides: [],
//     awaiting: null,
//     confirming: false,
//     completed: false
//   };

//   chatSessions.set(sessionId, { store, session });

//   return res.json({
//     sessionId,
//     message: getGreetingText(store)
//   });
// });

// /* =========================
//    WEB CHAT: MESSAGE
// ========================= */

// app.post("/api/chat/message", (req, res) => {
//   const sessionId = String(req.body.sessionId || "");
//   const text = String(req.body.text || "").trim();

//   if (!sessionId || !chatSessions.has(sessionId)) {
//     return res.status(400).json({ error: "Invalid sessionId. Click Start again." });
//   }
//   if (!text) {
//     return res.status(400).json({ error: "Empty message." });
//   }

//   const payload = chatSessions.get(sessionId);
//   const { store, session } = payload;

//   const result = handleUserTurn(store, session, text);

//   // If completed, create ticket and close chat session
//   if (result.session.completed) {
//     const summary = buildConfirmationText(store, result.session);

//     createTicket({
//       store_id: store.id,
//       caller: session.caller,
//       items: result.session.items,
//       sides: result.session.sides,
//       orderType: result.session.orderType || "Pickup",
//       address: result.session.address || null,
//       summary
//     });

//     chatSessions.delete(sessionId);

//     return res.json({
//       message: result.reply || "Perfect — your order is confirmed. Thank you!"
//     });
//   }

//   return res.json({ message: result.reply });
// });

// /* =========================
//    DASHBOARD API
// ========================= */

// app.get("/api/stores/:id/tickets", (req, res) => {
//   return res.json(getTicketsByStore(req.params.id));
// });

// /* =========================
//    TWILIO HELPER
// ========================= */

// function twilioRespond(res, text) {
//   const twiml = new twilio.twiml.VoiceResponse();

//   twiml.say({ voice: "alice", language: "en-CA" }, text);

//   twiml.gather({
//     input: "speech",
//     language: "en-CA",
//     bargeIn: true,
//     action: "/twilio/step",
//     method: "POST"
//   });

//   return res.type("text/xml").send(twiml.toString());
// }

// /* =========================
//    START SERVER
// ========================= */

// app.listen(PORT, () => {
//   console.log("🚀 Store AI running on port", PORT);
// });

// /**
//  * index.js
//  * Full server that supports:
//  * 1) Twilio voice webhook endpoints:
//  *    - POST /twilio/voice
//  *    - POST /twilio/step
//  * 2) Local dashboard chat testing:
//  *    - GET  /api/chat/start
//  *    - POST /api/chat/turn
//  * 3) Static dashboard:
//  *    - /dashboard/chat.html
//  *
//  * Fixes included:
//  * - No duplicated code
//  * - Correct ESM imports (node:path, node:url)
//  * - Spice detection works for phrases like "medium please" or "medium hot"
//  * - Items are MERGED (won’t wipe spice/size/qty when user answers later)
//  * - Sides are loaded from pizza64.json (flexible path search)
//  * - User can ask "which pizzas do you have" / "which sides are available" anytime
//  * - During confirmation, user can still say "add coke" and it will update + re-confirm
//  */

// import "dotenv/config"; // Loads .env values into process.env (Twilio keys, PORT, etc.)
// import express from "express"; // Web server framework
// import cors from "cors"; // Allow dashboard to call APIs
// import fs from "node:fs"; // File system for reading pizza64.json
// import path from "node:path"; // Path utilities (dirname, join, etc.)
// import twilio from "twilio"; // Twilio SDK for TwiML
// import { fileURLToPath } from "node:url"; // Convert import.meta.url to file path

// // OPTIONAL: if you already have AI service, we’ll use it safely.
// // If you don't have it, comment these 2 lines out.
// import { extractMeaning } from "./services/aiService.js"; // Optional AI extractor

// // OPTIONAL: ticket storage service (your existing one).
// // If you don't have it or want to disable, comment these 2 lines out.
// import { createTicket, getTicketsByStore } from "./services/ticketService.js"; // Ticket store

// /* =========================
//    BASIC SETUP
// ========================= */

// // Convert module URL to real file path (needed for ESM).
// const __filename = fileURLToPath(import.meta.url); // Absolute file path of this file
// const __dirname = path.dirname(__filename); // Folder containing index.js

// const app = express(); // Create express app
// app.use(cors()); // Enable CORS for dashboard fetch calls
// app.use(express.urlencoded({ extended: false })); // Twilio sends URL-encoded by default
// app.use(express.json()); // Dashboard sends JSON

// // Serve the dashboard folder at /dashboard
// app.use("/dashboard", express.static(path.join(__dirname, "dashboard")));

// // Port from env or fallback
// const PORT = process.env.PORT || 10000;

// /* =========================
//    LOAD STORE CONFIG (pizza64.json)
// ========================= */

// /**
//  * We try to find pizza64.json in common locations.
//  * Adjust these if your file is somewhere else.
//  */
// function loadPizzaConfig() {
//   const candidates = [
//     path.join(__dirname, "pizza64.json"), // same folder as index.js
//     path.join(__dirname, "data", "pizza64.json"), // /data/pizza64.json
//     path.join(__dirname, "config", "pizza64.json"), // /config/pizza64.json
//     path.join(process.cwd(), "pizza64.json"), // project root
//     path.join(process.cwd(), "data", "pizza64.json") // projectRoot/data
//   ];

//   for (const p of candidates) {
//     if (fs.existsSync(p)) {
//       const raw = fs.readFileSync(p, "utf-8"); // read file
//       const json = JSON.parse(raw); // parse JSON
//       return { json, filePath: p }; // return config
//     }
//   }

//   // If not found, return a safe default config
//   return {
//     json: {
//       id: "default",
//       name: "Pizza Store",
//       phones: [],
//       menu: ["Cheese Lovers", "Pepperoni", "Veggie Supreme", "Butter Chicken", "Shahi Paneer", "Tandoori Chicken"],
//       sides: ["Coke", "Sprite", "Fries", "Garlic Bread", "Wings"],
//       conversation: {
//         greeting: "Hi, welcome! What would you like to order?"
//       }
//     },
//     filePath: null
//   };
// }

// const { json: STORE_CONFIG, filePath: CONFIG_PATH } = loadPizzaConfig(); // Load store config at startup

// // Normalize store into a consistent shape
// const STORE = {
//   id: STORE_CONFIG.id || "pizza64",
//   name: STORE_CONFIG.name || "Pizza Store",
//   phones: Array.isArray(STORE_CONFIG.phones) ? STORE_CONFIG.phones : [],
//   // Menu can be array of strings OR array of objects; we convert to array of names.
//   menu: normalizeMenu(STORE_CONFIG.menu),
//   // Sides can be array of strings OR objects; we convert to array of names.
//   sides: normalizeSides(STORE_CONFIG.sides),
//   conversation: STORE_CONFIG.conversation || { greeting: "Hi, what would you like to order?" }
// };

// // Helper: normalize menu to array of pizza names
// function normalizeMenu(menu) {
//   if (!Array.isArray(menu)) return [];
//   return menu
//     .map((m) => (typeof m === "string" ? m : m?.name))
//     .filter(Boolean);
// }

// // Helper: normalize sides to array of side names
// function normalizeSides(sides) {
//   if (!Array.isArray(sides)) return [];
//   return sides
//     .map((s) => (typeof s === "string" ? s : s?.name))
//     .filter(Boolean);
// }

// /* =========================
//    IN-MEMORY SESSIONS
// ========================= */

// /**
//  * sessionsById stores both:
//  * - Twilio CallSid sessions
//  * - Dashboard chat sessions
//  */
// const sessionsById = new Map(); // Map<sessionId, sessionObject>

// /* =========================
//    TEXT HELPERS
// ========================= */

// function norm(text) {
//   return String(text || "").trim(); // ensure string + trim spaces
// }

// function lower(text) {
//   return norm(text).toLowerCase(); // trim and lowercase
// }

// function isDone(text) {
//   const t = lower(text);
//   return /(no$|no more|that's all|that’s all|thats all|done|finish|nothing else|nope|all good|all set|thats it|that's it)/i.test(t);
// }

// function isNoSides(text) {
//   const t = lower(text);
//   return /(no sides|no side|without sides|none|nothing|no thanks|no thank you|dont want sides|don't want sides)/i.test(t);
// }

// function isConfirmYes(text) {
//   return /^(yes|yeah|yep|correct|right|that's right|that is right|confirm|sounds good|ok|okay)$/i.test(norm(text));
// }

// function isConfirmNo(text) {
//   return /^(no|nope|wrong|incorrect|change|not correct|not right)$/i.test(norm(text));
// }

// function detectOrderType(text) {
//   const t = lower(text);
//   if (/(pickup|pick up|picup|carryout|carry out|takeaway|take away)/i.test(t)) return "Pickup";
//   if (/(delivery|deliver|drop off|dropoff)/i.test(t)) return "Delivery";
//   return null;
// }

// /**
//  * FIXED: Spice detection is "contains based", not exact match.
//  * Handles phrases like:
//  * - "medium please"
//  * - "medium hot" (chooses Hot)
//  * - "not too spicy" (chooses Mild)
//  */
// function detectSpice(text) {
//   const t = lower(text);

//   // Strongest first (if user says multiple words like "medium hot")
//   if (/\b(hot|extra spicy|very spicy|spicy)\b/i.test(t)) return "Hot";
//   if (/\b(medium|mid)\b/i.test(t)) return "Medium";
//   if (/\b(mild|not spicy|low spicy|less spicy|not too spicy)\b/i.test(t)) return "Mild";

//   return null;
// }

// function detectSize(text) {
//   const t = lower(text);
//   if (/\b(small|sm|s)\b/i.test(t)) return "Small";
//   if (/\b(medium|med|m)\b/i.test(t)) return "Medium";
//   if (/\b(large|lg|l)\b/i.test(t)) return "Large";
//   return null;
// }

// function detectQty(text) {
//   const t = lower(text);

//   // Digits: "2", "3"
//   const digitMatch = t.match(/\b(\d{1,2})\b/);
//   if (digitMatch) return Math.max(1, Number(digitMatch[1]));

//   // Words: one/two/three...
//   const words = {
//     one: 1,
//     two: 2,
//     three: 3,
//     four: 4,
//     five: 5,
//     six: 6
//   };
//   for (const [w, n] of Object.entries(words)) {
//     if (new RegExp(`\\b${w}\\b`, "i").test(t)) return n;
//   }

//   return null;
// }

// function isAskingMenu(text) {
//   const t = lower(text);
//   return /(menu|what pizzas|which pizzas|pizza options|pizza do you have|available pizzas|what do you have)/i.test(t);
// }

// function isAskingSides(text) {
//   const t = lower(text);
//   return /(sides|side options|what sides|which sides|sides available|addons|add ons|drinks|beverages)/i.test(t);
// }

// /**
//  * Extract sides from text using known sides list + fallback items.
//  */
// function extractSidesFromText(text, knownSides = []) {
//   const t = lower(text);
//   const found = new Set();

//   // Match from known sides list
//   for (const s of knownSides) {
//     const sLow = s.toLowerCase();
//     if (sLow && t.includes(sLow)) found.add(s);
//   }

//   // Fallback detection for common items
//   const common = ["Coke", "Sprite", "Pepsi", "Water", "Fries", "Garlic Bread", "Wings", "Ranch"];
//   for (const c of common) {
//     if (t.includes(c.toLowerCase())) found.add(c);
//   }

//   return Array.from(found);
// }

// /**
//  * Extract pizza name from text by fuzzy "includes" matching.
//  * Example: "shahi paneer" in "i want large shahi paneer pizza"
//  */
// function extractPizzaFromText(text, menuNames = []) {
//   const t = lower(text);

//   // If menu has "Shahi Paneer", match "shahi paneer" phrase inside text
//   for (const name of menuNames) {
//     const n = name.toLowerCase();
//     if (n && t.includes(n)) return name;
//   }

//   return null;
// }

// /**
//  * Some pizzas require spice level (you can customize this list).
//  * If your pizza64.json contains rules, you can upgrade this later.
//  */
// function pizzaRequiresSpice(pizzaName) {
//   const n = (pizzaName || "").toLowerCase();
//   // Indian-style pizzas usually need spice:
//   if (/(butter chicken|shahi paneer|tandoori|paneer|chicken)/i.test(n)) return true;
//   return false;
// }

// /* =========================
//    ITEM MERGE HELPERS (PREVENTS SPICE LOOP)
// ========================= */

// function normalizeItems(items = []) {
//   return items
//     .map((it) => ({
//       name: it?.name || it?.pizza || it?.item || null,
//       size: it?.size || null,
//       qty: Number(it?.qty || 1),
//       spice: it?.spice || null
//     }))
//     .filter((x) => x.name); // keep only items with a name
// }

// /**
//  * Merge items so new data doesn't wipe old fields.
//  * This prevents the "spice loop" caused by AI returning spice:null.
//  */
// function mergeItems(existing = [], incoming = []) {
//   if (!existing.length) return incoming; // if no existing, just use incoming
//   const out = existing.map((oldItem, idx) => {
//     const n = incoming[idx] || {};
//     return {
//       name: n.name || oldItem.name,
//       size: n.size || oldItem.size,
//       qty: n.qty ? Number(n.qty) : oldItem.qty,
//       spice: n.spice || oldItem.spice
//     };
//   });

//   // Append any extra incoming items
//   if (incoming.length > existing.length) {
//     for (let i = existing.length; i < incoming.length; i++) out.push(incoming[i]);
//   }

//   return out;
// }

// /* =========================
//    CORE TURN HANDLER (SCRIPT-BASED)
// ========================= */

// /**
//  * Build a confirmation message.
//  */
// function buildConfirmation(session) {
//   const parts = [];

//   // Order type + address if delivery
//   parts.push(`Order type: ${session.orderType || "Pickup"}.`);
//   if (session.orderType === "Delivery" && session.address) {
//     parts.push(`Address: ${session.address}.`);
//   }

//   // Items
//   const itemsLine = session.items
//     .map((it, idx) => {
//       const qty = it.qty || 1;
//       const size = it.size || "";
//       const spice = it.spice ? ` (${it.spice})` : "";
//       return `${idx + 1}. ${qty} ${size} ${it.name}${spice}`.replace(/\s+/g, " ").trim();
//     })
//     .join(". ");
//   parts.push(itemsLine ? itemsLine + "." : "No items.");

//   // Sides
//   if (session.sides?.length) {
//     parts.push(`Sides: ${session.sides.join(", ")}.`);
//   } else {
//     parts.push("No sides.");
//   }

//   return `Please confirm your order. ${parts.join(" ")} Is that correct?`;
// }

// /**
//  * Get next question based on missing slots.
//  */
// function nextPrompt(store, session) {
//   // If no pizza selected
//   if (!session.items.length) {
//     return "What would you like to order?";
//   }

//   // Ensure qty + size + spice per item
//   for (const it of session.items) {
//     if (!it.qty) return `How many ${it.name} pizzas would you like?`; // qty missing
//     if (!it.size) return `What size for ${it.name}? Small, Medium, or Large?`; // size missing
//     if (pizzaRequiresSpice(it.name) && !it.spice) {
//       return `What spice level for ${it.name}? Mild, Medium, or Hot?`; // spice missing
//     }
//   }

//   // Ensure pickup/delivery
//   if (!session.orderType) {
//     return "Pickup or delivery?";
//   }

//   // If delivery, ensure address
//   if (session.orderType === "Delivery" && !session.address) {
//     return "What is the delivery address?";
//   }

//   // Ask sides once
//   if (!session.sidesAsked) {
//     session.sidesAsked = true; // mark asked
//     return "Would you like to add any sides? (You can also say: no sides)";
//   }

//   // If user said done/no sides, proceed to confirm
//   return "confirm";
// }

// /**
//  * Apply user text into session using:
//  * - Optional AI extraction (safe)
//  * - Rule-based parsing (always)
//  */
// async function applyUserInput(store, session, text) {
//   const t = norm(text);

//   // 1) OrderType detection
//   const ot = detectOrderType(t);
//   if (ot) session.orderType = ot;

//   // 2) Size / qty / spice detection (applies to the "current" item = last item)
//   const lastItem = session.items.length ? session.items[session.items.length - 1] : null;

//   // 3) Menu & sides questions can be answered anytime
//   if (isAskingMenu(t)) {
//     return { immediateReply: `Here are our pizzas: ${store.menu.join(", ")}.` };
//   }
//   if (isAskingSides(t)) {
//     return { immediateReply: `Available sides: ${store.sides.join(", ")}.` };
//   }

//   // 4) "No sides" signal
//   if (isNoSides(t)) {
//     session.sides = []; // clear sides
//     session.noSidesLocked = true; // lock it so it doesn't keep asking
//   }

//   // 5) Extract sides from text (additive)
//   const newSides = extractSidesFromText(t, store.sides);
//   if (newSides.length) {
//     session.sides = Array.from(new Set([...(session.sides || []), ...newSides])); // add + dedupe
//     session.noSidesLocked = false; // if they add sides, unlock
//   }

//   // 6) Try AI extraction (optional) — but NEVER let it wipe good values
//   try {
//     const ai = await extractMeaning(store, t); // your aiService.js
//     if (ai && typeof ai === "object") {
//       // Merge items safely (prevents spice loop)
//       if (Array.isArray(ai.items) && ai.items.length) {
//         const incoming = normalizeItems(ai.items);
//         session.items = mergeItems(session.items, incoming);
//       }

//       // Merge sides safely
//       if (Array.isArray(ai.sides) && ai.sides.length) {
//         session.sides = Array.from(new Set([...(session.sides || []), ...ai.sides]));
//         session.noSidesLocked = false;
//       }

//       // Merge order type if AI found it
//       if (ai.orderType) session.orderType = ai.orderType;

//       // Merge address if AI found it
//       if (ai.address && !session.address) session.address = ai.address;
//     }
//   } catch (e) {
//     // If AI fails, we still proceed with rule-based logic
//   }

//   // 7) Rule-based pizza detection if AI didn’t add items
//   const pizza = extractPizzaFromText(t, store.menu);

//   // If user mentioned a pizza name, add it as a new item
//   if (pizza) {
//     session.items.push({
//       name: pizza,
//       qty: detectQty(t) || 0, // 0 means missing -> we’ll ask
//       size: detectSize(t) || null,
//       spice: detectSpice(t) || null
//     });
//   }

//   // 8) If user gave qty/size/spice but no new pizza name, apply to last item
//   if (lastItem) {
//     const qty = detectQty(t);
//     if (qty && !lastItem.qty) lastItem.qty = qty;

//     const size = detectSize(t);
//     if (size && !lastItem.size) lastItem.size = size;

//     const sp = detectSpice(t);
//     if (sp && !lastItem.spice) lastItem.spice = sp;
//   }

//   // 9) Address detection (simple fallback)
//   // If user says "my address is ..." or looks like an address and we need it
//   if (session.orderType === "Delivery" && !session.address) {
//     const maybeAddress = t.replace(/^my address is\s+/i, "").trim();
//     // Basic heuristic: if it has a number + street-ish word, accept it
//     if (/\d/.test(maybeAddress) && /(st|street|ave|avenue|rd|road|blvd|drive|dr|lane|ln|way|court|ct)/i.test(maybeAddress)) {
//       session.address = maybeAddress;
//     }
//   }

//   return { immediateReply: null };
// }

// /**
//  * Main script-based conversation turn.
//  */
// async function handleTurn(store, session, text) {
//   // If user is asking menu/sides etc, handle immediately
//   const { immediateReply } = await applyUserInput(store, session, text);
//   if (immediateReply) {
//     return { reply: immediateReply, end: false };
//   }

//   // If we are in confirmation mode:
//   if (session.confirming) {
//     // Confirm YES -> finalize
//     if (isConfirmYes(text)) {
//       // Save ticket if service exists
//       try {
//         createTicket({
//           store_id: store.id,
//           caller: session.caller || "chat",
//           items: session.items,
//           sides: session.sides || [],
//           orderType: session.orderType || "Pickup",
//           address: session.address || null
//         });
//       } catch (e) {
//         // If ticket service not available, ignore
//       }

//       return { reply: "Your order is confirmed. Thank you!", end: true };
//     }

//     // Confirm NO -> exit confirmation and ask what to change
//     if (isConfirmNo(text)) {
//       session.confirming = false;
//       return {
//         reply: "No problem. What would you like to change? (Example: change size, add another pizza, switch to delivery, add/remove sides)",
//         end: false
//       };
//     }

//     // If user says something else during confirmation, treat it as a change request:
//     // Update session and re-confirm.
//     session.confirming = false; // drop out so prompts work
//   }

//   // If user says "done" and sides were asked, we can jump to confirm
//   if (session.sidesAsked && (isDone(text) || isNoSides(text) || session.noSidesLocked)) {
//     // no-op, nextPrompt will lead to confirm
//   }

//   // Decide next step
//   const prompt = nextPrompt(store, session);

//   // If ready to confirm
//   if (prompt === "confirm") {
//     session.confirming = true;
//     return { reply: buildConfirmation(session), end: false };
//   }

//   // Otherwise ask next question
//   return { reply: prompt, end: false };
// }

// /* =========================
//    TWILIO HELPERS
// ========================= */

// function twilioRespond(res, text) {
//   const twiml = new twilio.twiml.VoiceResponse(); // create TwiML response

//   twiml.say({ voice: "alice", language: "en-CA" }, text); // speak the text

//   // gather next speech input
//   twiml.gather({
//     input: "speech",
//     language: "en-CA",
//     bargeIn: true,
//     action: "/twilio/step",
//     method: "POST"
//   });

//   res.type("text/xml").send(twiml.toString()); // send TwiML
// }

// /* =========================
//    TWILIO ENTRY POINT
// ========================= */

// app.post("/twilio/voice", (req, res) => {
//   // Twilio sends "To" (your Twilio number). We are using single-store config for now.
//   const greeting = STORE?.conversation?.greeting || "Hi, how can I help you today?"; // greeting text

//   // Create a fresh TwiML
//   const twiml = new twilio.twiml.VoiceResponse(); // response builder

//   // Say greeting
//   twiml.say({ voice: "alice", language: "en-CA" }, greeting);

//   // Ask for speech
//   twiml.gather({
//     input: "speech",
//     language: "en-CA",
//     bargeIn: true,
//     action: "/twilio/step",
//     method: "POST"
//   });

//   // Reply XML
//   res.type("text/xml").send(twiml.toString());
// });

// /* =========================
//    TWILIO STEP
// ========================= */

// app.post("/twilio/step", async (req, res) => {
//   try {
//     const callSid = req.body.CallSid; // unique call id
//     const speech = norm(req.body.SpeechResult); // speech text

//     // Create session if missing
//     if (!sessionsById.has(callSid)) {
//       sessionsById.set(callSid, {
//         id: callSid,
//         store_id: STORE.id,
//         caller: req.body.From, // caller number
//         items: [],
//         sides: [],
//         orderType: null,
//         address: null,
//         sidesAsked: false,
//         noSidesLocked: false,
//         confirming: false
//       });
//     }

//     const session = sessionsById.get(callSid); // get current session

//     // Silence protection
//     if (!speech) {
//       return twilioRespond(res, "Sorry, I didn’t catch that. Please say it again.");
//     }

//     // Handle the turn
//     const { reply, end } = await handleTurn(STORE, session, speech);

//     // If finished, clear the session and end politely
//     if (end) {
//       sessionsById.delete(callSid);
//       const twiml = new twilio.twiml.VoiceResponse();
//       twiml.say({ voice: "alice", language: "en-CA" }, reply);
//       twiml.hangup();
//       return res.type("text/xml").send(twiml.toString());
//     }

//     // Otherwise respond normally
//     return twilioRespond(res, reply);
//   } catch (err) {
//     console.error("❌ Twilio step error:", err);
//     const twiml = new twilio.twiml.VoiceResponse();
//     twiml.say("Sorry, something went wrong. Please try again.");
//     res.type("text/xml").send(twiml.toString());
//   }
// });

// /* =========================
//    DASHBOARD CHAT TEST API
// ========================= */

// /**
//  * Start a new chat session for dashboard testing.
//  */
// app.get("/api/chat/start", (req, res) => {
//   const sessionId = `chat_${Date.now()}_${Math.random().toString(16).slice(2)}`; // unique id

//   // Create a new session
//   sessionsById.set(sessionId, {
//     id: sessionId,
//     store_id: STORE.id,
//     caller: "chat",
//     items: [],
//     sides: [],
//     orderType: null,
//     address: null,
//     sidesAsked: false,
//     noSidesLocked: false,
//     confirming: false
//   });

//   res.json({
//     sessionId,
//     greeting: STORE?.conversation?.greeting || "Hi! What would you like to order?",
//     store: {
//       id: STORE.id,
//       name: STORE.name,
//       menuCount: STORE.menu.length,
//       sidesCount: STORE.sides.length,
//       configPath: CONFIG_PATH
//     }
//   });
// });

// /**
//  * One chat turn for dashboard testing.
//  */
// app.post("/api/chat/turn", async (req, res) => {
//   try {
//     const { sessionId, message } = req.body; // read JSON
//     if (!sessionId || !sessionsById.has(sessionId)) {
//       return res.status(400).json({ error: "Invalid sessionId. Start with /api/chat/start." });
//     }

//     const session = sessionsById.get(sessionId); // session object
//     const text = norm(message); // user message

//     if (!text) {
//       return res.json({ reply: "Please type something.", end: false, session });
//     }

//     const { reply, end } = await handleTurn(STORE, session, text);

//     // If order ends, delete session
//     if (end) {
//       sessionsById.delete(sessionId);
//     }

//     return res.json({ reply, end, session });
//   } catch (err) {
//     console.error("❌ Chat turn error:", err);
//     return res.status(500).json({ error: "Server error. Check console." });
//   }
// });

// /* =========================
//    DASHBOARD TICKETS API (optional)
// ========================= */

// app.get("/api/stores/:id/tickets", (req, res) => {
//   try {
//     // If your ticketService is available
//     res.json(getTicketsByStore(req.params.id));
//   } catch (e) {
//     res.json([]); // fallback
//   }
// });

// /* =========================
//    SERVER
// ========================= */

// app.listen(PORT, () => {
//   console.log("🚀 Store AI running on port", PORT);
//   console.log("🧾 Loaded config from:", CONFIG_PATH || "(default/fallback)");
//   console.log("🍕 Menu items:", STORE.menu.length, "| 🥤 Sides:", STORE.sides.length);
//   console.log("🧪 Test chatbox at: http://localhost:" + PORT + "/dashboard/chat.html");
// });

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
