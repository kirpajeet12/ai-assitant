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

app.get("/", (req, res) =>
  res.send("Server is running ✅ Try /index.html or /health")
);

app.get("/health", (req, res) =>
  res.json({ status: "ok", message: "pizza64 voice assistant backend running" })
);

// --------------------
// FREE TEST MODE
// --------------------
function isMockMode() {
  if (process.env.MOCK_AI === "true") return true;
  if (!process.env.OPENAI_API_KEY) return true;
  return false;
}

function buildMockOrder(transcript) {
  const t = (transcript || "").toLowerCase();
  const orderType =
    t.includes("deliver") || t.includes("delivery") || t.includes("address")
      ? "delivery"
      : "pickup";

  let qty = 1;
  if (t.match(/\b2\b/) || t.includes("two")) qty = 2;
  if (t.match(/\b3\b/) || t.includes("three")) qty = 3;

  const size = t.includes("large")
    ? "Large"
    : t.includes("small")
    ? "Small"
    : "Medium";

  let name = "Pepperoni Pizza";
  let spice_level = "not_applicable";
  const toppings = [];

  if (t.includes("butter")) {
    name = "Butter Chicken Pizza";
    spice_level = "Medium";
    toppings.push("cilantro");
  } else if (t.includes("tandoori")) {
    name = "Tandoori Chicken Pizza";
    spice_level = "Hot";
    toppings.push("cilantro");
  } else if (t.includes("paneer")) {
    name = "Shahi Paneer Pizza";
    spice_level = "Medium";
    toppings.push("cilantro", "spinach");
  } else if (t.includes("veggie") || t.includes("vegetable")) {
    name = "Pesto Veggie Pizza";
    toppings.push("spinach");
  } else if (t.includes("hawaiian")) {
    name = "Hawaiian Pizza";
    toppings.push("pineapple");
  }

  if (t.includes("pineapple") && !toppings.includes("pineapple"))
    toppings.push("pineapple");
  if (t.includes("spinach") && !toppings.includes("spinach"))
    toppings.push("spinach");
  if (t.includes("cilantro") && !toppings.includes("cilantro"))
    toppings.push("cilantro");
  if (t.includes("jalap")) toppings.push("jalapeños");

  if (t.includes("mild")) spice_level = "Mild";
  if (t.includes("medium")) spice_level = "Medium";
  if (t.includes("hot")) spice_level = "Hot";

  return {
    orderType,
    customer: {
      name: "Phone Customer",
      phone: "unknown",
      address: orderType === "delivery" ? "NEEDS ADDRESS (ask customer)" : null,
    },
    items: [
      {
        category: "pizza",
        name,
        size,
        quantity: qty,
        spice_level,
        toppings,
        notes: null,
      },
    ],
    special_instructions: "MOCK MODE: no OpenAI cost",
    requested_time: "ASAP",
    payment_method: "unknown",
  };
}

// Web page calls this
app.post("/api/ai/pizza64-order", (req, res) => {
  const transcript = req.body?.transcript || "";
  if (isMockMode())
    return res.json({
      ok: true,
      mode: "mock",
      transcript,
      order: buildMockOrder(transcript),
    });

  return res.status(501).json({
    ok: false,
    error: "Real AI not implemented. Set MOCK_AI=true for free testing.",
  });
});

// --------------------------
// Human-friendly Twilio Voice
// --------------------------

// Simple in-memory call sessions (good for testing)
const sessions = new Map(); // CallSid -> { step, order }

function getSession(callSid) {
  if (!sessions.has(callSid)) {
    sessions.set(callSid, { step: "ORDER", order: null });
  }
  return sessions.get(callSid);
}

function detectOrderTypeFromSpeech(speech) {
  const t = (speech || "").toLowerCase();
  if (t.includes("deliver") || t.includes("delivery") || t.includes("address"))
    return "delivery";
  if (t.includes("pickup") || t.includes("pick up") || t.includes("pick it up"))
    return "pickup";
  return null;
}

function isSpicyPizza(order) {
  const name = (order?.items?.[0]?.name || "").toLowerCase();
  return name.includes("butter") || name.includes("tandoori") || name.includes("paneer");
}

function applyExtras(order, speech) {
  const t = (speech || "").toLowerCase();
  const item = order.items[0];

  // Spice
  if (t.includes("mild")) item.spice_level = "Mild";
  else if (t.includes("hot")) item.spice_level = "Hot";
  else if (t.includes("medium")) item.spice_level = "Medium";

  // Extras
  item.toppings = item.toppings || [];
  const add = (x) => {
    if (!item.toppings.includes(x)) item.toppings.push(x);
  };

  if (
    t.includes("no extras") ||
    t.includes("no extra") ||
    t.includes("no topping") ||
    t.includes("no toppings")
  ) {
    item.toppings = [];
    return;
  }

  if (t.includes("pineapple")) add("pineapple");
  if (t.includes("spinach")) add("spinach");
  if (t.includes("cilantro")) add("cilantro");
  if (t.includes("jalap")) add("jalapeños");
  if (t.includes("extra cheese")) add("extra cheese");
}

function buildConfirmLine(order) {
  const item = order.items[0];
  const tops =
    (item.toppings || []).length > 0 ? item.toppings.join(", ") : "no extras";

  const spice =
    item.spice_level && item.spice_level !== "not_applicable"
      ? `${item.spice_level} spice`
      : "regular";

  const type = order.orderType === "delivery" ? "delivery" : "pickup";

  return `Quick confirm: ${item.quantity} ${item.size} ${item.name}, ${spice}, with ${tops}, for ${type}.`;
}

