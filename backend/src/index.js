import "dotenv/config";
import express from "express";
import cors from "cors";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/* =========================
   APP SETUP
========================= */

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
   UTIL: FUZZY MATCH
========================= */

function normalize(text = "") {
  return text.toLowerCase().replace(/[^a-z]/g, "");
}

function findPizza(input) {
  const cleaned = normalize(input);
  return MENU.find(p => cleaned.includes(normalize(p)));
}

/* =========================
   SESSIONS
========================= */

const sessions = new Map();

function newSession() {
  return {
    step: "type", // type → pizza → size → spice → cilantro → name → phone → confirm
    order: {
      pizza: null,
      size: null,
      spice: null,
      cilantro: null,
      orderType: null,
      name: null,
      phone: null
    }
  };
}

/* =========================
   TICKETS
========================= */

let tickets = [];
let today = new Date().toDateString();
let counter = 1;

function nextTicket() {
  const now = new Date();
  if (now.toDateString() !== today) {
    today = now.toDateString();
    counter = 1;
  }
  return `P64-${now.getFullYear()}-${now.getMonth()+1}-${now.getDate()}-${counter++}`;
}

/* =========================
   CHAT ENDPOINT
========================= */

app.post("/chat", (req, res) => {
  const { sessionId, message } = req.body;
  const text = message.toLowerCase();

  if (!sessions.has(sessionId)) {
    sessions.set(sessionId, newSession());
    return res.json({
      reply: "Hi! Welcome to Pizza 64 🙂 Pickup or delivery?"
    });
  }

  const session = sessions.get(sessionId);
  const o = session.order;

  /* ===== STEP: PICKUP / DELIVERY ===== */
  if (session.step === "type") {
    if (text.includes("pickup")) {
      o.orderType = "Pickup";
      session.step = "pizza";
      return res.json({
        reply: "What pizza would you like? We have Cheese Lovers, Pepperoni, Veggie Supreme, Butter Chicken, Shahi Paneer, Tandoori Chicken."
      });
    }
    if (text.includes("delivery")) {
      o.orderType = "Delivery";
      session.step = "pizza";
      return res.json({
        reply: "What pizza would you like? We have Cheese Lovers, Pepperoni, Veggie Supreme, Butter Chicken, Shahi Paneer, Tandoori Chicken."
      });
    }
    return res.json({ reply: "Is this for pickup or delivery?" });
  }

  /* ===== STEP: PIZZA ===== */
  if (session.step === "pizza") {
    const pizza = findPizza(text);
    if (!pizza) {
      return res.json({
        reply: "Sorry, I didn’t catch that. Please choose from our menu."
      });
    }
    o.pizza = pizza;
    session.step = "size";
    return res.json({ reply: "What size would you like? Small, Medium, or Large?" });
  }

  /* ===== STEP: SIZE ===== */
  if (session.step === "size") {
    if (/small|medium|large/.test(text)) {
      o.size = text.match(/small|medium|large/)[0];
      session.step = "spice";
      return res.json({
        reply: "How spicy would you like it? Mild, Medium, or Hot?"
      });
    }
    return res.json({ reply: "Please choose Small, Medium, or Large." });
  }

  /* ===== STEP: SPICE ===== */
  if (session.step === "spice") {
    if (/mild|medium|hot/.test(text)) {
      o.spice = text.match(/mild|medium|hot/)[0];
      session.step = "cilantro";
      return res.json({
        reply: "Would you like to add cilantro? Yes or No?"
      });
    }
    return res.json({ reply: "Mild, Medium, or Hot?" });
  }

  /* ===== STEP: CILANTRO ===== */
  if (session.step === "cilantro") {
    if (text.includes("yes")) o.cilantro = "Yes";
    else if (text.includes("no")) o.cilantro = "No";
    else return res.json({ reply: "Please say Yes or No." });

    session.step = "name";
    return res.json({ reply: "May I have your name for the order?" });
  }

  /* ===== STEP: NAME ===== */
  if (session.step === "name") {
    o.name = message.trim();
    session.step = "phone";
    return res.json({ reply: "Can I get a contact phone number?" });
  }

  /* ===== STEP: PHONE ===== */
  if (session.step === "phone") {
    o.phone = message.trim();
    session.step = "confirm";
    return res.json({
      reply: `Please confirm your order:
${o.size} ${o.pizza}
Spice: ${o.spice}
Cilantro: ${o.cilantro}
${o.orderType}
Is that correct?`
    });
  }

  /* ===== STEP: CONFIRM ===== */
  if (session.step === "confirm") {
    if (!text.includes("yes")) {
      sessions.delete(sessionId);
      return res.json({ reply: "No problem, let's start again. Pickup or delivery?" });
    }

    const ticketNo = nextTicket();
    tickets.unshift({
      ticketNo,
      time: new Date().toLocaleTimeString(),
      order: o
    });

    sessions.delete(sessionId);

    return res.json({
      reply: `✅ Order confirmed! Ticket #${ticketNo}
Your pizza will be ready in 20–25 minutes.
Thank you for ordering Pizza 64 🍕`
    });
  }
});

/* =========================
   CONFIRMED ORDERS API
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
