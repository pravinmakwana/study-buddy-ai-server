import express from "express";
import cors from "cors";
import crypto from "crypto";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { GoogleGenAI } from "@google/genai";
import pg from "pg";

const { Pool } = pg;

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();

app.use(cors());
app.use(express.json({ limit: "2mb" }));

// ============================================================
// CONFIGURATION
// ============================================================

const PORT = process.env.PORT || 10000;

const DATABASE_URL = process.env.DATABASE_URL;

const RESEND_API_KEY = process.env.RESEND_API_KEY;

const RESEND_FROM_EMAIL =
    process.env.RESEND_FROM_EMAIL ||
    "onboarding@resend.dev";

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;

const GEMINI_MODEL =
    process.env.GEMINI_MODEL ||
    "gemini-3.5-flash-lite";

const OPENAI_API_KEY =
    process.env.OPENAI_API_KEY || "";

// ============================================================
// POSTGRESQL
// ============================================================

if (!DATABASE_URL) {
    console.error("DATABASE_URL is not configured.");
    process.exit(1);
}

const pool = new Pool({
    connectionString: DATABASE_URL,
    ssl: {
        rejectUnauthorized: false
    },
    max: 10,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 10000
});

// ============================================================
// GEMINI
// ============================================================

let gemini = null;

if (GEMINI_API_KEY) {
    gemini = new GoogleGenAI({
        apiKey: GEMINI_API_KEY
    });

    console.log("Gemini AI service configured.");
} else {
    console.log("Gemini API key not configured.");
}

// ============================================================
// RESEND
// ============================================================

const resendConfigured = Boolean(RESEND_API_KEY);

if (resendConfigured) {
    console.log("Resend email service configured.");
} else {
    console.log("Resend email service not configured.");
}

// ============================================================
// FILE PATHS
// ============================================================

const DATA_DIR = path.join(__dirname, "data");

const QUESTIONS_FILE =
    path.join(DATA_DIR, "questions.json");

// ============================================================
// DATABASE INITIALIZATION
// ============================================================



async function initializeDatabase() {
    console.log("Initializing PostgreSQL database...");

    await pool.query(`
        CREATE TABLE IF NOT EXISTS users (
            id TEXT PRIMARY KEY DEFAULT
                ('user_' || gen_random_uuid()::text),
            name VARCHAR(150) NOT NULL,
            email VARCHAR(255) NOT NULL UNIQUE,
            password_hash TEXT NOT NULL,
            password_salt TEXT NOT NULL,
            auth_token TEXT,
            reset_otp_hash TEXT,
            reset_otp_expires_at TIMESTAMPTZ,
            reset_otp_verified_until TIMESTAMPTZ,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );
    `);

    // Repair the existing TEXT ID column.
    await pool.query(`
        ALTER TABLE users
        ALTER COLUMN id
        SET DEFAULT ('user_' || gen_random_uuid()::text);
    `);

    await pool.query(`
        CREATE INDEX IF NOT EXISTS idx_users_email
        ON users(email);
    `);

    await pool.query(`
        CREATE INDEX IF NOT EXISTS idx_users_auth_token
        ON users(auth_token);
    `);

    await pool.query(`
        CREATE TABLE IF NOT EXISTS quiz_results (
            id SERIAL PRIMARY KEY,
            user_id INTEGER,
            subject VARCHAR(150),
            difficulty VARCHAR(100),
            questions JSONB,
            answers JSONB,
            answer_details JSONB,
            score INTEGER DEFAULT 0,
            total_questions INTEGER DEFAULT 0,
            correct_answers INTEGER DEFAULT 0,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );
    `);

    await pool.query(`
        CREATE INDEX IF NOT EXISTS idx_quiz_results_user_id
        ON quiz_results(user_id);
    `);

    console.log("PostgreSQL database initialized successfully.");
}
// ============================================================
// PASSWORD FUNCTIONS
// ============================================================

function hashPassword(password) {

    const salt = crypto.randomBytes(16).toString("hex");

    const hash = crypto
        .scryptSync(password, salt, 64)
        .toString("hex");

    return {
        hash,
        salt
    };
}

