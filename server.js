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

// -----------------------------------------
// Gemini AI Function
// -----------------------------------------

async function generateGeminiAnswer(prompt) {

    const maxAttempts = 3;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {

        try {

            console.log(
                `Gemini request attempt ${attempt}`
            );

            const response =
                await ai.models.generateContent({

                    model: "gemini-3.8-flash",

                    contents: prompt

                });

            const answer =
                response.text?.trim();

            if (!answer) {

                throw new Error(
                    "Gemini returned an empty response."
                );

            }

            return answer;

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

            if (
                !isTemporaryError ||
                attempt === maxAttempts
            ) {

                throw error;

            }

            const waitTime =
                attempt * 2000;

            console.log(
                `Waiting ${waitTime}ms before retry...`
            );

            await new Promise(
                resolve =>
                    setTimeout(
                        resolve,
                        waitTime
                    )
            );
        }
    }

    throw new Error(
        "Gemini service is temporarily unavailable."
    );
}

// -----------------------------------------
// AI Tutor
// -----------------------------------------

app.post("/api/ask", async (req, res) => {

    try {

        const question =
            req.body?.question?.trim();

        const subject =
            req.body?.subject?.trim() ||
            "General";

        // -----------------------------------------
        // Validate question
        // -----------------------------------------

        if (!question) {

            return res.status(400).json({
                error: "Question is required"
            });

        }

        // -----------------------------------------
        // Check API key
        // -----------------------------------------

        if (!process.env.GEMINI_API_KEY) {

            console.error(
                "GEMINI_API_KEY is missing."
            );

            return res.status(500).json({
                error:
                    "Gemini API key is not configured on the server."
            });

        }

        // -----------------------------------------
        // Study Buddy AI Prompt
        // -----------------------------------------

        const prompt = `
You are Study Buddy AI, an educational AI tutor.

IMPORTANT:
The student's selected subject is: ${subject}

The student's question is:
${question}

You MUST answer according to the selected subject.

SUBJECT RULES:

- If the selected subject is Mathematics, answer as a Mathematics tutor.
- If the selected subject is Physics, answer as a Physics tutor.
- If the selected subject is Chemistry, answer as a Chemistry tutor.
- If the selected subject is Biology, answer as a Biology tutor.
- If the selected subject is English, answer as an English tutor.
- If the selected subject is General, answer generally.

IMPORTANT SUBJECT BEHAVIOR:

1. Never change the selected subject.
2. Never say that the student is in another subject.
3. Never mention Biology when Mathematics is selected unless the student specifically asks about Biology.
4. Never add unrelated subject examples.
5. Answer the exact question asked by the student.
6. For simple questions, keep the answer reasonably short.
7. Explain difficult concepts step by step.
8. For Mathematics, show formulas and calculations clearly.
9. For Mathematics, use simple numerical examples when useful.
10. For Biology and Chemistry, explain scientific concepts accurately.
11. For Physics, explain formulas and physical concepts clearly.
12. For English, explain grammar, vocabulary and writing clearly.

FORMATTING RULES:

- Use simple headings when useful.
- Put every heading on its own line.
- Put every bullet point on its own line.
- Use the bullet character "•".
- Do NOT use Markdown symbols such as #, ##, ###, **, *, or ---.
- Do NOT create unnecessary numbered sections.
- Do NOT put numbers such as "3." on a separate line unless they are part of a numbered list.
- Keep paragraphs short.
- Do not repeat the question unnecessarily.
- Do not mention the API, backend, server or Demo Mode.

For example, if the student asks:

"Square Root"

and the selected subject is Mathematics, provide a clear Mathematics explanation such as:

What is a Square Root?

A square root of a number is a value that, when multiplied by itself, gives the original number.

Examples:

• √4 = 2 because 2 × 2 = 4
• √9 = 3 because 3 × 3 = 9
• √16 = 4 because 4 × 4 = 16

Do not discuss Biology unless the student specifically asks about Biology.

Now answer the student's question.
`;

        // -----------------------------------------
        // Generate answer
        // -----------------------------------------

        const answer =
            await generateGeminiAnswer(prompt);

        // -----------------------------------------
        // Send answer to Android
        // -----------------------------------------

        return res.json({
            answer: answer
        });

    } catch (error) {

        console.error(
            "AI Tutor error:",
            error
        );

        const message =
            error?.message ||
            "Something went wrong while generating the AI response.";

        // Temporary Gemini availability problem
        if (
            message.includes("503") ||
            message.includes("UNAVAILABLE") ||
            message.includes("high demand")
        ) {

            return res.status(503).json({
                error:
                    "AI service is temporarily busy. Please try again in a few seconds."
            });

        }

        return res.status(500).json({
            error: message
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