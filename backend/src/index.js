import "dotenv/config";
import express from "express";
import cors from "cors";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, "../public")));

/* =========================
   MENU (Pizza 64)
========================= */

const MENU = [
  "Cheese Lovers",
  "Pepperoni",
  "Veggie Supreme",
  "Butter Chicken",
  "Shahi Paneer",
  "Tandoori Chicken"
];

/* =========================
   SESSION MEMORY
========================= */

const sessions = new Map();

function newSession(phone = null) {
  return {
    step: "pizza",
    order: {
      pizza: null,
      size: null,
      spice: null,
      cilantro: null,
      orderType: null,
      address: null,
      name: null,
      phone
    }
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
let day = new Date().toDateString();
let counter = 1;

function nextTicket() {
  const today = new Date().toDateString();
  if (today !== day) {
    day = today;
    counter = 1;
  }
  return `${today.replace(/\s/g, "")}-${counter++}`;
}

function createTicket(order, source) {
  const ticket = {
    ticketNo: nextTicket(),
    time: new Date().toLocaleTimeString(),
    source,
    order
  };

  tickets.unshift(ticket);

  console.log("🎫 CONFIRMED TICKET:", ticket.ticketNo);
  console.log(ticket);

  return ticket;
}

/* =========================
   ORDER FLOW (CORE LOGIC)
========================= */

function handleOrderFlow(session, message) {
  const t = message.toLowerCase();

  switch (session.step) {

    case "pizza": {
      const pizza = MENU.find(p => t.includes(p.toLowerCase()));
      if (!pizza) {
        return `We have ${MENU.join(", ")}. Which pizza would you like?`;
      }
      session.order.pizza = pizza;
      session.step = "size";
      return "What size would you like? Small, Medium, or Large?";
    }

    case "size": {
      if (!/small|medium|large/.test(t)) {
        return "Please choose a size: Small, Medium, or Large.";
      }
      session.order.size = t.match(/small|medium|large/)[0];
      session.step = "spice";
      return "How spicy would you like it? Mild, Medium, or Hot?";
    }

    case "spice": {
      if (!/mild|medium|hot/.test(t)) {
        return "Please choose spice level: Mild, Medium, or Hot.";
      }
      session.order.spice = t.match(/mild|medium|hot/)[0];
      session.step = "cilantro";
      return "Would you like to add cilantro? Yes or No?";
    }

    case "cilantro": {
      session.order.cilantro = t.includes("yes");
      session.step = "orderType";
      return "Will this be pickup or delivery?";
    }

    case "orderType": {
      if (t.includes("delivery")) {
        session.order.orderType = "delivery";
        session.step = "address";
        return "Can I get the delivery address?";
      }
      if (t.includes("pickup")) {
        session.order.orderType = "pickup";
        session.step = "name";
        return "May I have your name for the order?";
      }
      return "Is this pickup or delivery?";
    }

    case "address": {
      session.order.address = message;
      session.step = "name";
      return "May I have your name for the order?";
    }

    case "name": {
      session.order.name = message;
      session.step = "phone";
      return "Can I get a contact phone number?";
    }

    case "phone": {
      session.order.phone = message;
      session.step = "confirm";
      return `
Please confirm your order:
${session.order.size} ${session.order.pizza}
Spice: ${session.order.spice}
Cilantro: ${session.order.cilantro ? "Yes" : "No"}
${session.order.orderType === "delivery" ? "Delivery" : "Pickup"}

Is that correct?
      `;
    }

    default:
      return null;
  }
}

/* =========================
   CHAT API
========================= */

app.post("/chat", (req, res) => {
  const { sessionId, message } = req.body;
  const session = getSession(sessionId);

  // Final confirmation
  if (session.step === "confirm") {
    if (/yes|correct/.test(message.toLowerCase())) {
      const ticket = createTicket(session.order, "CHAT");
      sessions.delete(sessionId);

      return res.json({
        reply: `✅ Order confirmed!
Ticket #${ticket.ticketNo}
Your pizza will be ready in 20–25 minutes.
Thank you for ordering Pizza 64 🍕`
      });
    }
    return res.json({ reply: "No problem. What would you like to change?" });
  }

  // Normal flow
  const reply = handleOrderFlow(session, message);
  res.json({ reply });
});

/* =========================
   CONFIRMED TICKETS API
========================= */

app.get("/api/tickets", (req, res) => {
  res.json(tickets);
});

/* =========================
   SERVER
========================= */

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  console.log("🍕 Pizza 64 server running on port", PORT);
});