// Entry webhook
app.all("/twilio/voice", (req, res) => {
  const callSid = req.body?.CallSid || req.query?.CallSid || "unknown";
  const session = getSession(callSid);

  session.step = "ORDER";
  session.order = null;

  const twiml = new twilio.twiml.VoiceResponse();

  twiml.say({ voice: "alice" }, "Hi, thanks for calling Pizza 64.");
  twiml.say({ voice: "alice" }, "What can I get started for you today?");

  const gather = twiml.gather({
    input: "speech",
    action: "/twilio/step",
    method: "POST",
    speechTimeout: "auto",
    language: "en-US",
  });

  gather.say(
    { voice: "alice" },
    "Just tell me your order, like: two medium butter chicken pizzas for pickup."
  );

  twiml.redirect({ method: "POST" }, "/twilio/voice");

  res.type("text/xml").send(twiml.toString());
});

// Main step handler (multi-turn)
app.post("/twilio/step", (req, res) => {
  const callSid = req.body?.CallSid || "unknown";
  const session = getSession(callSid);

  const speech = (req.body?.SpeechResult || "").trim();
  const twiml = new twilio.twiml.VoiceResponse();

  if (!speech) {
    twiml.say({ voice: "alice" }, "Sorry—say that one more time for me.");
    twiml.redirect({ method: "POST" }, "/twilio/voice");
    return res.type("text/xml").send(twiml.toString());
  }

  // STEP 1: Take base order
  if (session.step === "ORDER") {
    const order = buildMockOrder(speech);

    // Respect pickup/delivery if customer said it
    const explicitType = detectOrderTypeFromSpeech(speech);
    if (explicitType) order.orderType = explicitType;

    session.order = order;
    session.step = "EXTRAS";

    const item = order.items[0];
    twiml.say(
      { voice: "alice" },
      `Okay—so far I’ve got ${item.quantity} ${item.size} ${item.name}.`
    );

    const gather = twiml.gather({
      input: "speech",
      action: "/twilio/step",
      method: "POST",
      speechTimeout: "auto",
      language: "en-US",
    });

    if (isSpicyPizza(order)) {
      gather.say(
        { voice: "alice" },
        "How spicy do you want it—mild, medium, or hot? Any extras like cilantro, spinach, pineapple, jalapeños, or extra cheese?"
      );
    } else {
      gather.say(
        { voice: "alice" },
        "Any extras on top? You can say cilantro, spinach, pineapple, jalapeños, extra cheese—or just say no extras."
      );
    }

    return res.type("text/xml").send(twiml.toString());
  }

  // STEP 2: Apply extras/spice
  if (session.step === "EXTRAS") {
    const order = session.order;
    applyExtras(order, speech);

    // Delivery -> ask address
    if (order.orderType === "delivery") {
      session.step = "ADDRESS";
      const gather = twiml.gather({
        input: "speech",
        action: "/twilio/step",
        method: "POST",
        speechTimeout: "auto",
        language: "en-US",
      });
      gather.say({ voice: "alice" }, "Perfect. What’s the full delivery address?");
      return res.type("text/xml").send(twiml.toString());
    }

    // Pickup -> confirm
    session.step = "CONFIRM";
    twiml.say({ voice: "alice" }, buildConfirmLine(order));

    const gather = twiml.gather({
      input: "speech",
      action: "/twilio/step",
      method: "POST",
      speechTimeout: "auto",
      language: "en-US",
    });
    gather.say({ voice: "alice" }, "Is that correct? Say yes to confirm, or tell me what to change.");
    return res.type("text/xml").send(twiml.toString());
  }

  // STEP 3: Delivery address
  if (session.step === "ADDRESS") {
    const order = session.order;
    order.customer.address = speech;

    session.step = "CONFIRM";
    twiml.say(
      { voice: "alice" },
      `${buildConfirmLine(order)} Delivery address: ${order.customer.address}.`
    );

    const gather = twiml.gather({
      input: "speech",
      action: "/twilio/step",
      method: "POST",
      speechTimeout: "auto",
      language: "en-US",
    });
    gather.say({ voice: "alice" }, "Is everything correct? Say yes to confirm, or tell me what to change.");
    return res.type("text/xml").send(twiml.toString());
  }

  // STEP 4: Final confirm
  if (session.step === "CONFIRM") {
    const t = speech.toLowerCase();

    if (t.includes("yes") || t.includes("correct") || t.includes("that's right") || t.includes("right")) {
      twiml.say({ voice: "alice" }, "Perfect. You’re all set. Thanks for calling Pizza 64!");
      sessions.delete(callSid);
      return res.type("text/xml").send(twiml.toString());
    }

    // Changes -> restart cleanly
    session.step = "ORDER";
    session.order = null;

    twiml.say({ voice: "alice" }, "No worries. Tell me the updated order in one sentence.");
    const gather = twiml.gather({
      input: "speech",
      action: "/twilio/step",
      method: "POST",
      speechTimeout: "auto",
      language: "en-US",
    });
    gather.say({ voice: "alice" }, "Go ahead.");
    return res.type("text/xml").send(twiml.toString());
  }

  // Fallback
  session.step = "ORDER";
  session.order = null;
  twiml.redirect({ method: "POST" }, "/twilio/voice");
  return res.type("text/xml").send(twiml.toString());
});

// --------------------
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log("Server listening on port", PORT));