function verifyPassword(password, storedHash, salt) {

    try {

        const hash = crypto
            .scryptSync(password, salt, 64)
            .toString("hex");

        return crypto.timingSafeEqual(
            Buffer.from(hash, "hex"),
            Buffer.from(storedHash, "hex")
        );

    } catch (error) {

        return false;
    }
}

// ============================================================
// TOKEN
// ============================================================

function generateToken() {

    return crypto
        .randomBytes(32)
        .toString("hex");
}

// ============================================================
// OTP
// ============================================================

function generateOTP() {

    return String(
        crypto.randomInt(100000, 1000000)
    );
}

function hashOTP(otp) {

    return crypto
        .createHash("sha256")
        .update(String(otp))
        .digest("hex");
}

// ============================================================
// EMAIL
// ============================================================

async function sendPasswordResetOTP(email, otp) {

    if (!RESEND_API_KEY) {

        throw new Error(
            "Resend email service is not configured."
        );
    }

    const response = await fetch(
        "https://api.resend.com/emails",
        {
            method: "POST",

            headers: {
                "Authorization":
                    `Bearer ${RESEND_API_KEY}`,
                "Content-Type":
                    "application/json"
            },

            body: JSON.stringify({

                from: RESEND_FROM_EMAIL,

                to: [email],

                subject:
                    "Study Buddy AI - Password Reset OTP",

                text:
                    `Your Study Buddy AI password reset OTP is ${otp}.\n\n` +
                    `This OTP will expire in 10 minutes.\n\n` +
                    `If you did not request this, please ignore this email.`
            })
        }
    );

    const data = await response.json();

    if (!response.ok) {

        console.error(
            "Resend error:",
            data
        );

        throw new Error(
            data?.message ||
            "Unable to send password reset email."
        );
    }

    return data;
}

// ============================================================
// AUTHENTICATED USER
// ============================================================

async function getAuthenticatedUser(req) {

    const authorization =
        req.headers.authorization || "";

    if (!authorization.startsWith("Bearer ")) {
        return null;
    }

    const token =
        authorization.substring(7).trim();

    if (!token) {
        return null;
    }

    const result = await pool.query(
        `
        SELECT
            id,
            name,
            email,
            created_at
        FROM users
        WHERE auth_token = $1
        LIMIT 1
        `,
        [token]
    );

    if (result.rows.length === 0) {
        return null;
    }

    return result.rows[0];
}

// ============================================================
// QUESTIONS
// ============================================================

function readQuestions() {

    try {

        if (!fs.existsSync(QUESTIONS_FILE)) {

            console.error(
                "questions.json not found:",
                QUESTIONS_FILE
            );

            return [];
        }

        const raw =
            fs.readFileSync(
                QUESTIONS_FILE,
                "utf8"
            );

        const parsed =
            JSON.parse(raw);

        if (Array.isArray(parsed)) {
            return parsed;
        }

        if (
            parsed &&
            Array.isArray(parsed.questions)
        ) {
            return parsed.questions;
        }

        return [];

    } catch (error) {

        console.error(
            "Unable to read questions.json:",
            error
        );

        return [];
    }
}

// ============================================================
// QUIZ ANSWER HELPERS
// ============================================================

function normalizeAnswer(value, question) {

    if (
        value === null ||
        value === undefined
    ) {
        return "";
    }

    const answer =
        String(value).trim();

    if (!answer) {
        return "";
    }

    const upper =
        answer.toUpperCase();

    if (
        upper === "A" ||
        upper === "B" ||
        upper === "C" ||
        upper === "D"
    ) {
        return upper;
    }

    const optionName =
        upper.replace(/\s+/g, "");

    if (optionName === "OPTIONA") {
        return "A";
    }

    if (optionName === "OPTIONB") {
        return "B";
    }

    if (optionName === "OPTIONC") {
        return "C";
    }

    if (optionName === "OPTIOND") {
        return "D";
    }

    const optionA =
        String(question?.optionA || "")
            .trim();

    const optionB =
        String(question?.optionB || "")
            .trim();

    const optionC =
        String(question?.optionC || "")
            .trim();

    const optionD =
        String(question?.optionD || "")
            .trim();

    if (
        answer.toLowerCase() ===
        optionA.toLowerCase()
    ) {
        return "A";
    }

    if (
        answer.toLowerCase() ===
        optionB.toLowerCase()
    ) {
        return "B";
    }

    if (
        answer.toLowerCase() ===
        optionC.toLowerCase()
    ) {
        return "C";
    }

    if (
        answer.toLowerCase() ===
        optionD.toLowerCase()
    ) {
        return "D";
    }

    return "";
}

