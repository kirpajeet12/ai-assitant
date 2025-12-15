import express from "express";
import cors from "cors";
import "dotenv/config";
import twilio from "twilio";

const app = express();

// Twilio sends form-encoded by default
app.use(express.urlencoded({ extended: false }));
app.use(express.json());
app.use(cors());

// Serve frontend from backend/public
app.use(express.static("public"));

app.get("/", (req, res) => res.send("Server is running ✅ Try /index.html or /health"));
app.get("/health", (req, res) => res.json({ status: "ok", message: "pizza64 voice assistant backend running" }));

function isMockMode() {
  if (process.env.MOCK_AI === "true") return true;
  if (!process.env.OPENAI_API_KEY) return true;
  return false;
}

function buildMockOrder(transcript) {
  const t = (transcript || "").toLowerCase();
  const orderType = (t.includes("deliver") || t.includes("delivery") || t.includes("address")) ? "delivery" : "pickup";

  let qty = 1;
  if (t.match(/\b2\b/) || t.includes("two")) qty = 2;
  if (t.match(/\b3\b/) || t.includes("three")) qty = 3;

  const size = t.includes("large") ? "Large" : t.includes("small") ? "Small" : "Medium";

  let name = "Pepperoni Pizza";
  let spice_level = "not_applicable";
  const toppings = [];

  if (t.includes("butter")) { name = "Butter Chicken Pizza"; spice_level = "Medium"; toppings.push("cilantro"); }
  else if (t.includes("tandoori")) { name = "Tandoori Chicken Pizza"; spice_level = "Hot"; toppings.push("cilantro"); }
  else if (t.includes("paneer")) { name = "Shahi Paneer Pizza"; spice_level = "Medium"; toppings.push("cilantro", "spinach"); }
  else if (t.includes("veggie") || t.includes("vegetable")) { name = "Pesto Veggie Pizza"; toppings.push("spinach"); }
  else if (t.includes("hawaiian")) { name = "Hawaiian Pizza"; toppings.push("pineapple"); }

  if (t.includes("pineapple") && !toppings.includes("pineapple")) toppings.push("pineapple");
  if (t.includes("spinach") && !toppings.includes("spinach")) toppings.push("spinach");
  if (t.includes("cilantro") && !toppings.includes("cilantro")) toppings.push("cilantro");
  if (t.includes("jalap")) toppings.push("jalapeños");

  if (t.includes("mild")) spice_level = "Mild";
  if (t.includes("medium")) spice_level = "Medium";
  if (t.includes("hot")) spice_level = "Hot";

  return {
    orderType,
    customer: {
      name: "Phone Customer",
      phone: "unknown",
      address: orderType === "delivery" ? "NEEDS ADDRESS (ask customer)" : null
    },
    items: [{
      category: "pizza",
      name,
      size,
      quantity: qty,
      spice_level,
      toppings,
      notes: null
    }],
    special_instructions: "MOCK MODE: no OpenAI cost",
    requested_time: "ASAP",
    payment_method: "unknown"
  };
}

// Web page calls this
app.post("/api/ai/pizza64-order", (req, res) => {
  const transcript = req.body?.transcript || "";
  if (isMockMode()) return res.json({ ok: true, mode: "mock", transcript, order: buildMockOrder(transcript) });
  return res.status(501).json({ ok: false, error: "Real AI not implemented. Set MOCK_AI=true for free testing." });
});

// Twilio Voice entry webhook
app.all("/twilio/voice", (req, res) => {
  const twiml = new twilio.twiml.VoiceResponse();

  twiml.say({ voice: "alice" }, "Hi! Thanks for calling Pizza 64.");
  twiml.say({ voice: "alice" }, "Tell me your order in one sentence. Example: two medium butter chicken pizzas for pickup.");

  const gather = twiml.gather({
    input: "speech",
    action: "/twilio/gather",
    method: "POST",
    speechTimeout: "auto",
    language: "en-US"
  });

  gather.say({ voice: "alice" }, "Go ahead, I'm listening.");

  twiml.redirect({ method: "POST" }, "/twilio/voice");

  res.type("text/xml").send(twiml.toString());
});

// Twilio speech result handler
app.post("/twilio/gather", (req, res) => {
  const speech = (req.body?.SpeechResult || "").trim();
  const twiml = new twilio.twiml.VoiceResponse();

  if (!speech) {
    twiml.say({ voice: "alice" }, "Sorry, I didn't catch that.");
    twiml.redirect({ method: "POST" }, "/twilio/voice");
    return res.type("text/xml").send(twiml.toString());
  }

  const order = buildMockOrder(speech);
  const item = order.items[0];

  twiml.say({ voice: "alice" }, `Okay. I heard: ${item.quantity} ${item.size} ${item.name}.`);

  // Delivery follow-up: ask for address
  if (order.orderType === "delivery") {
    const gatherAddr = twiml.gather({
      input: "speech",
      action: "/twilio/address",
      method: "POST",
      speechTimeout: "auto",
      language: "en-US"
    });

    gatherAddr.say({ voice: "alice" }, "Got it. Please say your full address now.");
    twiml.redirect({ method: "POST" }, "/twilio/voice");
    return res.type("text/xml").send(twiml.toString());
  }

  twiml.say({ voice: "alice" }, "Great. We'll have that ready for pickup. Thank you!");
  return res.type("text/xml").send(twiml.toString());
});

// Delivery address capture
app.post("/twilio/address", (req, res) => {
  const addressSpeech = (req.body?.SpeechResult || "").trim();
  const twiml = new twilio.twiml.VoiceResponse();

  if (!addressSpeech) {
    twiml.say({ voice: "alice" }, "Sorry, I didn't catch the address.");
    twiml.say({ voice: "alice" }, "Please call again, or speak with the store staff.");
    return res.type("text/xml").send(twiml.toString());
  }

  twiml.say({ voice: "alice" }, `Thanks. I got your address as: ${addressSpeech}.`);
  twiml.say({ voice: "alice" }, "Perfect. We'll send your order to the store for confirmation. Thank you!");
  return res.type("text/xml").send(twiml.toString());
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log("Server listening on port", PORT));
