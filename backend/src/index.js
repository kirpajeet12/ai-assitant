// index.js
console.log("ENV CHECK - OPENAI_API_KEY exists:", !!process.env.OPENAI_API_KEY);

import express from "express";
import cors from "cors";
import "dotenv/config";
import twilio from "twilio";

/* =========================
   APP SETUP
========================= */

const app = express();
app.use(cors());
app.use(express.urlencoded({ extended: false }));
app.use(express.json());

/* =========================
   OPENAI (REAL AI)
========================= */
let openai = null;

async function getOpenAI() {
  if (openai) return openai;

  if (!process.env.OPENAI_API_KEY) {
    console.error("❌ OPENAI_API_KEY missing at runtime");
    return null;
  }

  try {
    const { default: OpenAI } = await import("openai");
    openai = new OpenAI({
      apiKey: process.env.OPENAI_API_KEY,
    });

    console.log("✅ OpenAI client CREATED");
    return openai;
  } catch (err) {
    console.error("❌ Failed to create OpenAI client:", err.message);
    return null;
  }
}

function isAIEnabled() {
  return !!openai;
}

/* =========================
   FULL MENU
========================= */

const MENU = [
  {
    name: "Butter Chicken Pizza",
    prices: { Small: 9.99, Medium: 13.99, Large: 17.99 },
  },
  {
    name: "Tandoori Chicken Pizza",
    prices: { Small: 10.99, Medium: 14.99, Large: 18.99 },
  },
  {
    name: "Shahi Paneer Pizza",
    prices: { Small: 9.49, Medium: 13.49, Large: 16.99 },
  },
  {
    name: "Hawaiian Pizza",
    prices: { Small: 8.99, Medium: 12.99, Large: 15.99 },
  },
  {
    name: "Veggie Pizza",
    prices: { Small: 8.49, Medium: 12.49, Large: 15.49 },
  },
];

/* =========================
   HELPERS
========================= */

function findPizza(text) {
  return MENU.find(p =>
    text.toLowerCase().includes(p.name.toLowerCase().split(" ")[0])
  );
}

/* =========================
   INTENT DETECTION (REAL AI)
========================= */

async function detectIntent(text) {
  if (!isAIEnabled()) return "ORDER";

  try {
    const res = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        { role: "system", content: "Classify user intent only." },
        {
          role: "user",
          content: `User said: "${text}"
Return ONE word:
ASK_MENU | ASK_PRICE | ORDER | CONFIRM | OTHER`,
        },
      ],
      temperature: 0,
    });

    const intent = res.choices[0].message.content.trim();
    console.log("🧠 Intent:", intent);
    return intent;
  } catch (err) {
    console.error("Intent AI error:", err.message);
    return "OTHER";
  }
}

/* =========================
   RESPONSE GENERATION (REAL AI)
========================= */

async function buildReply(intent, speech) {
  // Code-first answers (safe)
  if (intent === "ASK_MENU") {
    return `We have ${MENU.map(p => p.name).join(", ")}. What would you like?`;
  }

  if (intent === "ASK_PRICE") {
    const pizza = findPizza(speech);
    return pizza
      ? `${pizza.name} prices are small $${pizza.prices.Small}, medium $${pizza.prices.Medium}, and large $${pizza.prices.Large}.`
      : "Which pizza are you asking about?";
  }

  if (intent === "CONFIRM") {
    return "Perfect. Your order is confirmed. Thanks for calling Pizza 64!";
  }

  // Natural AI response for everything else
  if (!isAIEnabled()) {
    return "Sure — tell me what pizza you’d like.";
  }

  try {
    const res = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        {
          role: "system",
          content:
            "You are a friendly Pizza 64 phone assistant. Be short and natural.",
        },
        { role: "user", content: speech },
      ],
      temperature: 0.7,
    });

    return res.choices[0].message.content;
  } catch (err) {
    console.error("Reply AI error:", err.message);
    return "Sorry, could you repeat that?";
  }
}

/* =========================
   TWILIO ENTRY
========================= */

app.post("/twilio/voice", (req, res) => {
  const twiml = new twilio.twiml.VoiceResponse();

  twiml.say({ voice: "alice" }, "Hi, thanks for calling Pizza 64.");
  twiml.say({ voice: "alice" }, "How can I help you today?");

  const gather = twiml.gather({
    input: "speech",
    action: "/twilio/step",
    method: "POST",
    speechTimeout: "auto",
  });

  gather.say({ voice: "alice" }, "Go ahead.");

  res.type("text/xml").send(twiml.toString());
});

/* =========================
   MAIN LOOP
========================= */

app.post("/twilio/step", async (req, res) => {
  const speech = req.body.SpeechResult || "";

  const intent = await detectIntent(speech);
  const reply = await buildReply(intent, speech);

  const twiml = new twilio.twiml.VoiceResponse();
  twiml.say({ voice: "alice" }, reply);

  if (intent !== "CONFIRM") {
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

/* =========================
   HEALTH CHECK
========================= */

app.get("/health", async (_, res) => {
  const client = await getOpenAI();

  res.json({
    status: "ok",
    aiEnabled: !!client,
  });
});


/* =========================
   START SERVER
========================= */

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  console.log(`🍕 Pizza 64 AI running on port ${PORT}`);
});