function getCorrectAnswer(question) {

    if (!question) {
        return "";
    }

    const answer =
        question.correctAnswer ??
        question.correct_answer ??
        question.correctOption ??
        question.correct_option ??
        question.answer ??
        question.correct ??
        "";

    return normalizeAnswer(
        answer,
        question
    );
}

function getQuestionSolution(question) {

    if (!question) {
        return "";
    }

    return String(
        question.solution ??
        question.explanation ??
        question.answerExplanation ??
        question.answer_explanation ??
        ""
    ).trim();
}

function getOptionText(question, answer) {

    if (!question || !answer) {
        return "";
    }

    switch (
        String(answer).toUpperCase()
    ) {

        case "A":
            return String(
                question.optionA || ""
            );

        case "B":
            return String(
                question.optionB || ""
            );

        case "C":
            return String(
                question.optionC || ""
            );

        case "D":
            return String(
                question.optionD || ""
            );

        default:
            return "";
    }
}

// ============================================================
// HEALTH
// ============================================================

app.get("/", (req, res) => {

    res.json({
        success: true,
        message: "Study Buddy AI API is running",
        database: "PostgreSQL",
        gemini: Boolean(gemini),
        resend: resendConfigured
    });
});

app.get("/health", async (req, res) => {

    try {

        await pool.query("SELECT 1");

        res.json({
            success: true,
            status: "healthy",
            database: "connected"
        });

    } catch (error) {

        console.error(
            "Health check error:",
            error
        );

        res.status(500).json({
            success: false,
            status: "unhealthy",
            database: "disconnected"
        });
    }
});

// ============================================================
// SIGN UP
// ============================================================

app.post(
    "/api/auth/signup",
    async (req, res) => {

        try {

            const {
                name,
                email,
                password
            } = req.body || {};

            const cleanName =
                String(name || "").trim();

            const cleanEmail =
                String(email || "")
                    .trim()
                    .toLowerCase();

            const cleanPassword =
                String(password || "");

            if (!cleanName) {

                return res.status(400).json({
                    success: false,
                    message:
                        "Please enter your name."
                });
            }

            if (!cleanEmail) {

                return res.status(400).json({
                    success: false,
                    message:
                        "Please enter your email."
                });
            }

            if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/
                .test(cleanEmail)) {

                return res.status(400).json({
                    success: false,
                    message:
                        "Please enter a valid email."
                });
            }

            if (cleanPassword.length < 6) {

                return res.status(400).json({
                    success: false,
                    message:
                        "Password must contain at least 6 characters."
                });
            }

            // IMPORTANT:
            // Check PostgreSQL before creating account.

            const existingUser =
                await pool.query(
                    `
                    SELECT id
                    FROM users
                    WHERE LOWER(email) = LOWER($1)
                    LIMIT 1
                    `,
                    [cleanEmail]
                );

            if (existingUser.rows.length > 0) {

                return res.status(409).json({
                    success: false,
                    message:
                        "Account already exists. Please Sign In."
                });
            }

            const {
                hash,
                salt
            } = hashPassword(
                cleanPassword
            );

            const result =
                await pool.query(
                    `
                    INSERT INTO users
                    (
                        name,
                        email,
                        password_hash,
                        password_salt
                    )
                    VALUES
                    ($1, $2, $3, $4)
                    RETURNING
                        id,
                        name,
                        email,
                        created_at
                    `,
                    [
                        cleanName,
                        cleanEmail,
                        hash,
                        salt
                    ]
                );

            const user =
                result.rows[0];

            console.log(
                "New user created:",
                user.email
            );

            return res.status(201).json({

                success: true,

                message:
                    "Account created successfully.",

                user: {
                    id: user.id,
                    name: user.name,
                    email: user.email
                }
            });

        } catch (error) {

            console.error(
                "Signup error:",
                error
            );

            if (
                error.code === "23505"
            ) {

                return res.status(409).json({
                    success: false,
                    message:
                        "Account already exists. Please Sign In."
                });
            }

            return res.status(500).json({
                success: false,
                message:
                    "Unable to create account."
            });
        }
    }
);

