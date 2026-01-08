// dashboard/dashboard.js

async function loadTickets() {
  const storeId = document.getElementById("storeId").value.trim();
  const token = document.getElementById("dashboardToken").value.trim();

  if (!storeId || !token) {
    alert("Store ID and Dashboard Token are required");
    return;
  }

  try {
    const res = await fetch(`/api/tickets/${storeId}?token=${token}`);
    const data = await res.json();

    if (!res.ok) {
      alert(data.error || "Failed to load orders");
      return;
    }

    const container = document.getElementById("orders");
    container.innerHTML = "";

    if (!data.length) {
      container.innerHTML = "<p>No orders found.</p>";
      return;
    }

    data.forEach(t => {
      const div = document.createElement("div");
      div.className = "ticket";
      div.innerHTML = `
        <h3>Ticket ${t.id}</h3>
        <p><b>${t.orderType}</b></p>
        <ul>
          ${t.items.map(i => `<li>${i.size} ${i.name}</li>`).join("")}
          ${(t.sides || []).map(s => `<li>${s.qty} ${s.name}</li>`).join("")}
        </ul>
        <button onclick="window.print()">Print</button>
        <hr>
      `;
      container.appendChild(div);
    });
  } catch (err) {
    console.error(err);
    alert("Server error while loading orders");
  }
}
