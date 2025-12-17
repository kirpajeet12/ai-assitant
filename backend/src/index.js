// index.js
import "dotenv/config";
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
   OPENAI (LAZY INIT)
========================= */

let openai = null;

async function getOpenAI() {
  if (openai) return openai;

  if (!process.env.OPENAI_API_KEY) {
    console.error("❌ OPENAI_API_KEY missing");
    return null;
  }

  const { default: OpenAI } = await import("openai");
  openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

  console.log("✅ OpenAI client CREATED");
  return openai;
}

/* =========================
   PIZZA 64 MENU
========================= */

const MENU = [
  {
    name: "Butter Chicken Pizza",
    description: "Creamy butter chicken, mozzarella, onions, cilantro",
    prices: { Small: 9.99, Medium: 13.99, Large: 17.99 },
    spicy: true,
  },
  {
    name: "Tandoori Chicken Pizza",
    description: "Tandoori chicken, bell peppers, onions, mozzarella",
    prices: { Small: 10.99, Medium: 14.99, Large: 18.99 },
    spicy: true,
  },
  {
    name: "Shahi Paneer Pizza",
    description: "Paneer in rich gravy, onions, green peppers",
    prices: { Small: 9.49, Medium: 13.49, Large: 16.99 },
    spicy: true,
  },
  {
    name: "Hawaiian Pizza",
    description: "Chicken ham, pineapple, mozzarella",
    prices: { Small: 8.99, Medium: 12.99, Large: 15.99 },
    spicy: false,
  },
  {
    name: "Veggie Pizza",
    description: "Onions, bell peppers, olives, mushrooms",
    prices: { Small: 8.49, Medium: 12.49, Large: 15.49 },
    spicy: false,
  }
];

/* =========================
   SYSTEM PROMPT (THE BRAIN)
========================= */

const SYSTEM_PROMPT = `
You are a real human employee answering the phone at Pizza 64.

Speak naturally, friendly, and casually.
Never sound robotic or scripted.
Keep replies short (1–2 sentences).
Ask one question at a time.

Menu:
${MENU.map(p => `
- ${p.name}
  (${p.description})
  Small $${p.prices.Small}, Medium $${p.prices.Medium}, Large $${p.prices.Large}
`).join("\n")}

Rules:
- Help customers order naturally
- Answer menu and price questions
- Guide ordering step by step
- Ask for size, spice level if applicable, and extras
- Confirm the full order before finishing
- Never mention AI, OpenAI, or systems
`;

/* =========================
   SESSIONS (MEMORY + ORDER)
========================= */

const sessions = new Map();

function emptyOrder() {
  return {
    items: [],
    orderType: "pickup",
    address: null,
  };
}

function getSession(callSid) {
  if (!sessions.has(callSid)) {
    sessions.set(callSid, {
      messages: [],
      order: emptyOrder(),
      awaitingConfirmation: false,
      confirmed: false,
    });
  }
  return sessions.get(callSid);
}

/* =========================
   CHATGPT-STYLE REPLY
========================= */

async function buildReply(session, userSpeech) {
  const client = await getOpenAI();
  if (!client) return "Sorry, I’m having trouble right now.";

  session.messages.push({ role: "user", content: userSpeech });

  const messages = [
    { role: "system", content: SYSTEM_PROMPT },
    ...session.messages.slice(-12),
  ];

  const res = await client.chat.completions.create({
    model: "gpt-4o-mini",
    messages,
    temperature: 0.6,
  });

  const reply = res.choices[0].message.content.trim();
  session.messages.push({ role: "assistant", content: reply });

  return reply;
}

/* =========================
   ORDER EXTRACTION (TICKET)
========================= */

async function extractOrder(session) {
  const client = await getOpenAI();
  if (!client) return null;

  const res = await client.chat.completions.create({
    model: "gpt-4o-mini",
    messages: [
      {
        role: "system",
        content: `
Extract the customer's pizza order from the conversation.

Return STRICT JSON only.

Schema:
{
  "items": [
    {
      "name": string,
      "size": "Small" | "Medium" | "Large",
      "quantity": number,
      "extras": string[],
      "spiceLevel": "Mild" | "Medium" | "Hot" | null
    }
  ],
  "orderType": "pickup" | "delivery",
  "address": string | null
}
`
      },
      ...session.messages.slice(-15),
    ],
    temperature: 0,
  });

  try {
    return JSON.parse(res.choices[0].message.content);
  } catch {
    return null;
  }
}

function buildConfirmation(order) {
  const items = order.items
    .map(i => `${i.quantity} ${i.size} ${i.name}`)
    .join(", ");

  return `Just to confirm, I have ${items} for ${order.orderType}. Is that correct?`;
}

/* =========================
   TWILIO ENTRY
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

/* =========================
   MAIN CONVERSATION LOOP
========================= */

app.post("/twilio/step", async (req, res) => {
  const callSid = req.body.CallSid || "unknown";
  const speech = (req.body.SpeechResult || "").trim();

  const session = getSession(callSid);
  const twiml = new twilio.twiml.VoiceResponse();

  // If awaiting confirmation
  if (session.awaitingConfirmation) {
    if (speech.toLowerCase().includes("yes")) {
      session.confirmed = true;

      console.log("🎟️ FINAL ORDER TICKET:");
      console.log(JSON.stringify(session.order, null, 2));

      twiml.say(
        { voice: "alice" },
        "Perfect. Your order is confirmed. Thank you for calling Pizza 64!"
      );

      sessions.delete(callSid);
      return res.type("text/xml").send(twiml.toString());
    } else {
      session.awaitingConfirmation = false;
      twiml.say({ voice: "alice" }, "No problem, let’s fix it.");
    }
  }

  // Try extracting order
  const extracted = await extractOrder(session);
  if (extracted && extracted.items?.length) {
    session.order = extracted;
    session.awaitingConfirmation = true;

    twiml.say({ voice: "alice" }, buildConfirmation(extracted));
    twiml.gather({
      input: "speech",
      action: "/twilio/step",
      method: "POST",
      speechTimeout: "auto",
    });

    return res.type("text/xml").send(twiml.toString());
  }

  // Normal chat reply
  const reply = await buildReply(session, speech);
  twiml.say({ voice: "alice" }, reply);

  twiml.gather({
    input: "speech",
    action: "/twilio/step",
    method: "POST",
    speechTimeout: "auto",
  });

  res.type("text/xml").send(twiml.toString());
});

/* =========================
   HEALTH CHECK
========================= */

app.get("/health", async (_, res) => {
  const client = await getOpenAI();
  res.json({ status: "ok", aiEnabled: !!client });
});

/* =========================
   START SERVER
========================= */

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  console.log(`🍕 Pizza 64 AI running on port ${PORT}`);
});
