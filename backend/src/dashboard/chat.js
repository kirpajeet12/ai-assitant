// dashboard/chat.js
// This file powers the test chat UI in the browser.

// Generate or reuse a sessionId so your chat remembers the conversation
function makeSessionId() {
  // crypto.randomUUID() exists in modern browsers
  return (crypto?.randomUUID?.() || (Date.now() + "-" + Math.random())).toString();
}

// Persist sessionId in localStorage so page refresh keeps the same conversation
let sessionId = localStorage.getItem("sessionId");
if (!sessionId) {
  sessionId = makeSessionId();
  localStorage.setItem("sessionId", sessionId);
}

// Grab UI elements from the page
const chatEl = document.getElementById("chat");
const formEl = document.getElementById("form");
const msgEl = document.getElementById("msg");
const storePhoneEl = document.getElementById("storePhone");
const newSessionBtn = document.getElementById("newSessionBtn");

// Helper: add a message bubble to the chat window
function addBubble(role, text) {
  const div = document.createElement("div");
  div.className = "bubble " + role; // "bubble user" or "bubble bot"
  div.textContent = text;
  chatEl.appendChild(div);
  chatEl.scrollTop = chatEl.scrollHeight;
}

// Start a new session (clears chat + new sessionId)
newSessionBtn.addEventListener("click", () => {
  sessionId = makeSessionId();
  localStorage.setItem("sessionId", sessionId);
  chatEl.innerHTML = "";
  addBubble("bot", "New session started. What would you like to order?");
});

// Send the user message to your backend API
async function sendMessage(text) {
  const storePhone = storePhoneEl.value.trim();

  // Store phone is required because your backend uses getStoreByPhone(storePhone)
  if (!storePhone) {
    addBubble("bot", "Please enter Store Phone first (same as Twilio 'To').");
    return;
  }

  // Show user message in UI
  addBubble("user", text);

  // Call your backend
  const resp = await fetch("/api/chat/step", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      sessionId,        // session key
      storePhone,       // store identifier
      message: text     // user text
    })
  });

  // Parse response JSON
  const data = await resp.json();

  // Handle errors from server
  if (!resp.ok || data.error) {
    addBubble("bot", "Error: " + (data.error || "Request failed"));
    return;
  }

  // Show bot reply
  addBubble("bot", data.reply || "…");
}

// On form submit, send the typed message
formEl.addEventListener("submit", (e) => {
  e.preventDefault();           // stop page reload
  const text = msgEl.value.trim();
  if (!text) return;            // ignore empty
  msgEl.value = "";             // clear input
  sendMessage(text);            // send to backend
});

// Initial bot prompt
addBubble("bot", "Enter Store Phone, then ask anything. Example: what pizzas do you have?");