// import "dotenv/config";
// import express from "express";
// import cors from "cors";
// import twilio from "twilio";
// import path from "path";
// import { fileURLToPath } from "url";

// /* =========================
//    SETUP
// ========================= */

// const __filename = fileURLToPath(import.meta.url);
// const __dirname = path.dirname(__filename);

// const app = express();
// app.use(cors());
// app.use(express.json());
// app.use(express.urlencoded({ extended: false }));
// app.use(express.static(path.join(__dirname, "../public")));

// /* =========================
//    OPENAI
// ========================= */

// let openai = null;
// async function getOpenAI() {
//   if (openai) return openai;
//   if (!process.env.OPENAI_API_KEY) return null;
//   const { default: OpenAI } = await import("openai");
//   openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
//   return openai;
// }

// /* =========================
//    MENU (Pizza 64)
// ========================= */

// const MENU = [
//   { name: "Shahi Paneer", spicy: true },
//   { name: "Butter Chicken", spicy: true },
//   { name: "Tandoori Chicken", spicy: true },
//   { name: "Veggie Supreme", spicy: false },
//   { name: "Pepperoni", spicy: false },
//   { name: "Cheese Lovers", spicy: false }
// ];

// /* =========================
//    SESSION MEMORY
// ========================= */

// const sessions = new Map();

// function newSession(phone) {
//   return {
//     messages: [],
//     step: "ordering",
//     order: {
//       items: [],
//       orderType: null,
//       address: null,
//       name: null,
//       phone: phone || null,
//       cilantro: false
//     }
//   };
// }

// function getSession(id, phone) {
//   if (!sessions.has(id)) {
//     sessions.set(id, newSession(phone));
//   }
//   return sessions.get(id);
// }

// /* =========================
//    TICKETS
// ========================= */

// let tickets = [];
// let today = new Date().toDateString();
// let counter = 1;

// function nextTicket() {
//   const now = new Date().toDateString();
//   if (now !== today) {
//     today = now;
//     counter = 1;
//   }
//   return `${today.replace(/\s/g, "")}-${counter++}`;
// }

// function createTicket(order, source) {
//   const ticket = {
//     ticketNo: nextTicket(),
//     time: new Date().toLocaleTimeString(),
//     source,
//     order
//   };
//   tickets.unshift(ticket);
//   console.log("🎫 NEW TICKET:", ticket.ticketNo);
//   console.log(buildKitchenTicket(order));
//   return ticket;
// }

// /* =========================
//    PROMPT
// ========================= */

// const SYSTEM_PROMPT = `
// You work at Pizza 64.
// Be friendly and short.
// Ask one question at a time.
// Only offer items from MENU.
// Never invent food.
// `;

// /* =========================
//    CHAT REPLY
// ========================= */

// async function chatReply(session, text) {
//   const client = await getOpenAI();
//   if (!client) return "Sorry, system issue.";

//   session.messages.push({ role: "user", content: text });

//   const res = await client.chat.completions.create({
//     model: "gpt-4o-mini",
//     messages: [
//       { role: "system", content: SYSTEM_PROMPT },
//       { role: "system", content: `MENU: ${JSON.stringify(MENU)}` },
//       ...session.messages.slice(-10)
//     ]
//   });

//   const reply = res.choices[0].message.content.trim();
//   session.messages.push({ role: "assistant", content: reply });
//   return reply;
// }

// /* =========================
//    ORDER FLOW LOGIC
// ========================= */

// function handleSteps(session, text) {
//   const t = text.toLowerCase();

//   if (session.step === "ordering") {
//     const found = MENU.find(p => t.includes(p.name.toLowerCase()));
//     if (found) {
//       session.order.items.push({ name: found.name, quantity: 1 });
//       session.step = "orderType";
//       return "Pickup or delivery?";
//     }
//     return null;
//   }

