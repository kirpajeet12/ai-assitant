// ✅ Node file system module to read folders/files
import fs from "fs";

// ✅ Path module to build OS-safe paths
import path from "path";

// ✅ ESM helper to convert import.meta.url into a normal file path
import { fileURLToPath } from "url";

// ✅ Get current file path (because __filename is not available in ESM)
const __filename = fileURLToPath(import.meta.url);

// ✅ Get directory of this file (backend/src/services)
const __dirname = path.dirname(__filename);

// ✅ Default stores folder: backend/data/stores
// ✅ You can override it in Render with env var STORES_DIR
const STORES_DIR = process.env.STORES_DIR
  ? path.resolve(process.env.STORES_DIR)
  : path.resolve(__dirname, "..", "..", "data", "stores");

/**
 * Normalize phone to a consistent E.164-ish format.
 * Examples:
 * - "+1 (218) 396-3550" -> "+12183963550"
 * - "2183963550" -> "+12183963550"
 * - "1-218-396-3550" -> "+12183963550"
 */
function normalizePhone(input) {
  // ✅ Turn input into a string and trim whitespace
  const raw = String(input || "").trim();

  // ✅ If empty, return empty
  if (!raw) return "";

  // ✅ Keep digits only (and we will re-add + ourselves)
  const digits = raw.replace(/\D/g, "");

  // ✅ If nothing left after cleanup, return empty
  if (!digits) return "";

  // ✅ If 10 digits, assume North America and add +1
  if (digits.length === 10) return `+1${digits}`;

  // ✅ If 11 digits and starts with 1, make it +1...
  if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`;

  // ✅ Otherwise, best effort: prefix +
  return `+${digits}`;
}

// ✅ Cache stores in memory (so we don’t read disk every request)
let STORES_CACHE = null;

/**
 * Load all store JSON files from STORES_DIR
 * - Supports file containing either ONE store object or an ARRAY of stores
 */
function loadStores() {
  // ✅ Log path so we can debug Render easily
  console.log("Loading stores from:", STORES_DIR);

  // ✅ If folder missing, return empty list
  if (!fs.existsSync(STORES_DIR)) {
    console.warn("⚠️ Stores folder not found:", STORES_DIR);
    return [];
  }

  // ✅ Read all .json files in folder
  const files = fs.readdirSync(STORES_DIR).filter((f) => f.endsWith(".json"));

  // ✅ Accumulator for all stores
  const stores = [];

  // ✅ Loop files
  for (const f of files) {
    try {
      // ✅ Create full path to the file
      const full = path.join(STORES_DIR, f);

      // ✅ Read file text
      const raw = fs.readFileSync(full, "utf-8");

      // ✅ Parse JSON
      const data = JSON.parse(raw);

      // ✅ Support file that contains an array of stores
      if (Array.isArray(data)) stores.push(...data);
      // ✅ Or file that contains a single store object
      else stores.push(data);
    } catch (e) {
      // ✅ If file has invalid JSON, log it
      console.error("❌ Failed to parse store file:", f, e.message);
    }
  }

  // ✅ Log count
  console.log(`✅ Loaded ${stores.length} store(s)`);

  // ✅ Helpful debug: print normalized phones
  console.log(
    "✅ Store phones (normalized):",
    stores.map((s) => ({
      id: s?.id,
      phoneRaw: s?.phone,
      phoneNorm: normalizePhone(s?.phone),
      phonesRaw: Array.isArray(s?.phones) ? s.phones : undefined,
      phonesNorm: Array.isArray(s?.phones) ? s.phones.map(normalizePhone) : undefined
    }))
  );

  // ✅ Return list
  return stores;
}

/**
 * Get stores list (cached unless fresh=true)
 */
export function getAllStores({ fresh = false } = {}) {
  // ✅ Reload from disk if requested or cache empty
  if (fresh || !STORES_CACHE) STORES_CACHE = loadStores();

  // ✅ Return cached list
  return STORES_CACHE;
}

/**
 * Find store by incoming "TO" phone number.
 * Also supports optional store.phones = ["+1...", ...] as aliases.
 */
export function getStoreByPhone(phone) {
  // ✅ Normalize the phone we are searching for
  const target = normalizePhone(phone);

  // ✅ Load stores from cache
  const stores = getAllStores();

  // ✅ Find store by normalized phone
  const store =
    stores.find((s) => {
      // ✅ Normalize main phone in config
      const main = normalizePhone(s?.phone);

      // ✅ Normalize optional alias phones array
      const aliases = Array.isArray(s?.phones) ? s.phones.map(normalizePhone) : [];

      // ✅ Match if either main or aliases match
      return main === target || aliases.includes(target);
    }) || null;

  // ✅ If not found, log clear debug info
  if (!store) {
    console.warn("⚠️ Store not found for phone:", { raw: phone, normalized: target });

    // ✅ Also tell how many stores exist (helps detect "folder missing" issue)
    console.warn("⚠️ Stores loaded:", stores.length);
  }

  // ✅ Return store or null
  return store;
}
