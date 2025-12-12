import express from "express";
import cors from "cors";
import "dotenv/config";

const app = express();
app.use(cors());
app.use(express.json());

app.get("/health", (req, res) => {
  res.json({ status: "ok", message: "backend is running" });
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log("Server listening on port", PORT));
