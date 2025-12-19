import "dotenv/config";
import express from "express";
import cors from "cors";
import twilio from "twilio";
import path from "path";
import { fileURLToPath } from "url";
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
/*app.use(express.static(path.join(process.cwd(), "public")));*/


/* =========================
   APP SETUP
========================= */

const app = express();
app.use(cors());
app.use(express.urlencoded({ extended: false }));
app.use(express.json());
app.use(express.static(path.join(__dirname, "../public")));


/* =========================
   OPENAI (LAZY INIT)
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
   TWILIO CLIENT (SMS)
========================= */



/* =========================
   MENU & EXTRAS
========================= */

const MENU = [
  {
    name: "Butter Chicken Pizza",
    category: "Indian Special",
    description: "Creamy butter chicken cooked in rich tomato gravy",
    toppings: ["Butter chicken", "Mozzarella", "Onions", "Cilantro"],
    prices: { Small: 9.99, Medium: 13.99, Large: 17.99 },
    spicy: true
  },
  {
    name: "Tandoori Chicken Pizza",
    category: "Indian Special",
    description: "Smoky tandoori chicken with desi spices",
    toppings: ["Tandoori chicken", "Bell peppers", "Onions", "Mozzarella"],
    prices: { Small: 10.99, Medium: 14.99, Large: 18.99 },
    spicy: true
  },
  {
    name: "Chicken Tikka Pizza",
    category: "Indian Special",
    description: "Spicy chicken tikka with fresh veggies",
    toppings: ["Chicken tikka", "Red onions", "Green peppers", "Mozzarella"],
    prices: { Small: 10.49, Medium: 14.49, Large: 18.49 },
    spicy: true
  },
  {
    name: "Shahi Paneer Pizza",
    category: "Indian Special",
    description: "Paneer in rich creamy shahi gravy",
    toppings: ["Paneer", "Onions", "Green peppers", "Mozzarella"],
    prices: { Small: 9.49, Medium: 13.49, Large: 16.99 },
    spicy: true
  },
  {
    name: "Achari Paneer Pizza",
    category: "Indian Special",
    description: "Tangy achari-flavored paneer",
    toppings: ["Paneer", "Onions", "Jalapeños", "Mozzarella"],
    prices: { Small: 9.99, Medium: 13.99, Large: 17.49 },
    spicy: true
  },
  {
    name: "Cheese Pizza",
    category: "Classic",
    description: "Classic cheesy goodness",
    toppings: ["Mozzarella", "Pizza sauce"],
    prices: { Small: 7.99, Medium: 11.99, Large: 14.99 },
    spicy: false
  },
  {
    name: "Pepperoni Pizza",
    category: "Classic",
    description: "All-time favorite pepperoni pizza",
    toppings: ["Pepperoni", "Mozzarella"],
    prices: { Small: 8.99, Medium: 12.99, Large: 15.99 },
    spicy: false
  },
  {
    name: "BBQ Chicken Pizza",
    category: "Fusion",
    description: "Sweet and smoky BBQ chicken flavor",
    toppings: ["BBQ chicken", "Onions", "Mozzarella"],
    prices: { Small: 9.99, Medium: 13.99, Large: 17.99 },
    spicy: false
  },
  {
    name: "Hawaiian Pizza",
    category: "Classic",
    description: "Sweet and savory pineapple combo",
    toppings: ["Chicken ham", "Pineapple", "Mozzarella"],
    prices: { Small: 8.99, Medium: 12.99, Large: 15.99 },
    spicy: false
  },
  {
    name: "Veggie Supreme Pizza",
    category: "Vegetarian",
    description: "Loaded with fresh vegetables",
    toppings: ["Onions", "Bell peppers", "Olives", "Mushrooms"],
    prices: { Small: 8.49, Medium: 12.49, Large: 15.49 },
    spicy: false
  },
  {
    name: "Mushroom & Olive Pizza",
    category: "Vegetarian",
    description: "Simple and flavorful veggie option",
    toppings: ["Mushrooms", "Black olives", "Mozzarella"],
    prices: { Small: 8.99, Medium: 12.99, Large: 15.99 },
    spicy: false
  },
  {
    name: "Corn & Capsicum Pizza",
    category: "Vegetarian",
    description: "Mild, crunchy, and cheesy",
    toppings: ["Sweet corn", "Green peppers", "Mozzarella"],
    prices: { Small: 8.49, Medium: 12.49, Large: 15.49 },
    spicy: false
  }
];


