import express from "express";
import cors from "cors";
import fs from "fs";
import path from "path";
import crypto from "crypto";
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

const usersFile = path.join(
    __dirname,
    "data",
    "users.json"
);

// ============================================================
// GEMINI CONFIGURATION
// ============================================================

const GEMINI_API_KEY =
    process.env.GEMINI_API_KEY;

const GEMINI_MODEL =
    process.env.GEMINI_MODEL ||
    "gemini-3.5-flash-lite";

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

        message:
            "Study Buddy AI Backend is running!",

        ai:
            GEMINI_API_KEY
                ? "Gemini configured"
                : "Gemini API key missing",

        quiz:
            "Quiz API configured",

        auth:
            "Authentication API configured"

    });

});

// ============================================================
// USER AUTHENTICATION HELPER FUNCTIONS
// ============================================================

function loadUsers() {

    try {

        if (!fs.existsSync(usersFile)) {

            fs.writeFileSync(
                usersFile,
                JSON.stringify(
                    {
                        users: []
                    },
                    null,
                    2
                )
            );

            return [];
        }

        const data =
            fs.readFileSync(
                usersFile,
                "utf8"
            );

        if (!data.trim()) {

            return [];
        }

        const parsed =
            JSON.parse(data);

        // Support:
        // { "users": [] }

        if (
            parsed &&
            Array.isArray(parsed.users)
        ) {

            return parsed.users;
        }

        // Also support:
        // [ ... ]

        if (
            Array.isArray(parsed)
        ) {

            return parsed;
        }

        console.error(
            "users.json must contain a users array."
        );

        return [];

    } catch (error) {

        console.error(
            "Unable to load users.json:",
            error.message
        );

        return [];
    }
}


// ============================================================
// SAVE USERS
// ============================================================

function saveUsers(users) {

    try {

        fs.writeFileSync(

            usersFile,

            JSON.stringify(
                {
                    users: users
                },
                null,
                2
            )

        );

        return true;

    } catch (error) {

        console.error(
            "Unable to save users.json:",
            error.message
        );

        return false;
    }
}


// ============================================================
// NORMALIZE EMAIL
// ============================================================

function normalizeEmail(email) {

    return String(
        email || ""
    )
        .trim()
        .toLowerCase();
}


// ============================================================
// HASH PASSWORD
// ============================================================

function hashPassword(
    password,
    salt = null
) {

    const passwordSalt =
        salt ||
        crypto.randomBytes(16).toString("hex");

    const hash =
        crypto
            .scryptSync(
                password,
                passwordSalt,
                64
            )
            .toString("hex");

    return {

        salt:
            passwordSalt,

        hash:
            hash

    };
}


// ============================================================
// VERIFY PASSWORD
// ============================================================

function verifyPassword(
    password,
    salt,
    storedHash
) {

    try {

        if (
            !password ||
            !salt ||
            !storedHash
        ) {

            return false;
        }

        const hash =
            crypto
                .scryptSync(
                    password,
                    salt,
                    64
                )
                .toString("hex");

        const hashBuffer =
            Buffer.from(
                hash,
                "hex"
            );

        const storedBuffer =
            Buffer.from(
                storedHash,
                "hex"
            );

        if (
            hashBuffer.length !==
            storedBuffer.length
        ) {

            return false;
        }

        return crypto.timingSafeEqual(
            hashBuffer,
            storedBuffer
        );

    } catch (error) {

        console.error(
            "Password verification error:",
            error.message
        );

        return false;
    }
}


// ============================================================
// CREATE AUTH TOKEN
// ============================================================

function createAuthToken() {

    return crypto
        .randomBytes(32)
        .toString("hex");
}


// ============================================================
// GET AUTH TOKEN FROM REQUEST
// ============================================================

function getTokenFromRequest(req) {

    const authorization =
        req.headers.authorization ||
        "";

    if (
        !authorization.startsWith(
            "Bearer "
        )
    ) {

        return null;
    }

    return authorization
        .substring(7)
        .trim();
}


// ============================================================
// GET USER FROM AUTH TOKEN
// ============================================================

