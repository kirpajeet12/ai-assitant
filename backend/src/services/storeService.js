import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// storeService.js is in: backend/src/services
// so backend folder is: ../../
const STORES_DIR = path.resolve(__dirname, "..", "..", "data", "stores");

function normalizePhone(input) {
  const raw = String(input || "").trim();
  if (!raw) return "";
  const cleaned = raw.replace(/[^\d+]/g, "");
  if (cleaned.startsWith("+")) return cleaned;
  if (/^\d{10}$/.test(cleaned)) return `+1${cleaned}`;
  if (/^1\d{10}$/.test(cleaned)) return `+${cleaned}`;
  return cleaned;
}

let STORES_CACHE = null;

function loadStores() {
  console.log("Loading stores from:", STORES_DIR);

  if (!fs.existsSync(STORES_DIR)) {
    console.warn("⚠️ Stores folder not found:", STORES_DIR);
    return [];
  }

  const files = fs.readdirSync(STORES_DIR).filter((f) => f.endsWith(".json"));
  const stores = [];

  for (const f of files) {
    try {
      const full = path.join(STORES_DIR, f);
      const raw = fs.readFileSync(full, "utf-8");
      const data = JSON.parse(raw);

      if (Array.isArray(data)) stores.push(...data);
      else stores.push(data);
    } catch (e) {
      console.error("❌ Failed to parse store file:", f, e);
    }
  }

  console.log(`✅ Loaded ${stores.length} store(s)`);
  return stores;
}

export function getAllStores({ fresh = false } = {}) {
  if (fresh || !STORES_CACHE) STORES_CACHE = loadStores();
  return STORES_CACHE;
}

export function getStoreByPhone(phone) {
  const target = normalizePhone(phone);
  const stores = getAllStores();
  const store = stores.find((s) => normalizePhone(s.phone) === target) || null;

  if (!store) {
    console.warn("⚠️ Store not found for phone:", target);
  }
  return store;
}