const EXTRAS = [
  { name: "Garlic Bread", price: 4.99 },
  { name: "Cheesy Garlic Bread", price: 5.99 },
  { name: "Chicken Wings (6 pcs)", price: 7.99 },
  { name: "Paneer Pakora (8 pcs)", price: 6.99 },
  { name: "Coke", price: 1.99 },
  { name: "Sprite", price: 1.99 },
  { name: "Diet Coke", price: 1.99 },
  { name: "Water Bottle", price: 1.49 }
];

/* =========================
   SYSTEM PROMPT
========================= */

const SYSTEM_PROMPT = `
You answer calls at Pizza 64.

Sound like a real desi pizza shop employee.
Friendly, casual, short replies.
Ask one question at a time.

Rules:
 You must ONLY offer items from the MENU.
- NEVER invent pizza names.
- If the user requests an item not in the MENU, clearly say it is NOT available.
- Then list the valid menu options.
- Confirm orders ONLY using valid menu items.
- Never assume an order
- Never rush confirmation
- Allow changes anytime
- Suggest extras only if asked or natural
- Do not list full menu unless asked
- Never mention AI or systems
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
      extras: [],
      orderType: null,
      address: null,
      phone
    },
    readyToExtract: false,
    awaitingConfirmation: false,
    awaitingAddress: false,
    upsellOffered: false
  };
}

function getSession(callSid, phone) {
  if (!sessions.has(callSid)) {
    sessions.set(callSid, newSession(phone));
  }
  return sessions.get(callSid);
}

/* =========================
   CHAT REPLY
========================= */


async function chatReply(session, speech) {
  const client = await getOpenAI();
  if (!client) return "Sorry, we're having a little issue right now.";

  session.messages.push({ role: "user", content: speech });

  const res = await client.chat.completions.create({
    model: "gpt-4o-mini",
    temperature: 0.5,
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
   INTENT DETECTION
========================= */

function detectIntent(session, speech) {
  const t = speech.toLowerCase();

  if (/delivery/i.test(t)) {
    session.order.orderType = "delivery";
    session.awaitingAddress = true;
  }

  if (/pickup|pick up/i.test(t)) {
    session.order.orderType = "pickup";
  }

  if (/wait|change|no actually|sorry/i.test(t)) {
    session.readyToExtract = false;
    session.awaitingConfirmation = false;
    session.awaitingAddress = false;
  }

  if (/that's all|that is all|done|nothing else/i.test(t)) {
    session.readyToExtract = true;
  }
}

/* =========================
   ADDRESS CAPTURE
========================= */

function captureAddress(session, speech) {
  if (!session.awaitingAddress) return false;

  session.order.address = speech;
  session.awaitingAddress = false;
  session.readyToExtract = true;
  return true;
}

/* =========================
   UPSELL (ONCE)
========================= */

function maybeUpsell(session) {
  if (session.upsellOffered) return null;
  if (!session.order.items.length) return null;

  session.upsellOffered = true;
  return "Would you like to add garlic bread or a cold drink with that?";
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
        content: `
ONLY extract if the customer is clearly finished ordering.

If unclear or incomplete, return:
{ "items": [], "extras": [], "orderType": null, "address": null }

