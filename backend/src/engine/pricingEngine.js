export function calculateTotal(store, session) {
  let subtotal = 0;

  for (const item of session.items) {
    const menuItem = store.menu[item.name];
    if (!menuItem) continue;

    const price = menuItem.sizes[item.size];
    subtotal += price * (item.qty || 1);
  }

  for (const side of session.sides) {
    subtotal += store.sides[side] || 0;
  }

  const tax = subtotal * (store.tax_rate || 0);
  const total = subtotal + tax;

  return {
    subtotal: round(subtotal),
    tax: round(tax),
    total: round(total)
  };
}

function round(n) {
  return Math.round(n * 100) / 100;
}