// ============================================================
// SIGN IN
// ============================================================

app.post(
    "/api/auth/signin",
    async (req, res) => {

        try {

            const {
                email,
                password
            } = req.body || {};

            const cleanEmail =
                String(email || "")
                    .trim()
                    .toLowerCase();

            const cleanPassword =
                String(password || "");

            if (!cleanEmail) {

                return res.status(400).json({
                    success: false,
                    message:
                        "Please enter your email."
                });
            }

            if (!cleanPassword) {

                return res.status(400).json({
                    success: false,
                    message:
                        "Please enter your password."
                });
            }

            const result =
                await pool.query(
                    `
                    SELECT
                        id,
                        name,
                        email,
                        password_hash,
                        password_salt
                    FROM users
                    WHERE LOWER(email) = LOWER($1)
                    LIMIT 1
                    `,
                    [cleanEmail]
                );

            if (result.rows.length === 0) {

                return res.status(401).json({
                    success: false,
                    message:
                        "Incorrect email or password."
                });
            }

            const user =
                result.rows[0];

            const passwordCorrect =
                verifyPassword(
                    cleanPassword,
                    user.password_hash,
                    user.password_salt
                );

            if (!passwordCorrect) {

                return res.status(401).json({
                    success: false,
                    message:
                        "Incorrect email or password."
                });
            }

            const token =
                generateToken();

            await pool.query(
                `
                UPDATE users
                SET auth_token = $1
                WHERE id = $2
                `,
                [
                    token,
                    user.id
                ]
            );

            console.log(
                "User signed in:",
                user.email
            );

            return res.json({

                success: true,

                message:
                    "Sign in successful.",

                token,

                user: {
                    id: user.id,
                    name: user.name,
                    email: user.email
                }
            });

        } catch (error) {

            console.error(
                "Signin error:",
                error
            );

            return res.status(500).json({
                success: false,
                message:
                    "Unable to sign in."
            });
        }
    }
);

// ============================================================
// GET CURRENT USER
// ============================================================

app.get(
    "/api/auth/me",
    async (req, res) => {

        try {

            const user =
                await getAuthenticatedUser(req);

            if (!user) {

                return res.status(401).json({
                    success: false,
                    message:
                        "Authentication required."
                });
            }

            return res.json({

                success: true,

                user: {
                    id: user.id,
                    name: user.name,
                    email: user.email,
                    createdAt:
                        user.created_at
                }
            });

        } catch (error) {

            console.error(
                "Auth me error:",
                error
            );

            return res.status(500).json({
                success: false,
                message:
                    "Unable to get user."
            });
        }
    }
);

// ============================================================
// LOGOUT
// ============================================================

app.post(
    "/api/auth/logout",
    async (req, res) => {

        try {

            const authorization =
                req.headers.authorization || "";

            if (
                authorization.startsWith(
                    "Bearer "
                )
            ) {

                const token =
                    authorization
                        .substring(7)
                        .trim();

                if (token) {

                    await pool.query(
                        `
                        UPDATE users
                        SET auth_token = NULL
                        WHERE auth_token = $1
                        `,
                        [token]
                    );
                }
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
                message:
                    "Unable to logout."
            });
        }
    }
);

// ============================================================
// FORGOT PASSWORD
// ============================================================

