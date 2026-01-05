import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const STORES_DIR = path.join(__dirname, "../data/stores");

export function getStoreByPhone(phone) {
  const files = fs.readdirSync(STORES_DIR);

  for (const f of files) {
    const store = JSON.parse(
      fs.readFileSync(path.join(STORES_DIR, f), "utf8")
    );
    if (store.twilio_phone === phone) return store;
  }
  return null;
}

export function getStoreById(id) {
  const files = fs.readdirSync(STORES_DIR);

  for (const f of files) {
    const store = JSON.parse(
      fs.readFileSync(path.join(STORES_DIR, f), "utf8")
    );
    if (store.id === id) return store;
  }
  return null;
}
