import fs from "fs";
import path from "path";

function normalizePhone(input) {
  const raw = String(input || "").trim();
  if (!raw) return "";
  const cleaned = raw.replace(/[^\d+]/g, "");
  if (cleaned.startsWith("+")) return cleaned;
  if (/^\d{10}$/.test(cleaned)) return `+1${cleaned}`;
  if (/^1\d{10}$/.test(cleaned)) return `+${cleaned}`;
  return cleaned;
}

const STORES_DIR = path.resolve(process.cwd(), "data", "stores");

let STORES_CACHE = null;

function loadStores() {
  console.log("Loading stores from:", STORES_DIR);

  if (!fs.existsSync(STORES_DIR)) {
    console.warn("⚠️ Stores folder not found:", STORES_DIR);
    return [];
  }

  const files = fs.readdirSync(STORES_DIR).filter((f) => f.endsWith(".json"));
  const stores = [];

  for (const file of files) {
    try {
      const full = path.join(STORES_DIR, file);
      const raw = fs.readFileSync(full, "utf-8");
      const data = JSON.parse(raw);

      if (Array.isArray(data)) stores.push(...data);
      else if (data && typeof data === "object") stores.push(data);
    } catch (e) {
      console.error("❌ Failed reading store file:", file, e);
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
  return stores.find((s) => normalizePhone(s.phone) === target) || null;
}
