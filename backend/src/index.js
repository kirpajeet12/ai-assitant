import "dotenv/config";
import express from "express";
import cors from "cors";
import twilio from "twilio";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/* =========================
   APP SETUP
========================= */

const app = express();
app.use(cors());
app.use(express.urlencoded({ extended: false }));
app.use(express.json());
app.use(express.static(path.join(__dirname, "../public")));

/* =========================
   OPENAI
========================= */

let openai = null;

async function getOpenAI() {
  if (openai) return openai;
  if (!process.env.OPENAI_API_KEY) return null;
  const { default: OpenAI } = await import("openai");
  openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  return openai;
}

/* =========================
   MENU (Pizza 64)
========================= */

const MENU = [
  // ======================
  // SPECIALTY PIZZAS
  // ======================
  {
    name: "Cheese Lovers",
    category: "Specialty",
    toppings: ["Mozzarella Cheese", "Pizza Sauce"],
    prices: { Small: 9.99, Medium: 11.99, Large: 14.99 },
    spicy: false
  },
  {
    name: "Pepperoni",
    category: "Specialty",
    toppings: ["Pepperoni", "Mozzarella Cheese", "Pizza Sauce"],
    prices: { Small: 10.99, Medium: 12.99, Large: 15.99 },
    spicy: false
  },
  {
    name: "Hawaiian",
    category: "Specialty",
    toppings: ["Ham", "Pineapple", "Mozzarella Cheese", "Pizza Sauce"],
    prices: { Small: 10.99, Medium: 12.99, Large: 15.99 },
    spicy: false
  },
  {
    name: "Canadian",
    category: "Specialty",
    toppings: ["Pepperoni", "Bacon", "Mushrooms", "Mozzarella Cheese", "Pizza Sauce"],
    prices: { Small: 11.99, Medium: 13.99, Large: 16.99 },
    spicy: false
  },

  // ======================
  // SIGNATURE PIZZAS
  // ======================
  {
    name: "Meat Lovers",
    category: "Signature",
    toppings: ["Pepperoni", "Ham", "Beef", "Italian Sausage", "Mozzarella Cheese"],
    prices: { Small: 12.99, Medium: 14.99, Large: 17.99 },
    spicy: false
  },
  {
    name: "BBQ Chicken",
    category: "Signature",
    toppings: ["Chicken", "Onions", "Green Peppers", "BBQ Sauce", "Mozzarella Cheese"],
    prices: { Small: 12.99, Medium: 14.99, Large: 17.99 },
    spicy: false
  },
  {
    name: "Tandoori Chicken",
    category: "Signature",
    toppings: ["Tandoori Chicken", "Onions", "Green Peppers", "Mozzarella Cheese"],
    prices: { Small: 12.99, Medium: 14.99, Large: 17.99 },
    spicy: true
  },

  // ======================
  // GOURMET PIZZAS
  // ======================
  {
    name: "Butter Chicken",
    category: "Gourmet",
    toppings: ["Butter Chicken", "Onions", "Green Peppers", "Jalapenos", "Mozzarella Cheese"],
    prices: { Small: 13.49, Medium: 15.49, Large: 18.49 },
    spicy: true
  },
  {
    name: "Shahi Paneer",
    category: "Gourmet",
    toppings: ["Tandoori Paneer", "Onions", "Spinach", "Mushrooms", "Mozzarella Cheese"],
    prices: { Small: 13.49, Medium: 15.49, Large: 18.49 },
    spicy: true
  },
  {
    name: "Passion of India",
    category: "Gourmet",
    toppings: ["Paneer", "Spinach", "Mushrooms", "Green Peppers", "Mozzarella Cheese"],
    prices: { Small: 13.99, Medium: 15.99, Large: 18.99 },
    spicy: true
  }
];


/* =========================
   SYSTEM PROMPT
========================= */

const SYSTEM_PROMPT = `
You work at Pizza 64.
Speak like a real pizza shop employee.
Ask one question at a time.
Only use items from MENU.
Never invent food.
Confirm order before finishing.
`;

/* =========================
   SESSION MEMORY
========================= */

const sessions = new Map();

function newSession(phone) {
  return {
    messages: [],
    order: {
      items: [],
      orderType: null,
      address: null,
      phone
    },
    readyToExtract: false,
    awaitingConfirmation: false,
    awaitingAddress: false
  };
}

function getSession(id, phone) {
  if (!sessions.has(id)) {
    sessions.set(id, newSession(phone));
  }
  return sessions.get(id);
}

/* =========================
   TICKET SYSTEM
========================= */

let tickets = [];
let ticketDate = new Date().toDateString();
let ticketCounter = 1;

function generateTicketNumber() {
  const today = new Date().toDateString();
  if (today !== ticketDate) {
    ticketDate = today;
    ticketCounter = 1;
  }
  return `${today.replace(/\s/g, "")}-${ticketCounter++}`;
}

