// dashboard/chat.js

let sessionId = null;
let isStarting = false;
let isSending = false;

const chatEl = document.getElementById("chat");
const msgEl = document.getElementById("msg");
const sendBtn = document.getElementById("sendBtn");
const startBtn = document.getElementById("startBtn");
const storePhoneEl = document.getElementById("storePhone");

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

function setUiState({ canSend, starting, sending }) {
  isStarting = !!starting;
  isSending = !!sending;

  sendBtn.disabled = !canSend || isStarting || isSending;
  startBtn.disabled = isStarting;
  msgEl.disabled = !canSend || isStarting;
}

async function start() {
  if (isStarting) return;

  sessionId = null;
  chatEl.innerHTML = "";
  addBubble("Starting session…", "bot");

  setUiState({ canSend: false, starting: true, sending: false });

  const body = {
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

async function send() {
  const text = msgEl.value.trim();
  if (!text) return;

  if (!sessionId) {
    addBubble("Session not started. Click Start.", "bot");
    return;
  }

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
    setUiState({ canSend: true, starting: false, sending: false });
    msgEl.focus();
  } catch (err) {
    console.error("Send error:", err);
    addBubble("Server not reachable. Check console + server logs.", "bot");
    setUiState({ canSend: true, starting: false, sending: false });
  }
}

// Wire up UI
startBtn.addEventListener("click", start);
sendBtn.addEventListener("click", send);

msgEl.addEventListener("keydown", (e) => {
  if (e.key === "Enter") send();
});

// Initial UI state + auto start
setUiState({ canSend: false, starting: false, sending: false });
start();