function getUserFromRequest(req) {

    const token =
        getTokenFromRequest(req);

    if (!token) {

        return null;
    }

    const users =
        loadUsers();

    return users.find(
        user =>
            user.authToken === token
    ) || null;
}


// ============================================================
// AUTH - SIGN UP
// ============================================================

app.post(
    "/api/auth/signup",
    (req, res) => {

        try {

            console.log(
                "Signup request received."
            );

            const name =
                String(
                    req.body?.name || ""
                ).trim();

            const email =
                normalizeEmail(
                    req.body?.email
                );

            const password =
                String(
                    req.body?.password || ""
                );

            const confirmPassword =
                String(
                    req.body?.confirmPassword || ""
                );

            // ------------------------------------------------
            // VALIDATE NAME
            // ------------------------------------------------

            if (!name) {

                return res.status(400).json({

                    success: false,

                    error:
                        "Name is required."

                });
            }

            // ------------------------------------------------
            // VALIDATE EMAIL
            // ------------------------------------------------

            if (!email) {

                return res.status(400).json({

                    success: false,

                    error:
                        "Email is required."

                });
            }

            // ------------------------------------------------
            // VALIDATE EMAIL FORMAT
            // ------------------------------------------------

            const emailRegex =
                /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

            if (
                !emailRegex.test(email)
            ) {

                return res.status(400).json({

                    success: false,

                    error:
                        "Please enter a valid email address."

                });
            }

            // ------------------------------------------------
            // VALIDATE PASSWORD
            // ------------------------------------------------

            if (
                password.length < 6
            ) {

                return res.status(400).json({

                    success: false,

                    error:
                        "Password must be at least 6 characters."

                });
            }

            // ------------------------------------------------
            // VALIDATE CONFIRM PASSWORD
            // ------------------------------------------------

            if (
                password !==
                confirmPassword
            ) {

                return res.status(400).json({

                    success: false,

                    error:
                        "Passwords do not match."

                });
            }

            // ------------------------------------------------
            // LOAD USERS
            // ------------------------------------------------

            const users =
                loadUsers();

            // ------------------------------------------------
            // CHECK DUPLICATE EMAIL
            // ------------------------------------------------

            const existingUser =
                users.find(
                    user =>
                        normalizeEmail(
                            user.email
                        ) === email
                );

            if (existingUser) {

                return res.status(409).json({

                    success: false,

                    error:
                        "An account already exists with this email."

                });
            }

            // ------------------------------------------------
            // HASH PASSWORD
            // ------------------------------------------------

            const passwordData =
                hashPassword(
                    password
                );

            // ------------------------------------------------
            // CREATE USER
            // ------------------------------------------------

            const newUser = {

                id:
                    crypto.randomUUID(),

                name:
                    name,

                email:
                    email,

                passwordHash:
                    passwordData.hash,

                passwordSalt:
                    passwordData.salt,

                authToken:
                    null,

                createdAt:
                    new Date().toISOString()

            };

            // ------------------------------------------------
            // ADD USER
            // ------------------------------------------------

            users.push(
                newUser
            );

            // ------------------------------------------------
            // SAVE USER
            // ------------------------------------------------

            const saved =
                saveUsers(
                    users
                );

            if (!saved) {

                return res.status(500).json({

                    success: false,

                    error:
                        "Unable to create account."

                });
            }

            console.log(
                "New user registered:",
                email
            );

            // ------------------------------------------------
            // RESPONSE
            // ------------------------------------------------

            return res.status(201).json({

                success: true,

                message:
                    "Account created successfully."

            });

        } catch (error) {

            console.error(
                "Signup error:",
                error
            );

            return res.status(500).json({

                success: false,

                error:
                    "Something went wrong while creating the account."

            });
        }
    }
);


// ============================================================
// AUTH - SIGN IN
// ============================================================