function createTicket(order, source) {
  const ticket = {
    ticketNo: generateTicketNumber(),
    time: new Date().toLocaleTimeString(),
    source,
    order
  };

  tickets.unshift(ticket);

  console.log("🎫 NEW TICKET:", ticket.ticketNo);
  console.log(buildKitchenTicket(order));

  return ticket;
}

/* =========================
   CHAT REPLY
========================= */

async function chatReply(session, message) {
  const client = await getOpenAI();
  if (!client) return "Sorry, system issue.";

  session.messages.push({ role: "user", content: message });

  const res = await client.chat.completions.create({
    model: "gpt-4o-mini",
    messages: [
      { role: "system", content: SYSTEM_PROMPT },
      { role: "system", content: `MENU: ${JSON.stringify(MENU)}` },
      ...session.messages.slice(-10)
    ]
  });

  const reply = res.choices[0].message.content.trim();
  session.messages.push({ role: "assistant", content: reply });
  return reply;
}

/* =========================
   INTENT
========================= */

function detectIntent(session, text) {
  const t = text.toLowerCase();
  if (/delivery/.test(t)) {
    session.order.orderType = "delivery";
    session.awaitingAddress = true;
  }
  if (/pickup/.test(t)) session.order.orderType = "pickup";
  if (/that's all|done|nothing else/.test(t)) session.readyToExtract = true;
}

/* =========================
   ORDER EXTRACTION
========================= */

async function extractOrder(session) {
  const client = await getOpenAI();
  if (!client) return null;

  const res = await client.chat.completions.create({
    model: "gpt-4o-mini",
    temperature: 0,
    messages: [
      {
        role: "system",
        content: `Return STRICT JSON:
{ "items":[{"name":"","quantity":1,"size":"Medium","price":0}] }`
      },
      ...session.messages.slice(-12)
    ]
  });

  try {
    return JSON.parse(res.choices[0].message.content);
  } catch {
    return null;
  }
}

/* =========================
   RECEIPTS
========================= */

function buildReceipt(order) {
  return order.items
    .map(i => `${i.quantity} x ${i.size} ${i.name}`)
    .join("\n");
}

function buildKitchenTicket(order) {
  return `
🍕 PIZZA 64 KITCHEN
------------------
${order.items.map(i => `${i.quantity} x ${i.size} ${i.name}`).join("\n")}
TYPE: ${order.orderType}
`;
}

/* =========================
   TWILIO VOICE
========================= */

app.post("/twilio/voice", (req, res) => {
  const twiml = new twilio.twiml.VoiceResponse();
  twiml.say("Welcome to Pizza 64. What can I get for you?");
  twiml.gather({ input: "speech", action: "/twilio/step", method: "POST" });
  res.type("text/xml").send(twiml.toString());
});

app.post("/twilio/step", async (req, res) => {
  const callSid = req.body.CallSid;
  const speech = (req.body.SpeechResult || "").trim();
  const phone = req.body.From;

  const session = getSession(callSid, phone);
  const twiml = new twilio.twiml.VoiceResponse();

  detectIntent(session, speech);

  if (session.awaitingConfirmation) {
    if (/yes|correct/.test(speech.toLowerCase())) {
      const ticket = createTicket(session.order, "CALL");
      twiml.say(`Order confirmed. Ticket number ${ticket.ticketNo}.`);
      sessions.delete(callSid);
      return res.type("text/xml").send(twiml.toString());
    }
    session.awaitingConfirmation = false;
  }

  if (session.readyToExtract) {
    const extracted = await extractOrder(session);
    if (extracted?.items?.length) {
      session.order.items = extracted.items;
      session.awaitingConfirmation = true;
      twiml.say(`Confirming your order. Is that correct?`);
      twiml.gather({ input: "speech", action: "/twilio/step", method: "POST" });
      return res.type("text/xml").send(twiml.toString());
    }
  }

  const reply = await chatReply(session, speech);
  twiml.say(reply);
  twiml.gather({ input: "speech", action: "/twilio/step", method: "POST" });
  res.type("text/xml").send(twiml.toString());
});

/* =========================
   CHAT API
========================= */

app.post("/chat", async (req, res) => {
  const { sessionId, message } = req.body;
  const session = getSession(sessionId, "+1000000000");

  detectIntent(session, message);

  if (session.awaitingConfirmation) {
    if (/yes|correct/.test(message.toLowerCase())) {
      const ticket = createTicket(session.order, "CHAT");
      sessions.delete(sessionId);
      return res.json({
        reply: `Order confirmed! Ticket #${ticket.ticketNo}`
      });
    }
    session.awaitingConfirmation = false;
  }

  if (session.readyToExtract) {
    const extracted = await extractOrder(session);
    if (extracted?.items?.length) {
      session.order.items = extracted.items;
      session.awaitingConfirmation = true;
      return res.json({ reply: "Please confirm your order." });
    }
  }

  const reply = await chatReply(session, message);
  res.json({ reply });
});

/* =========================
   TICKETS API (HTML VIEW)
========================= */

app.get("/api/tickets", (req, res) => {
  res.json(tickets);
});

/* =========================
   SERVER
========================= */

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  console.log("🍕 Pizza 64 running on port", PORT);
});
