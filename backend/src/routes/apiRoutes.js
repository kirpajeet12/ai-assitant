import { Router } from "express";
import { createAiPizzaOrder } from "../controllers/aiOrderController.js";

const router = Router();

// AI: build Pizza 64 order from text "transcript"
router.post("/ai/pizza64-order", createAiPizzaOrder);

export default router;