app.post(
    "/api/auth/signin",
    (req, res) => {

        try {

            console.log(
                "Signin request received."
            );

            const email =
                normalizeEmail(
                    req.body?.email
                );

            const password =
                String(
                    req.body?.password || ""
                );

            // ------------------------------------------------
            // VALIDATE INPUT
            // ------------------------------------------------

            if (
                !email ||
                !password
            ) {

                return res.status(400).json({

                    success: false,

                    error:
                        "Email and password are required."

                });
            }

            // ------------------------------------------------
            // LOAD USERS
            // ------------------------------------------------

            const users =
                loadUsers();

            // ------------------------------------------------
            // FIND USER
            // ------------------------------------------------

            const userIndex =
                users.findIndex(
                    user =>
                        normalizeEmail(
                            user.email
                        ) === email
                );

            if (
                userIndex === -1
            ) {

                return res.status(401).json({

                    success: false,

                    error:
                        "Invalid email or password."

                });
            }

            const user =
                users[userIndex];

            // ------------------------------------------------
            // VERIFY PASSWORD
            // ------------------------------------------------

            const passwordCorrect =
                verifyPassword(
                    password,
                    user.passwordSalt,
                    user.passwordHash
                );

            if (!passwordCorrect) {

                return res.status(401).json({

                    success: false,

                    error:
                        "Invalid email or password."

                });
            }

            // ------------------------------------------------
            // CREATE AUTH TOKEN
            // ------------------------------------------------

            const authToken =
                createAuthToken();

            // ------------------------------------------------
            // SAVE AUTH TOKEN
            // ------------------------------------------------

            users[userIndex].authToken =
                authToken;

            const saved =
                saveUsers(
                    users
                );

            if (!saved) {

                return res.status(500).json({

                    success: false,

                    error:
                        "Unable to create authentication session."

                });
            }

            console.log(
                "User signed in:",
                email
            );

            // ------------------------------------------------
            // RESPONSE
            // ------------------------------------------------

            return res.json({

                success: true,

                message:
                    "Sign in successful.",

                token:
                    authToken,

                user: {

                    id:
                        user.id,

                    name:
                        user.name,

                    email:
                        user.email

                }

            });

        } catch (error) {

            console.error(
                "Signin error:",
                error
            );

            return res.status(500).json({

                success: false,

                error:
                    "Something went wrong while signing in."

            });
        }
    }
);


// ============================================================
// AUTH - GET CURRENT USER
// ============================================================

app.get(
    "/api/auth/me",
    (req, res) => {

        try {

            const user =
                getUserFromRequest(
                    req
                );

            if (!user) {

                return res.status(401).json({

                    success: false,

                    error:
                        "Invalid or expired authentication token."

                });
            }

            return res.json({

                success: true,

                user: {

                    id:
                        user.id,

                    name:
                        user.name,

                    email:
                        user.email

                }

            });

        } catch (error) {

            console.error(
                "Auth me error:",
                error
            );

            return res.status(500).json({

                success: false,

                error:
                    "Unable to verify authentication."

            });
        }
    }
);


// ============================================================
// AUTH - LOGOUT
// ============================================================

app.post(
    "/api/auth/logout",
    (req, res) => {

        try {

            const token =
                getTokenFromRequest(
                    req
                );

            if (!token) {

                return res.json({

                    success: true,

                    message:
                        "Already logged out."

                });
            }

            const users =
                loadUsers();

            const userIndex =
                users.findIndex(
                    user =>
                        user.authToken ===
                        token
                );

            if (
                userIndex !== -1
            ) {

                users[userIndex].authToken =
                    null;

                saveUsers(
                    users
                );
            }

            return res.json({

                success: true,

                message:
                    "Logged out successfully."

            });

        } catch (error) {

            console.error(
                "Logout error:",
                error
            );

            return res.status(500).json({

                success: false,

                error:
                    "Unable to logout."

            });
        }
    }
);


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

