import express from "express";
import cors from "cors";
import { GoogleGenAI } from "@google/genai";

const app = express();

app.use(cors());
app.use(express.json({ limit: "20kb" }));

// -----------------------------------------
// Gemini Configuration
// -----------------------------------------

const ai = new GoogleGenAI({
    apiKey: process.env.GEMINI_API_KEY
});

// -----------------------------------------
// Test endpoint
// -----------------------------------------

app.get("/", (req, res) => {

    res.json({
        message: "Study Buddy AI Backend is running!",
        ai: process.env.GEMINI_API_KEY
            ? "Gemini configured"
            : "Gemini API key missing"
    });

});

//

async function generateGeminiAnswer(prompt) {

    const maxAttempts = 3;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {

        try {

            const response =
                await ai.models.generateContent({

                    model: "gemini-3.8-flash",

                    contents: prompt

                });

            return response.text?.trim();

        } catch (error) {

            console.error(
                `Gemini attempt ${attempt} failed:`,
                error?.message || error
            );

            const message =
                error?.message || "";

            const isTemporaryError =
                message.includes("503") ||
                message.includes("UNAVAILABLE") ||
                message.includes("high demand") ||
                error?.status === 503;

            if (!isTemporaryError ||
                    attempt === maxAttempts) {

                throw error;
            }

            // Wait before trying again
            const waitTime =
                attempt * 2000;

            await new Promise(resolve =>
                setTimeout(resolve, waitTime)
            );
        }
    }

    throw new Error(
        "Gemini service is temporarily unavailable."
    );
} -----------------------------------------
// AI Tutor
// -----------------------------------------

app.post("/api/ask", async (req, res) => {

    try {

        const question =
            req.body?.question?.trim();

        const subject =
            req.body?.subject?.trim() || "General";

        // -----------------------------------------
        // Validate question
        // -----------------------------------------

        if (!question) {

            return res.status(400).json({
                error: "Question is required"
            });

        }

        // -----------------------------------------
        // Check Gemini API key
        // -----------------------------------------

        if (!process.env.GEMINI_API_KEY) {

            console.error(
                "GEMINI_API_KEY is not configured."
            );

            return res.status(500).json({
                error:
                    "Gemini API key is not configured on the server."
            });

        }

        // -----------------------------------------
        // Study Buddy AI Tutor prompt
        // -----------------------------------------

        const prompt = `
You are Study Buddy AI, a friendly educational AI tutor.

The student selected this subject:

${subject}

The student asked:

${question}

Please answer the student's question using these rules:

1. Explain the concept in simple student-friendly language.
2. Give a step-by-step explanation when useful.
3. Give examples when helpful.
4. For Mathematics and Physics, show formulas and calculations clearly.
5. For Biology and Chemistry, explain scientific concepts accurately.
6. For English, explain grammar, vocabulary and writing clearly.
7. If the question asks for practice questions, provide practice questions.
8. If the question asks for an example, provide a simple example.
9. Use headings and bullet points when useful.
10. Keep the answer clear and reasonably concise.
11. Do not mention Demo Mode.
12. Do not mention the API or backend.
13. Answer the student's actual question directly.
14. Maintain a friendly and encouraging teaching style.
`;

        // -----------------------------------------
        // Call Gemini
        // -----------------------------------------

        const response =
            await ai.models.generateContent({

                model: "gemini-3.8-flash",

                contents: prompt

            });

        // -----------------------------------------
        // Get Gemini answer
        // -----------------------------------------

        const answer =
            response.text?.trim();

        if (!answer) {

            return res.status(500).json({
                error:
                    "Gemini returned an empty response."
            });

        }

        // -----------------------------------------
        // Send answer to Android
        // -----------------------------------------

        return res.json({
            answer: answer
        });

    } catch (error) {

        console.error(
            "Gemini error:",
            error
        );

        return res.status(500).json({
            error:
                error?.message ||
                "Something went wrong while generating the AI response."
        });

    }

});

// -----------------------------------------
// Start Server
// -----------------------------------------

const PORT =
    process.env.PORT || 3000;

app.listen(PORT, () => {

    console.log(
        `Study Buddy AI server running on port ${PORT}`
    );

    if (process.env.GEMINI_API_KEY) {

        console.log(
            "Gemini API key detected."
        );

    } else {

        console.log(
            "WARNING: GEMINI_API_KEY is missing."
        );

    }

});