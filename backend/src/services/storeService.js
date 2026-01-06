import fs from "fs";
import path from "path";

 // make sure your pizza64.json is inside /stores
const storesDir = path.join(process.cwd(), "src", "stores");

function normalizePhone(raw) {
  let s = String(raw || "").trim();

  // remove common prefixes if present
  s = s.replace(/^whatsapp:/i, "");
  s = s.replace(/^sip:/i, "");
  s = s.replace(/^tel:/i, "");

  // keep only digits
  s = s.replace(/[^\d]/g, "");

  // if it starts with 1 and length is 11, drop leading 1 (North America)
  if (s.length === 11 && s.startsWith("1")) s = s.slice(1);

  return s; // now it's like: 2183963550
}

export function getStoreByPhone(phone) {
  const target = normalizePhone(phone);

  const files = fs.existsSync(storesDir)
    ? fs.readdirSync(storesDir).filter((f) => f.endsWith(".json"))
    : [];

  for (const f of files) {
    const full = path.join(storesDir, f);
    const store = JSON.parse(fs.readFileSync(full, "utf8"));
    const storePhone = normalizePhone(store.phone);

    if (storePhone && storePhone === target) return store;
  }

  return null;
}
