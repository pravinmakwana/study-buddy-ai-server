import express from "express";
import cors from "cors";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { GoogleGenAI } from "@google/genai";

const app = express();

app.use(cors());
app.use(express.json({ limit: "50kb" }));

// ============================================================
// PATH CONFIGURATION
// ============================================================

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const questionsFile = path.join(
    __dirname,
    "data",
    "questions.json"
);

// ============================================================
// GEMINI CONFIGURATION
// ============================================================

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;

const GEMINI_MODEL =
    process.env.GEMINI_MODEL || "gemini-3.5-flash-lite";

let ai = null;

if (GEMINI_API_KEY) {

    ai = new GoogleGenAI({
        apiKey: GEMINI_API_KEY
    });

    console.log("Gemini API key detected.");

} else {

    console.log(
        "WARNING: GEMINI_API_KEY is missing."
    );
}

// ============================================================
// HOME / SERVER STATUS
// ============================================================

app.get("/", (req, res) => {

    res.json({
        message: "Study Buddy AI Backend is running!",
        ai: GEMINI_API_KEY
            ? "Gemini configured"
            : "Gemini API key missing",
        quiz: "Quiz API configured"
    });

});

// ============================================================
// LOAD QUIZ QUESTIONS
// ============================================================

function loadQuestions() {

    try {

        if (!fs.existsSync(questionsFile)) {

            console.error(
                "questions.json not found:",
                questionsFile
            );

            return [];
        }

        const data =
            fs.readFileSync(
                questionsFile,
                "utf8"
            );

        const questions =
            JSON.parse(data);

        if (!Array.isArray(questions)) {

            console.error(
                "questions.json must contain an array."
            );

            return [];
        }

        return questions;

    } catch (error) {

        console.error(
            "Unable to load questions.json:",
            error.message
        );

        return [];
    }
}

// ============================================================
// QUIZ - GET QUESTIONS
// ============================================================
//
// Example:
//
// /api/quiz/questions
//
// /api/quiz/questions?subject=Biology
//
// /api/quiz/questions?subject=Biology&difficulty=Easy&count=5
//
// IMPORTANT:
// correctAnswer and solution are NOT sent here.
// ============================================================

app.get(
    "/api/quiz/questions",
    (req, res) => {

        try {

            const subject =
                String(
                    req.query.subject || "General"
                ).trim();

            const difficulty =
                String(
                    req.query.difficulty || "All"
                ).trim();

            let count =
                parseInt(
                    req.query.count || "10",
                    10
                );

            // Keep quiz count between 1 and 20.
            if (isNaN(count)) {
                count = 10;
            }

            count =
                Math.max(
                    1,
                    Math.min(count, 20)
                );

            let questions =
                loadQuestions();

            // ------------------------------------------------
            // FILTER SUBJECT
            // ------------------------------------------------

            if (
                subject &&
                subject.toLowerCase() !== "general"
            ) {

                questions =
                    questions.filter(
                        question =>
                            String(
                                question.subject || ""
                            ).toLowerCase() ===
                            subject.toLowerCase()
                    );
            }

            // ------------------------------------------------
            // FILTER DIFFICULTY
            // ------------------------------------------------

            if (
                difficulty &&
                difficulty.toLowerCase() !== "all"
            ) {

                questions =
                    questions.filter(
                        question =>
                            String(
                                question.difficulty || ""
                            ).toLowerCase() ===
                            difficulty.toLowerCase()
                    );
            }

            // ------------------------------------------------
            // RANDOMIZE QUESTIONS
            // ------------------------------------------------

            questions =
                questions.sort(
                    () => Math.random() - 0.5
                );

            // ------------------------------------------------
            // LIMIT QUESTION COUNT
            // ------------------------------------------------

            questions =
                questions.slice(
                    0,
                    count
                );

            // ------------------------------------------------
            // CHECK WHETHER QUESTIONS EXIST
            // ------------------------------------------------

            if (questions.length === 0) {

                return res.status(404).json({

                    success: false,

                    error:
                        "No quiz questions found for the selected subject and difficulty."

                });
            }

            // ------------------------------------------------
            // REMOVE ANSWER AND SOLUTION
            // ------------------------------------------------

            const safeQuestions =
                questions.map(
                    question => ({

                        id: question.id,

                        subject:
                            question.subject || "",

                        topic:
                            question.topic || "",

                        difficulty:
                            question.difficulty || "",

                        question:
                            question.question || "",

                        optionA:
                            question.optionA || "",

                        optionB:
                            question.optionB || "",

                        optionC:
                            question.optionC || "",

                        optionD:
                            question.optionD || ""

                    })
                );

            res.json({

                success: true,

                count:
                    safeQuestions.length,

                questions:
                    safeQuestions

            });

        } catch (error) {

            console.error(
                "Quiz questions error:",
                error
            );

            res.status(500).json({

                success: false,

                error:
                    "Unable to load quiz questions."

            });
        }
    }
);

