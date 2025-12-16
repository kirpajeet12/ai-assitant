// index.js
import express from "express";
import cors from "cors";
import "dotenv/config";
import twilio from "twilio";

/* ----------------------------
   APP SETUP
----------------------------- */

const app = express();
app.use(cors());
app.use(express.urlencoded({ extended: false }));
app.use(express.json());

/* ----------------------------
   OPENAI (SAFE INIT)
----------------------------- */

let openai = null;

async function initOpenAI() {
  try {
    if (!process.env.OPENAI_API_KEY) {
      console.warn("⚠️ OPENAI_API_KEY missing — mock mode enabled");
      return;
    }
    const OpenAI = (await import("openai")).default;
    openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
    console.log("✅ OpenAI ready");
  } catch (err) {
    console.warn("⚠️ OpenAI init failed:", err.message);
  }
}
initOpenAI();

function isMockMode() {
  return !openai || process.env.MOCK_AI === "true";
}

/* ----------------------------
   FULL PIZZA 64 MENU
----------------------------- */

const MENU = [
  {
    name: "Butter Chicken Pizza",
    spicy: true,
    prices: { Small: 9.99, Medium: 13.99, Large: 17.99 },
  },
  {
    name: "Tandoori Chicken Pizza",
    spicy: true,
    prices: { Small: 10.99, Medium: 14.99, Large: 18.99 },
  },
  {
    name: "Shahi Paneer Pizza",
    spicy: true,
    prices: { Small: 9.49, Medium: 13.49, Large: 16.99 },
  },
  {
    name: "Hawaiian Pizza",
    spicy: false,
    prices: { Small: 8.99, Medium: 12.99, Large: 15.99 },
  },
  {
    name: "Veggie Pizza",
    spicy: false,
    prices: { Small: 8.49, Medium: 12.49, Large: 15.49 },
  },
];

/* ----------------------------
   SESSION STORE
----------------------------- */

const sessions = new Map();

function getSession(callSid) {
  if (!sessions.has(callSid)) {
    sessions.set(callSid, { confirmed: false });
  }
  return sessions.get(callSid);
}

/* ----------------------------
   INTENT DETECTION
----------------------------- */

async function detectIntent(text) {
  const t = text.toLowerCase();

  if (isMockMode()) {
    if (t.includes("menu")) return "ASK_MENU";
    if (t.includes("price") || t.includes("how much")) return "ASK_PRICE";
    if (t.includes("yes") || t.includes("correct")) return "CONFIRM";
    return "ORDER";
  }

  try {
    const res = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        { role: "system", content: "Classify intent only." },
        {
          role: "user",
          content: `User said: "${text}"
Return one word:
ASK_MENU | ASK_PRICE | ORDER | CONFIRM | OTHER`,
        },
      ],
      temperature: 0,
    });

    return res.choices[0].message.content.trim();
  } catch {
    return "OTHER";
  }
}

/* ----------------------------
   MENU HELPERS
----------------------------- */

function readMenu() {
  return MENU.map((p) => p.name).join(", ");
}

function findPizza(text) {
  return MENU.find((p) =>
    text.toLowerCase().includes(p.name.toLowerCase().split(" ")[0])
  );
}

function priceLine(pizza) {
  return `Small $${pizza.prices.Small}, Medium $${pizza.prices.Medium}, Large $${pizza.prices.Large}.`;
}

/* ----------------------------
   HUMAN RESPONSES
----------------------------- */

async function buildReply(intent, speech) {
  if (isMockMode()) {
    if (intent === "ASK_MENU")
      return `We have ${readMenu()}. What sounds good today?`;

    if (intent === "ASK_PRICE") {
      const pizza = findPizza(speech);
      return pizza
        ? `${pizza.name} prices are ${priceLine(pizza)}`
        : "Which pizza are you asking about?";
    }

    if (intent === "CONFIRM")
      return "Perfect, your order is confirmed. Thanks for calling Pizza 64!";

    return "Sure. Tell me what pizza you’d like to order.";
  }

  try {
    const res = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        {
          role: "system",
          content:
            "You are a friendly Pizza 64 phone assistant. Speak naturally and briefly.",
        },
        {
          role: "user",
          content: `Intent: ${intent}
User said: "${speech}"
Menu: ${JSON.stringify(MENU)}`,
        },
      ],
      temperature: 0.7,
    });

    return res.choices[0].message.content;
  } catch {
    return "Sorry, can you repeat that?";
  }
}

/* ----------------------------
   TWILIO ENTRY
----------------------------- */

app.all("/twilio/voice", (req, res) => {
  const twiml = new twilio.twiml.VoiceResponse();

  twiml.say({ voice: "alice" }, "Hi! Thanks for calling Pizza 64.");
  twiml.say({ voice: "alice" }, "What can I help you with today?");

  const gather = twiml.gather({
    input: "speech",
    action: "/twilio/step",
    method: "POST",
    speechTimeout: "auto",
  });

  gather.say({ voice: "alice" }, "Go ahead.");

  res.type("text/xml").send(twiml.toString());
});

/* ----------------------------
   MAIN LOOP
----------------------------- */

app.post("/twilio/step", async (req, res) => {
  const callSid = req.body.CallSid || "unknown";
  const speech = req.body.SpeechResult || "";
  const session = getSession(callSid);

  const intent = await detectIntent(speech);

  if (intent === "CONFIRM") {
    session.confirmed = true;
    sessions.delete(callSid);
  }

  const reply = await buildReply(intent, speech);

  const twiml = new twilio.twiml.VoiceResponse();
  twiml.say({ voice: "alice" }, reply);

  if (!session.confirmed) {
    const gather = twiml.gather({
      input: "speech",
      action: "/twilio/step",
      method: "POST",
      speechTimeout: "auto",
    });
    gather.say({ voice: "alice" }, "Anything else?");
  }

  res.type("text/xml").send(twiml.toString());
});

/* ----------------------------
   HEALTH CHECK
----------------------------- */

app.get("/health", (_, res) => {
  res.json({ status: "ok", mockMode: isMockMode() });
});

/* ----------------------------
   START SERVER
----------------------------- */

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  console.log(`🍕 Pizza 64 AI running on port ${PORT}`);
});