app.post(
    "/api/auth/forgot-password",
    async (req, res) => {

        try {

            const {
                email
            } = req.body || {};

            const cleanEmail =
                String(email || "")
                    .trim()
                    .toLowerCase();

            if (!cleanEmail) {

                return res.status(400).json({
                    success: false,
                    message:
                        "Please enter your email."
                });
            }

            const result =
                await pool.query(
                    `
                    SELECT id, email
                    FROM users
                    WHERE LOWER(email) = LOWER($1)
                    LIMIT 1
                    `,
                    [cleanEmail]
                );

            if (result.rows.length === 0) {

                return res.status(404).json({
                    success: false,
                    message:
                        "No account found with this email."
                });
            }

            const otp =
                generateOTP();

            const otpHash =
                hashOTP(otp);

            await pool.query(
                `
                UPDATE users
                SET
                    reset_otp_hash = $1,
                    reset_otp_expires_at =
                        NOW() + INTERVAL '10 minutes',
                    reset_otp_verified_until = NULL
                WHERE id = $2
                `,
                [
                    otpHash,
                    result.rows[0].id
                ]
            );

            await sendPasswordResetOTP(
                cleanEmail,
                otp
            );

            console.log(
                "Password reset OTP sent to:",
                cleanEmail
            );

            return res.json({

                success: true,

                message:
                    "Password reset OTP sent to your email."
            });

        } catch (error) {

            console.error(
                "Forgot password error:",
                error
            );

            return res.status(500).json({
                success: false,
                message:
                    error.message ||
                    "Unable to send password reset OTP."
            });
        }
    }
);

// ============================================================
// VERIFY RESET OTP
// ============================================================

app.post(
    "/api/auth/verify-reset-otp",
    async (req, res) => {

        try {

            const {
                email,
                otp
            } = req.body || {};

            const cleanEmail =
                String(email || "")
                    .trim()
                    .toLowerCase();

            const cleanOTP =
                String(otp || "").trim();

            if (!cleanEmail || !cleanOTP) {

                return res.status(400).json({
                    success: false,
                    message:
                        "Email and OTP are required."
                });
            }

            const result =
                await pool.query(
                    `
                    SELECT
                        id,
                        reset_otp_hash,
                        reset_otp_expires_at
                    FROM users
                    WHERE LOWER(email) = LOWER($1)
                    LIMIT 1
                    `,
                    [cleanEmail]
                );

            if (result.rows.length === 0) {

                return res.status(404).json({
                    success: false,
                    message:
                        "User not found."
                });
            }

            const user =
                result.rows[0];

            if (
                !user.reset_otp_hash ||
                !user.reset_otp_expires_at
            ) {

                return res.status(400).json({
                    success: false,
                    message:
                        "OTP not found. Please request a new OTP."
                });
            }

            if (
                new Date(
                    user.reset_otp_expires_at
                ).getTime() <
                Date.now()
            ) {

                return res.status(400).json({
                    success: false,
                    message:
                        "OTP has expired. Please request a new OTP."
                });
            }

            const valid =
                crypto.timingSafeEqual(
                    Buffer.from(
                        hashOTP(cleanOTP),
                        "hex"
                    ),
                    Buffer.from(
                        user.reset_otp_hash,
                        "hex"
                    )
                );

            if (!valid) {

                return res.status(400).json({
                    success: false,
                    message:
                        "Invalid OTP."
                });
            }

            await pool.query(
                `
                UPDATE users
                SET
                    reset_otp_verified_until =
                        NOW() + INTERVAL '15 minutes'
                WHERE id = $1
                `,
                [user.id]
            );

            return res.json({

                success: true,

                message:
                    "OTP verified successfully."
            });

        } catch (error) {

            console.error(
                "Verify OTP error:",
                error
            );

            return res.status(500).json({
                success: false,
                message:
                    "Unable to verify OTP."
            });
        }
    }
);

// ============================================================
// RESET PASSWORD
// ============================================================

