import "dotenv/config";
import express from "express";
import cors from "cors";
import fs from "fs";
import path from "path";
import OpenAI from "openai";
import twilio from "twilio";
import { fileURLToPath } from "url";

/* =========================
   BASIC SETUP
========================= */

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(cors());
app.use(express.urlencoded({ extended: false }));
app.use(express.json());
app.use(express.static(path.join(__dirname, "../public")));

const PORT = process.env.PORT || 10000;

/* =========================
   MENU
========================= */

const MENU = [
  "Cheese Lovers",
  "Pepperoni",
  "Veggie Supreme",
  "Butter Chicken",
  "Shahi Paneer",
  "Tandoori Chicken"
];

const SIDES = ["Garlic Bread", "Chicken Wings", "Fries", "Coke", "Sprite"];

/* =========================
   STORAGE
========================= */

const TICKETS_FILE = path.join(__dirname, "tickets.json");
if (!fs.existsSync(TICKETS_FILE)) fs.writeFileSync(TICKETS_FILE, "[]");

let tickets = JSON.parse(fs.readFileSync(TICKETS_FILE, "utf8"));
const sessions = new Map();

/* =========================
   OPENAI
========================= */

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
});

/* =========================
   AI EXTRACTION (ORDER + EDIT)
========================= */

async function extract(message) {
  const prompt = `
Extract intent from user message.
Return ONLY JSON.

Menu pizzas: ${MENU.join(", ")}

{
  "intent": "order | edit | remove | menu | confirm | other",
  "edit": {
    "index": number | null,
    "field": "size | spice" | null,
    "value": string | null
  },
  "remove": {
    "name": string | null,
    "index": number | null
  },
  "pizzas": [
    {
      "name": string | null,
      "size": "Small" | "Medium" | "Large" | null,
      "spice": "Mild" | "Medium" | "Hot" | null,
      "qty": number
    }
  ]
}

Message:
"${message}"
`;

  try {
    const r = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      temperature: 0,
      messages: [{ role: "system", content: prompt }]
    });
    return JSON.parse(r.choices[0].message.content);
  } catch {
    return {};
  }
}

/* =========================
   NEXT QUESTION LOGIC
========================= */

function nextQuestion(session) {

  if (session.activePizzaIndex === null) {
    session.activePizzaIndex = session.pizzas.findIndex(
      p => !p.size || !p.spice
    );
  }

  const p =
    session.activePizzaIndex !== null &&
    session.activePizzaIndex !== -1
      ? session.pizzas[session.activePizzaIndex]
      : null;

  if (p) {
    if (!p.size) return `What size would you like for the ${p.name}?`;
    if (!p.spice)
      return `How spicy would you like the ${p.name}? Mild, Medium, or Hot?`;
  }

  session.activePizzaIndex = null;

  if (
    session.pizzas.length > 0 &&
    session.pizzas.every(p => p.size && p.spice) &&
    !session.morePizzaAsked
  ) {
    session.morePizzaAsked = true;
    return "Would you like to add another pizza or is that all?";
  }

  if (!session.sidesAsked && session.pizzas.length > 0) {
    session.sidesAsked = true;
    return "Would you like any sides or drinks?";
  }

  if (!session.name) return "May I have your name for the order?";
  if (!session.phone) return "Can I get a contact phone number?";

  return "confirm";
}

/* =========================
   CHAT ENGINE
========================= */

async function reply(session, msg) {
  const ai = await extract(msg);

  /* ===== GREETING ===== */
  if (!session.started) {
    session.started = true;
    return "Hi! This is Pizza 64 🙂 How can I help you today?";
  }

  /* ===== MENU ===== */
  if (ai.intent === "menu") {
    return "Our most popular pizzas are Pepperoni, Butter Chicken, Shahi Paneer, Veggie Supreme, and Tandoori Chicken.";
  }

  /* ===== REMOVE PIZZA ===== */
  if (ai.intent === "remove") {
    if (ai.remove?.index !== null && session.pizzas[ai.remove.index]) {
      session.pizzas.splice(ai.remove.index, 1);
      return "Got it 👍 I’ve removed that pizza.";
    }

    if (ai.remove?.name) {
      const i = session.pizzas.findIndex(p =>
        p.name.toLowerCase().includes(ai.remove.name.toLowerCase())
      );
      if (i !== -1) {
        session.pizzas.splice(i, 1);
        return "No problem 👍 I’ve removed that pizza.";
      }
    }
  }

  /* ===== EDIT PIZZA ===== */
  if (ai.intent === "edit" && ai.edit?.index !== null) {
    const p = session.pizzas[ai.edit.index];
    if (p && ai.edit.field && ai.edit.value) {
      p[ai.edit.field] =
        ai.edit.value[0].toUpperCase() + ai.edit.value.slice(1);
      return `Done 👍 I’ve updated the ${p.name}.`;
    }
  }

  /* ===== MERGE NEW PIZZAS ===== */
  if (ai.pizzas?.length) {
    for (const p of ai.pizzas) {
      if (!p.name) continue;
      session.pizzas.push({
        name: p.name,
        size: p.size || null,
        spice: p.spice || null,
        qty: p.qty || 1
      });
    }
  }

  /* ===== APPLY SIZE/SPICE TO ACTIVE ===== */
  const active =
    session.activePizzaIndex !== null
      ? session.pizzas[session.activePizzaIndex]
      : null;

  if (active) {
    const t = msg.toLowerCase();
    if (!active.size && /small|medium|large/.test(t)) {
      active.size =
        t.match(/small|medium|large/)[0][0].toUpperCase() +
        t.match(/small|medium|large/)[0].slice(1);
    }
    if (!active.spice && /mild|medium|hot/.test(t)) {
      active.spice =
        t.match(/mild|medium|hot/)[0][0].toUpperCase() +
        t.match(/mild|medium|hot/)[0].slice(1);
    }
    if (active.size && active.spice) session.activePizzaIndex = null;
  }

  /* ===== CONFIRM ===== */
  const next = nextQuestion(session);

  if (next === "confirm" && !session.confirming) {
    session.confirming = true;

    return `Please confirm your order:\n\n${session.pizzas
      .map(
        (p, i) =>
          `${i + 1}. ${p.qty}× ${p.size} ${p.name} (${p.spice})`
      )
      .join("\n")}\n\nIs that correct?`;
  }

  if (session.confirming && /yes|correct/i.test(msg)) {
    const ticket = {
      id: `P64-${Date.now()}`,
      time: new Date().toLocaleTimeString(),
      pizzas: session.pizzas
    };

    tickets.unshift(ticket);
    fs.writeFileSync(TICKETS_FILE, JSON.stringify(tickets, null, 2));
    sessions.delete(session.id);

    return "✅ Order confirmed! Your pizza will be ready in 20–25 minutes. Thank you for ordering Pizza 64 🍕";
  }

  return next;
}

/* =========================
   CHAT API
========================= */

app.post("/chat", async (req, res) => {
  const { sessionId, message } = req.body;

  if (!sessions.has(sessionId)) {
    sessions.set(sessionId, {
      id: sessionId,
      started: false,
      pizzas: [],
      sides: [],
      confirming: false,
      morePizzaAsked: false,
      sidesAsked: false,
      activePizzaIndex: null
    });
  }

  const session = sessions.get(sessionId);
  const replyText = await reply(session, message);
  res.json({ reply: replyText });
});

/* =========================
   TWILIO VOICE (PAUSED)
========================= */

app.post("/twilio/voice", (req, res) => {
  const twiml = new twilio.twiml.VoiceResponse();
  twiml.say("Welcome to Pizza 64.");
  twiml.pause({ length: 1 });
  twiml.say("What can I get for you today?");
  twiml.gather({ input: "speech", action: "/twilio/step", method: "POST" });
  res.type("text/xml").send(twiml.toString());
});

app.post("/twilio/step", async (req, res) => {
  const callSid = req.body.CallSid;
  const speech = req.body.SpeechResult || "";

  if (!sessions.has(callSid)) {
    sessions.set(callSid, {
      id: callSid,
      started: false,
      pizzas: [],
      confirming: false,
      morePizzaAsked: false,
      sidesAsked: false,
      activePizzaIndex: null
    });
  }

  const session = sessions.get(callSid);
  const replyText = await reply(session, speech);

  const twiml = new twilio.twiml.VoiceResponse();
  twiml.say(replyText);
  twiml.pause({ length: 1 });
  twiml.gather({ input: "speech", action: "/twilio/step", method: "POST" });
  res.type("text/xml").send(twiml.toString());
});

/* =========================
   SERVER
========================= */

app.listen(PORT, () => {
  console.log("🍕 Pizza 64 AI running on port", PORT);
});




// version 55 
// import "dotenv/config";
// import express from "express";
// import cors from "cors";
// import fs from "fs";
// import path from "path";
// import OpenAI from "openai";
// import twilio from "twilio";
// import { fileURLToPath } from "url";

// /* =========================
//    BASIC SETUP
// ========================= */

// const __filename = fileURLToPath(import.meta.url);
// const __dirname = path.dirname(__filename);

// const app = express();
// app.use(cors());
// app.use(express.urlencoded({ extended: false }));
// app.use(express.json());
// app.use(express.static(path.join(__dirname, "../public")));

// const PORT = process.env.PORT || 10000;

// /* =========================
//    MENU (BASE + CUSTOM)
// ========================= */

// const MENU = [
//   "Cheese Lovers",
//   "Pepperoni",
//   "Veggie Supreme",
//   "Butter Chicken",
//   "Shahi Paneer",
//   "Tandoori Chicken"
// ];

// const SIDES = ["Garlic Bread", "Chicken Wings", "Fries", "Coke", "Sprite"];

// /* =========================
//    STORAGE
// ========================= */

// const TICKETS_FILE = path.join(__dirname, "tickets.json");
// if (!fs.existsSync(TICKETS_FILE)) fs.writeFileSync(TICKETS_FILE, "[]");

// let tickets = JSON.parse(fs.readFileSync(TICKETS_FILE, "utf8"));
// const sessions = new Map();

// /* =========================
//    OPENAI
// ========================= */

// const openai = new OpenAI({
//   apiKey: process.env.OPENAI_API_KEY
// });

// /* =========================
//    AI EXTRACTION (FLEXIBLE)
// ========================= */

// async function extract(msg) {
//   const prompt = `
// You are extracting pizza order info.
// Return ONLY JSON.

// Menu pizzas: ${MENU.join(", ")}
// Sides: ${SIDES.join(", ")}

// Support:
// - customization (extra cheese, no onion, less spicy)
// - multiple pizzas
// - delivery/pickup anytime

// JSON:
// {
//   "intent": "order | menu | suggest | other",
//   "orderType": "Pickup" | "Delivery" | null,
//   "address": string | null,
//   "pizzas": [
//     {
//       "name": string | null,
//       "size": "Small" | "Medium" | "Large" | null,
//       "spice": "Mild" | "Medium" | "Hot" | null,
//       "custom": string | null,
//       "qty": number
//     }
//   ],
//   "sides": [string],
//   "done": boolean
// }

