import fs from "fs";
import path from "path";

const STORES_DIR = path.join(process.cwd(), "src/data/stores");

export function findStoreByPhone(phone) {
  const files = fs.readdirSync(STORES_DIR);

  for (const file of files) {
    if (!file.endsWith(".json")) continue;

    const fullPath = path.join(STORES_DIR, file);
    const raw = fs.readFileSync(fullPath, "utf-8");
    const store = JSON.parse(raw);

    if (store.phone === phone) {
      return store;
    }
  }

  return null;
}
