/**
 * chat.js
 * - Stores sessionId in localStorage so conversation continues
 * - Calls /api/chat for replies
 */

const chatEl = document.getElementById("chat");
const textEl = document.getElementById("text");
const sendBtn = document.getElementById("sendBtn");
const resetBtn = document.getElementById("resetBtn");
const storePhoneEl = document.getElementById("storePhone");

// Keep session across refresh
let sessionId = localStorage.getItem("store_ai_sessionId") || "";

// Helper: render message bubble
function addMessage(role, text) {
  const row = document.createElement("div");
  row.className = `msg ${role}`;

  const bubble = document.createElement("div");
  bubble.className = "bubble";
  bubble.textContent = text;

  row.appendChild(bubble);
  chatEl.appendChild(row);
  chatEl.scrollTop = chatEl.scrollHeight;
}

// Call server
async function sendText(text) {
  const storePhone = storePhoneEl.value.trim();

  if (!storePhone) {
    addMessage("bot", "⚠️ Enter your store phone first (same number Twilio uses in To).");
    return;
  }

  const res = await fetch("/api/chat", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ storePhone, sessionId, text })
  });

  const data = await res.json();
  if (!res.ok) {
    addMessage("bot", data.error || "Something went wrong.");
    return;
  }

  // Save sessionId if server created it
  sessionId = data.sessionId;
  localStorage.setItem("store_ai_sessionId", sessionId);

  addMessage("bot", data.reply);
}

// Send button
sendBtn.addEventListener("click", async () => {
  const text = textEl.value.trim();
  if (!text) return;
  addMessage("user", text);
  textEl.value = "";
  await sendText(text);
});

// Enter key
textEl.addEventListener("keydown", async (e) => {
  if (e.key === "Enter") {
    sendBtn.click();
  }
});

// Reset session
resetBtn.addEventListener("click", async () => {
  if (sessionId) {
    await fetch("/api/chat/reset", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sessionId })
    });
  }
  sessionId = "";
  localStorage.removeItem("store_ai_sessionId");
  chatEl.innerHTML = "";
  addMessage("bot", "✅ New session started. What would you like to order?");
});

// Initial bot greeting
addMessage("bot", "New session started. What would you like to order?");
