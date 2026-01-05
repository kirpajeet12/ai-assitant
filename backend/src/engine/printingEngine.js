export function formatForKitchen(ticket) {
  return `
ORDER #${ticket.id}
${ticket.orderType}

${ticket.items.map(i => `• ${i.qty} ${i.size} ${i.name}`).join("\n")}

Sides:
${ticket.sides.join(", ") || "None"}

TOTAL: $${ticket.total}
`;
}