// ============================================================
// QUIZ - SUBMIT ANSWER
// ============================================================
//
// Android sends:
//
// {
//     "questionId": 1,
//     "selectedAnswer": "D"
// }
//
// Server checks the answer and returns:
//
// correct
// correctAnswer
// solution
// ============================================================

app.post(
    "/api/quiz/submit",
    (req, res) => {

        try {

            const questionId =
                Number(
                    req.body?.questionId
                );

            const selectedAnswer =
                String(
                    req.body?.selectedAnswer || ""
                )
                    .trim()
                    .toUpperCase();

            // ------------------------------------------------
            // VALIDATION
            // ------------------------------------------------

            if (
                !questionId ||
                !selectedAnswer
            ) {

                return res.status(400).json({

                    success: false,

                    error:
                        "Question ID and selected answer are required."

                });
            }

            // Only A/B/C/D allowed.
            if (
                ![
                    "A",
                    "B",
                    "C",
                    "D"
                ].includes(selectedAnswer)
            ) {

                return res.status(400).json({

                    success: false,

                    error:
                        "Selected answer must be A, B, C or D."

                });
            }

            // ------------------------------------------------
            // LOAD QUESTIONS
            // ------------------------------------------------

            const questions =
                loadQuestions();

            // ------------------------------------------------
            // FIND QUESTION
            // ------------------------------------------------

            const question =
                questions.find(
                    item =>
                        Number(item.id) ===
                        questionId
                );

            if (!question) {

                return res.status(404).json({

                    success: false,

                    error:
                        "Question not found."

                });
            }

            // ------------------------------------------------
            // GET CORRECT ANSWER
            // ------------------------------------------------

            const correctAnswer =
                String(
                    question.correctAnswer || ""
                )
                    .trim()
                    .toUpperCase();

            // ------------------------------------------------
            // CHECK ANSWER
            // ------------------------------------------------

            const isCorrect =
                selectedAnswer ===
                correctAnswer;

            // ------------------------------------------------
            // RETURN RESULT
            // ------------------------------------------------

            res.json({

                success: true,

                questionId:
                    question.id,

                selectedAnswer:
                    selectedAnswer,

                correct:
                    isCorrect,

                correctAnswer:
                    correctAnswer,

                solution:
                    question.solution || "",

                explanation:
                    question.explanation || ""

            });

        } catch (error) {

            console.error(
                "Quiz submit error:",
                error
            );

            res.status(500).json({

                success: false,

                error:
                    "Unable to check quiz answer."

            });
        }
    }
);

// ============================================================
// GEMINI - AI TUTOR
// ============================================================