Return STRICT JSON only.
`
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
   CONFIRMATION TEXT
========================= */

function buildConfirmation(order) {
  const pizzas = order.items
    .map(i => `${i.quantity} ${i.size} ${i.name}`)
    .join(", ");

  const extras = order.extras?.length
    ? ` with ${order.extras.join(", ")}`
    : "";

  const where =
    order.orderType === "delivery"
      ? `for delivery to ${order.address}`
      : "for pickup";

  return `Just confirming — ${pizzas}${extras}, ${where}. Is that correct?`;
}
/* =========================
   RECEIPT & KITCHEN TICKET
========================= */

function buildReceipt(order) {
  const TAX_RATE = 0.13;
  let subtotal = 0;

  const itemsText = order.items.map(i => {
    const price = i.price || 0;
    subtotal += price * i.quantity;
    return `${i.quantity} x ${i.size} ${i.name}  $${(price * i.quantity).toFixed(2)}`;
  }).join("\n");

  const extrasText = order.extras?.length
    ? order.extras.map(e => {
        subtotal += e.price;
        return `${e.name}  $${e.price.toFixed(2)}`;
      }).join("\n")
    : "None";

  const tax = subtotal * TAX_RATE;
  const total = subtotal + tax;

  return `
🍕 PIZZA 64 RECEIPT 🍕

Items:
${itemsText}

Extras:
${extrasText}

Order Type: ${order.orderType}
${order.orderType === "delivery" ? "Address: " + order.address : ""}

Subtotal: $${subtotal.toFixed(2)}
Tax (13%): $${tax.toFixed(2)}
TOTAL: $${total.toFixed(2)}

Thank you for ordering!
`;
}

function buildKitchenTicket(order) {
  const time = new Date().toLocaleTimeString();

  return `
========================
🍕  PIZZA 64 - KITCHEN
========================
TIME: ${time}
TYPE: ${order.orderType.toUpperCase()}

${order.orderType === "delivery" ? "DELIVERY ADDRESS:\n" + order.address : ""}

------------------------
ITEMS:
------------------------
${order.items.map(i => `
${i.quantity} x ${i.size} ${i.name}
Spice: ${i.spiceLevel || "Regular"}
Extras: ${i.extras?.length ? i.extras.join(", ") : "None"}
`).join("\n")}

------------------------
SIDE EXTRAS:
------------------------
${order.extras?.length
  ? order.extras.map(e => `- ${e.name}`).join("\n")
  : "None"}

========================
`;
}

/* =========================
   SEND SMS SUMMARY
========================= */

/*async function sendSMS(order) {
  if (!order.phone) return;

  const body = `
Pizza 64 Order 🍕
${order.items.map(i => `• ${i.quantity} ${i.size} ${i.name}`).join("\n")}
${order.extras?.length ? "Extras: " + order.extras.join(", ") : ""}
${order.orderType === "delivery" ? "Delivery to: " + order.address : "Pickup"}