app.post(
    "/api/auth/reset-password",
    async (req, res) => {

        try {

            const {
                email,
                password
            } = req.body || {};

            const cleanEmail =
                String(email || "")
                    .trim()
                    .toLowerCase();

            const cleanPassword =
                String(password || "");

            if (!cleanEmail) {

                return res.status(400).json({
                    success: false,
                    message:
                        "Email is required."
                });
            }

            if (cleanPassword.length < 6) {

                return res.status(400).json({
                    success: false,
                    message:
                        "Password must contain at least 6 characters."
                });
            }

            const result =
                await pool.query(
                    `
                    SELECT
                        id,
                        reset_otp_verified_until
                    FROM users
                    WHERE LOWER(email) = LOWER($1)
                    LIMIT 1
                    `,
                    [cleanEmail]
                );

            if (result.rows.length === 0) {

                return res.status(404).json({
                    success: false,
                    message:
                        "User not found."
                });
            }

            const user =
                result.rows[0];

            if (
                !user.reset_otp_verified_until ||
                new Date(
                    user.reset_otp_verified_until
                ).getTime() <
                Date.now()
            ) {

                return res.status(400).json({
                    success: false,
                    message:
                        "Please verify OTP first."
                });
            }

            const {
                hash,
                salt
            } = hashPassword(
                cleanPassword
            );

            await pool.query(
                `
                UPDATE users
                SET
                    password_hash = $1,
                    password_salt = $2,
                    reset_otp_hash = NULL,
                    reset_otp_expires_at = NULL,
                    reset_otp_verified_until = NULL,
                    auth_token = NULL
                WHERE id = $3
                `,
                [
                    hash,
                    salt,
                    user.id
                ]
            );

            return res.json({

                success: true,

                message:
                    "Password reset successfully."
            });

        } catch (error) {

            console.error(
                "Reset password error:",
                error
            );

            return res.status(500).json({
                success: false,
                message:
                    "Unable to reset password."
            });
        }
    }
);

// ============================================================
// QUIZ QUESTIONS
// ============================================================

app.get(
    "/api/quiz/questions",
    async (req, res) => {

        try {

            const {
                subject,
                difficulty,
                count
            } = req.query;

            let questions =
                readQuestions();

            if (!questions.length) {

                return res.status(404).json({
                    success: false,
                    message:
                        "No questions found."
                });
            }

            if (
                subject &&
                String(subject).trim() &&
                String(subject).toLowerCase() !== "all"
            ) {

                const requestedSubject =
                    String(subject)
                        .trim()
                        .toLowerCase();

                questions =
                    questions.filter(
                        question =>
                            String(
                                question.subject || ""
                            )
                            .trim()
                            .toLowerCase() ===
                            requestedSubject
                    );
            }

            if (
                difficulty &&
                String(difficulty).trim() &&
                String(difficulty).toLowerCase() !== "all"
            ) {

                const requestedDifficulty =
                    String(difficulty)
                        .trim()
                        .toLowerCase();

                questions =
                    questions.filter(
                        question =>
                            String(
                                question.difficulty || ""
                            )
                            .trim()
                            .toLowerCase() ===
                            requestedDifficulty
                    );
            }

            if (!questions.length) {

                return res.status(404).json({
                    success: false,
                    message:
                        "No questions found for the selected subject and difficulty."
                });
            }

            questions =
                questions.sort(
                    () => Math.random() - 0.5
                );

            const requestedCount =
                Math.max(
                    1,
                    Math.min(
                        Number(count) || 5,
                        50
                    )
                );

            questions =
                questions.slice(
                    0,
                    requestedCount
                );

            // Never expose correct answer
            // before the user submits.

            const safeQuestions =
                questions.map(
                    question => {

                        const copy = {
                            ...question
                        };

                        delete copy.correctAnswer;
                        delete copy.correct_answer;
                        delete copy.correctOption;
                        delete copy.correct_option;
                        delete copy.answer;
                        delete copy.correct;
                        delete copy.solution;
                        delete copy.explanation;
                        delete copy.answerExplanation;
                        delete copy.answer_explanation;

                        return copy;
                    }
                );

            return res.json({

                success: true,

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
                message:
                    "Unable to load quiz questions."
            });
        }
    }
);

// ============================================================
// QUIZ SUBMIT
// ============================================================