app.get(
    "/api/quiz/questions",
    (req, res) => {

        try {

            const subject =
                String(
                    req.query.subject ||
                    "General"
                ).trim();

            const difficulty =
                String(
                    req.query.difficulty ||
                    "All"
                ).trim();

            let count =
                parseInt(
                    req.query.count ||
                    "10",
                    10
                );

            // ------------------------------------------------
            // VALIDATE QUESTION COUNT
            // ------------------------------------------------

            if (isNaN(count)) {

                count = 10;
            }

            count =
                Math.max(
                    1,
                    Math.min(
                        count,
                        20
                    )
                );

            // ------------------------------------------------
            // LOAD QUESTIONS
            // ------------------------------------------------

            let questions =
                loadQuestions();

            if (
                questions.length === 0
            ) {

                return res.status(500).json({

                    success: false,

                    error:
                        "No questions are available on the server."

                });
            }

            // ------------------------------------------------
            // FILTER SUBJECT
            // ------------------------------------------------

            if (
                subject &&
                subject.toLowerCase() !==
                    "general"
            ) {

                questions =
                    questions.filter(
                        question =>
                            String(
                                question.subject ||
                                ""
                            )
                                .trim()
                                .toLowerCase() ===
                            subject.toLowerCase()
                    );
            }

            // ------------------------------------------------
            // FILTER DIFFICULTY
            // ------------------------------------------------

            if (
                difficulty &&
                difficulty.toLowerCase() !==
                    "all"
            ) {

                questions =
                    questions.filter(
                        question =>
                            String(
                                question.difficulty ||
                                ""
                            )
                                .trim()
                                .toLowerCase() ===
                            difficulty.toLowerCase()
                    );
            }

            // ------------------------------------------------
            // RANDOMIZE
            // ------------------------------------------------

            questions =
                questions.sort(
                    () =>
                        Math.random() - 0.5
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
            // NO QUESTIONS FOUND
            // ------------------------------------------------

            if (
                questions.length === 0
            ) {

                return res.status(404).json({

                    success: false,

                    error:
                        "No quiz questions found for the selected subject and difficulty."

                });
            }

            // ------------------------------------------------
            // REMOVE ANSWERS
            // ------------------------------------------------

            const safeQuestions =
                questions.map(
                    question => ({

                        id:
                            question.id,

                        subject:
                            question.subject ||
                            "",

                        topic:
                            question.topic ||
                            "",

                        difficulty:
                            question.difficulty ||
                            "",

                        question:
                            question.question ||
                            "",

                        optionA:
                            question.optionA ||
                            "",

                        optionB:
                            question.optionB ||
                            "",

                        optionC:
                            question.optionC ||
                            "",

                        optionD:
                            question.optionD ||
                            ""

                    })
                );

            // ------------------------------------------------
            // RESPONSE
            // ------------------------------------------------

            return res.json({

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

            return res.status(500).json({

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

app.post(
    "/api/quiz/submit",
    (req, res) => {

        try {

            // ------------------------------------------------
            // LOG REQUEST
            // ------------------------------------------------

            console.log(
                "Quiz submit request:",
                JSON.stringify(req.body)
            );

            // ------------------------------------------------
            // GET QUESTION ID
            // ------------------------------------------------

            const rawQuestionId =
                req.body?.questionId ??
                req.body?.id;

            const questionId =
                Number(
                    rawQuestionId
                );

            // ------------------------------------------------
            // GET SELECTED ANSWER
            // ------------------------------------------------

            let selectedAnswer =
                String(
                    req.body?.selectedAnswer ??
                    req.body?.answer ??
                    req.body?.selectedOption ??
                    ""
                ).trim();

            // ------------------------------------------------
            // VALIDATE QUESTION ID
            // ------------------------------------------------

            if (
                !Number.isInteger(
                    questionId
                ) ||
                questionId <= 0
            ) {

                console.log(
                    "Invalid question ID:",
                    rawQuestionId
                );

                return res.status(400).json({

                    success: false,

                    error:
                        "Valid questionId is required."

                });
            }

            // ------------------------------------------------
            // VALIDATE ANSWER
            // ------------------------------------------------

            if (!selectedAnswer) {

                console.log(
                    "Selected answer is missing."
                );

                return res.status(400).json({

                    success: false,

                    error:
                        "Selected answer is required."

                });
            }

            // ------------------------------------------------
            // LOAD QUESTIONS
            // ------------------------------------------------

            const questions =
                loadQuestions();

            if (
                questions.length === 0
            ) {

                return res.status(500).json({

                    success: false,

                    error:
                        "Unable to load quiz questions."

                });
            }

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

                console.log(
                    "Question not found:",
                    questionId
                );

                return res.status(404).json({

                    success: false,

                    error:
                        "Question not found."

                });
            }

            // ------------------------------------------------
            // NORMALIZE ANSWER
            // ------------------------------------------------

            const originalAnswer =
                selectedAnswer;

            selectedAnswer =
                selectedAnswer
                    .trim()
                    .toUpperCase();

            // ------------------------------------------------
            // IF ANSWER IS A/B/C/D
            // ------------------------------------------------

            if (
                [
                    "A",
                    "B",
                    "C",
                    "D"
                ].includes(
                    selectedAnswer
                )
            ) {

                // Already valid.

            } else {

                // ------------------------------------------------
                // CONVERT OPTION TEXT TO A/B/C/D
                // ------------------------------------------------

                const optionA =
                    String(
                        question.optionA ||
                        ""
                    )
                        .trim()
                        .toUpperCase();

                const optionB =
                    String(
                        question.optionB ||
                        ""
                    )
                        .trim()
                        .toUpperCase();

                const optionC =
                    String(
                        question.optionC ||
                        ""
                    )
                        .trim()
                        .toUpperCase();

                const optionD =
                    String(
                        question.optionD ||
                        ""
                    )
                        .trim()
                        .toUpperCase();

                if (
                    selectedAnswer ===
                    optionA
                ) {

                    selectedAnswer =
                        "A";

                } else if (
                    selectedAnswer ===
                    optionB
                ) {

                    selectedAnswer =
                        "B";

                } else if (
                    selectedAnswer ===
                    optionC
                ) {

                    selectedAnswer =
                        "C";

                } else if (
                    selectedAnswer ===
                    optionD
                ) {

                    selectedAnswer =
                        "D";

                } else {

                    console.log(
                        "Invalid selected answer:",
                        originalAnswer
                    );

                    return res.status(400).json({

                        success: false,

                        error:
                            "Selected answer must be A, B, C or D, or match one of the question options."

                    });
                }
            }

            // ------------------------------------------------
            // GET CORRECT ANSWER
            // ------------------------------------------------

            const correctAnswer =
                String(
                    question.correctAnswer ||
                    ""
                )
                    .trim()
                    .toUpperCase();

            // ------------------------------------------------
            // VALIDATE CORRECT ANSWER
            // ------------------------------------------------

            if (
                ![
                    "A",
                    "B",
                    "C",
                    "D"
                ].includes(
                    correctAnswer
                )
            ) {

                console.error(
                    "Invalid correctAnswer in questions.json:",
                    question.id,
                    question.correctAnswer
                );

                return res.status(500).json({

                    success: false,

                    error:
                        "Invalid correct answer configured for this question."

                });
            }

            // ------------------------------------------------
            // CHECK ANSWER
            // ------------------------------------------------

            const isCorrect =
                selectedAnswer ===
                correctAnswer;

            // ------------------------------------------------
            // LOG RESULT
            // ------------------------------------------------

            console.log(
                `Question ${questionId}: Selected=${selectedAnswer}, Correct=${correctAnswer}, Result=${isCorrect}`
            );

            // ------------------------------------------------
            // RETURN RESULT
            // ------------------------------------------------

            return res.json({

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
                    question.solution ||
                    "",

                explanation:
                    question.explanation ||
                    ""

            });

        } catch (error) {

            console.error(
                "Quiz submit error:",
                error
            );

            return res.status(500).json({

                success: false,

                error:
                    "Unable to check quiz answer."

            });
        }
    }
);


// ============================================================
// GEMINI - GENERATE ANSWER
// ============================================================

async function generateGeminiAnswer(
    prompt
) {

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

            model:
                GEMINI_MODEL,

            contents:
                prompt

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

            return res.json({

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
                    .includes(
                        "high demand"
                    )
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
                    .includes(
                        "not found"
                    )
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
            `Users file: ${usersFile}`
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