//   if (session.step === "orderType") {
//     if (t.includes("delivery")) {
//       session.order.orderType = "delivery";
//       session.step = "address";
//       return "Can I get the delivery address?";
//     }
//     if (t.includes("pickup")) {
//       session.order.orderType = "pickup";
//       session.step = "name";
//       return "May I have your name?";
//     }
//   }

//   if (session.step === "address") {
//     session.order.address = text;
//     session.step = "name";
//     return "May I have your name?";
//   }

//   if (session.step === "name") {
//     session.order.name = text;
//     session.step = "phone";
//     return "Can I get a contact phone number?";
//   }

//   if (session.step === "phone") {
//     session.order.phone = text;
//     session.step = "cilantro";
//     return "Would you like to add cilantro on your pizza?";
//   }

//   if (session.step === "cilantro") {
//     session.order.cilantro = t.includes("yes");
//     session.step = "confirm";
//     return "Perfect! Confirming your order now.";
//   }

//   return null;
// }

// /* =========================
//    RECEIPTS
// ========================= */

// function buildKitchenTicket(order) {
//   return `
// 🍕 PIZZA 64 - KITCHEN
// ------------------
// ${order.items.map(i => `${i.quantity} x ${i.name}`).join("\n")}
// Cilantro: ${order.cilantro ? "YES" : "NO"}
// TYPE: ${order.orderType}
// ${order.address ? "ADDRESS: " + order.address : ""}
// `;
// }

// /* =========================
//    CHAT API
// ========================= */

// app.post("/chat", async (req, res) => {
//   const { sessionId, message } = req.body;
//   const session = getSession(sessionId);

//   const stepReply = handleSteps(session, message);
//   if (stepReply) return res.json({ reply: stepReply });

//   if (session.step === "confirm") {
//     const ticket = createTicket(session.order, "CHAT");
//     sessions.delete(sessionId);
//     return res.json({
//       reply: `✅ Order confirmed!
// Ticket #${ticket.ticketNo}
// Pickup in 20–25 minutes 🍕`
//     });
//   }

//   const reply = await chatReply(session, message);
//   res.json({ reply });
// });

// /* =========================
//    TWILIO CALLS
// ========================= */

// app.post("/twilio/voice", (req, res) => {
//   const twiml = new twilio.twiml.VoiceResponse();
//   twiml.say("Welcome to Pizza 64. What can I get for you?");
//   twiml.gather({ input: "speech", action: "/twilio/step", method: "POST" });
//   res.type("text/xml").send(twiml.toString());
// });

// app.post("/twilio/step", async (req, res) => {
//   const callSid = req.body.CallSid;
//   const speech = (req.body.SpeechResult || "").trim();
//   const phone = req.body.From;

//   const session = getSession(callSid, phone);
//   const twiml = new twilio.twiml.VoiceResponse();

//   const stepReply = handleSteps(session, speech);
//   if (stepReply) {
//     twiml.say(stepReply);
//     twiml.gather({ input: "speech", action: "/twilio/step", method: "POST" });
//     return res.type("text/xml").send(twiml.toString());
//   }

//   if (session.step === "confirm") {
//     const ticket = createTicket(session.order, "CALL");
//     twiml.say(`Order confirmed. Ticket number ${ticket.ticketNo}. Ready in 25 minutes.`);
//     sessions.delete(callSid);
//     return res.type("text/xml").send(twiml.toString());
//   }

//   const reply = await chatReply(session, speech);
//   twiml.say(reply);
//   twiml.gather({ input: "speech", action: "/twilio/step", method: "POST" });
//   res.type("text/xml").send(twiml.toString());
// });

// /* =========================
//    TICKETS API
// ========================= */

// app.get("/api/tickets", (req, res) => {
//   res.json(tickets);
// });

// /* =========================
//    SERVER
// ========================= */

// const PORT = process.env.PORT || 10000;
// app.listen(PORT, () => {
//   console.log("🍕 Pizza 64 running on port", PORT);
// });
