/**
 * dashboard.js
 * Frontend logic for chat.html
 * - Starts a new session using GET /api/chat/start
 * - Sends messages using POST /api/chat/turn
 */

let sessionId = null; // holds current chat session id

const messagesEl = document.getElementById("messages"); // message container
const inputEl = document.getElementById("input"); // text input
const metaEl = document.getElementById("meta"); // debug/meta line
const sendBtn = document.getElementById("send"); // send button
const newBtn = document.getElementById("new"); // new session button

// Append a message bubble to the UI
function addMessage(who, text) {
  const row = document.createElement("div"); // row div
  row.className = "row " + (who === "me" ? "me" : "bot"); // align based on sender

  const bubble = document.createElement("div"); // bubble div
  bubble.className = "bubble"; // bubble styling
  bubble.textContent = text; // set text

  row.appendChild(bubble); // add bubble to row
  messagesEl.appendChild(row); // add row to messages

  // Auto-scroll to bottom
  messagesEl.scrollTop = messagesEl.scrollHeight;
}

// Start a new session and show greeting
async function startSession() {
  // Clear UI
  messagesEl.innerHTML = "";
  metaEl.textContent = "";

  // Call server
  const res = await fetch("/api/chat/start"); // GET start
  const data = await res.json(); // parse json

  // Save session id
  sessionId = data.sessionId;

  // Show greeting from server
  addMessage("bot", data.greeting);

  // Show meta info
  metaEl.textContent =
    `Session: ${sessionId} | Store: ${data.store.name} | Menu: ${data.store.menuCount} | Sides: ${data.store.sidesCount} | Config: ${data.store.configPath || "fallback"}`;
}

// Send one message turn
async function sendMessage() {
  const text = (inputEl.value || "").trim(); // read input
  if (!text) return; // do nothing if empty

  // Show user message immediately
  addMessage("me", text);
  inputEl.value = ""; // clear input
  inputEl.focus(); // focus input

  // Safety: if no session yet, start one
  if (!sessionId) {
    await startSession();
  }

  // Call server
  const res = await fetch("/api/chat/turn", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ sessionId, message: text })
  });

  const data = await res.json(); // parse response

  // If server errors
  if (data.error) {
    addMessage("bot", "Error: " + data.error);
    return;
  }

  // Show bot reply
  addMessage("bot", data.reply);

  // If session ended, show note and clear sessionId
  if (data.end) {
    addMessage("bot", "✅ Session ended. Click 'New Session' to start again.");
    sessionId = null;
  }
}

// Button handlers
sendBtn.addEventListener("click", sendMessage); // click send
newBtn.addEventListener("click", startSession); // click new session

// Enter key sends message
inputEl.addEventListener("keydown", (e) => {
  if (e.key === "Enter") sendMessage();
});

// Start immediately on load
startSession();
