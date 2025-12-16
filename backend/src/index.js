// index.js
import "dotenv/config";               // ✅ MUST be first
import express from "express";
import cors from "cors";
import twilio from "twilio";

/* =========================
   APP SETUP
========================= */

const app = express();
app.use(cors());
app.use(express.urlencoded({ extended: false }));
app.use(express.json());

console.log(
  "ENV CHECK - OPENAI_API_KEY exists:",
  !!process.env.OPENAI_API_KEY
);

/* =========================
   OPENAI (LAZY + SAFE)
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

/* =========================
   MENU
========================= */

const MENU = [
  { name: "Butter Chicken Pizza", prices: { Small: 9.99, Medium: 13.99, Large: 17.99 } },
  { name: "Tandoori Chicken Pizza", prices: { Small: 10.99, Medium: 14.99, Large: 18.99 } },
  { name: "Shahi Paneer Pizza", prices: { Small: 9.49, Medium: 13.49, Large: 16.99 } },
  { name: "Hawaiian Pizza", prices: { Small: 8.99, Medium: 12.99, Large: 15.99 } },
  { name: "Veggie Pizza", prices: { Small: 8.49, Medium: 12.49, Large: 15.49 } },
];

function findPizza(text) {
  return MENU.find(p =>
    text.toLowerCase().includes(p.name.toLowerCase().split(" ")[0])
  );
}

/* =========================
   INTENT DETECTION (REAL AI)
========================= */

async function detectIntent(text) {
  const client = await getOpenAI();     // ✅ THIS WAS MISSING

  if (!client) {
    console.log("⚠️ AI unavailable → fallback intent");
    return "ORDER";
  }

  try {
    const res = await client.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        { role: "system", content: "Classify intent only." },
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
    console.error("❌ Intent AI error:", err.message);
    return "OTHER";
  }
}

/* =========================
   RESPONSE
========================= */

async function buildReply(intent, speech) {
  if (intent === "ASK_MENU") {
    return `We have ${MENU.map(p => p.name).join(", ")}.`;
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

  const client = await getOpenAI();
  if (!client) return "Sure — tell me what pizza you’d like.";

  try {
    const res = await client.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        { role: "system", content: "You are a friendly Pizza 64 assistant." },
        { role: "user", content: speech },
      ],
      temperature: 0.7,
    });

    return res.choices[0].message.content;
  } catch {
    return "Sorry, could you repeat that?";
  }
}

/* =========================
   TWILIO ROUTES
========================= */

app.post("/twilio/voice", (req, res) => {
  const twiml = new twilio.twiml.VoiceResponse();

  twiml.say({ voice: "alice" }, "Hi, thanks for calling Pizza 64.");
  twiml.say({ voice: "alice" }, "How can I help you today?");

  twiml.gather({
    input: "speech",
    action: "/twilio/step",
    method: "POST",
    speechTimeout: "auto",
  });

  res.type("text/xml").send(twiml.toString());
});

app.post("/twilio/step", async (req, res) => {
  const speech = req.body.SpeechResult || "";

  const intent = await detectIntent(speech);
  const reply = await buildReply(intent, speech);

  const twiml = new twilio.twiml.VoiceResponse();
  twiml.say({ voice: "alice" }, reply);

  if (intent !== "CONFIRM") {
    twiml.gather({
      input: "speech",
      action: "/twilio/step",
      method: "POST",
      speechTimeout: "auto",
    });
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