// Message:
// "${msg}"
// `;

//   try {
//     const r = await openai.chat.completions.create({
//       model: "gpt-4o-mini",
//       temperature: 0,
//       messages: [{ role: "system", content: prompt }]
//     });
//     return JSON.parse(r.choices[0].message.content);
//   } catch {
//     return {};
//   }
// }

// /* =========================
//    HUMAN RESPONSE AGENT
// ========================= */

// async function speak(context) {
//   const r = await openai.chat.completions.create({
//     model: "gpt-4o-mini",
//     temperature: 0.7,
//     messages: [
//       {
//         role: "system",
//         content: `
// You work at Pizza 64.
// Speak like a real human.
// Short sentences.
// Ask one question at a time.
// `
//       },
//       { role: "user", content: JSON.stringify(context) }
//     ]
//   });

//   return r.choices[0].message.content.trim();
// }

// /* =========================
//    NEXT QUESTION LOGIC
// ========================= */

// function nextQuestion(s) {
//   const p = s.pizzas.find(
//     x => !x.size || !x.spice
//   );

//   if (p) {
//     if (!p.size) return `What size would you like for the ${p.name}?`;
//     if (!p.spice)
//       return `How spicy should the ${p.name}? Mild, Medium, or Hot?`;
//   }

//   if (!s.morePizzaAsked) {
//     s.morePizzaAsked = true;
//     return "Would you like to add another pizza or is that all?";
//   }

//   if (!s.sidesAsked) {
//     s.sidesAsked = true;
//     return "Would you like any sides or drinks?";
//   }

//   if (!s.name) return "May I have your name for the order?";
//   if (!s.phone) return "Can I get a contact phone number?";

//   return "confirm";
// }

// /* =========================
//    CHAT ENGINE
// ========================= */

// async function reply(session, msg) {
//   const ai = await extract(msg);

//   /* ===== GREETING ===== */
//   if (!session.started) {
//     session.started = true;
//     return "Hi! This is Pizza 64 🙂 How can I help you today?";
//   }

//   /* ===== INTENTS ===== */
//   if (ai.intent === "menu") {
//     return `Our most popular pizzas are Pepperoni, Butter Chicken, Shahi Paneer, Veggie Supreme, and Tandoori Chicken.`;
//   }

//   if (ai.intent === "suggest") {
//     return "Most customers love Pepperoni or Butter Chicken. Which one would you like?";
//   }

//   /* ===== ORDER TYPE ===== */
//   if (ai.orderType) session.orderType = ai.orderType;
//   if (session.orderType === "Delivery" && !session.address) {
//     if (!ai.address) return "Can I get the delivery address?";
//     session.address = ai.address;
//   }

//   /* ===== MERGE PIZZAS ===== */
//   if (ai.pizzas?.length) {
//     for (const p of ai.pizzas) {
//       if (!p.name) continue;
//       session.pizzas.push({
//         name: p.name,
//         size: p.size || null,
//         spice: p.spice || null,
//         custom: p.custom || null,
//         qty: p.qty || 1
//       });
//     }
//   }

//   /* ===== SIDES ===== */
//   if (ai.sides?.length) session.sides.push(...ai.sides);

//   /* ===== CONFIRM ===== */
//   const next = nextQuestion(session);

//   if (next === "confirm" && !session.confirming) {
//     session.confirming = true;

//     return `Please confirm your order:

// ${session.pizzas.map(
//       p =>
//         `${p.qty}× ${p.size || ""} ${p.name} (${p.spice || ""}) ${
//           p.custom ? "- " + p.custom : ""
//         }`
//     ).join("\n")}

// Sides: ${session.sides.length ? session.sides.join(", ") : "None"}
// ${session.orderType}

// Is that correct?`;
//   }

//   if (session.confirming && /yes|correct/i.test(msg)) {
//     const ticket = {
//       id: `P64-${Date.now()}`,
//       time: new Date().toLocaleTimeString(),
//       ...session
//     };

//     tickets.unshift(ticket);
//     fs.writeFileSync(TICKETS_FILE, JSON.stringify(tickets, null, 2));
//     sessions.delete(session.id);

//     return "✅ Order confirmed! Your pizza will be ready in 20–25 minutes. Thank you for ordering Pizza 64 🍕";
//   }

//   return next;
// }

// /* =========================
//    CHAT API
// ========================= */

// app.post("/chat", async (req, res) => {
//   const { sessionId, message } = req.body;

//   if (!sessions.has(sessionId)) {
//     sessions.set(sessionId, {
//       id: sessionId,
//       started: false,
//       pizzas: [],
//       sides: [],
//       orderType: null,
//       address: null,
//       name: null,
//       phone: null,
//       confirming: false,
//       morePizzaAsked: false,
//       sidesAsked: false
//     });
//   }

//   const session = sessions.get(sessionId);
//   const r = await reply(session, message);
//   res.json({ reply: r });
// });

// /* =========================
//    TWILIO VOICE
// ========================= */

// app.post("/twilio/voice", (req, res) => {
//   const twiml = new twilio.twiml.VoiceResponse();
//   twiml.say("Welcome to Pizza 64. What can I get for you?");
//   twiml.gather({ input: "speech", action: "/twilio/step", method: "POST" });
//   res.type("text/xml").send(twiml.toString());
// });

// app.post("/twilio/step", async (req, res) => {
//   const callSid = req.body.CallSid;
//   const speech = req.body.SpeechResult || "";

//   if (!sessions.has(callSid)) {
//     sessions.set(callSid, {
//       id: callSid,
//       started: false,
//       pizzas: [],
//       sides: [],
//       orderType: null,
//       address: null,
//       confirming: false,
//       morePizzaAsked: false,
//       sidesAsked: false
//     });
//   }

//   const session = sessions.get(callSid);
//   const replyText = await reply(session, speech);

//   const twiml = new twilio.twiml.VoiceResponse();
//   twiml.say(replyText);
//   twiml.gather({ input: "speech", action: "/twilio/step", method: "POST" });
//   res.type("text/xml").send(twiml.toString());
// });

// /* =========================
//    TICKETS API
// ========================= */

// app.get("/api/tickets", (req, res) => res.json(tickets));

// /* =========================
//    SERVER
// ========================= */

// app.listen(PORT, () => {
//   console.log("🍕 Pizza 64 AI running on", PORT);
// });

// version 4 4 
// import express from "express";
// import cors from "cors";
// import fs from "fs";
// import path from "path";
// import OpenAI from "openai";
// import { fileURLToPath } from "url";

// /* =========================
//    BASIC SETUP
// ========================= */

// const __filename = fileURLToPath(import.meta.url);
// const __dirname = path.dirname(__filename);

// const app = express();
// app.use(cors());
// app.use(express.json());
// app.use(express.static(path.join(__dirname, "../public")));

// const PORT = process.env.PORT || 10000;

// /* =========================
//    DATA
// ========================= */

// const MENU = [
//   "Cheese Lovers",
//   "Pepperoni",
//   "Veggie Supreme",
//   "Butter Chicken",
//   "Shahi Paneer",
//   "Tandoori Chicken"
// ];

// const SIDES = [
//   "Garlic Bread",
//   "Chicken Wings",
//   "Fries",
//   "Coke",
//   "Sprite"
// ];

// const TICKETS_FILE = path.join(__dirname, "tickets.json");
// if (!fs.existsSync(TICKETS_FILE)) fs.writeFileSync(TICKETS_FILE, "[]");

// let tickets = JSON.parse(fs.readFileSync(TICKETS_FILE, "utf8"));

// /* =========================
//    OPENAI (EXTRACTION ONLY)
// ========================= */

// const openai = new OpenAI({
//   apiKey: process.env.OPENAI_API_KEY
// });

// async function extract(message) {
//   const prompt = `
// Extract order info from the customer message.
// Return ONLY valid JSON.

// Menu pizzas: ${MENU.join(", ")}
// Sides: ${SIDES.join(", ")}

// Rules:
// - Do NOT invent pizzas
// - Quantity defaults to 1
// - Missing fields must be null

// JSON:
// {
//   "orderType": "Pickup" | "Delivery" | null,
//   "pizzas": [
//     {
//       "name": string | null,
//       "size": "Small" | "Medium" | "Large" | null,
//       "spice": "Mild" | "Medium" | "Hot" | null,
//       "qty": number
//     }
//   ],
//   "sides": [string]
// }

// Message:
// "${message}"
// `;

//   try {
//     const res = await openai.chat.completions.create({
//       model: "gpt-4o-mini",
//       temperature: 0,
//       messages: [{ role: "system", content: prompt }]
//     });
//     return JSON.parse(res.choices[0].message.content);
//   } catch {
//     return {};
//   }
// }

// /* =========================
//    SESSION MEMORY
// ========================= */

// const sessions = new Map();

// /* =========================
//    NEXT QUESTION LOGIC
// ========================= */

// function nextQuestion(session) {
//   if (session.pizzas.length === 0) {
//     return "Sure 🙂 What pizza would you like?";
//   }

//   const p = session.pizzas.find(
//     x => !x.size || !x.spice || x.cilantro === null
//   );

//   if (p) {
//     if (!p.size) return `What size would you like for the ${p.name}?`;
//     if (!p.spice)
//       return `How spicy would you like the ${p.name}? Mild, Medium, or Hot?`;
//     if (p.cilantro === null)
//       return `Would you like cilantro on the ${p.name}? Yes or No?`;
//   }

//   if (!session.orderType) {
//     return "Is this for pickup or delivery?";
//   }

//   if (!session.sidesAsked) {
//     session.sidesAsked = true;
//     return `Would you like any sides or drinks? We have ${SIDES.join(", ")}.`;
//   }

//   if (!session.name) {
//     return "May I have your name for the order?";
//   }

//   if (!session.phone) {
//     return "Can I get a contact phone number?";
//   }

//   return "confirm";
// }

// /* =========================
//    CHAT ENGINE
// ========================= */

// async function reply(session, msg) {
//   const ai = await extract(msg);

//   /* ===== GREETING ===== */
//   if (!session.started) {
//     session.started = true;
//     return "Hi! This is Pizza 64 🙂 How can I help you today?";
//   }

//   /* ===== MERGE ORDER TYPE ===== */
//   if (ai.orderType) session.orderType = ai.orderType;

//   /* ===== MERGE PIZZAS ===== */
//   if (ai.pizzas?.length) {
//     for (const p of ai.pizzas) {
//       if (!p.name) continue;

//       session.pizzas.push({
//         name: p.name,
//         size: p.size || null,
//         spice: p.spice || null,
//         qty: p.qty || 1,
//         cilantro: null
//       });
//     }
//   }

//   /* ===== MERGE SIDES ===== */
//   if (ai.sides?.length) {
//     session.sides.push(...ai.sides);
//   }

//   /* ===== FILL MISSING PIZZA INFO ===== */
//   const active = session.pizzas.find(
//     x => !x.size || !x.spice || x.cilantro === null
//   );

//   if (active) {
//     const t = msg.toLowerCase();