Thank you for ordering with Pizza 64!
`;

  await smsClient.messages.create({
    from: process.env.TWILIO_PHONE_NUMBER,
    to: order.phone,
    body
  });
}*/

/* =========================
   TWILIO ROUTES
========================= */

app.post("/twilio/voice", (req, res) => {
  const twiml = new twilio.twiml.VoiceResponse();

  twiml.say("Hi, thanks for calling Pizza 64.");
  twiml.say("What can I help you with today?");

  twiml.gather({
    input: "speech",
    action: "/twilio/step",
    method: "POST",
    speechTimeout: "auto"
  });

  res.type("text/xml").send(twiml.toString());
});

app.post("/twilio/step", async (req, res) => {
  const callSid = req.body.CallSid;
  const speech = (req.body.SpeechResult || "").trim();
  const phone = req.body.From;

  const session = getSession(callSid, phone);
  const twiml = new twilio.twiml.VoiceResponse();

  detectIntent(session, speech);

  if (captureAddress(session, speech)) {
    twiml.say("Got it. Anything else?");
    twiml.gather({ input: "speech", action: "/twilio/step", method: "POST" });
    return res.type("text/xml").send(twiml.toString());
  }
   if (session.awaitingConfirmation) {
  if (/yes|correct|yeah/i.test(speech.toLowerCase())) {

    console.log("🧾 CUSTOMER RECEIPT:");
    console.log(buildReceipt(session.order));

    console.log("👨‍🍳 KITCHEN TICKET:");
    console.log(buildKitchenTicket(session.order));

    twiml.say("Perfect. Your order is confirmed. See you soon!");
    sessions.delete(callSid);
    return res.type("text/xml").send(twiml.toString());
  } else {
    session.awaitingConfirmation = false;
    twiml.say("No problem, what would you like to change?");
  }
}

   
if (session.awaitingConfirmation) {
  if (/yes|correct|yeah/i.test(message.toLowerCase())) {
    console.log("🧾 RECEIPT:\n", buildReceipt(session.order));
    console.log("👨‍🍳 KITCHEN:\n", buildKitchenTicket(session.order));
    sessions.delete(sessionId);
    return res.json({ reply: "Perfect. Your order is confirmed!" });
  }
}

/*
    // Send receipt via SMS
    await sendSMS(session.order.phone, buildReceipt(session.order));

    twiml.say("Perfect. Your order is confirmed. See you soon!");
    sessions.delete(callSid);
    return res.type("text/xml").send(twiml.toString());
  } else {
    session.awaitingConfirmation = false;
    twiml.say("No problem, what would you like to change?");
  }
}*/


  if (session.readyToExtract) {
    const extracted = await extractOrder(session);
    if (extracted?.items?.length) {
      session.order = { ...session.order, ...extracted };
      session.awaitingConfirmation = true;

      twiml.say(buildConfirmation(session.order));
      twiml.gather({ input: "speech", action: "/twilio/step", method: "POST" });
      return res.type("text/xml").send(twiml.toString());
    }
  }

  const upsell = maybeUpsell(session);
  if (upsell) {
    twiml.say(upsell);
    twiml.gather({ input: "speech", action: "/twilio/step", method: "POST" });
    return res.type("text/xml").send(twiml.toString());
  }

  const reply = await chatReply(session, speech);
  twiml.say(reply);

  twiml.gather({
    input: "speech",
    action: "/twilio/step",
    method: "POST",
    speechTimeout: "auto"
  });

  res.type("text/xml").send(twiml.toString());
});
/* =========================
   CHAT TEST ENDPOINT
========================= */

app.post("/chat", async (req, res) => {
  const { sessionId, message } = req.body;

  const session = getSession(sessionId, "+10000000000");
  detectIntent(session, message);

  // Address capture
  if (captureAddress(session, message)) {
    return res.json({ reply: "Got it. Anything else you'd like?" });
  }

  // Confirmation
  if (session.awaitingConfirmation) {
    if (/yes|correct|yeah/i.test(message.toLowerCase())) {
      console.log("🧾 RECEIPT:\n", buildReceipt(session.order));
      console.log("👨‍🍳 KITCHEN:\n", buildKitchenTicket(session.order));
      sessions.delete(sessionId);
      return res.json({ reply: "Perfect. Your order is confirmed!" });
    } else {
      session.awaitingConfirmation = false;
      return res.json({ reply: "No worries, what would you like to change?" });
    }
  }

  // Extract order
  if (session.readyToExtract) {
    const extracted = await extractOrder(session);
    if (extracted?.items?.length) {
      session.order = { ...session.order, ...extracted };
      session.awaitingConfirmation = true;
      return res.json({ reply: buildConfirmation(session.order) });
    }
  }

  // Upsell
  const upsell = maybeUpsell(session);
  if (upsell) {
    return res.json({ reply: upsell });
  }

  // Normal chat
  const reply = await chatReply(session, message);
  res.json({ reply });
});


/* =========================
   SERVER
========================= */

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  console.log(`🍕 Pizza 64 AI running on port ${PORT}`);
});

