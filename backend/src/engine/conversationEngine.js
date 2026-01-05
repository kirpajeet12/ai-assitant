export function nextQuestion(store, session) {
  const item = session.items[0];

  if (!item) return "What would you like to order?";

  for (const attr of store.attributes) {
    if (!item.attributes[attr]) {
      return `What ${attr} would you like?`;
    }
  }

  if (
    store.conversation.ask_sides &&
    !session.askedSides &&
    store.sides
  ) {
    session.askedSides = true;
    return `Would you like any sides?`;
  }

  if (
    store.conversation.ask_delivery_address &&
    session.orderType === "Delivery" &&
    !session.address
  ) {
    return "Please tell me the delivery address.";
  }

  return "confirm";
}
