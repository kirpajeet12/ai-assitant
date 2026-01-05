
async function loadTickets() {
  const storeId = document.getElementById("storeId").value.trim();
  const token = document.getElementById("token").value.trim();

  if (!storeId || !token) {
    alert("Store ID and Token are required");
    return;
  }

  const res = await fetch(
    `/api/stores/${storeId}/tickets?token=${encodeURIComponent(token)}`
  );

  if (!res.ok) {
    alert("Access denied, invalid token, or store not found");
    return;
  }

  const tickets = await res.json();
  renderTickets(tickets);
}

function renderTickets(tickets) {
  const container = document.getElementById("tickets");
  container.innerHTML = "";

  if (!tickets.length) {
    container.innerHTML = "<p>No orders yet.</p>";
    return;
  }

  tickets.forEach(ticket => {
    const div = document.createElement("div");
    div.className = "ticket";

    const itemsHtml = ticket.items.map(item => {
      const attrs = item.attributes
        ? Object.entries(item.attributes)
            .map(([k, v]) => `${k}: ${v}`)
            .join(", ")
        : "";

      return `<li>${item.qty}× ${item.name} ${attrs ? `(${attrs})` : ""}</li>`;
    }).join("");

    div.innerHTML = `
      <h3>🧾 Ticket ${ticket.id}</h3>

      <p><b>Order Type:</b> ${ticket.orderType}</p>

      ${ticket.caller ? `<p><b>Caller:</b> ${ticket.caller}</p>` : ""}

      ${ticket.address ? `<p><b>Address:</b> ${ticket.address}</p>` : ""}

      <ul>${itemsHtml}</ul>

      <p><b>Sides:</b> ${ticket.sides?.length ? ticket.sides.join(", ") : "None"}</p>

      <p class="time">${new Date(ticket.created_at).toLocaleString()}</p>

      <button onclick="printTicket('${ticket.id}')">🖨️ Print</button>
    `;

    container.appendChild(div);
  });
}

function printTicket(ticketId) {
  const win = window.open(`/api/tickets/${ticketId}`, "_blank");
  if (!win) alert("Popup blocked. Allow popups to print.");
}
