import express from "express";
import cors from "cors";
import OpenAI from "openai";

const app = express();

app.use(cors());
app.use(express.json({ limit: "20kb" }));

// -----------------------------------------
// OpenAI Configuration
// -----------------------------------------

const openai = new OpenAI({
    apiKey: process.env.OPENAI_API_KEY
});

// -----------------------------------------
// Test endpoint
// -----------------------------------------

app.get("/", (req, res) => {
    res.json({
        message: "Study Buddy AI Backend is running!",
        ai: process.env.OPENAI_API_KEY
            ? "OpenAI configured"
            : "OpenAI API key missing"
    });
});

// -----------------------------------------
// AI Tutor
// -----------------------------------------

app.post("/api/ask", async (req, res) => {

    try {

        const question =
            req.body?.question?.trim();

        const subject =
            req.body?.subject?.trim() || "General";

        // Validate question
        if (!question) {

            return res.status(400).json({
                error: "Question is required"
            });
        }

        // Check API key
        if (!process.env.OPENAI_API_KEY) {

            console.error(
                "OPENAI_API_KEY is not configured."
            );

            return res.status(500).json({
                error: "OpenAI API key is not configured on the server."
            });
        }

        // -----------------------------------------
        // AI Tutor Instructions
        // -----------------------------------------

        const instructions = `
You are Study Buddy AI, a friendly educational AI tutor.

Your job is to help students understand academic topics clearly.

Subject: ${subject}

Rules:

1. Explain concepts in simple and student-friendly language.
2. Give step-by-step explanations when appropriate.
3. Use examples when they help understanding.
4. For Mathematics and Physics, show important formulas and calculations clearly.
5. For Biology and Chemistry, explain scientific concepts accurately.
6. For English, explain grammar, vocabulary, comprehension, and writing clearly.
7. If the question is ambiguous, ask for clarification.
8. Do not unnecessarily make answers very long.
9. Use headings and bullet points when useful.
10. Do not say that you are in Demo Mode.
11. Answer the student's actual question directly.
12. If the student asks for practice questions, provide useful practice questions.
13. If the student asks for an example, provide a simple example.
14. Keep the tone encouraging and educational.
`;

        // -----------------------------------------
        // Call OpenAI
        // -----------------------------------------

        const response =
            await openai.responses.create({

                model: "gpt-5.6-luna",

                instructions: instructions,

                input: question

            });

        // -----------------------------------------
        // Get AI answer
        // -----------------------------------------

        const answer =
            response.output_text?.trim();

        if (!answer) {

            return res.status(500).json({
                error: "OpenAI returned an empty response."
            });
        }

        // -----------------------------------------
        // Send response to Android app
        // -----------------------------------------

        return res.json({
            answer: answer
        });

    } catch (error) {

        console.error(
            "OpenAI error:",
            error
        );

        // OpenAI API error
        if (error?.status) {

            return res.status(error.status).json({
                error:
                    error?.message ||
                    "OpenAI API request failed."
            });
        }

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

    if (process.env.OPENAI_API_KEY) {

        console.log(
            "OpenAI API key detected."
        );

    } else {

        console.log(
            "WARNING: OPENAI_API_KEY is missing."
        );
    }
});