//     if (!active.size && /small|medium|large/.test(t)) {
//       active.size =
//         t.match(/small|medium|large/i)[0][0].toUpperCase() +
//         t.match(/small|medium|large/i)[0].slice(1);
//     }

//     if (!active.spice && /mild|medium|hot/.test(t)) {
//       active.spice =
//         t.match(/mild|medium|hot/i)[0][0].toUpperCase() +
//         t.match(/mild|medium|hot/i)[0].slice(1);
//     }

//     if (active.cilantro === null && /yes|no/.test(t)) {
//       active.cilantro = /yes/.test(t) ? "Yes" : "No";
//     }
//   }

//   /* ===== CUSTOMER INFO ===== */
//   if (!session.name && session.sidesAsked && !session.confirming) {
//     if (!/\d/.test(msg)) session.name = msg.trim();
//   }

//   if (!session.phone) {
//     const m = msg.match(/\b\d{10}\b/);
//     if (m) session.phone = m[0];
//   }

//   /* ===== CONFIRMATION ===== */
//   const next = nextQuestion(session);

//   if (next === "confirm" && !session.confirming) {
//     session.confirming = true;
//     return `Please confirm your order:

// PIZZAS:
// ${session.pizzas.map(
//       p => `${p.qty}× ${p.size} ${p.name} (${p.spice}) Cilantro: ${p.cilantro}`
//     ).join("\n")}

// SIDES:
// ${session.sides.length ? session.sides.join(", ") : "None"}

// ${session.orderType}

// Is that correct?`;
//   }

//   /* ===== FINAL YES (ONCE ONLY) ===== */
//   if (session.confirming && /yes|correct/i.test(msg)) {
//     session.confirming = false;

//     const ticket = {
//       id: `P64-${Date.now()}`,
//       time: new Date().toLocaleTimeString(),
//       name: session.name,
//       phone: session.phone,
//       orderType: session.orderType,
//       pizzas: session.pizzas,
//       sides: session.sides
//     };

//     tickets.unshift(ticket);
//     fs.writeFileSync(TICKETS_FILE, JSON.stringify(tickets, null, 2));
//     sessions.delete(session.id);

//     return `✅ Order confirmed! Ticket #${ticket.id}
// Your order will be ready in 20–25 minutes.
// Thank you for ordering Pizza 64 🍕`;
//   }

//   /* ===== ABSOLUTE SAFETY NET ===== */
//   return nextQuestion(session);
// }

// /* =========================
//    API
// ========================= */

// app.post("/chat", async (req, res) => {
//   const { sessionId, message } = req.body;

//   if (!sessions.has(sessionId)) {
//     sessions.set(sessionId, {
//       id: sessionId,
//       started: false,
//       orderType: null,
//       pizzas: [],
//       sides: [],
//       sidesAsked: false,
//       name: null,
//       phone: null,
//       confirming: false
//     });
//   }

//   const session = sessions.get(sessionId);
//   const replyText = await reply(session, message);
//   res.json({ reply: replyText });
// });

// app.get("/health", (req, res) => {
//   res.json({ status: "ok" });
// });

// app.get("/api/tickets", (req, res) => {
//   res.json(tickets);
// });

// app.listen(PORT, () => {
//   console.log("🍕 Pizza 64 AI Assistant running on port", PORT);
// });

// vesion 1.2
// import express from "express";
// import cors from "cors";
// import path from "path";
// import fs from "fs";
// import OpenAI from "openai";
// import { fileURLToPath } from "url";

// /* =========================
//    SETUP
// ========================= */

// const __filename = fileURLToPath(import.meta.url);
// const __dirname = path.dirname(__filename);

// const TICKETS_FILE = path.join(__dirname, "tickets.json");
// if (!fs.existsSync(TICKETS_FILE)) fs.writeFileSync(TICKETS_FILE, "[]");

// const openai = new OpenAI({
//   apiKey: process.env.OPENAI_API_KEY
// });

// const app = express();
// app.use(cors());
// app.use(express.json());
// app.use(express.static(path.join(__dirname, "../public")));

// /* =========================
//    MENU
// ========================= */

// const MENU = [
//   "Cheese Lovers",
//   "Pepperoni",
//   "Veggie Supreme",
//   "Butter Chicken",
//   "Shahi Paneer",
//   "Tandoori Chicken"
// ];

// const SIDES = [
//   "Garlic Bread",
//   "Chicken Wings",
//   "Fries",
//   "Coke",
//   "Sprite"
// ];

// /* =========================
//    STORAGE
// ========================= */

// const sessions = new Map();
// let tickets = JSON.parse(fs.readFileSync(TICKETS_FILE, "utf8"));

// let day = new Date().toDateString();
// let counter = 1;

// function nextTicket() {
//   const today = new Date().toDateString();
//   if (today !== day) {
//     day = today;
//     counter = 1;
//   }
//   return `P64-${today.replace(/\s/g, "")}-${counter++}`;
// }

// /* =========================
//    AI EXTRACTION
// ========================= */

// async function extractInfo(message) {
//   const prompt = `
// You work at Pizza 64.
// Extract structured order data.
// Return ONLY valid JSON.

// Rules:
// - Support multiple pizzas in one message
// - Quantity defaults to 1
// - Only use pizzas from this menu: ${MENU.join(", ")}
// - Only use sides from this list: ${SIDES.join(", ")}

// Return format:
// {
//   "intent": "order_pizza | other",
//   "orderType": null | "Pickup" | "Delivery",
//   "pizzas": [
//     {
//       "name": string,
//       "size": "Small" | "Medium" | "Large" | null,
//       "spice": "Mild" | "Medium" | "Hot" | null,
//       "qty": number
//     }
//   ],
//   "sides": [string],
//   "done": boolean
// }

// User message:
// "${message}"
// `;

//   try {
//     const res = await openai.chat.completions.create({
//       model: "gpt-4o-mini",
//       temperature: 0,
//       messages: [{ role: "system", content: prompt }]
//     });

//     return JSON.parse(res.choices[0].message.content);
//   } catch {
//     return {};
//   }
// }

// /* =========================
//    CHAT LOGIC
// ========================= */

// async function reply(session, msg) {
//   const ai = await extractInfo(msg);

//   /* ===== GREETING ===== */
//   if (!session.started) {
//     session.started = true;
//     return "Hi! This is Pizza 64 🙂 How can I help you today?";
//   }

//   /* ===== MERGE ORDER TYPE ===== */
//   if (ai.orderType && !session.orderType) {
//     session.orderType = ai.orderType;
//   }

//   if (!session.orderType) {
//     return "Is this for pickup or delivery?";
//   }

//   /* ===== MERGE PIZZAS ===== */
//   if (ai.pizzas?.length) {
//     for (const p of ai.pizzas) {
//       session.pendingPizzas.push({
//         name: p.name,
//         size: p.size,
//         spice: p.spice,
//         qty: p.qty || 1,
//         cilantro: null
//       });
//     }
//   }

//   /* ===== COMPLETE PIZZAS ONE BY ONE ===== */
//   const nextPizza = session.pendingPizzas.find(
//     p => !p.size || !p.spice || p.cilantro === null
//   );

//   if (nextPizza) {
//     if (!nextPizza.size) {
//       return `What size would you like for the ${nextPizza.name}?`;
//     }
//     if (!nextPizza.spice) {
//       return `How spicy should the ${nextPizza.name} be? Mild, Medium, or Hot?`;
//     }
//     if (nextPizza.cilantro === null) {
//       return `Would you like cilantro on the ${nextPizza.name}? Yes or No?`;
//     }
//   }

//   /* ===== MOVE COMPLETED PIZZAS ===== */
//   while (session.pendingPizzas.length) {
//     const p = session.pendingPizzas[0];
//     if (p.size && p.spice && p.cilantro !== null) {
//       session.items.push(p);
//       session.pendingPizzas.shift();
//     } else {
//       break;
//     }
//   }

//   /* ===== ASK FOR SIDES ===== */
//   if (!session.sidesAsked) {
//     session.sidesAsked = true;
//     return `Would you like any sides or drinks? We have ${SIDES.join(", ")}.`;
//   }

//   if (ai.sides?.length) {
//     session.sides.push(...ai.sides);
//   }

//   /* ===== NAME ===== */
//   if (!session.name) {
//     session.name = msg.trim();
//     return "Can I get a contact phone number?";
//   }

//   /* ===== PHONE ===== */
//   if (!session.phone) {
//     const match = msg.match(/\b\d{10}\b/);
//     if (!match) return "Can I get a contact phone number?";
//     session.phone = match[0];
//   }

//   /* ===== CONFIRM ===== */
//   if (!session.confirming) {
//     session.confirming = true;
//     return `Please confirm your order:

// PIZZAS:
// ${session.items.map(
//       p => `${p.qty}× ${p.size} ${p.name} (${p.spice}) Cilantro: ${p.cilantro}`
//     ).join("\n")}

// SIDES:
// ${session.sides.length ? session.sides.join(", ") : "None"}

// ${session.orderType}

// Is that correct?`;
//   }

//   /* ===== FINAL ===== */
//   if (/yes|correct/i.test(msg)) {
//     const ticket = {
//       id: nextTicket(),
//       time: new Date().toLocaleTimeString(),
//       name: session.name,
//       phone: session.phone,
//       orderType: session.orderType,
//       pizzas: session.items,
//       sides: session.sides
//     };

//     tickets.unshift(ticket);
//     fs.writeFileSync(TICKETS_FILE, JSON.stringify(tickets, null, 2));
//     sessions.delete(session.id);

//     return `✅ Order confirmed! Ticket #${ticket.id}
// Your order will be ready in 20–25 minutes.
// Thank you for ordering Pizza 64 🍕`;
//   }

//   session.confirming = false;
//   return "No problem 🙂 What would you like to change?";
// }

// /* =========================
//    CHAT API
// ========================= */

// app.post("/chat", async (req, res) => {
//   const { sessionId, message } = req.body;

//   if (!sessions.has(sessionId)) {
//     sessions.set(sessionId, {
//       id: sessionId,
//       started: false,
//       orderType: null,
//       pendingPizzas: [],
//       items: [],
//       sides: [],
//       sidesAsked: false,
//       name: null,
//       phone: null,
//       confirming: false
//     });
//   }

//   const session = sessions.get(sessionId);
//   const replyText = await reply(session, message);
//   res.json({ reply: replyText });
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
//   console.log("🍕 Pizza 64 AI assistant running on port", PORT);
// });


// version ai 1.1

// import express from "express";
// import cors from "cors";
// import path from "path";
// import fs from "fs";
// import OpenAI from "openai";
// import { fileURLToPath } from "url";

// /* =========================
//    SETUP
// ========================= */

// const __filename = fileURLToPath(import.meta.url);
// const __dirname = path.dirname(__filename);

// const TICKETS_FILE = path.join(__dirname, "tickets.json");
// if (!fs.existsSync(TICKETS_FILE)) fs.writeFileSync(TICKETS_FILE, "[]");

// const openai = new OpenAI({
//   apiKey: process.env.OPENAI_API_KEY
// });

