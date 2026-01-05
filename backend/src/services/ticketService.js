import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const FILE = path.join(__dirname, "../data/tickets.json");

function read() {
  return JSON.parse(fs.readFileSync(FILE, "utf8"));
}

function write(data) {
  fs.writeFileSync(FILE, JSON.stringify(data, null, 2));
}

export function createTicket(ticket) {
  const all = read();
  all.unshift(ticket);
  write(all);
}

export function getTicketsByStore(storeId) {
  return read().filter(t => t.store_id === storeId);
}

export function getTicketById(id) {
  return read().find(t => t.id === id);
}
