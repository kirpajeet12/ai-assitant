// backend/src/services/ticketService.js

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

/* =========================
   PATH SETUP
========================= */

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ✅ backend/src/data/tickets.json
const TICKETS_FILE = path.resolve(__dirname, "..", "tickets.json");

/* =========================
   ENSURE FILE EXISTS
========================= */

function ensureTicketsFile() {
  const dir = path.dirname(TICKETS_FILE);

  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  if (!fs.existsSync(TICKETS_FILE)) {
    fs.writeFileSync(TICKETS_FILE, "[]", "utf-8");
  }
}

/* =========================
   READ / WRITE
========================= */

function readTickets() {
  ensureTicketsFile();
  return JSON.parse(fs.readFileSync(TICKETS_FILE, "utf-8"));
}

function writeTickets(tickets) {
  ensureTicketsFile();
  fs.writeFileSync(TICKETS_FILE, JSON.stringify(tickets, null, 2));
}

/* =========================
   PUBLIC API
========================= */

export function createTicket(ticket) {
  const tickets = readTickets();

  const newTicket = {
    id: Date.now().toString(),
    createdAt: new Date().toISOString(),
    ...ticket
  };

  tickets.push(newTicket);
  writeTickets(tickets);

  return newTicket;
}

export function getTicketsByStore(storeId) {
  const tickets = readTickets();
  return tickets.filter(t => t.store_id === storeId);
}

// import fs from "fs";
// import path from "path";
// import { fileURLToPath } from "url";

// const __filename = fileURLToPath(import.meta.url);
// const __dirname = path.dirname(__filename);
// const FILE = path.join(__dirname, "../data/tickets.json");

// function read() {
//   return JSON.parse(fs.readFileSync(FILE, "utf8"));
// }

// function write(data) {
//   fs.writeFileSync(FILE, JSON.stringify(data, null, 2));
// }

// export function createTicket(ticket) {
//   const all = read();
//   all.unshift(ticket);
//   write(all);
// }

// export function getTicketsByStore(storeId) {
//   return read().filter(t => t.store_id === storeId);
// }

// export function getTicketById(id) {
//   return read().find(t => t.id === id);
// }