// const app = express();
// app.use(cors());
// app.use(express.json());
// app.use(express.static(path.join(__dirname, "../public")));

// /* =========================
//    MENU
// ========================= */

// const MENU = [
//   "Cheese Lovers",
//   "Pepperoni",
//   "Veggie Supreme",
//   "Butter Chicken",
//   "Shahi Paneer",
//   "Tandoori Chicken"
// ];

// /* =========================
//    STORAGE
// ========================= */

// const sessions = new Map();
// let tickets = JSON.parse(fs.readFileSync(TICKETS_FILE, "utf8"));

// let day = new Date().toDateString();
// let counter = 1;

// function nextTicket() {
//   const today = new Date().toDateString();
//   if (today !== day) {
//     day = today;
//     counter = 1;
//   }
//   return `P64-${today.replace(/\s/g, "")}-${counter++}`;
// }

// /* =========================
//    AI: EXTRACT INFO
// ========================= */

// async function extractInfo(message) {
//   const prompt = `
// You work at Pizza 64.
// Extract structured data from user message.
// Return ONLY JSON.

// Format:
// {
//   "intent": "order_pizza | other",
//   "pizza": null | string,
//   "size": null | "Small" | "Medium" | "Large",
//   "spice": null | "Mild" | "Medium" | "Hot",
//   "orderType": null | "Pickup" | "Delivery",
//   "name": null | string,
//   "phone": null | string,
//   "done": true | false
// }

// Menu: ${MENU.join(", ")}

// Message:
// "${message}"
// `;

//   try {
//     const res = await openai.chat.completions.create({
//       model: "gpt-4o-mini",
//       temperature: 0,
//       messages: [{ role: "system", content: prompt }]
//     });

//     return JSON.parse(res.choices[0].message.content);
//   } catch {
//     return {};
//   }
// }

// /* =========================
//    CHAT LOGIC
// ========================= */

// async function reply(session, msg) {
//   const ai = await extractInfo(msg);

//   /* === GREETING === */
//   if (!session.started) {
//     session.started = true;
//     return "Hi! This is Pizza 64 🙂 How can I help you today?";
//   }

//   /* === MERGE AI INFO SAFELY === */
//   if (ai.orderType && !session.orderType) session.orderType = ai.orderType;
//   if (ai.pizza && !session.current.pizza) session.current.pizza = ai.pizza;
//   if (ai.size && !session.current.size) session.current.size = ai.size;
//   if (ai.spice && !session.current.spice) session.current.spice = ai.spice;
//   if (ai.name && !session.name) session.name = ai.name;
//   if (ai.phone && !session.phone) session.phone = ai.phone;

//   /* === ORDER TYPE === */
//   if (!session.orderType) {
//     return "Is this for pickup or delivery?";
//   }

//   /* === PIZZA FLOW === */
//   if (!session.doneWithPizzas) {
//     if (!session.current.pizza) {
//       return `What pizza would you like? We have ${MENU.join(", ")}.`;
//     }

//     if (!session.current.size) {
//       return "What size would you like? Small, Medium, or Large?";
//     }

//     if (!session.current.spice) {
//       return "How spicy would you like it? Mild, Medium, or Hot?";
//     }

//     if (session.current.cilantro === undefined) {
//       session.current.cilantro = "ASK";
//       return "Would you like to add cilantro? Yes or No?";
//     }

//     if (session.current.cilantro === "ASK") {
//       session.current.cilantro = /yes/i.test(msg) ? "Yes" : "No";
//     }

//     session.items.push({ ...session.current });
//     session.current = {};
//     session.doneWithPizzas = true;

//     return "Would you like to add another pizza or is that all?";
//   }

//   /* === ADD MORE? === */
//   if (!session.confirming && ai.done === false) {
//     session.doneWithPizzas = false;
//     return `Sure 🙂 What pizza would you like next?`;
//   }

//   /* === NAME === */
//   if (!session.name) {
//     return "May I have your name for the order?";
//   }

//   /* === PHONE === */
//   if (!session.phone) {
//     return "Can I get a contact phone number?";
//   }

//   /* === CONFIRM === */
//   if (!session.confirming) {
//     session.confirming = true;
//     return `Please confirm your order:
// ${session.items.map(
//       i => `${i.size} ${i.pizza} (${i.spice}) Cilantro: ${i.cilantro}`
//     ).join("\n")}
// ${session.orderType}
// Is that correct?`;
//   }

//   /* === FINAL CONFIRM === */
//   if (/yes|correct/i.test(msg)) {
//     const ticket = {
//       id: nextTicket(),
//       time: new Date().toLocaleTimeString(),
//       name: session.name,
//       phone: session.phone,
//       orderType: session.orderType,
//       items: session.items
//     };

//     tickets.unshift(ticket);
//     fs.writeFileSync(TICKETS_FILE, JSON.stringify(tickets, null, 2));
//     sessions.delete(session.id);

//     return `✅ Order confirmed! Ticket #${ticket.id}
// Your pizza will be ready in 20–25 minutes.
// Thank you for ordering Pizza 64 🍕`;
//   }

//   session.confirming = false;
//   return "No problem 🙂 What would you like to change?";
// }

// /* =========================
//    CHAT API
// ========================= */

// app.post("/chat", async (req, res) => {
//   const { sessionId, message } = req.body;

//   if (!sessions.has(sessionId)) {
//     sessions.set(sessionId, {
//       id: sessionId,
//       started: false,
//       items: [],
//       current: {},
//       orderType: null,
//       name: null,
//       phone: null,
//       confirming: false,
//       doneWithPizzas: false
//     });
//   }

//   const session = sessions.get(sessionId);
//   const replyText = await reply(session, message);
//   res.json({ reply: replyText });
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
//   console.log("🍕 Pizza 64 AI assistant running on port", PORT);
// });



// withpt ai version 



// import express from "express";
// import cors from "cors";
// import path from "path";
// import fs from "fs";
// import { fileURLToPath } from "url";


// const __filename = fileURLToPath(import.meta.url);
// const __dirname = path.dirname(__filename);
// const TICKETS_FILE = path.join(__dirname, "tickets.json");


// const app = express();
// app.use(cors());
// app.use(express.json());
// app.use(express.static(path.join(__dirname, "../public")));

// /* =========================
//    MENU
// ========================= */

// const MENU = [
//   "Cheese Lovers",
//   "Pepperoni",
//   "Veggie Supreme",
//   "Butter Chicken",
//   "Shahi Paneer",
//   "Tandoori Chicken"
// ];

// /* =========================
//    STORAGE
// ========================= */

// const sessions = new Map();
// let tickets = [];

// if (fs.existsSync(TICKETS_FILE)) {
//   try {
//     tickets = JSON.parse(fs.readFileSync(TICKETS_FILE, "utf8"));
//   } catch (err) {
//     tickets = [];
//   }
// }


// let day = new Date().toDateString();
// let counter = 1;

// function nextTicket() {
//   const today = new Date().toDateString();
//   if (today !== day) {
//     day = today;
//     counter = 1;
//   }
//   return `P64-${today.replace(/\s/g, "")}-${counter++}`;
// }

// /* =========================
//    HELPERS
// ========================= */

// function normalize(text = "") {
//   return text
//     .toLowerCase()
//     .replace(/[^a-z0-9\s]/g, "")
//     .replace(/\s+/g, " ")
//     .trim();
// }

// function findPizza(text) {
//   const t = normalize(text);

//   for (const p of MENU) {
//     if (t.includes(normalize(p))) {
//       return { name: p, sure: true };
//     }
//   }

//   const aliases = {
//     shai: "Shahi Paneer",
//     paneer: "Shahi Paneer",
//     paner: "Shahi Paneer",
//     tandori: "Tandoori Chicken",
//     veg: "Veggie Supreme"
//   };

//   for (const key in aliases) {
//     if (t.includes(key)) {
//       return { name: aliases[key], sure: false };
//     }
//   }

//   return null;
// }

// function isDone(text = "") {
//   return /^(no|nah|nope)$|no more|thats all|that’s all|done|finish|nothing else/i
//     .test(text.trim());
// }

// /* =========================
//    CHAT LOGIC
// ========================= */

// function reply(session, msg) {
//   const text = normalize(msg);

//   /* ===== GREETING ===== */
//   if (!session.started) {
//     session.started = true;
//     return "Hi! Welcome to Pizza 64 🙂 Pickup or delivery?";
//   }

//   /* ===== ORDER TYPE ===== */
//   if (!session.orderType) {
//     if (text.includes("pickup")) session.orderType = "Pickup";
//     if (text.includes("delivery")) session.orderType = "Delivery";
//     if (!session.orderType) return "Pickup or delivery?";
//   }

//   /* =====================================================
//      HANDLE “ANOTHER PIZZA?” ANSWER — MUST COME FIRST
//   ===================================================== */
//   if (session.awaitingMorePizza) {
//     if (isDone(msg)) {
//       session.awaitingMorePizza = false;
//       session.doneWithPizzas = true;
//     } else {
//       session.awaitingMorePizza = false;
//       session.current = {};
//       return `What pizza would you like? We have ${MENU.join(", ")}.`;
//     }
//   }

//   /* =====================================================
//      PIZZA FLOW (ONLY IF NOT DONE)
//   ===================================================== */
//   if (!session.doneWithPizzas) {

//     // Pizza
//     if (!session.current.pizza) {
//       const found = findPizza(msg);
//       if (!found) {
//         return `What pizza would you like? We have ${MENU.join(", ")}.`;
//       }
//       if (!found.sure) {
//         session.pendingPizza = found.name;
//         return `Did you mean ${found.name}?`;
//       }
//       session.current.pizza = found.name;
//     }

//     // Confirm fuzzy pizza
//     if (session.pendingPizza && !session.current.pizza) {
//       if (text.includes("yes")) {
//         session.current.pizza = session.pendingPizza;
//         session.pendingPizza = null;
//       } else {
//         session.pendingPizza = null;
//         return `Okay, please choose from ${MENU.join(", ")}.`;
//       }
//     }

//     // Size
//     if (!session.current.size) {
//       if (text.includes("small")) session.current.size = "Small";
//       if (text.includes("medium")) session.current.size = "Medium";
//       if (text.includes("large")) session.current.size = "Large";
//       if (!session.current.size)
//         return "What size would you like? Small, Medium, or Large?";
//     }

//     // Spice
//     if (!session.current.spice) {
//       if (text.includes("mild")) session.current.spice = "Mild";
//       if (text.includes("medium")) session.current.spice = "Medium";
//       if (text.includes("hot")) session.current.spice = "Hot";
//       if (!session.current.spice)
//         return "How spicy would you like it? Mild, Medium, or Hot?";
//     }

//     // Cilantro
//     if (session.current.cilantro === undefined) {
//       session.current.cilantro = "ASK";
//       return "Would you like to add cilantro? Yes or No?";
//     }

//     if (session.current.cilantro === "ASK") {
//       session.current.cilantro = text.includes("yes") ? "Yes" : "No";
//     }

