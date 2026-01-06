// src/services/storeService.js
// Loads store JSON configs (like pizza64.json) and finds a store by phone reliably.

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

/* =========================
   PATH HELPERS (ESM)
========================= */

// __filename / __dirname for ESM
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/**
 * IMPORTANT:
 * This points to: <project-root>/stores
 *
 * Because this file is: <project-root>/src/services/storeService.js
 * so ../../ takes us to <project-root>
 */
const STORES_DIR = path.join(__dirname, "../../stores");

/* =========================
   PHONE NORMALIZATION
========================= */

/**
 * Normalize a phone number into an E.164-ish format for US/Canada.
 * - Removes spaces, dashes, brackets, etc
 * - Converts "12183963550" -> "+12183963550"
 * - Converts "2183963550" -> "+12183963550" (assumes US/Canada if 10 digits)
 */
function normalizePhone(phone) {
  const raw = String(phone || "").trim();
  if (!raw) return "";

  // keep digits only
  let digits = raw.replace(/[^\d]/g, "");

  // If user typed 10 digits, assume US/Canada and add country code 1
  if (digits.length === 10) digits = "1" + digits;

  // If already has 11 digits and starts with 1, good for US/Canada
  // If not 11 digits, still return "+" + digits (best effort)
  return digits ? `+${digits}` : "";
}

/* =========================
   STORE LOADING (CACHED)
========================= */

let cachedStores = null;

/**
 * Load all JSON files in /stores folder once and cache them.
 * Each JSON should look like:
 * { id, name, phone, conversation, menu, sides, ... }
 */
function loadStores() {
  if (cachedStores) return cachedStores;

  // Helpful debug in Render logs
  console.log("📦 Loading stores from:", STORES_DIR);

  if (!fs.existsSync(STORES_DIR)) {
    console.warn("⚠️ Stores folder not found:", STORES_DIR);
    cachedStores = [];
    return cachedStores;
  }

  const files = fs
    .readdirSync(STORES_DIR)
    .filter((f) => f.toLowerCase().endsWith(".json"));

  const stores = [];

  for (const file of files) {
    try {
      const full = path.join(STORES_DIR, file);
      const txt = fs.readFileSync(full, "utf8");
      const store = JSON.parse(txt);

      // Normalize/store a helper field for fast matching
      store._phoneNorm = normalizePhone(store.phone);

      stores.push(store);
    } catch (e) {
      console.error("❌ Failed to load store file:", file, e);
    }
  }

  console.log(
    "✅ Stores loaded:",
    stores.map((s) => ({ id: s.id, phone: s.phone, phoneNorm: s._phoneNorm }))
  );

  cachedStores = stores;
  return cachedStores;
}

/* =========================
   PUBLIC API
========================= */

/**
 * Find store by phone.
 * Works with:
 * "+12183963550"
 * "12183963550"
 * "218-396-3550"
 * "(218) 396-3550"
 */
export function getStoreByPhone(phone) {
  const stores = loadStores();
  const p = normalizePhone(phone);

  if (!p) return null;

  const found = stores.find((s) => s._phoneNorm === p);
  return found || null;
}

export function getAllStores() {
  return loadStores();
}
