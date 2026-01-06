import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

/**
 * We use ESM, so __dirname isn't available by default.
 * This recreates __dirname safely.
 */
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/**
 * Stores folder path (../stores from services folder)
 * Adjust if your folder structure is different.
 */
const STORES_DIR = path.join(__dirname, "..", "stores");

/**
 * In-memory cache so we don't re-read JSON on every request.
 */
let storesCache = [];
let phoneToStore = new Map();
let idToStore = new Map();

/**
 * Normalize phone numbers so comparisons don't break.
 * Twilio sends E.164 usually (like +1604xxxxxxx).
 */
function normPhone(p) {
  return String(p || "").trim();
}

/**
 * Load every .json file inside /stores and build lookup maps.
 */
export function loadStores() {
  // Reset caches
  storesCache = [];
  phoneToStore = new Map();
  idToStore = new Map();

  // If folder missing, fail gracefully (avoid crash)
  if (!fs.existsSync(STORES_DIR)) {
    console.warn("⚠️ stores folder not found:", STORES_DIR);
    return;
  }

  // Read files in the folder
  const files = fs.readdirSync(STORES_DIR);

  for (const file of files) {
    // Only read .json files
    if (!file.toLowerCase().endsWith(".json")) continue;

    const fullPath = path.join(STORES_DIR, file);

    // Read file contents
    const raw = fs.readFileSync(fullPath, "utf-8");

    // Parse JSON
    const store = JSON.parse(raw);

    // Basic validation (optional but recommended)
    if (!store?.id) {
      console.warn("⚠️ Store missing id in file:", file);
      continue;
    }

    storesCache.push(store);

    // Map by id
    idToStore.set(store.id, store);

    // Map by phone(s)
    const phones = Array.isArray(store.phones) ? store.phones : [];
    for (const ph of phones) {
      phoneToStore.set(normPhone(ph), store);
    }
  }

  console.log(`✅ Loaded ${storesCache.length} store configs`);
}

/**
 * Get store by phone number (Twilio "To" number).
 */
export function getStoreByPhone(toPhone) {
  return phoneToStore.get(normPhone(toPhone)) || null;
}

/**
 * Get store by store id.
 */
export function getStoreById(id) {
  return idToStore.get(String(id || "").trim()) || null;
}