//     // Save pizza
//     if (
//       session.current.pizza &&
//       session.current.size &&
//       session.current.spice &&
//       session.current.cilantro !== undefined &&
//       !session.awaitingMorePizza
//     ) {
//       session.items.push({ ...session.current });
//       session.current = {};
//       session.awaitingMorePizza = true;
//       return "Would you like to add another pizza or is that all?";
//     }
//   }

//   /* =====================================================
//      CUSTOMER DETAILS
//   ===================================================== */

//   // Name (FIXED: actually save name)
//   if (!session.name) {
//     session.name = msg.trim();
//     return "Can I get a contact phone number?";
//   }

//   // Phone
//   if (!session.phone) {
//     const match = msg.match(/\b\d{10}\b/);
//     if (!match) return "Can I get a contact phone number?";
//     session.phone = match[0];
//   }

//   // Confirmation
//   if (!session.confirming) {
//     session.confirming = true;
//     return `Please confirm your order:
// ${session.items.map(
//       i => `${i.size} ${i.pizza} (${i.spice}) Cilantro: ${i.cilantro}`
//     ).join("\n")}
// ${session.orderType}
// Is that correct?`;
//   }

//  if (text.includes("yes")) {
//   const ticket = {
//     id: nextTicket(),
//     time: new Date().toLocaleTimeString(),
//     name: session.name,
//     phone: session.phone,
//     orderType: session.orderType,
//     items: session.items
//   };

//   // ✅ ADD HERE
//   tickets.unshift(ticket);

//   fs.writeFileSync(
//     TICKETS_FILE,
//     JSON.stringify(tickets, null, 2)
//   );

//   sessions.delete(session.id);

//   return `✅ Order confirmed! Ticket #${ticket.id}
// Your pizza will be ready in 20–25 minutes.
// Thank you for ordering Pizza 64 🍕`;
// }


//   return "No problem — what would you like to change?";
// }

// /* =========================
//    CHAT API
// ========================= */

// app.post("/chat", (req, res) => {
//   const { sessionId, message } = req.body;

//   if (!sessions.has(sessionId)) {
//     sessions.set(sessionId, {
//       id: sessionId,
//       started: false,
//       items: [],
//       current: {},
//       orderType: null,
//       name: null,
//       phone: null,
//       confirming: false,
//       awaitingMorePizza: false,
//       doneWithPizzas: false
//     });
//   }

//   const session = sessions.get(sessionId);
//   res.json({ reply: reply(session, message) });
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

//version
// import express from "express";
// import cors from "cors";
// import path from "path";
// import { fileURLToPath } from "url";

// const __filename = fileURLToPath(import.meta.url);
// const __dirname = path.dirname(__filename);

// const app = express();
// app.use(cors());
// app.use(express.json());
// app.use(express.static(path.join(__dirname, "../public")));

// /* =========================
//    MENU
// ========================= */

// const MENU = [
//   "Cheese Lovers",
//   "Pepperoni",
//   "Veggie Supreme",
//   "Butter Chicken",
//   "Shahi Paneer",
//   "Tandoori Chicken"
// ];

// /* =========================
//    STORAGE
// ========================= */

// const sessions = new Map();
// let tickets = [];

// let day = new Date().toDateString();
// let counter = 1;

// function nextTicket() {
//   const today = new Date().toDateString();
//   if (today !== day) {
//     day = today;
//     counter = 1;
//   }
//   return `P64-${today.replace(/\s/g, "")}-${counter++}`;
// }

// /* =========================
//    HELPERS
// ========================= */

// function normalize(text = "") {
//   return text
//     .toLowerCase()
//     .replace(/[^a-z0-9\s]/g, "")
//     .replace(/\s+/g, " ")
//     .trim();
// }

// function findPizza(text) {
//   const t = normalize(text);

//   for (const p of MENU) {
//     if (t.includes(normalize(p))) {
//       return { name: p, sure: true };
//     }
//   }

//   const aliases = {
//     shai: "Shahi Paneer",
//     paneer: "Shahi Paneer",
//     paner: "Shahi Paneer",
//     tandori: "Tandoori Chicken",
//     veg: "Veggie Supreme"
//   };

//   for (const key in aliases) {
//     if (t.includes(key)) {
//       return { name: aliases[key], sure: false };
//     }
//   }

//   return null;
// }

// function isDone(text = "") {
//   return /^(no|nah|nope)$|no more|thats all|that’s all|done|finish|nothing else/i
//     .test(text.trim());
// }

// /* =========================
//    CHAT LOGIC
// ========================= */

// function reply(session, msg) {
//   const text = normalize(msg);

//   // Greeting
//   if (!session.started) {
//     session.started = true;
//     return "Hi! Welcome to Pizza 64 🙂 Pickup or delivery?";
//   }

//   // Pickup / Delivery
//   if (!session.orderType) {
//     if (text.includes("pickup")) session.orderType = "Pickup";
//     if (text.includes("delivery")) session.orderType = "Delivery";
//     if (!session.orderType) return "Pickup or delivery?";
//   }

//   /* =========================
//      PIZZA FLOW (ONLY IF NOT DONE)
//   ========================= */

//   if (!session.doneWithPizzas) {

//     // Pizza
//     if (!session.current.pizza) {
//       const found = findPizza(msg);
//       if (!found) {
//         return `What pizza would you like? We have ${MENU.join(", ")}.`;
//       }
//       if (!found.sure) {
//         session.pendingPizza = found.name;
//         return `Did you mean ${found.name}?`;
//       }
//       session.current.pizza = found.name;
//     }

//     // Confirm fuzzy pizza
//     if (session.pendingPizza && !session.current.pizza) {
//       if (text.includes("yes")) {
//         session.current.pizza = session.pendingPizza;
//         session.pendingPizza = null;
//       } else {
//         session.pendingPizza = null;
//         return `Okay, please choose from ${MENU.join(", ")}.`;
//       }
//     }

//     // Size
//     if (!session.current.size) {
//       if (text.includes("small")) session.current.size = "Small";
//       if (text.includes("medium")) session.current.size = "Medium";
//       if (text.includes("large")) session.current.size = "Large";
//       if (!session.current.size)
//         return "What size would you like? Small, Medium, or Large?";
//     }

//     // Spice
//     if (!session.current.spice) {
//       if (text.includes("mild")) session.current.spice = "Mild";
//       if (text.includes("medium")) session.current.spice = "Medium";
//       if (text.includes("hot")) session.current.spice = "Hot";
//       if (!session.current.spice)
//         return "How spicy would you like it? Mild, Medium, or Hot?";
//     }

//     // Cilantro
//     if (session.current.cilantro === undefined) {
//       session.current.cilantro = "ASK";
//       return "Would you like to add cilantro? Yes or No?";
//     }

//     if (session.current.cilantro === "ASK") {
//       session.current.cilantro = text.includes("yes") ? "Yes" : "No";
//     }

//     // Save pizza
//     if (
//       session.current.pizza &&
//       session.current.size &&
//       session.current.spice &&
//       session.current.cilantro !== undefined &&
//       !session.awaitingMorePizza
//     ) {
//       session.items.push({ ...session.current });
//       session.current = {};
//       session.awaitingMorePizza = true;
//       return "Would you like to add another pizza or is that all?";
//     }

//     // Handle more pizza
//     if (session.awaitingMorePizza) {
//       if (isDone(msg)) {
//         session.awaitingMorePizza = false;
//         session.doneWithPizzas = true;
//       } else {
//         session.awaitingMorePizza = false;
//         return `What pizza would you like? We have ${MENU.join(", ")}.`;
//       }
//     }
//   }

//   /* =========================
//      CUSTOMER DETAILS
//   ========================= */

//   if (!session.name) {
//     return "May I have your name for the order?";
//   }

//   if (!session.phone) {
//     const match = msg.match(/\b\d{10}\b/);
//     if (!match) return "Can I get a contact phone number?";
//     session.phone = match[0];
//   }

//   if (!session.confirming) {
//     session.confirming = true;
//     return `Please confirm your order:
// ${session.items.map(
//       i => `${i.size} ${i.pizza} (${i.spice}) Cilantro: ${i.cilantro}`
//     ).join("\n")}
// ${session.orderType}
// Is that correct?`;
//   }

//   if (text.includes("yes")) {
//     const ticket = {
//       id: nextTicket(),
//       time: new Date().toLocaleTimeString(),
//       name: session.name,
//       phone: session.phone,
//       orderType: session.orderType,
//       items: session.items
//     };

//     tickets.unshift(ticket);
//     sessions.delete(session.id);

//     return `✅ Order confirmed! Ticket #${ticket.id}
// Your pizza will be ready in 20–25 minutes.
// Thank you for ordering Pizza 64 🍕`;
//   }

//   return "No problem — what would you like to change?";
// }

// /* =========================
//    CHAT API
// ========================= */

// app.post("/chat", (req, res) => {
//   const { sessionId, message } = req.body;

//   if (!sessions.has(sessionId)) {
//     sessions.set(sessionId, {
//       id: sessionId,
//       started: false,
//       items: [],
//       current: {},
//       orderType: null,
//       name: null,
//       phone: null,
//       confirming: false,
//       awaitingMorePizza: false,
//       doneWithPizzas: false
//     });
//   }

//   const session = sessions.get(sessionId);
//   res.json({ reply: reply(session, message) });
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


// import express from "express";
// import cors from "cors";
// import path from "path";
// import { fileURLToPath } from "url";

// const __filename = fileURLToPath(import.meta.url);
// const __dirname = path.dirname(__filename);

// const app = express();
// app.use(cors());
// app.use(express.json());
// app.use(express.static(path.join(__dirname, "../public")));

// /* =========================
//    MENU
// ========================= */

// const MENU = [
//   "Cheese Lovers",
//   "Pepperoni",
//   "Veggie Supreme",
//   "Butter Chicken",
//   "Shahi Paneer",
//   "Tandoori Chicken"
// ];

// /* =========================
//    STORAGE
// ========================= */

// const sessions = new Map();
// let tickets = [];

// let day = new Date().toDateString();
// let counter = 1;

// function nextTicket() {
//   const today = new Date().toDateString();
//   if (today !== day) {
//     day = today;
//     counter = 1;
//   }
//   return `P64-${today.replace(/\s/g, "")}-${counter++}`;
// }

// /* =========================
//    HELPERS
// ========================= */

// function normalize(text = "") {
//   return text
//     .toLowerCase()
//     .replace(/[^a-z0-9\s]/g, "")
//     .replace(/\s+/g, " ")
//     .trim();
// }

// function findPizza(text) {
//   const t = normalize(text);

//   // Exact or partial match
//   for (const p of MENU) {
//     if (t.includes(normalize(p))) {
//       return { name: p, sure: true };
//     }
//   }

//   // Fuzzy typo handling
//   const aliases = {
//     "shai": "Shahi Paneer",
//     "paneer": "Shahi Paneer",
//     "paner": "Shahi Paneer",
//     "tandori": "Tandoori Chicken",
//     "tandoori": "Tandoori Chicken",
//     "veg": "Veggie Supreme"
//   };

