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
app.use(
  "/dashboard",
  express.static(path.join(__dirname, "dashboard"))
);

const PORT = process.env.PORT || 10000;

/* =========================
   IN-MEMORY SESSIONS
========================= */

const sessions = new Map();

/* =========================
   TWILIO ENTRY POINT
========================= */

app.post("/twilio/voice", (req, res) => {
  const store = getStoreByPhone(req.body.To);
  const twiml = new twilio.twiml.VoiceResponse();

  twiml.say(
    { voice: "alice", language: "en-CA" },
    store?.conversation?.greeting ||
      "Hi, how can I help you today?"
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
    const speech = (req.body.SpeechResult || "").trim();

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
        sidesAsked: false
      });
    }

    const session = sessions.get(callSid);

    // silence protection
    if (!speech) {
      return respond(
        res,
        "Sorry, I didn’t catch that. Please say it again."
      );
    }

    const ai = await extractMeaning(store, speech);

    // AI safety
    if (!ai || typeof ai !== "object") {
      return respond(
        res,
        "Sorry, I didn’t understand that. Could you repeat?"
      );
    }

    // merge order type
    if (ai.orderType) {
      session.orderType = ai.orderType;
    }

    // merge items (always respect latest)
    if (Array.isArray(ai.items) && ai.items.length > 0) {
      session.items = ai.items;
      session.confirming = false;
    }

    // merge sides safely
    if (Array.isArray(ai.sides)) {
      session.sides = ai.sides;
    }

    // ask next question
    const q = nextQuestion(store, session);
    const question =
      typeof q === "string" && q.length
        ? q
        : "Is there anything else I can help you with?";

    // confirmation phase
    if (question === "confirm" && !session.confirming) {
      session.confirming = true;
      return respond(
        res,
        buildConfirmation(store, session)
      );
    }

    // user confirms
    if (session.confirming && /^(yes|yeah|correct)$/i.test(speech)) {
      createTicket({
        store_id: store.id,
        caller: session.caller,
        items: session.items,
        sides: session.sides,
        orderType: session.orderType || "Pickup",
        address: session.address || null
      });

      sessions.delete(callSid);
      return respond(
        res,
        "Your order is confirmed. Thank you!"
      );
    }

    // user rejects confirmation → loop
    if (session.confirming && /^(no|wrong)$/i.test(speech)) {
      session.confirming = false;
      return respond(
        res,
        "No problem. Please tell me the correct order."
      );
    }

    return respond(res, question);

  } catch (err) {
    console.error("❌ Twilio step error:", err);
    const twiml = new twilio.twiml.VoiceResponse();
    twiml.say(
      "Sorry, something went wrong. Please try again."
    );
    res.type("text/xml").send(twiml.toString());
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
  const items = session.items
    .map(
      (i, idx) =>
        `${idx + 1}. ${i.qty || 1} ${i.size || ""} ${i.name}`
    )
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
