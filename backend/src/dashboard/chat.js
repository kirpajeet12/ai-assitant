// dashboard/chat.js
/**
 * dashboard/chat.js
 *
 * This file powers your chat.html UI:
 * - Starts a chat session via POST /api/chat/start
 * - Sends messages via POST /api/chat/message
 *
 * IMPORTANT:
 * - You MUST reference this file from chat.html:
 *   <script src="chat.js"></script>
 */

let sessionId = null;       // Current session id returned by backend
let isStarting = false;     // Prevent double-start spam
let isSending = false;      // Prevent multi-send spam

// Grab UI elements
const chatEl = document.getElementById("chat");
const msgEl = document.getElementById("msg");
const sendBtn = document.getElementById("sendBtn");
const startBtn = document.getElementById("startBtn");
const storePhoneEl = document.getElementById("storePhone");

// Add chat bubble to UI
function addBubble(text, who = "bot") {
  const row = document.createElement("div");
  row.className = "row " + (who === "me" ? "me" : "bot");

  const b = document.createElement("div");
  b.className = "bubble";
  b.textContent = text;

  row.appendChild(b);
  chatEl.appendChild(row);
  chatEl.scrollTop = chatEl.scrollHeight;
}

// Enable/disable buttons based on current state
function setUiState({ canSend, starting, sending }) {
  isStarting = !!starting;
  isSending = !!sending;

  sendBtn.disabled = !canSend || isStarting || isSending;
  startBtn.disabled = isStarting;
  msgEl.disabled = !canSend || isStarting;
}

// Start a new chat session
async function start() {
  if (isStarting) return;

  sessionId = null;
  chatEl.innerHTML = "";
  addBubble("Starting session…", "bot");

  setUiState({ canSend: false, starting: true, sending: false });

  // Build request body
  const body = {
    // Optional store phone — if empty, backend uses DEFAULT_STORE_PHONE from env
    storePhone: storePhoneEl.value.trim() || undefined,
    from: "web-user"
  };

  try {
    const r = await fetch("/api/chat/start", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body)
    });

    const data = await r.json().catch(() => ({}));

    if (!r.ok) {
      chatEl.innerHTML = "";
      addBubble(data.error || "Failed to start session.", "bot");
      setUiState({ canSend: false, starting: false, sending: false });
      return;
    }

    // Save session id
    sessionId = data.sessionId;

    chatEl.innerHTML = "";
    addBubble(data.message || "Session started.", "bot");

    setUiState({ canSend: true, starting: false, sending: false });
    msgEl.focus();
  } catch (err) {
    console.error("Start error:", err);
    chatEl.innerHTML = "";
    addBubble("Server not reachable. Make sure your Node server is running.", "bot");
    setUiState({ canSend: false, starting: false, sending: false });
  }
}

// Send a message
async function send() {
  const text = msgEl.value.trim();
  if (!text) return;

  // If no session, force user to Start again
  if (!sessionId) {
    addBubble("Session not started. Click Start.", "bot");
    return;
  }

  // Prevent double-send spam
  if (isSending) return;

  addBubble(text, "me");
  msgEl.value = "";

  setUiState({ canSend: true, starting: false, sending: true });

  try {
    const r = await fetch("/api/chat/message", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sessionId, text })
    });

    const data = await r.json().catch(() => ({}));

    if (!r.ok) {
      addBubble(data.error || "Something went wrong.", "bot");
      setUiState({ canSend: true, starting: false, sending: false });
      return;
    }

    addBubble(data.message || "(no response)", "bot");

    // If backend ended the session (order confirmed), sessionId is now invalid
    // We detect that by message content. You can also add a flag later.
    if ((data.message || "").toLowerCase().includes("order is confirmed")) {
      sessionId = null;
      setUiState({ canSend: false, starting: false, sending: false });
      addBubble("Session closed. Click Start to begin a new order.", "bot");
      return;
    }

    setUiState({ canSend: true, starting: false, sending: false });
    msgEl.focus();
  } catch (err) {
    console.error("Send error:", err);
    addBubble("Server not reachable. Check console + server logs.", "bot");
    setUiState({ canSend: true, starting: false, sending: false });
  }
}

// Wire buttons
startBtn.addEventListener("click", start);
sendBtn.addEventListener("click", send);

// Enter key sends message
msgEl.addEventListener("keydown", (e) => {
  if (e.key === "Enter") send();
});

// Initial UI state
setUiState({ canSend: false, starting: false, sending: false });

// Auto-start session on load
start();
