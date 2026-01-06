/* ===================================================================
   index.js  (SCRIPT-BASED CHECKLIST BOT)
   - Twilio Voice (/twilio/voice + /twilio/step)
   - Web Chat Tester (/chat.html + /api/chat/start + /api/chat/message)
   - Deterministic slot-filling so it never misses size/qty/etc.
=================================================================== */

import "dotenv/config"; // Loads .env values into process.env
import express from "express"; // Web server
import cors from "cors"; // Allow cross-origin requests (dashboard/chat)
import path from "path"; // Safe path handling
import twilio from "twilio"; // Twilio TwiML builder
import { fileURLToPath } from "url"; // Needed for __dirname in ESM

// Your existing services (keep as-is)
import { getStoreByPhone } from "./services/storeService.js"; // Looks up store config using phone number
import { extractMeaning } from "./services/aiService.js"; // Optional: AI to parse free text into structured intent
import { createTicket, getTicketsByStore } from "./services/ticketService.js"; // Ticket storage (json/in-memory/etc.)

/* =========================
   BASIC SETUP
========================= */

const __filename = fileURLToPath(import.meta.url); // Current file path
const __dirname = path.dirname(__filename); // Folder of this file

const app = express(); // Create Express app
app.use(cors()); // Enable CORS
app.use(express.urlencoded({ extended: false })); // Parse form bodies (Twilio sends urlencoded)
app.use(express.json()); // Parse JSON bodies (web chat uses JSON)

// Serve your dashboard folder
app.use("/dashboard", express.static(path.join(__dirname, "dashboard")));

// Serve a public folder for chat tester
app.use("/", express.static(path.join(__dirname, "public")));

const PORT = process.env.PORT || 10000; // Render/hosting port fallback

/* =========================
   IN-MEMORY SESSIONS
   - Key: callSid for Twilio
   - Key: chatSessionId for Web chat
========================= */

const sessions = new Map(); // Stores state for each live conversation

/* ===================================================================
   SCRIPT HELPERS (DETERMINISTIC FLOW)
=================================================================== */

/* ---------- text utilities ---------- */

// Normalize any input to a clean string
function norm(text) {
  return String(text || "").trim();
}