//   for (const key in aliases) {
//     if (t.includes(key)) {
//       return { name: aliases[key], sure: false };
//     }
//   }

//   return null;
// }



// function isDone(text = "") {
//   return /^(no|nah|nope)$|no more|thats all|that’s all|done|finish|nothing else/i
//     .test(text.trim());
// }


// /* =========================
//    CHAT LOGIC
// ========================= */

// function reply(session, msg) {
//   const text = normalize(msg);

//   // Greeting
//   if (!session.started) {
//     session.started = true;
//     return "Hi! Welcome to Pizza 64 🙂 Pickup or delivery?";
//   }

//   // Order type
//   if (!session.orderType) {
//     if (text.includes("pickup")) session.orderType = "Pickup";
//     if (text.includes("delivery")) session.orderType = "Delivery";
//     if (!session.orderType) return "Pickup or delivery?";
//   }

//   // Pizza detection
//   if (!session.current.pizza) {
//     const found = findPizza(msg);
//     if (found) {
//       if (!found.sure) {
//         session.pendingPizza = found.name;
//         return `Did you mean ${found.name}?`;
//       }
//       session.current.pizza = found.name;
//     } else {
//       return `What pizza would you like? We have ${MENU.join(", ")}.`;
//     }
//   }

//   // Confirm fuzzy pizza
//   if (session.pendingPizza && !session.current.pizza) {
//     if (text.includes("yes")) {
//       session.current.pizza = session.pendingPizza;
//       session.pendingPizza = null;
//     } else {
//       session.pendingPizza = null;
//       return `Okay, please choose from ${MENU.join(", ")}.`;
//     }
//   }

//   // Size
//   if (!session.current.size) {
//     if (text.includes("small")) session.current.size = "Small";
//     if (text.includes("medium")) session.current.size = "Medium";
//     if (text.includes("large")) session.current.size = "Large";
//     if (!session.current.size) {
//       return "What size would you like? Small, Medium, or Large?";
//     }
//   }

//   // Spice
//   if (!session.current.spice) {
//     if (text.includes("mild")) session.current.spice = "Mild";
//     if (text.includes("medium")) session.current.spice = "Medium";
//     if (text.includes("hot")) session.current.spice = "Hot";
//     if (!session.current.spice) {
//       return "How spicy would you like it? Mild, Medium, or Hot?";
//     }
//   }

//   // Cilantro
//   if (session.current.cilantro === undefined) {
//     session.current.cilantro = "ASK";
//     return "Would you like to add cilantro? Yes or No?";
//   }

//   if (session.current.cilantro === "ASK") {
//     session.current.cilantro = text.includes("yes") ? "Yes" : "No";
//   }

// // =========================
// // SAVE PIZZA (ONLY ONCE)
// // =========================
// if (
//   session.current.pizza &&
//   session.current.size &&
//   session.current.spice &&
//   session.current.cilantro !== undefined &&
//   !session.awaitingMorePizza
// ) {
//   session.items.push({ ...session.current });

//   // reset current pizza
//   session.current = {};

//   // pause flow and ask about more pizzas
//   session.awaitingMorePizza = true;
//   return "Would you like to add another pizza or is that all?";
// }

// // =========================
// // HANDLE "ANOTHER PIZZA?" ANSWER
// // =========================
// if (session.awaitingMorePizza) {
//   if (isDone(msg)) {
//     // user said NO / THAT'S ALL
//     session.awaitingMorePizza = false;
//     // IMPORTANT: do NOT return → flow continues to name
//   } else {
//     // user wants another pizza
//     session.awaitingMorePizza = false;
//     session.current = {};
//     return "What pizza would you like? We have Cheese Lovers, Pepperoni, Veggie Supreme, Butter Chicken, Shahi Paneer, Tandoori Chicken.";
//   }
// }


  

//   // Name
//   if (!session.name) {
//     return "May I have your name for the order?";
//   }

//   // Phone
//   if (!session.phone) {
//     if (/\b\d{10}\b/.test(text)) {
//       session.phone = text.match(/\b\d{10}\b/)[0];
//     } else {
//       return "Can I get a contact phone number?";
//     }
//   }

//   // Confirmation
//   if (!session.confirming) {
//     session.confirming = true;
//     return `Please confirm your order:
// ${session.items.map(i => `${i.size} ${i.pizza} (${i.spice}) Cilantro: ${i.cilantro}`).join("\n")}
// ${session.orderType}
// Is that correct?`;
//   }

//   if (text.includes("yes")) {
//     const ticket = {
//       id: nextTicket(),
//       time: new Date().toLocaleTimeString(),
//       name: session.name,
//       phone: session.phone,
//       orderType: session.orderType,
//       items: session.items
//     };

//     tickets.unshift(ticket);
//     sessions.delete(session.id);

//     return `✅ Order confirmed! Ticket #${ticket.id}
// Your pizza will be ready in 20–25 minutes.
// Thank you for ordering Pizza 64 🍕`;
//   }

//   return "No problem — what would you like to change?";
// }

// /* =========================
//    CHAT API
// ========================= */

// app.post("/chat", (req, res) => {
//   const { sessionId, message } = req.body;

//   if (!sessions.has(sessionId)) {
//     sessions.set(sessionId, {
//       id: sessionId,
//       started: false,
//       items: [],
//       current: {},
//       orderType: null,
//       name: null,
//       phone: null,
//       confirming: false
//     });
//   }

//   const session = sessions.get(sessionId);
//   const replyText = reply(session, message);
//   res.json({ reply: replyText });
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


// import "dotenv/config";
// import express from "express";
// import cors from "cors";
// import path from "path";
// import { fileURLToPath } from "url";

// const __filename = fileURLToPath(import.meta.url);
// const __dirname = path.dirname(__filename);

// const app = express();
// app.use(cors());
// app.use(express.json());
// app.use(express.static(path.join(__dirname, "../public")));

// /* =========================
//    MENU
// ========================= */

// const MENU = [
//   "Cheese Lovers",
//   "Pepperoni",
//   "Veggie Supreme",
//   "Butter Chicken",
//   "Shahi Paneer",
//   "Tandoori Chicken"
// ];

// /* =========================
//    TICKETS
// ========================= */

// let tickets = [];
// let day = new Date().toDateString();
// let count = 1;

// function generateTicket() {
//   const today = new Date().toDateString();
//   if (today !== day) {
//     day = today;
//     count = 1;
//   }
//   return `P64-${today.replace(/\s/g, "")}-${count++}`;
// }

// /* =========================
//    SESSIONS
// ========================= */

// const sessions = new Map();

// function newSession(id) {
//   return {
//     id,
//     step: "ORDER_TYPE",
//     items: [],
//     current: {},
//     name: null,
//     phone: null,
//     orderType: null,
//     pendingPizza: null,
//     confirming: false
//   };
// }

// /* =========================
//    HELPERS
// ========================= */

// function normalize(text = "") {
//   return text
//     .toLowerCase()
//     .replace(/[^a-z0-9\s]/g, "")
//     .replace(/\s+/g, " ")
//     .trim();
// }

// function isDone(text) {
//   const t = normalize(text);
//   return (
//     t === "no" ||
//     t === "thats all" ||
//     t === "that is all" ||
//     t === "done" ||
//     t === "no other pizza" ||
//     t === "nothing else"
//   );
// }

// function fuzzyPizza(text) {
//   const clean = normalize(text);

//   for (const pizza of MENU) {
//     if (clean.includes(normalize(pizza))) {
//       return { match: pizza, sure: true };
//     }
//   }

//   let best = null;
//   let score = 0;

//   for (const pizza of MENU) {
//     let s = 0;
//     for (const w of normalize(pizza).split(" ")) {
//       if (clean.includes(w)) s++;
//     }
//     if (s > score) {
//       score = s;
//       best = pizza;
//     }
//   }

//   if (best && score >= 1) {
//     return { match: best, sure: false };
//   }

//   return null;
// }

// /* =========================
//    CHAT ENGINE
// ========================= */

// function reply(session, message) {
//   const text = normalize(message);

//   /* GREETING */
//   if (session.step === "ORDER_TYPE") {
//     if (text.includes("pickup")) {
//       session.orderType = "Pickup";
//       session.step = "PIZZA";
//       return "Great 👍 What pizza would you like?";
//     }
//     if (text.includes("delivery")) {
//       session.orderType = "Delivery";
//       session.step = "PIZZA";
//       return "Sure 👍 What pizza would you like?";
//     }
//     return "Hi! Welcome to Pizza 64 🙂 Pickup or delivery?";
//   }

//   /* PIZZA */
//   if (session.step === "PIZZA") {
//     const found = fuzzyPizza(message);

//     if (!found) {
//       return `What pizza would you like? We have ${MENU.join(", ")}.`;
//     }

//     if (!found.sure) {
//       session.pendingPizza = found.match;
//       return `Did you mean ${found.match}?`;
//     }

//     session.current.pizza = found.match;
//     session.step = "SIZE";
//     return "What size would you like? Small, Medium, or Large?";
//   }

//   /* CONFIRM TYPO */
//   if (session.pendingPizza) {
//     if (text.includes("yes")) {
//       session.current.pizza = session.pendingPizza;
//       session.pendingPizza = null;
//       session.step = "SIZE";
//       return "Got it 👍 What size would you like?";
//     }
//     session.pendingPizza = null;
//     return `Okay, please choose from ${MENU.join(", ")}.`;
//   }

//   /* SIZE */
//   if (session.step === "SIZE") {
//     if (text.includes("small")) session.current.size = "Small";
//     else if (text.includes("medium")) session.current.size = "Medium";
//     else if (text.includes("large")) session.current.size = "Large";
//     else return "Please choose Small, Medium, or Large.";

//     session.step = "SPICE";
//     return "How spicy would you like it? Mild, Medium, or Hot?";
//   }

//   /* SPICE */
//   if (session.step === "SPICE") {
//     if (text.includes("mild")) session.current.spice = "Mild";
//     else if (text.includes("medium")) session.current.spice = "Medium";
//     else if (text.includes("hot")) session.current.spice = "Hot";
//     else return "Mild, Medium, or Hot?";

//     session.step = "CILANTRO";
//     return "Would you like to add cilantro? Yes or No?";
//   }

//   /* CILANTRO */
//   if (session.step === "CILANTRO") {
//     session.current.cilantro = text.includes("yes") ? "Yes" : "No";

//     session.items.push({ ...session.current, qty: 1 });
//     session.current = {};
//     session.step = "MORE";

//     return "Would you like to add another pizza or is that all?";
//   }

//   /* MORE */
//   if (session.step === "MORE") {
//     if (isDone(message)) {
//       session.step = "NAME";
//       return "May I have your name for the order?";
//     }
//     session.step = "PIZZA";
//     return "Sure! What pizza would you like next?";
//   }

//   /* NAME */
//   if (session.step === "NAME") {
//     session.name = message.trim();
//     session.step = "PHONE";
//     return "Can I get a contact phone number?";
//   }

