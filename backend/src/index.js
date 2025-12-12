import express from "express";
import cors from "cors";
import "dotenv/config";

const app = express();

app.use(cors());
app.use(express.json());

// ✅ Serve static files from backend/public (so /index.html works)
app.use(express.static("public"));

// ✅ Optional: nice homepage message
app.get("/", (req, res) => {
  res.send("Server is running ✅ Try /health or /index.html");
});

app.get("/health", (req, res) => {
  res.json({ status: "ok", message: "backend is running" });
});

/**
 * ✅ AI Order Endpoint (MOCK MODE)
 * Your frontend should POST { transcript: "..." } here.
 *
 * If OPENAI_API_KEY is missing OR MOCK_AI=true, it returns a fake order
 * so you can test without paying anything.
 */
app.post("/api/ai/pizza64-order", (req, res) => {
  const transcript = req.body?.transcript || "";

  const MOCK_MODE = !process.env.OPENAI_API_KEY || process.env.MOCK_AI === "true";

  if (MOCK_MODE) {
    return res.json({
      ok: true,
      mode: "mock",
      transcript,
      order: {
        orderType: "pickup",
        customer: { name: "Test Customer", phone: "000-000-0000" },
        items: [
          { name: "Butter Chicken Pizza", size: "Medium", qty: 2 },
          { name: "Garlic Bread", qty: 1 }
        ],
        notes: [
          "MOCK RESPONSE: OpenAI disabled",
          "To enable real AI, set OPENAI_API_KEY and set MOCK_AI=false"
        ]
      }
    });
  }

  // If you later enable OpenAI, you’ll replace this part with real OpenAI call.
  return res.status(501).json({
    ok: false,
    error: "Real OpenAI mode not implemented in this file yet. Set MOCK_AI=true to test for free."
  });
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log("Server listening on port", PORT));