// Detect "done / nothing else" phrases
function isDone(text) {
  const t = norm(text).toLowerCase();
  return /(no$|no more|that's all|that’s all|thats all|done|finish|nothing else|nope|all good)/i.test(t);
}

// Detect "no sides"
function isNoSides(text) {
  const t = norm(text).toLowerCase();
  return /(no sides|no side|without sides|none|nothing|no thanks|no thank you|dont want sides|don't want sides)/i.test(t);
}

// Confirmation yes
function isConfirmYes(text) {
  return /^(yes|yeah|yep|correct|right|that's right|that is right|confirm)$/i.test(norm(text));
}

// Confirmation no
function isConfirmNo(text) {
  return /^(no|nope|wrong|incorrect|change|not correct)$/i.test(norm(text));
}

// Detect pickup/delivery in user message
function detectOrderType(text) {
  const t = norm(text).toLowerCase();
  if (/(pickup|pick up|picup|carryout|carry out|takeaway|take away)/i.test(t)) return "Pickup";
  if (/(delivery|deliver|drop off|dropoff)/i.test(t)) return "Delivery";
  return null;
}

// Detect size
function detectSize(text) {
  const t = norm(text).toLowerCase();
  if (/^(small|s)$/i.test(t)) return "Small";
  if (/^(medium|m)$/i.test(t)) return "Medium";
  if (/^(large|l)$/i.test(t)) return "Large";
  return null;
}

// Detect spice level
function detectSpice(text) {
  const t = norm(text).toLowerCase();
  if (/^(mild|not spicy|low spicy)$/i.test(t)) return "Mild";
  if (/^(medium|mid|medium spicy)$/i.test(t)) return "Medium";
  if (/^(hot|spicy|extra spicy|very spicy)$/i.test(t)) return "Hot";
  return null;
}

// Detect if user is asking menu
function isAskingMenu(text) {
  const t = norm(text).toLowerCase();
  return /(menu|what pizzas|which pizzas|pizza options|pizza do you have|available pizzas)/i.test(t);
}

// Detect if user is asking sides
function isAskingSides(text) {
  const t = norm(text).toLowerCase();
  return /(sides|side options|what sides|which sides|sides available|addons|add ons|drinks)/i.test(t);
}

/* ---------- store config getters (ROBUST) ---------- */
/**
 * Your store object can be structured differently depending on your JSON loader.
 * This function tries multiple common paths so "sides not listed" doesn't happen.
 */
function getSidesList(store) {
  // Try common keys where sides might live
  const candidates = [
    store?.sides,
    store?.menu?.sides,
    store?.conversation?.sides,
    store?.config?.sides,
    store?.pizza?.sides,
    store?.data?.sides
  ];

  // Return the first array-like candidate
  for (const c of candidates) {
    if (Array.isArray(c) && c.length) return c;
  }

  // If nothing found, return empty
  return [];
}

/**
 * Menu list getter (same idea).
 */
function getMenuList(store) {
  const candidates = [
    store?.menu,
    store?.menu?.pizzas,
    store?.pizzas,
    store?.conversation?.menu,
    store?.config?.menu,
    store?.data?.menu
  ];

  // If store.menu is an object, it might contain pizzas array inside
  if (Array.isArray(store?.menu) && store.menu.length) return store.menu;

  for (const c of candidates) {
    if (Array.isArray(c) && c.length) return c;
  }

  return [];
}

/**
 * Some pizzas require spice. You can drive this from JSON if you want.
 * If not available, we default to: Shahi Paneer + Butter Chicken + Tandoori Chicken require spice.
 */
function pizzaRequiresSpice(store, pizzaName) {
  const name = norm(pizzaName).toLowerCase();

  // If your JSON provides rules like: store.rules.spiceRequired = ["Shahi Paneer", ...]
  const configured = store?.rules?.spiceRequired;
  if (Array.isArray(configured)) {
    return configured.map(s => s.toLowerCase()).includes(name);
  }

  // Fallback rules
  return /(shahi paneer|butter chicken|tandoori chicken)/i.test(name);
}

/* ---------- sides extraction ---------- */
/**
 * Detect sides from user message.
 * - If sides list exists: match inclusion.
 * - Also detect common drinks/words.
 */
function extractSidesFromText(text, knownSides = []) {
  const t = norm(text).toLowerCase(); // Normalize
  const found = new Set(); // Collect unique sides

  // Match from known sides list
  for (const s of knownSides) {
    const sLow = String(s).toLowerCase();
    if (sLow && t.includes(sLow)) found.add(s);
  }

  // Fallback detection for common items
  const common = ["Coke", "Sprite", "Pepsi", "Water", "Fries", "Garlic Bread", "Wings", "Ranch"];
  for (const c of common) {
    if (t.includes(c.toLowerCase())) found.add(c);
  }

  return Array.from(found); // Return array
}

/* ===================================================================
   SESSION SHAPE + DEFAULTS
=================================================================== */

function makeNewSession(store, caller) {
  return {
    store_id: store.id, // Store id
    caller: caller || null, // Caller phone (Twilio From)
    orderType: null, // "Pickup" or "Delivery"
    address: null, // Needed for delivery
    items: [], // [{ name, size, qty, spice }]
    sides: [], // ["Coke", ...]
    confirming: false // When true, we expect yes/no OR modifications
  };
}

/* ===================================================================
   CORE SCRIPT BRAIN: handleUserTurn()
   - Deterministic: always asks for missing required fields
   - Handles menu/sides questions anytime
   - Allows changes during confirmation
=================================================================== */

async function handleUserTurn({ store, session, text }) {
  const userText = norm(text); // Normalize input
  const menu = getMenuList(store); // Store menu list
  const sidesList = getSidesList(store); // Store sides list

  /* ---------- 1) Handle FAQ-style questions anytime ---------- */

  if (isAskingMenu(userText)) {
    if (!menu.length) {
      return { reply: "Menu is not set yet. Please tell me what pizza you’d like." };
    }
    return { reply: `We have: ${menu.join(", ")}. What would you like to order?` };
  }

  if (isAskingSides(userText)) {
    if (!sidesList.length) {
      return { reply: "Sides are not set yet. You can say: no sides, or tell me what side you want." };
    }
    return { reply: `Available sides are: ${sidesList.join(", ")}. Would you like any sides?` };
  }

  /* ---------- 2) If we are in confirmation mode, allow edits ---------- */
  if (session.confirming) {
    // If user confirms, create ticket and end
    if (isConfirmYes(userText)) {
      createTicket({
        store_id: store.id,
        caller: session.caller,
        items: session.items,
        sides: session.sides,
        orderType: session.orderType || "Pickup",
        address: session.address || null
      });

      return { reply: "Your order is confirmed. Thank you!", done: true };
    }

    // If user says it's wrong, exit confirmation and ask for correction
    if (isConfirmNo(userText)) {
      session.confirming = false;
      return { reply: "No problem. Tell me what you want to change (pizza, size, spice, sides, or pickup/delivery)." };
    }

    // If user tries to add/modify during confirmation (like "add coke")
    const addedSides = extractSidesFromText(userText, sidesList);
    if (addedSides.length) {
      // Merge new sides
      const merged = new Set([...(session.sides || []), ...addedSides]);
      session.sides = Array.from(merged);
      // Re-confirm with updated summary
      return { reply: buildConfirmation(store, session) };
    }

    // If user says "no sides" during confirmation, clear sides and re-confirm
    if (isNoSides(userText) || isDone(userText)) {
      session.sides = [];
      return { reply: buildConfirmation(store, session) };
    }

    // If user said something else while confirming, we treat it as a change request
    // Exit confirmation and continue slot-filling
    session.confirming = false;
  }

  /* ---------- 3) Merge easy detections from raw text (script) ---------- */

  // Order type if said inline
  const detectedType = detectOrderType(userText);
  if (detectedType) session.orderType = detectedType;

  // Extract sides even before we explicitly ask (people do “add coke” early)
  const sideHits = extractSidesFromText(userText, sidesList);
  if (sideHits.length) {
    const merged = new Set([...(session.sides || []), ...sideHits]);
    session.sides = Array.from(merged);
  }

  /* ---------- 4) Optional: Use AI to parse items if available ---------- */
  // This helps with phrases like “2 large shahi paneer and 1 medium pepperoni”
  // But the script still controls what to ask next.
  try {
    const ai = await extractMeaning(store, userText);

    if (ai && typeof ai === "object") {
      // Merge order type (AI)
      if (ai.orderType) session.orderType = ai.orderType;

      // Merge sides (AI)
      if (Array.isArray(ai.sides) && ai.sides.length) {
        const merged = new Set([...(session.sides || []), ...ai.sides]);
        session.sides = Array.from(merged);
      }

      // Merge items (AI)
      if (Array.isArray(ai.items) && ai.items.length) {
        // Normalize item fields so script can validate them
        session.items = ai.items.map((it) => ({
          name: it.name || it.pizza || it.item || null,
          size: it.size || null,
          qty: Number(it.qty || 1),
          spice: it.spice || null
        }));
      }
    }
  } catch (e) {
    // If AI fails, ignore and keep script-only behavior
    // (No crash. No stuck.)
  }

  /* ---------- 5) If no items yet, ask for pizza ---------- */
  if (!session.items.length) {
    return { reply: "What would you like to order? (You can say: 1 large pepperoni)" };
  }

  /* ---------- 6) Slot filling for each item: qty, size, spice (if required) ---------- */

  // Fill missing fields from this message if user answered with just "large" or "2" or "hot"
  // If user said only “large”, we apply it to the first item missing size.
  const msgSize = detectSize(userText);
  const msgSpice = detectSpice(userText);

  if (msgSize) {
    const target = session.items.find((i) => !i.size);
    if (target) target.size = msgSize;
  }

  if (msgSpice) {
    const target = session.items.find((i) => {
      const needs = pizzaRequiresSpice(store, i.name);
      return needs && !i.spice;
    });
    if (target) target.spice = msgSpice;
  }

  // Qty parsing: if user replies "2" to qty question
  const qtyNum = Number.parseInt(userText, 10);
  if (!Number.isNaN(qtyNum) && qtyNum > 0 && qtyNum < 50) {
    const target = session.items.find((i) => !i.qty || i.qty === 1);
    if (target) target.qty = qtyNum;
  }

  // Now compute what’s missing (priority order)
  const missing = getMissing(store, session);

  /* ---------- 7) Ask next missing thing deterministically ---------- */
  if (missing.length) {
    return { reply: missing[0] };
  }

  /* ---------- 8) If all required fields are filled, ask sides (optional) ---------- */
  // If user already gave sides earlier, we can skip asking and go confirm.
  if (!session.sides || session.sides.length === 0) {
    // If store has sides list, ask properly
    if (sidesList.length) {
      return { reply: `Would you like any sides? Available: ${sidesList.join(", ")}. (Or say: no sides)` };
    }
    // If no sides configured, allow "no sides"
    return { reply: "Would you like any sides? (Or say: no sides)" };
  }

  /* ---------- 9) Confirmation ---------- */
  session.confirming = true;
  return { reply: buildConfirmation(store, session) };
}

/* ===================================================================
   Determine what is missing (CHECKLIST QUESTIONS)
=================================================================== */

function getMissing(store, session) {
  const missingQuestions = []; // List of next prompts

  // 1) Order type
  if (!session.orderType) {
    missingQuestions.push("Pickup or delivery?");
    return missingQuestions; // Stop early: always ask orderType first
  }

  // 2) If delivery, need address
  if (session.orderType === "Delivery" && !session.address) {
    missingQuestions.push("What is the delivery address?");
    return missingQuestions;
  }

  // 3) For each item, require name, size, qty, spice(if required)
  for (const item of session.items) {
    // Ensure name exists
    if (!item.name) {
      missingQuestions.push("Which pizza would you like? (Example: Shahi Paneer)");
      return missingQuestions;
    }

    // Require size
    if (!item.size) {
      missingQuestions.push(`What size for ${item.name}? Small, Medium, or Large?`);
      return missingQuestions;
    }

    // Require qty (default to 1, but if you want to always ask, remove defaulting)
    if (!item.qty || item.qty < 1) {
      missingQuestions.push(`How many ${item.size} ${item.name} pizzas would you like?`);
      return missingQuestions;
    }

    // Require spice only if pizza requires it
    if (pizzaRequiresSpice(store, item.name) && !item.spice) {
      missingQuestions.push(`What spice level for ${item.name}? Mild, Medium, Hot?`);
      return missingQuestions;
    }
  }

  return missingQuestions; // Empty means nothing missing
}

/* ===================================================================
   CONFIRMATION MESSAGE
=================================================================== */

function buildConfirmation(store, session) {
  // Make a clean item summary
  const items = session.items
    .map((i, idx) => {
      const qty = i.qty || 1; // qty fallback
      const size = i.size ? `${i.size} ` : ""; // size fallback
      const spice = i.spice ? ` (${i.spice})` : ""; // spice fallback
      return `${idx + 1}. ${qty} ${size}${i.name}${spice}`;
    })
    .join(". ");

  // Sides summary
  const sidesText = session.sides && session.sides.length ? session.sides.join(", ") : "No sides";

  // Address only if delivery
  const addrText = session.orderType === "Delivery" ? ` Address: ${session.address || "(missing)"}.` : "";

  return `Please confirm your order. Order type: ${session.orderType}. ${items}. Sides: ${sidesText}.${addrText} Is that correct?`;
}

/* ===================================================================
   TWILIO ROUTES
=================================================================== */

app.post("/twilio/voice", (req, res) => {
  const store = getStoreByPhone(req.body.To); // Store by called number
  const twiml = new twilio.twiml.VoiceResponse(); // TwiML builder

  // Greeting message
  twiml.say(
    { voice: "alice", language: "en-CA" },
    store?.conversation?.greeting || "Hi! What would you like to order?"
  );

  // Gather speech
  twiml.gather({
    input: "speech",
    language: "en-CA",
    bargeIn: true,
    action: "/twilio/step",
    method: "POST"
  });

  // Return XML
  res.type("text/xml").send(twiml.toString());
});

app.post("/twilio/step", async (req, res) => {
  try {
    const store = getStoreByPhone(req.body.To); // Store lookup
    if (!store) return res.sendStatus(404); // No store config

    const callSid = req.body.CallSid; // Session key
    const speech = norm(req.body.SpeechResult); // User speech text

    // Create session if missing
    if (!sessions.has(callSid)) {
      sessions.set(callSid, makeNewSession(store, req.body.From));
    }

    const session = sessions.get(callSid); // Get session state

    // Silence protection
    if (!speech) {
      return respondTwilio(res, "Sorry, I didn’t catch that. Please say it again.");
    }

    // If delivery address question, store address directly when asked
    if (session.orderType === "Delivery" && !session.address) {
      // If they reply with something that looks like an address, store it
      // (Basic: just store whatever they said)
      session.address = speech;
      // Continue with script flow
    }

    // Run deterministic turn handler
    const out = await handleUserTurn({ store, session, text: speech });

    // If done, clear session
    if (out?.done) sessions.delete(callSid);

    // Respond back to Twilio
    return respondTwilio(res, out?.reply || "Sorry, could you repeat that?");
  } catch (err) {
    console.error("❌ Twilio step error:", err);
    const twiml = new twilio.twiml.VoiceResponse();
    twiml.say("Sorry, something went wrong. Please try again.");
    res.type("text/xml").send(twiml.toString());
  }
});

// Helper to respond in Twilio format
function respondTwilio(res, text) {
  const twiml = new twilio.twiml.VoiceResponse(); // Create TwiML
  twiml.say({ voice: "alice", language: "en-CA" }, text); // Speak response
  twiml.gather({
    input: "speech",
    language: "en-CA",
    bargeIn: true,
    action: "/twilio/step",
    method: "POST"
  });
  res.type("text/xml").send(twiml.toString()); // Return XML
}

/* ===================================================================
   WEB CHAT TESTER API
   - Start: POST /api/chat/start
   - Message: POST /api/chat/message  { sessionId, to, text }
=================================================================== */

app.post("/api/chat/start", (req, res) => {
  const to = req.body?.to || process.env.DEFAULT_STORE_TO; // store phone (same as Twilio To)
  const store = getStoreByPhone(to); // lookup store

  if (!store) return res.status(404).json({ error: "Store not found for this 'to' value." });

  // Make a simple session id
  const sessionId = `chat_${Date.now()}_${Math.random().toString(16).slice(2)}`;

  // Create session
  sessions.set(sessionId, makeNewSession(store, "web"));

  // Reply greeting
  res.json({
    sessionId,
    message: store?.conversation?.greeting || "New session started. What would you like to order?"
  });
});

app.post("/api/chat/message", async (req, res) => {
  const sessionId = req.body?.sessionId; // chat session id
  const to = req.body?.to || process.env.DEFAULT_STORE_TO; // store phone
  const text = norm(req.body?.text); // user text

  const store = getStoreByPhone(to); // store lookup
  if (!store) return res.status(404).json({ error: "Store not found." });

  if (!sessions.has(sessionId)) {
    // If session missing, force user to /start
    return res.status(400).json({ error: "Session not found. Call /api/chat/start first." });
  }

  const session = sessions.get(sessionId); // get session

  // If the next missing is address, store it directly
  if (session.orderType === "Delivery" && !session.address) {
    session.address = text;
  }

  const out = await handleUserTurn({ store, session, text });

  if (out?.done) sessions.delete(sessionId);

  res.json({ message: out?.reply || "Sorry, say that again.", done: !!out?.done });
});

/* ===================================================================
   DASHBOARD API
=================================================================== */

app.get("/api/stores/:id/tickets", (req, res) => {
  res.json(getTicketsByStore(req.params.id));
});

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
