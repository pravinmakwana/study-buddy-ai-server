import express from "express";
import cors from "cors";
import { GoogleGenAI } from "@google/genai";

const app = express();

app.use(cors());
app.use(express.json({ limit: "20kb" }));

const ai = new GoogleGenAI({
    apiKey: process.env.GEMINI_API_KEY
});


/* =========================================================
   HOME / SERVER STATUS
   ========================================================= */

app.get("/", (req, res) => {

    res.json({
        message: "Study Buddy AI Backend is running!",

        ai: process.env.GEMINI_API_KEY
            ? "Gemini configured"
            : "Gemini API key missing"
    });

});


/* =========================================================
   GEMINI AI FUNCTION
   ========================================================= */

async function generateGeminiAnswer(prompt) {

    try {

        console.log("Sending request to Gemini...");

        const response =
            await ai.models.generateContent({

                model: "gemini-3.5-flash-lite",

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
            "Gemini error:",
            error?.message || error
        );

        throw error;

    }

}


/* =========================================================
   AI TUTOR API
   ========================================================= */

app.post("/api/ask", async (req, res) => {

    try {

        /* -------------------------------------------------
           GET QUESTION
           ------------------------------------------------- */

        const question =
            req.body?.question?.trim();


        /* -------------------------------------------------
           GET SUBJECT
           ------------------------------------------------- */

        const subject =
            req.body?.subject?.trim() ||
            "General";


        /* -------------------------------------------------
           VALIDATE QUESTION
           ------------------------------------------------- */

        if (!question) {

            return res.status(400).json({

                error:
                    "Question is required."

            });

        }


        /* -------------------------------------------------
           CHECK API KEY
           ------------------------------------------------- */

        if (!process.env.GEMINI_API_KEY) {

            console.error(
                "GEMINI_API_KEY is missing."
            );

            return res.status(500).json({

                error:
                    "Gemini API key is not configured on the server."

            });

        }


        /* =================================================
           AI PROMPT
           ================================================= */

        const prompt = `

You are Study Buddy AI, an educational AI tutor.

IMPORTANT:
The student's selected subject is: ${subject}

The student's question is:

${question}


=================================================
SUBJECT RULES
=================================================

You MUST answer according to the selected subject.

- If the selected subject is Mathematics, answer as a Mathematics tutor.
- If the selected subject is Physics, answer as a Physics tutor.
- If the selected subject is Chemistry, answer as a Chemistry tutor.
- If the selected subject is Biology, answer as a Biology tutor.
- If the selected subject is English, answer as an English tutor.
- If the selected subject is General, answer generally.


=================================================
IMPORTANT SUBJECT BEHAVIOR
=================================================

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


=================================================
FORMATTING RULES
=================================================

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


=================================================
EXAMPLE
=================================================

If the student asks:

"Square Root"

and the selected subject is Mathematics, provide a clear Mathematics explanation such as:

What is a Square Root?

A square root of a number is a value that, when multiplied by itself, gives the original number.

Examples:

• √4 = 2 because 2 × 2 = 4
• √9 = 3 because 3 × 3 = 9
• √16 = 4 because 4 × 4 = 16

Do not discuss Biology unless the student specifically asks about Biology.


=================================================
FINAL INSTRUCTION
=================================================

Now answer the student's question.
`;


        /* -------------------------------------------------
           CALL GEMINI
           ------------------------------------------------- */

        const answer =
            await generateGeminiAnswer(prompt);


        /* -------------------------------------------------
           SUCCESS RESPONSE
           ------------------------------------------------- */

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
            "";


        /* =================================================
           429 - QUOTA EXCEEDED
           ================================================= */

        if (
            message.includes("429") ||
            message.includes("RESOURCE_EXHAUSTED") ||
            message.toLowerCase().includes("quota")
        ) {

            return res.status(429).json({

                error:
                    "AI usage limit reached. Please try again later."

            });

        }


        /* =================================================
           503 - GEMINI TEMPORARILY BUSY
           ================================================= */

        if (
            message.includes("503") ||
            message.includes("UNAVAILABLE") ||
            message.toLowerCase().includes("high demand")
        ) {

            return res.status(503).json({

                error:
                    "AI service is temporarily busy. Please try again in a few seconds."

            });

        }


        /* =================================================
           OTHER ERROR
           ================================================= */

        return res.status(500).json({

            error:
                "Something went wrong while generating the AI response."

        });

    }

});


/* =========================================================
   START SERVER
   ========================================================= */

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