//   /* PHONE */
//   if (session.step === "PHONE") {
//     const m = message.match(/\d{10}/);
//     if (!m) return "Please enter a 10-digit phone number.";
//     session.phone = m[0];
//     session.step = "CONFIRM";
//   }

//   /* CONFIRM */
//   if (session.step === "CONFIRM") {
//     if (!session.confirming) {
//       session.confirming = true;
//       return `Please confirm your order:
// ${session.items.map(i =>
//         `• ${i.size} ${i.pizza} (${i.spice}) Cilantro: ${i.cilantro}`
//       ).join("\n")}
// ${session.orderType}
// Is that correct?`;
//     }

//     if (text.includes("yes")) {
//       const ticket = {
//         id: generateTicket(),
//         time: new Date().toLocaleTimeString(),
//         ...session
//       };
//       tickets.unshift(ticket);
//       sessions.delete(session.id);

//       return `✅ Order confirmed! Ticket #${ticket.id}
// Your pizza will be ready in 20–25 minutes.
// Thank you for ordering Pizza 64 🍕`;
//     }

//     session.confirming = false;
//     session.step = "PIZZA";
//     return "No problem — what would you like to change?";
//   }
// }

// /* =========================
//    CHAT API
// ========================= */

// app.post("/chat", (req, res) => {
//   const { sessionId, message } = req.body;

//   if (!sessions.has(sessionId)) {
//     sessions.set(sessionId, newSession(sessionId));
//   }

//   const session = sessions.get(sessionId);
//   res.json({ reply: reply(session, message) });
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
//   console.log("🍕 Pizza 64 running on", PORT);
// });

//version 

// import "dotenv/config";
// import express from "express";
// import cors from "cors";
// import twilio from "twilio";
// import path from "path";
// import fs from "fs";
// import { fileURLToPath } from "url";

// const __filename = fileURLToPath(import.meta.url);
// const __dirname = path.dirname(__filename);

// const app = express();
// app.use(cors());
// app.use(express.urlencoded({ extended: false }));
// app.use(express.json());
// app.use(express.static(path.join(__dirname, "../public")));

// /* =========================
//    MENU
// ========================= */

// const MENU = [
//   "Cheese Lovers",
//   "Pepperoni",
//   "Veggie Supreme",
//   "Butter Chicken",
//   "Shahi Paneer",
//   "Tandoori Chicken"
// ];

// /* =========================
//    TICKETS (FILE BASED)
// ========================= */

// const TICKET_FILE = path.join(__dirname, "tickets.json");

// function loadTickets() {
//   if (!fs.existsSync(TICKET_FILE)) return [];
//   return JSON.parse(fs.readFileSync(TICKET_FILE, "utf8"));
// }

// function saveTickets(tickets) {
//   fs.writeFileSync(TICKET_FILE, JSON.stringify(tickets, null, 2));
// }

// function createTicket(order) {
//   const tickets = loadTickets();
//   const today = new Date().toISOString().slice(0, 10);
//   const ticketNo = `P64-${today}-${tickets.length + 1}`;

//   const ticket = {
//     ticketNo,
//     time: new Date().toLocaleTimeString(),
//     order
//   };

//   tickets.unshift(ticket);
//   saveTickets(tickets);
//   return ticket;
// }

// /* =========================
//    SESSION MEMORY
// ========================= */

// const sessions = new Map();

// function newSession() {
//   return {
//     order: {
//       pizza: null,
//       size: null,
//       spice: null,
//       cilantro: null,
//       orderType: null,
//       name: null,
//       phone: null
//     },
//     confirmed: false
//   };
// }

// function getSession(id) {
//   if (!sessions.has(id)) sessions.set(id, newSession());
//   return sessions.get(id);
// }

// /* =========================
//    HELPERS
// ========================= */

// function normalize(text) {
//   return text.toLowerCase().replace(/[^a-z\s]/g, "");
// }

// function matchPizza(text) {
//   const t = normalize(text);
//   return MENU.find(p =>
//     t.includes(normalize(p).split(" ")[0])
//   );
// }

// /* =========================
//    CHAT LOGIC
// ========================= */

// app.post("/chat", (req, res) => {
//   const { sessionId, message } = req.body;
//   const session = getSession(sessionId);
//   const msg = normalize(message);

//   // 1️⃣ pickup / delivery
//   if (!session.order.orderType) {
//     if (msg.includes("pickup")) session.order.orderType = "Pickup";
//     if (msg.includes("delivery")) session.order.orderType = "Delivery";
//     if (!session.order.orderType)
//       return res.json({ reply: "Pickup or delivery?" });
//   }

//   // 2️⃣ pizza
//   if (!session.order.pizza) {
//     const pizza = matchPizza(msg);
//     if (pizza) {
//       session.order.pizza = pizza;
//     } else {
//       return res.json({
//         reply: `What pizza would you like? We have ${MENU.join(", ")}.`
//       });
//     }
//   }

//   // 3️⃣ size
//   if (!session.order.size) {
//     if (msg.includes("small")) session.order.size = "Small";
//     if (msg.includes("medium")) session.order.size = "Medium";
//     if (msg.includes("large")) session.order.size = "Large";
//     if (!session.order.size)
//       return res.json({ reply: "What size would you like? Small, Medium, or Large?" });
//   }

//   // 4️⃣ spice
//   if (!session.order.spice) {
//     if (msg.includes("mild")) session.order.spice = "Mild";
//     if (msg.includes("medium")) session.order.spice = "Medium";
//     if (msg.includes("hot")) session.order.spice = "Hot";
//     if (!session.order.spice)
//       return res.json({ reply: "How spicy would you like it? Mild, Medium, or Hot?" });
//   }

//   // 5️⃣ cilantro
//   if (session.order.cilantro === null) {
//     if (msg.includes("no")) session.order.cilantro = "No";
//     if (msg.includes("yes")) session.order.cilantro = "Yes";
//     if (session.order.cilantro === null)
//       return res.json({ reply: "Would you like to add cilantro? Yes or No?" });
//   }

//   // 6️⃣ name
//   if (!session.order.name) {
//     if (msg.length > 2) {
//       session.order.name = message.trim();
//     } else {
//       return res.json({ reply: "May I have your name for the order?" });
//     }
//   }

//   // 7️⃣ phone
//   if (!session.order.phone) {
//     if (/\d{7,}/.test(msg)) {
//       session.order.phone = message.trim();
//     } else {
//       return res.json({ reply: "Can I get a contact phone number?" });
//     }
//   }

//   // 8️⃣ confirmation
//   if (!session.confirmed) {
//     session.confirmed = true;
//     const ticket = createTicket(session.order);
//     sessions.delete(sessionId);

//     return res.json({
//       reply: `✅ Order confirmed! Ticket #${ticket.ticketNo}. Your pizza will be ready in 20–25 minutes. Thank you for ordering Pizza 64 🍕`
//     });
//   }
// });

// /* =========================
//    TICKETS API
// ========================= */

// app.get("/api/tickets", (req, res) => {
//   res.json(loadTickets());
// });

// /* =========================
//    SERVER
// ========================= */

// const PORT = process.env.PORT || 10000;
// app.listen(PORT, () => {
//   console.log("🍕 Pizza 64 running on port", PORT);
// });


// import "dotenv/config";
// import express from "express";
// import cors from "cors";
// import path from "path";
// import { fileURLToPath } from "url";

// const __filename = fileURLToPath(import.meta.url);
// const __dirname = path.dirname(__filename);

// /* =========================
//    APP SETUP
// ========================= */

// const app = express();
// app.use(cors());
// app.use(express.json());
// app.use(express.static(path.join(__dirname, "../public")));

// /* =========================
//    MENU
// ========================= */

// const MENU = [
//   "Cheese Lovers",
//   "Pepperoni",
//   "Veggie Supreme",
//   "Butter Chicken",
//   "Shahi Paneer",
//   "Tandoori Chicken"
// ];

// /* =========================
//    UTIL: FUZZY MATCH
// ========================= */

// function normalize(text = "") {
//   return text.toLowerCase().replace(/[^a-z]/g, "");
// }

// function findPizza(input) {
//   const cleaned = normalize(input);
//   return MENU.find(p => cleaned.includes(normalize(p)));
// }

// /* =========================
//    SESSIONS
// ========================= */

// const sessions = new Map();

// function newSession() {
//   return {
//     step: "type", // type → pizza → size → spice → cilantro → name → phone → confirm
//     order: {
//       pizza: null,
//       size: null,
//       spice: null,
//       cilantro: null,
//       orderType: null,
//       name: null,
//       phone: null
//     }
//   };
// }

// /* =========================
//    TICKETS
// ========================= */

// let tickets = [];
// let today = new Date().toDateString();
// let counter = 1;

// function nextTicket() {
//   const now = new Date();
//   if (now.toDateString() !== today) {
//     today = now.toDateString();
//     counter = 1;
//   }
//   return `P64-${now.getFullYear()}-${now.getMonth()+1}-${now.getDate()}-${counter++}`;
// }

// /* =========================
//    CHAT ENDPOINT
// ========================= */

// app.post("/chat", (req, res) => {
//   const { sessionId, message } = req.body;
//   const text = message.toLowerCase();

//   if (!sessions.has(sessionId)) {
//     sessions.set(sessionId, newSession());
//     return res.json({
//       reply: "Hi! Welcome to Pizza 64 🙂 Pickup or delivery?"
//     });
//   }

//   const session = sessions.get(sessionId);
//   const o = session.order;

//   /* ===== STEP: PICKUP / DELIVERY ===== */
//   if (session.step === "type") {
//     if (text.includes("pickup")) {
//       o.orderType = "Pickup";
//       session.step = "pizza";
//       return res.json({
//         reply: "What pizza would you like? We have Cheese Lovers, Pepperoni, Veggie Supreme, Butter Chicken, Shahi Paneer, Tandoori Chicken."
//       });
//     }
//     if (text.includes("delivery")) {
//       o.orderType = "Delivery";
//       session.step = "pizza";
//       return res.json({
//         reply: "What pizza would you like? We have Cheese Lovers, Pepperoni, Veggie Supreme, Butter Chicken, Shahi Paneer, Tandoori Chicken."
//       });
//     }
//     return res.json({ reply: "Is this for pickup or delivery?" });
//   }

//   /* ===== STEP: PIZZA ===== */
//   if (session.step === "pizza") {
//     const pizza = findPizza(text);
//     if (!pizza) {
//       return res.json({
//         reply: "Sorry, I didn’t catch that. Please choose from our menu."
//       });
//     }
//     o.pizza = pizza;
//     session.step = "size";
//     return res.json({ reply: "What size would you like? Small, Medium, or Large?" });
//   }

//   /* ===== STEP: SIZE ===== */
//   if (session.step === "size") {
//     if (/small|medium|large/.test(text)) {
//       o.size = text.match(/small|medium|large/)[0];
//       session.step = "spice";
//       return res.json({
//         reply: "How spicy would you like it? Mild, Medium, or Hot?"
//       });
//     }
//     return res.json({ reply: "Please choose Small, Medium, or Large." });
//   }

