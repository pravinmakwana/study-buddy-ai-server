import express from "express";
import cors from "cors";

const app = express();

app.use(cors());
app.use(express.json({ limit: "20kb" }));

// Test endpoint
app.get("/", (req, res) => {
    res.json({
        message: "Study Buddy AI Backend is running!"
    });
});

// Demo AI Tutor
app.post("/api/ask", async (req, res) => {

    const question = req.body?.question?.trim();

    if (!question) {
        return res.status(400).json({
            error: "Question is required"
        });
    }

    let answer;

    const lowerQuestion = question.toLowerCase();

    if (
        lowerQuestion.includes("human heart") ||
        lowerQuestion.includes("heart")
    ) {

        answer =
            "The human heart is a muscular organ that pumps blood throughout the body. " +
            "It has four chambers: two atria and two ventricles. " +
            "The right side of the heart sends deoxygenated blood to the lungs, " +
            "while the left side sends oxygen-rich blood to the rest of the body.";

    } else if (
        lowerQuestion.includes("photosynthesis")
    ) {

        answer =
            "Photosynthesis is the process by which green plants make their food " +
            "using sunlight, carbon dioxide, and water. " +
            "It mainly takes place in the leaves and produces glucose and oxygen.";

    } else if (
        lowerQuestion.includes("gravity")
    ) {

        answer =
            "Gravity is the force that attracts objects toward each other. " +
            "On Earth, gravity pulls objects toward the Earth's center and gives " +
            "objects their weight.";

    } else {

        answer =
            "This is Demo Mode. Your question was: \"" +
            question +
            "\"\n\n" +
            "The AI Tutor backend is working correctly. " +
            "Real AI answers will be enabled when OpenAI API credits are available.";
    }

    res.json({
        answer: answer
    });
});

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
    console.log(`Study Buddy AI server running on port ${PORT}`);
});