app.post(
    "/api/quiz/submit",
    async (req, res) => {

        try {

            const body =
                req.body || {};

            // ------------------------------------------------
            // SINGLE QUESTION MODE
            // ------------------------------------------------

            if (
                body.questionId !== undefined &&
                body.selectedAnswer !== undefined
            ) {

                const questionId =
                    Number(body.questionId);

                const selectedAnswer =
                    String(
                        body.selectedAnswer || ""
                    ).trim();

                const questions =
                    readQuestions();

                const question =
                    questions.find(
                        item =>
                            Number(item.id) ===
                            questionId
                    );

                if (!question) {

                    return res.status(404).json({
                        success: false,
                        message:
                            "Question not found."
                    });
                }

                const normalizedSelected =
                    normalizeAnswer(
                        selectedAnswer,
                        question
                    );

                const correctAnswer =
                    getCorrectAnswer(
                        question
                    );

                const isCorrect =
                    normalizedSelected !== "" &&
                    correctAnswer !== "" &&
                    normalizedSelected ===
                    correctAnswer;

                const solution =
                    getQuestionSolution(
                        question
                    );

                return res.json({

                    success: true,

                    correct:
                        isCorrect,

                    questionId,

                    selectedAnswer:
                        normalizedSelected,

                    selectedOption:
                        getOptionText(
                            question,
                            normalizedSelected
                        ),

                    correctAnswer,

                    correctOption:
                        getOptionText(
                            question,
                            correctAnswer
                        ),

                    solution,

                    explanation:
                        solution
                });
            }

            // ------------------------------------------------
            // BATCH QUIZ MODE
            // ------------------------------------------------

            const {
                userId,
                subject,
                difficulty,
                questions: submittedQuestions,
                answers,
                score,
                totalQuestions
            } = body;

            const quizQuestions =
                Array.isArray(
                    submittedQuestions
                )
                    ? submittedQuestions
                    : [];

            const submittedAnswers =
                answers &&
                typeof answers === "object"
                    ? answers
                    : {};

            let correctAnswers = 0;

            const answerDetails =
                quizQuestions.map(
                    question => {

                        const questionId =
                            Number(
                                question.id
                            );

                        const selected =
                            submittedAnswers[
                                questionId
                            ] ??
                            submittedAnswers[
                                String(questionId)
                            ] ??
                            "";

                        const normalizedSelected =
                            normalizeAnswer(
                                selected,
                                question
                            );

                        const correctAnswer =
                            getCorrectAnswer(
                                question
                            );

                        const correct =
                            normalizedSelected ===
                            correctAnswer &&
                            correctAnswer !== "";

                        if (correct) {
                            correctAnswers++;
                        }

                        return {

                            questionId,

                            selectedAnswer:
                                normalizedSelected,

                            correctAnswer,

                            correct,

                            solution:
                                getQuestionSolution(
                                    question
                                )
                        };
                    }
                );

            const finalTotal =
                Number(totalQuestions) ||
                quizQuestions.length;

            const finalScore =
                score !== undefined
                    ? Number(score)
                    : (
                        finalTotal > 0
                            ? Math.round(
                                (
                                    correctAnswers /
                                    finalTotal
                                ) * 100
                            )
                            : 0
                    );

            let savedResult = null;

            if (userId) {

                const insert =
                    await pool.query(
                        `
                        INSERT INTO quiz_results
                        (
                            user_id,
                            subject,
                            difficulty,
                            questions,
                            answers,
                            answer_details,
                            score,
                            total_questions,
                            correct_answers
                        )
                        VALUES
                        ($1, $2, $3, $4, $5, $6,
                         $7, $8, $9)
                        RETURNING
                            id,
                            created_at
                        `,
                        [
                            Number(userId),
                            subject || "",
                            difficulty || "",
                            JSON.stringify(
                                quizQuestions
                            ),
                            JSON.stringify(
                                submittedAnswers
                            ),
                            JSON.stringify(
                                answerDetails
                            ),
                            finalScore,
                            finalTotal,
                            correctAnswers
                        ]
                    );

                savedResult =
                    insert.rows[0];
            }

            return res.json({

                success: true,

                score:
                    finalScore,

                totalQuestions:
                    finalTotal,

                correctAnswers,

                answerDetails,

                resultId:
                    savedResult?.id || null
            });

        } catch (error) {

            console.error(
                "Quiz submit error:",
                error
            );

            return res.status(500).json({
                success: false,
                message:
                    "Unable to submit quiz."
            });
        }
    }
);

// ============================================================
// QUIZ HISTORY
// ============================================================