//   /* ===== STEP: SPICE ===== */
//   if (session.step === "spice") {
//     if (/mild|medium|hot/.test(text)) {
//       o.spice = text.match(/mild|medium|hot/)[0];
//       session.step = "cilantro";
//       return res.json({
//         reply: "Would you like to add cilantro? Yes or No?"
//       });
//     }
//     return res.json({ reply: "Mild, Medium, or Hot?" });
//   }

//   /* ===== STEP: CILANTRO ===== */
//   if (session.step === "cilantro") {
//     if (text.includes("yes")) o.cilantro = "Yes";
//     else if (text.includes("no")) o.cilantro = "No";
//     else return res.json({ reply: "Please say Yes or No." });

//     session.step = "name";
//     return res.json({ reply: "May I have your name for the order?" });
//   }

//   /* ===== STEP: NAME ===== */
//   if (session.step === "name") {
//     o.name = message.trim();
//     session.step = "phone";
//     return res.json({ reply: "Can I get a contact phone number?" });
//   }

//   /* ===== STEP: PHONE ===== */
//   if (session.step === "phone") {
//     o.phone = message.trim();
//     session.step = "confirm";
//     return res.json({
//       reply: `Please confirm your order:
// ${o.size} ${o.pizza}
// Spice: ${o.spice}
// Cilantro: ${o.cilantro}
// ${o.orderType}
// Is that correct?`
//     });
//   }

//   /* ===== STEP: CONFIRM ===== */
//   if (session.step === "confirm") {
//     if (!text.includes("yes")) {
//       sessions.delete(sessionId);
//       return res.json({ reply: "No problem, let's start again. Pickup or delivery?" });
//     }

//     const ticketNo = nextTicket();
//     tickets.unshift({
//       ticketNo,
//       time: new Date().toLocaleTimeString(),
//       order: o
//     });

//     sessions.delete(sessionId);

//     return res.json({
//       reply: `✅ Order confirmed! Ticket #${ticketNo}
// Your pizza will be ready in 20–25 minutes.
// Thank you for ordering Pizza 64 🍕`
//     });
//   }
// });

// /* =========================
//    CONFIRMED ORDERS API
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
//version
// import "dotenv/config";
// import express from "express";
// import cors from "cors";
// import twilio from "twilio";
// import path from "path";
// import { fileURLToPath } from "url";

// const __filename = fileURLToPath(import.meta.url);
// const __dirname = path.dirname(__filename);

// /* =========================
//    APP SETUP
// ========================= */

// const app = express();
// app.use(cors());
// app.use(express.urlencoded({ extended: false }));
// app.use(express.json());
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
//   // ======================
//   // SPECIALTY PIZZAS
//   // ======================
//   {
//     name: "Cheese Lovers",
//     category: "Specialty",
//     toppings: ["Mozzarella Cheese", "Pizza Sauce"],
//     prices: { Small: 9.99, Medium: 11.99, Large: 14.99 },
//     spicy: false
//   },
//   {
//     name: "Pepperoni",
//     category: "Specialty",
//     toppings: ["Pepperoni", "Mozzarella Cheese", "Pizza Sauce"],
//     prices: { Small: 10.99, Medium: 12.99, Large: 15.99 },
//     spicy: false
//   },
//   {
//     name: "Hawaiian",
//     category: "Specialty",
//     toppings: ["Ham", "Pineapple", "Mozzarella Cheese", "Pizza Sauce"],
//     prices: { Small: 10.99, Medium: 12.99, Large: 15.99 },
//     spicy: false
//   },
//   {
//     name: "Canadian",
//     category: "Specialty",
//     toppings: ["Pepperoni", "Bacon", "Mushrooms", "Mozzarella Cheese", "Pizza Sauce"],
//     prices: { Small: 11.99, Medium: 13.99, Large: 16.99 },
//     spicy: false
//   },

//   // ======================
//   // SIGNATURE PIZZAS
//   // ======================
//   {
//     name: "Meat Lovers",
//     category: "Signature",
//     toppings: ["Pepperoni", "Ham", "Beef", "Italian Sausage", "Mozzarella Cheese"],
//     prices: { Small: 12.99, Medium: 14.99, Large: 17.99 },
//     spicy: false
//   },
//   {
//     name: "BBQ Chicken",
//     category: "Signature",
//     toppings: ["Chicken", "Onions", "Green Peppers", "BBQ Sauce", "Mozzarella Cheese"],
//     prices: { Small: 12.99, Medium: 14.99, Large: 17.99 },
//     spicy: false
//   },
//   {
//     name: "Tandoori Chicken",
//     category: "Signature",
//     toppings: ["Tandoori Chicken", "Onions", "Green Peppers", "Mozzarella Cheese"],
//     prices: { Small: 12.99, Medium: 14.99, Large: 17.99 },
//     spicy: true
//   },

//   // ======================
//   // GOURMET PIZZAS
//   // ======================
//   {
//     name: "Butter Chicken",
//     category: "Gourmet",
//     toppings: ["Butter Chicken", "Onions", "Green Peppers", "Jalapenos", "Mozzarella Cheese"],
//     prices: { Small: 13.49, Medium: 15.49, Large: 18.49 },
//     spicy: true
//   },
//   {
//     name: "Shahi Paneer",
//     category: "Gourmet",
//     toppings: ["Tandoori Paneer", "Onions", "Spinach", "Mushrooms", "Mozzarella Cheese"],
//     prices: { Small: 13.49, Medium: 15.49, Large: 18.49 },
//     spicy: true
//   },
//   {
//     name: "Passion of India",
//     category: "Gourmet",
//     toppings: ["Paneer", "Spinach", "Mushrooms", "Green Peppers", "Mozzarella Cheese"],
//     prices: { Small: 13.99, Medium: 15.99, Large: 18.99 },
//     spicy: true
//   }
// ];


// /* =========================
//    SYSTEM PROMPT
// ========================= */

// const SYSTEM_PROMPT = `
// You work at Pizza 64.
// Speak like a real pizza shop employee.
// Ask one question at a time.
// Only use items from MENU.
// Never invent food.
// Confirm order before finishing.
// `;

// /* =========================
//    SESSION MEMORY
// ========================= */

// const sessions = new Map();

// function newSession(phone) {
//   return {
//     messages: [],
//     order: {
//       items: [],
//       orderType: null,
//       address: null,
//       phone
//     },
//     readyToExtract: false,
//     awaitingConfirmation: false,
//     awaitingAddress: false
//   };
// }

// function getSession(id, phone) {
//   if (!sessions.has(id)) {
//     sessions.set(id, newSession(phone));
//   }
//   return sessions.get(id);
// }

// /* =========================
//    TICKET SYSTEM
// ========================= */

// let tickets = [];
// let ticketDate = new Date().toDateString();
// let ticketCounter = 1;

// function generateTicketNumber() {
//   const today = new Date().toDateString();
//   if (today !== ticketDate) {
//     ticketDate = today;
//     ticketCounter = 1;
//   }
//   return `${today.replace(/\s/g, "")}-${ticketCounter++}`;
// }

// function createTicket(order, source) {
//   const ticket = {
//     ticketNo: generateTicketNumber(),
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
//    CHAT REPLY
// ========================= */

// async function chatReply(session, message) {
//   const client = await getOpenAI();
//   if (!client) return "Sorry, system issue.";

//   session.messages.push({ role: "user", content: message });

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
//    INTENT
// ========================= */

// function detectIntent(session, text) {
//   const t = text.toLowerCase();
//   if (/delivery/.test(t)) {
//     session.order.orderType = "delivery";
//     session.awaitingAddress = true;
//   }
//   if (/pickup/.test(t)) session.order.orderType = "pickup";
//   if (/that's all|done|nothing else/.test(t)) session.readyToExtract = true;
// }

// /* =========================
//    ORDER EXTRACTION
// ========================= */

// async function extractOrder(session) {
//   const client = await getOpenAI();
//   if (!client) return null;

//   const res = await client.chat.completions.create({
//     model: "gpt-4o-mini",
//     temperature: 0,
//     messages: [
//       {
//         role: "system",
//         content: `Return STRICT JSON:
// { "items":[{"name":"","quantity":1,"size":"Medium","price":0}] }`
//       },
//       ...session.messages.slice(-12)
//     ]
//   });

//   try {
//     return JSON.parse(res.choices[0].message.content);
//   } catch {
//     return null;
//   }
// }

// /* =========================
//    RECEIPTS
// ========================= */

// function buildReceipt(order) {
//   return order.items
//     .map(i => `${i.quantity} x ${i.size} ${i.name}`)
//     .join("\n");
// }

// function buildKitchenTicket(order) {
//   return `
// 🍕 PIZZA 64 KITCHEN
// ------------------
// ${order.items.map(i => `${i.quantity} x ${i.size} ${i.name}`).join("\n")}
// TYPE: ${order.orderType}
// `;
// }

// /* =========================
//    TWILIO VOICE
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

//   detectIntent(session, speech);

//   if (session.awaitingConfirmation) {
//     if (/yes|correct/.test(speech.toLowerCase())) {
//       const ticket = createTicket(session.order, "CALL");
//       twiml.say(`Order confirmed. Ticket number ${ticket.ticketNo}.`);
//       sessions.delete(callSid);
//       return res.type("text/xml").send(twiml.toString());
//     }
//     session.awaitingConfirmation = false;
//   }

//   if (session.readyToExtract) {
//     const extracted = await extractOrder(session);
//     if (extracted?.items?.length) {
//       session.order.items = extracted.items;
//       session.awaitingConfirmation = true;
//       twiml.say(`Confirming your order. Is that correct?`);
//       twiml.gather({ input: "speech", action: "/twilio/step", method: "POST" });
//       return res.type("text/xml").send(twiml.toString());
//     }
//   }

//   const reply = await chatReply(session, speech);
//   twiml.say(reply);
//   twiml.gather({ input: "speech", action: "/twilio/step", method: "POST" });
//   res.type("text/xml").send(twiml.toString());
// });

// /* =========================
//    CHAT API
// ========================= */

// app.post("/chat", async (req, res) => {
//   const { sessionId, message } = req.body;
//   const session = getSession(sessionId, "+1000000000");

//   detectIntent(session, message);

//   if (session.awaitingConfirmation) {
//     if (/yes|correct/.test(message.toLowerCase())) {
//       const ticket = createTicket(session.order, "CHAT");
//       sessions.delete(sessionId);
//       return res.json({
//         reply: `Order confirmed! Ticket #${ticket.ticketNo}`
//       });
//     }
//     session.awaitingConfirmation = false;
//   }

//   if (session.readyToExtract) {
//     const extracted = await extractOrder(session);
//     if (extracted?.items?.length) {
//       session.order.items = extracted.items;
//       session.awaitingConfirmation = true;
//       return res.json({ reply: "Please confirm your order." });
//     }
//   }

//   const reply = await chatReply(session, message);
//   res.json({ reply });
// });

// /* =========================
//    TICKETS API (HTML VIEW)
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

