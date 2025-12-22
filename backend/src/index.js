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

/* =========================
   SESSIONS
========================= */

const sessions = new Map();

/* =========================
   TICKETS
========================= */

let tickets = [];
let day = new Date().toDateString();
let count = 1;

function generateTicket() {
  const today = new Date().toDateString();
  if (today !== day) {
    day = today;
    count = 1;
  }
  return `P64-${today.replace(/\s/g, "")}-${count++}`;
}


//normalize 

function normalize(text = "") {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, "") // remove punctuation
    .replace(/\s+/g, " ")        // collapse spaces
    .trim();
}


/* =========================
   UTILS
========================= */
function fuzzyPizza(text) {
  const clean = normalize(text);

  // 1. Exact match (strongest)
  for (const pizza of MENU) {
    if (clean.includes(normalize(pizza))) {
      return { match: pizza, sure: true };
    }
  }

  // 2. Word similarity score
  let best = null;
  let bestScore = 0;

  for (const pizza of MENU) {
    const words = normalize(pizza).split(" ");
    let score = 0;

    for (const w of words) {
      if (clean.includes(w)) score++;
    }

    if (score > bestScore) {
      bestScore = score;
      best = pizza;
    }
  }

  // 3. Only suggest if confidence is reasonable
  if (best && bestScore >= 2) {
    return { match: best, sure: false };
  }

  return null;
}


function extractAll(text, session) {
  const t = normalize(text);

  // quantity
  const q = t.match(/\b(\d+)\b/);
  if (q && !session.current.qty) session.current.qty = parseInt(q[1]);

  // size
  if (!session.current.size) {
    if (t.includes("small")) session.current.size = "Small";
    if (t.includes("medium")) session.current.size = "Medium";
    if (t.includes("large")) session.current.size = "Large";
  }

  // spice
  if (!session.current.spice) {
    if (t.includes("mild")) session.current.spice = "Mild";
    if (t.includes("medium")) session.current.spice = "Medium";
    if (t.includes("hot")) session.current.spice = "Hot";
  }

  // pickup / delivery
  if (!session.orderType) {
    if (t.includes("pickup")) session.orderType = "Pickup";
    if (t.includes("delivery")) session.orderType = "Delivery";
  }

  // phone
  const phone = t.match(/\b\d{10}\b/);
  if (phone && !session.phone) session.phone = phone[0];

  // name (single word assumption)
  if (!session.name && /^[a-z]{3,}$/.test(t)) {
    session.name = text.trim();
  }

  // pizza
  if (!session.current.pizza) {
    const found = fuzzyPizza(text);
    if (found) {
      if (found.sure) {
        session.current.pizza = found.match;
      } else {
        session.pendingPizza = found.match;
      }
    }
  }
}

/* =========================
   CHAT ENGINE
========================= */

function reply(session, message) {
  extractAll(message, session);

  // typo confirmation
  if (session.pendingPizza && !session.current.pizza) {
    if (normalize(message).includes("yes")) {
      session.current.pizza = session.pendingPizza;
      session.pendingPizza = null;
      return "Got it 👍 What size would you like?";
    }
    return `Did you mean ${session.pendingPizza}?`;
  }

  if (!session.orderType) {
    return "Hi! Welcome to Pizza 64 🙂 Pickup or delivery?";
  }

  if (!session.current.pizza) {
    return `What pizza would you like? We have ${MENU.join(", ")}.`;
  }

  if (!session.current.size) {
    return "What size would you like? Small, Medium, or Large?";
  }

  if (!session.current.spice) {
    return "How spicy would you like it? Mild, Medium, or Hot?";
  }

  if (!session.current.cilantro) {
    session.current.cilantro = "ASK";
    return "Would you like to add cilantro? Yes or No?";
  }

  if (session.current.cilantro === "ASK") {
    session.current.cilantro =
      normalize(message).includes("yes") ? "Yes" : "No";
  }

  // finalize pizza
  if (!session.current.done) {
    session.items.push({
      qty: session.current.qty || 1,
      pizza: session.current.pizza,
      size: session.current.size,
      spice: session.current.spice,
      cilantro: session.current.cilantro
    });

    session.current = {};
    return "Would you like to add another pizza or is that all?";
  }

  if (!session.name) return "May I have your name for the order?";
  if (!session.phone) return "Can I get a contact phone number?";

  if (!session.confirming) {
    session.confirming = true;
    return `Please confirm your order:
${session.items.map(i =>
      `${i.qty} ${i.size} ${i.pizza} (${i.spice}) Cilantro: ${i.cilantro}`
    ).join("\n")}
${session.orderType}
Is that correct?`;
  }

  if (normalize(message).includes("yes")) {
    const ticket = {
      id: generateTicket(),
      time: new Date().toLocaleTimeString(),
      name: session.name,
      phone: session.phone,
      orderType: session.orderType,
      items: session.items
    };

    tickets.unshift(ticket);
    sessions.delete(session.id);

    return `✅ Order confirmed! Ticket #${ticket.id}
Your pizza will be ready in 20–25 minutes.
Thank you for ordering Pizza 64 🍕`;
  }

  return "No problem — what would you like to change?";
}

/* =========================
   CHAT API
========================= */

app.post("/chat", (req, res) => {
  const { sessionId, message } = req.body;

  if (!sessions.has(sessionId)) {
    sessions.set(sessionId, {
      id: sessionId,
      items: [],
      current: {},
      name: null,
      phone: null,
      orderType: null,
      confirming: false
    });
  }

  const session = sessions.get(sessionId);
  const text = reply(session, message);
  res.json({ reply: text });
});

/* =========================
   CONFIRMED TICKETS
========================= */

app.get("/api/tickets", (req, res) => {
  res.json(tickets);
});

/* =========================
   SERVER
========================= */

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  console.log("🍕 Pizza 64 running on", PORT);
});


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

