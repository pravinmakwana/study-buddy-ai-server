import express from "express";
import cors from "cors";
import OpenAI from "openai";

const app = express();

app.use(cors());
app.use(express.json({ limit: "20kb" }));

const client = new OpenAI({
    apiKey: process.env.OPENAI_API_KEY
});

// Test endpoint
app.get("/", (req, res) => {
    res.json({
        message: "Study Buddy AI Backend is running!"
    });
});

// AI Tutor endpoint
app.post("/api/ask", async (req, res) => {

    const question = req.body?.question?.trim();

    if (!question) {
        return res.status(400).json({
            error: "Question is required"
        });
    }

    if (question.length > 4000) {
        return res.status(400).json({
            error: "Question is too long"
        });
    }

    try {

        const response = await client.responses.create({
            model: "gpt-5.6-luna",

            input: [
                {
                    role: "developer",
                    content:
                        "You are Study Buddy AI, a friendly and helpful study tutor. " +
                        "Explain answers clearly and simply. " +
                        "Use examples when useful. " +
                        "For school questions, provide step-by-step explanations."
                },
                {
                    role: "user",
                    content: question
                }
            ]
        });

        res.json({
            answer: response.output_text
        });

    } catch (error) {

        console.error(error);

        res.status(500).json({
            error: "Unable to generate AI response"
        });
    }
});

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
    console.log(`Study Buddy AI server running on port ${PORT}`);
});
