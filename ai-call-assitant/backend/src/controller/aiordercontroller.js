import { buildPizza64OrderFromText } from "../services/pizza64OrderAgent.js";

export const createAiPizzaOrder = async (req, res) => {
  try {
    const { transcript } = req.body;

    if (!transcript || transcript.trim().length === 0) {
      return res
        .status(400)
        .json({ success: false, error: "transcript is required" });
    }

    const result = await buildPizza64OrderFromText(transcript);

    return res.json({ success: true, data: result });
  } catch (err) {
    console.error("Error in createAiPizzaOrder:", err);
    return res.status(500).json({
      success: false,
      error: "Failed to build order from transcript",
    });
  }
};