async function generateGeminiAnswer(prompt) {

    if (!ai) {

        throw new Error(
            "Gemini API key is not configured."
        );
    }

    console.log(
        "Sending request to Gemini..."
    );

    const response =
        await ai.models.generateContent({

            model: GEMINI_MODEL,

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
}

// ============================================================
// AI TUTOR API
// ============================================================

app.post(
    "/api/ask",
    async (req, res) => {

        try {

            const question =
                req.body?.question?.trim();

            const subject =
                req.body?.subject?.trim() ||
                "General";

            // ------------------------------------------------
            // VALIDATE QUESTION
            // ------------------------------------------------

            if (!question) {

                return res.status(400).json({

                    error:
                        "Question is required."

                });
            }

            // ------------------------------------------------
            // CHECK GEMINI KEY
            // ------------------------------------------------

            if (!GEMINI_API_KEY) {

                return res.status(500).json({

                    error:
                        "Gemini API key is not configured on the server."

                });
            }

            // ------------------------------------------------
            // AI PROMPT
            // ------------------------------------------------

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
3. Never mention unrelated subjects unless the student asks.
4. Answer the exact question asked.
5. For simple questions, keep the answer reasonably short.
6. Explain difficult concepts step by step.
7. For Mathematics, show formulas and calculations clearly.
8. For Mathematics, use simple numerical examples when useful.
9. For Biology and Chemistry, explain scientific concepts accurately.
10. For Physics, explain formulas and physical concepts clearly.
11. For English, explain grammar, vocabulary and writing clearly.

=================================================
FORMATTING RULES
=================================================

- Use simple headings when useful.
- Put every heading on its own line.
- Put every bullet point on its own line.
- Use the bullet character "•".
- Do NOT use Markdown symbols such as #, ##, ###, **, *, or ---.
- Do NOT create unnecessary numbered sections.
- Keep paragraphs short.
- Do not repeat the question unnecessarily.
- Do not mention the API, backend, server or Demo Mode.

=================================================
EXAMPLE
=================================================

If the student asks:

"Square Root"

and the selected subject is Mathematics, provide a clear Mathematics explanation.

=================================================
FINAL INSTRUCTION
=================================================

Now answer the student's question.
`;

            // ------------------------------------------------
            // GENERATE ANSWER
            // ------------------------------------------------

            const answer =
                await generateGeminiAnswer(
                    prompt
                );

            res.json({

                success: true,

                answer:
                    answer

            });

        } catch (error) {

            console.error(
                "AI Tutor error:",
                error
            );

            const message =
                error?.message || "";

            // ------------------------------------------------
            // QUOTA ERROR
            // ------------------------------------------------

            if (
                message.includes("429") ||
                message.includes(
                    "RESOURCE_EXHAUSTED"
                ) ||
                message
                    .toLowerCase()
                    .includes("quota")
            ) {

                return res.status(429).json({

                    error:
                        "AI usage limit reached. Please try again later."

                });
            }

            // ------------------------------------------------
            // SERVER BUSY
            // ------------------------------------------------

            if (
                message.includes("503") ||
                message.includes(
                    "UNAVAILABLE"
                ) ||
                message
                    .toLowerCase()
                    .includes("high demand")
            ) {

                return res.status(503).json({

                    error:
                        "AI service is temporarily busy. Please try again."

                });
            }

            // ------------------------------------------------
            // MODEL ERROR
            // ------------------------------------------------

            if (
                message.includes("404") ||
                message
                    .toLowerCase()
                    .includes("not found")
            ) {

                return res.status(500).json({

                    error:
                        "The configured Gemini model is unavailable. Please check GEMINI_MODEL in Render."

                });
            }

            // ------------------------------------------------
            // GENERAL ERROR
            // ------------------------------------------------

            return res.status(500).json({

                error:
                    "Something went wrong while generating the AI response."

            });
        }
    }
);

// ============================================================
// START SERVER
// ============================================================

const PORT =
    process.env.PORT || 3000;

app.listen(
    PORT,
    () => {

        console.log(
            `Study Buddy AI server running on port ${PORT}`
        );

        console.log(
            `Quiz questions file: ${questionsFile}`
        );

        console.log(
            `Gemini model: ${GEMINI_MODEL}`
        );

        if (GEMINI_API_KEY) {

            console.log(
                "Gemini API key detected."
            );

        } else {

            console.log(
                "WARNING: GEMINI_API_KEY is missing."
            );
        }
    }
);