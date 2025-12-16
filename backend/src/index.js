import express from "express";
import cors from "cors";
import "dotenv/config";
import twilio from "twilio";
import OpenAI from "openai";

const app = express();
app.use(cors());
app.use(express.urlencoded({ extended: false }));
app.use(express.json());

/* ------------------------
   CONFIG
------------------------- */

const openai = process.env.OPENAI_API_KEY
  ? new OpenAI({ apiKey: process.env.OPENAI_API_KEY })
  : null;

function isMockMode() {
  return !openai || process.env.MOCK_AI === "true";
}

/* ------------------------
   FULL PIZZA 64 MENU
------------------------- */

const MENU = {
  pizzas: [
    {
      id: "butter_chicken",
      name: "Butter Chicken Pizza",
      spicy: true,
      sizes: { Small: 9.99, Medium: 13.99, Large: 17.99 },
      toppings: ["cilantro", "jalapeños", "extra cheese"],
    },
    {
      id: "tandoori_chicken",
      name: "Tandoori Chicken Pizza",
      spicy: true,
      sizes: { Small: 10.99, Medium: 14.99, Large: 18.99 },
      toppings: ["cilantro", "onions", "jalapeños"],
    },
    {
      id: "shahi_paneer",
      name: "Shahi Paneer Pizza",
      spicy: true,
      sizes: { Small: 9.49, Medium: 13.49, Large: 16.99 },
      toppings: ["spinach", "cilantro", "extra cheese"],
    },
    {
      id: "hawaiian",
      name: "Hawaiian Pizza",
      spicy: false,
      sizes: { Small: 8.99, Medium: 12.99, Large: 15.99 },
      toppings: ["pineapple", "extra cheese"],
    },
    {
      id: "veggie",
      name: "Pesto Veggie Pizza",
      spicy: false,
      sizes: { Small: 8.49, Medium: 12.49, Large: 15.49 },
      toppings: ["spinach", "olives", "onions"],
    },
  ],
};

/* ------------------------
   STATE (in-memory)
------------------------- */

const sessions = new Map();

function getSession(callSid) {
  if (!sessions.has(callSid)) {
    sessions.set(callSid, {
      order: null,
      history: [],
      confirmed: false,
    });
  }
  return sessions.get(callSid);
}

/* ------------------------
   OPENAI PROMPTS
------------------------- */

const SYSTEM_PROMPT = `
You are a friendly Pizza 64 phone assistant.

Style rules:
- Sound human, warm, and casual
- Short sentences
- Suggest options naturally
- Answer menu and price questions clearly
- Guide toward completing the order
`;

/* ------------------------
   INTENT DETECTION
------------------------- */

async function detectIntent(text) {
  if (isMockMode()) {
    if (text.toLowerCase().includes("menu")) return { intent: "ASK_MENU" };
    if (text.toLowerCase().includes("price")) return { intent: "ASK_PRICE" };
    if (text.toLowerCase().includes("yes")) return { intent: "CONFIRM" };
    return { intent: "PLACE_ORDER" };
  }

  const res = await openai.chat.completions.create({
    model: "gpt-4o-mini",
    messages: [
      { role: "system", content: "Classify intent only." },
      {
        role: "user",
        content: `
User said: "${text}"

Return JSON:
{
  "intent": "ASK_MENU | ASK_PRICE | PLACE_ORDER | MODIFY_ORDER | CONFIRM | UNKNOWN"
}
`,
      },
    ],
    temperature: 0,
  });

  return JSON.parse(res.choices[0].message.content);
}

/* ------------------------
   HUMAN RESPONSE
------------------------- */

async function generateReply(context) {
  if (isMockMode()) {
    if (context.intent === "ASK_MENU")
      return "We have Butter Chicken, Tandoori Chicken, Shahi Paneer, Hawaiian, and Veggie pizzas. Want prices or want to order?";

    if (context.intent === "CONFIRM")
      return "Perfect! Your order is confirmed. Thanks for calling Pizza 64.";

    return "Sounds good. Tell me what pizza you’d like.";
  }

  const res = await openai.chat.completions.create({
    model: "gpt-4o-mini",
    messages: [
      { role: "system", content: SYSTEM_PROMPT },
      {
        role: "user",
        content: JSON.stringify(context, null, 2),
      },
    ],
    temperature: 0.7,
  });

  return res.choices[0].message.content;
}

/* ------------------------
   TWILIO ENTRY
------------------------- */

app.all("/twilio/voice", (req, res) => {
  const twiml = new twilio.twiml.VoiceResponse();

  twiml.say({ voice: "alice" }, "Hi! Thanks for calling Pizza 64.");
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

/* ------------------------
   MAIN CONVERSATION LOOP
------------------------- */

app.post("/twilio/step", async (req, res) => {
  const callSid = req.body.CallSid;
  const speech = req.body.SpeechResult || "";
  const session = getSession(callSid);

  const intentData = await detectIntent(speech);
  session.history.push({ user: speech, intent: intentData.intent });

  if (intentData.intent === "CONFIRM") {
    session.confirmed = true;
    sessions.delete(callSid);
  }

  const reply = await generateReply({
    intent: intentData.intent,
    menu: MENU,
    order: session.order,
    history: session.history,
  });

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

/* ------------------------
   SERVER
------------------------- */

app.get("/health", (_, res) => res.json({ status: "ok" }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () =>
  console.log(`🍕 Pizza 64 AI running on port ${PORT}`)
);