app.get(
    "/api/quiz/history",
    async (req, res) => {

        try {

            const userId =
                Number(
                    req.query.userId
                );

            if (!userId) {

                return res.status(400).json({
                    success: false,
                    message:
                        "userId is required."
                });
            }

            const result =
                await pool.query(
                    `
                    SELECT
                        id,
                        subject,
                        difficulty,
                        questions,
                        answers,
                        answer_details,
                        score,
                        total_questions,
                        correct_answers,
                        created_at
                    FROM quiz_results
                    WHERE user_id = $1
                    ORDER BY created_at DESC
                    `,
                    [userId]
                );

            return res.json({

                success: true,

                history:
                    result.rows
            });

        } catch (error) {

            console.error(
                "Quiz history error:",
                error
            );

            return res.status(500).json({
                success: false,
                message:
                    "Unable to load quiz history."
            });
        }
    }
);

// ============================================================
// AI TUTOR
// ============================================================

app.post(
    "/api/ask",
    async (req, res) => {

        try {

            const {
                question,
                prompt,
                message
            } = req.body || {};

            const userQuestion =
                String(
                    question ||
                    prompt ||
                    message ||
                    ""
                ).trim();

            if (!userQuestion) {

                return res.status(400).json({
                    success: false,
                    message:
                        "Please enter a question."
                });
            }

            if (!gemini) {

                return res.status(503).json({
                    success: false,
                    message:
                        "AI service is not configured."
                });
            }

            const systemInstruction = `
You are Study Buddy AI, a friendly educational AI tutor.

Help students understand concepts clearly.

Rules:
1. Explain in simple language.
2. Use step-by-step explanations when useful.
3. Use examples.
4. Use headings and bullet points.
5. For mathematics, show calculations clearly.
6. Do not provide unsafe or harmful instructions.
7. Encourage learning and understanding.
8. Avoid unnecessary repetition.
`;

            const response =
                await gemini.models.generateContent({

                    model:
                        GEMINI_MODEL,

                    contents: [
                        {
                            role: "user",
                            parts: [
                                {
                                    text:
                                        `${systemInstruction}\n\nStudent question:\n${userQuestion}`
                                }
                            ]
                        }
                    ]
                });

            const answer =
                response?.text ||
                response?.candidates?.[0]
                    ?.content?.parts
                    ?.map(
                        part =>
                            part.text || ""
                    )
                    .join("") ||
                "";

            if (!answer.trim()) {

                return res.status(500).json({
                    success: false,
                    message:
                        "AI did not return an answer."
                });
            }

            return res.json({

                success: true,

                answer:
                    answer.trim()
            });

        } catch (error) {

            console.error(
                "AI Tutor error:",
                error
            );

            return res.status(500).json({
                success: false,
                message:
                    "Unable to get AI answer."
            });
        }
    }
);

// ============================================================
// 404
// ============================================================

app.use(
    (req, res) => {

        res.status(404).json({

            success: false,

            message:
                "API endpoint not found."
        });
    }
);

// ============================================================
// GLOBAL ERROR
// ============================================================

app.use(
    (error, req, res, next) => {

        console.error(
            "Unhandled server error:",
            error
        );

        res.status(500).json({

            success: false,

            message:
                "Internal server error."
        });
    }
);

// ============================================================
// START SERVER
// ============================================================

async function startServer() {

    try {

        console.log(
            "Initializing PostgreSQL database..."
        );

        await initializeDatabase();

        await pool.query(
            "SELECT NOW()"
        );

        console.log(
            "PostgreSQL connection successful."
        );

        console.log(
            "=========================================="
        );

        console.log(
            `Study Buddy AI server running on port ${PORT}`
        );

        console.log(
            "Database: PostgreSQL"
        );

        console.log(
            `Gemini model: ${GEMINI_MODEL}`
        );

        console.log(
            `Gemini: ${
                gemini
                    ? "configured"
                    : "not configured"
            }`
        );

        console.log(
            `Resend: ${
                resendConfigured
                    ? "configured"
                    : "not configured"
            }`
        );

        console.log(
            "=========================================="
        );

        app.listen(
            PORT,
            "0.0.0.0",
            () => {

                console.log(
                    `Server listening on 0.0.0.0:${PORT}`
                );
            }
        );

    } catch (error) {

        console.error(
            "Failed to start server:",
            error
        );

        process.exit(1);
    }
}

startServer();