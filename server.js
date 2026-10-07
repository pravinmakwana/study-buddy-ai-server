import express from "express";
import cors from "cors";
import fs from "fs";
import path from "path";
import crypto from "crypto";
import { fileURLToPath } from "url";
import pg from "pg";
import { GoogleGenAI } from "@google/genai";

const { Pool } = pg;

/*
========================================================
BASIC CONFIGURATION
========================================================
*/

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();

const PORT = process.env.PORT || 10000;

app.use(cors());
app.use(express.json({ limit: "2mb" }));

/*
========================================================
ENVIRONMENT VARIABLES
========================================================
*/

const DATABASE_URL = process.env.DATABASE_URL;

const RESEND_API_KEY =
    process.env.RESEND_API_KEY || "";

const RESEND_FROM_EMAIL =
    process.env.RESEND_FROM_EMAIL ||
    "onboarding@resend.dev";

const GEMINI_API_KEY =
    process.env.GEMINI_API_KEY || "";

const GEMINI_MODEL =
    process.env.GEMINI_MODEL ||
    "gemini-3.5-flash-lite";

const OPENAI_API_KEY =
    process.env.OPENAI_API_KEY || "";

if (!DATABASE_URL) {
    console.error("DATABASE_URL is not configured.");
    process.exit(1);
}

/*
========================================================
SERVICES
========================================================
*/

let genAI = null;

if (GEMINI_API_KEY) {
    genAI = new GoogleGenAI({
        apiKey: GEMINI_API_KEY
    });

    console.log("Gemini AI service configured.");
} else {
    console.log("Gemini API key not configured.");
}

if (RESEND_API_KEY) {
    console.log("Resend email service configured.");
} else {
    console.log("Resend email service not configured.");
}

/*
========================================================
POSTGRESQL
========================================================
*/

const pool = new Pool({
    connectionString: DATABASE_URL,
    ssl: {
        rejectUnauthorized: false
    }
});

pool.on("error", (error) => {
    console.error("Unexpected PostgreSQL error:", error);
});

/*
========================================================
DATABASE INITIALIZATION
========================================================
*/

async function initializeDatabase() {

    console.log("Initializing PostgreSQL database...");

    await pool.query(`
        CREATE TABLE IF NOT EXISTS users (
            id SERIAL PRIMARY KEY,
            name TEXT NOT NULL,
            email TEXT NOT NULL UNIQUE,
            password_hash TEXT NOT NULL,
            password_salt TEXT NOT NULL,
            auth_token TEXT,
            reset_otp_hash TEXT,
            reset_otp_expires_at TIMESTAMPTZ,
            reset_otp_verified_until TIMESTAMPTZ,
            created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
        )
    `);

    await pool.query(`
        CREATE TABLE IF NOT EXISTS quiz_results (
            id SERIAL PRIMARY KEY,
            user_id INTEGER,
            subject TEXT,
            difficulty TEXT,
            questions JSONB,
            answers JSONB,
            answer_details JSONB,
            score INTEGER DEFAULT 0,
            total_questions INTEGER DEFAULT 0,
            correct_answers INTEGER DEFAULT 0,
            created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
        )
    `);

    /*
    Add missing columns if an older version of the
    database already exists.
    */

    await pool.query(`
        ALTER TABLE users
        ADD COLUMN IF NOT EXISTS reset_otp_hash TEXT
    `);

    await pool.query(`
        ALTER TABLE users
        ADD COLUMN IF NOT EXISTS reset_otp_expires_at TIMESTAMPTZ
    `);

    await pool.query(`
        ALTER TABLE users
        ADD COLUMN IF NOT EXISTS reset_otp_verified_until TIMESTAMPTZ
    `);

    await pool.query(`
        ALTER TABLE users
        ADD COLUMN IF NOT EXISTS auth_token TEXT
    `);

    await pool.query(`
        ALTER TABLE users
        ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ
        DEFAULT CURRENT_TIMESTAMP
    `);

    await pool.query(`
        ALTER TABLE quiz_results
        ADD COLUMN IF NOT EXISTS answer_details JSONB
    `);

    await pool.query(`
        ALTER TABLE quiz_results
        ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ
        DEFAULT CURRENT_TIMESTAMP
    `);

    await pool.query(`
        CREATE INDEX IF NOT EXISTS idx_users_email
        ON users(email)
    `);

    await pool.query(`
        CREATE INDEX IF NOT EXISTS idx_users_auth_token
        ON users(auth_token)
    `);

    await pool.query(`
        CREATE INDEX IF NOT EXISTS idx_quiz_results_user_id
        ON quiz_results(user_id)
    `);

    console.log("PostgreSQL database initialized successfully.");
}

/*
========================================================
JSON QUESTION FILE
========================================================
*/

const DATA_DIR =
    path.join(__dirname, "data");

const QUESTIONS_FILE =
    path.join(DATA_DIR, "questions.json");

/*
========================================================
FALLBACK QUESTIONS
========================================================

These are used only if questions.json is missing,
empty, or contains no matching questions.

This prevents:

"Unable to load quiz: No questions found."
*/

const FALLBACK_QUESTIONS = [

    {
        id: 1,
        subject: "Mathematics",
        topic: "Arithmetic",
        difficulty: "Easy",
        question: "What is 15 + 27?",
        optionA: "32",
        optionB: "42",
        optionC: "52",
        optionD: "38",
        correctAnswer: "B",
        solution: "15 + 27 = 42."
    },

    {
        id: 2,
        subject: "Mathematics",
        topic: "Arithmetic",
        difficulty: "Easy",
        question: "What is the square of 6?",
        optionA: "12",
        optionB: "18",
        optionC: "36",
        optionD: "42",
        correctAnswer: "C",
        solution: "6 × 6 = 36."
    },

    {
        id: 3,
        subject: "Mathematics",
        topic: "Arithmetic",
        difficulty: "Easy",
        question: "What is 8 × 7?",
        optionA: "48",
        optionB: "54",
        optionC: "56",
        optionD: "64",
        correctAnswer: "C",
        solution: "8 × 7 = 56."
    },

    {
        id: 4,
        subject: "Biology",
        topic: "Cell",
        difficulty: "Easy",
        question: "What is the basic structural and functional unit of life?",
        optionA: "Tissue",
        optionB: "Cell",
        optionC: "Organ",
        optionD: "Organ system",
        correctAnswer: "B",
        solution: "The cell is the basic structural and functional unit of life."
    },

    {
        id: 5,
        subject: "Biology",
        topic: "Human Body",
        difficulty: "Easy",
        question: "Which organ pumps blood throughout the human body?",
        optionA: "Lungs",
        optionB: "Brain",
        optionC: "Heart",
        optionD: "Kidney",
        correctAnswer: "C",
        solution: "The heart pumps blood throughout the human body."
    },

    {
        id: 6,
        subject: "Physics",
        topic: "Units",
        difficulty: "Easy",
        question: "What is the SI unit of force?",
        optionA: "Joule",
        optionB: "Newton",
        optionC: "Watt",
        optionD: "Pascal",
        correctAnswer: "B",
        solution: "The SI unit of force is the Newton."
    },

    {
        id: 7,
        subject: "Chemistry",
        topic: "Elements",
        difficulty: "Easy",
        question: "What is the chemical symbol for oxygen?",
        optionA: "O",
        optionB: "Ox",
        optionC: "C",
        optionD: "H",
        correctAnswer: "A",
        solution: "The chemical symbol for oxygen is O."
    }
];

function loadQuestions() {

    try {

        if (!fs.existsSync(QUESTIONS_FILE)) {
            console.log(
                "questions.json not found. Using fallback questions."
            );

            return FALLBACK_QUESTIONS;
        }

        const raw =
            fs.readFileSync(
                QUESTIONS_FILE,
                "utf8"
            );

        const parsed =
            JSON.parse(raw);

        let questions = [];

        if (Array.isArray(parsed)) {
            questions = parsed;
        } else if (
            parsed &&
            Array.isArray(parsed.questions)
        ) {
            questions = parsed.questions;
        }

        if (questions.length === 0) {
            console.log(
                "questions.json is empty. Using fallback questions."
            );

            return FALLBACK_QUESTIONS;
        }

        return questions;

    } catch (error) {

        console.error(
            "Unable to load questions.json:",
            error.message
        );

        return FALLBACK_QUESTIONS;
    }
}

/*
========================================================
QUESTION HELPERS
========================================================
*/

function normalizeAnswer(value, question = {}) {

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

    if (optionName === "OPTIONA") return "A";
    if (optionName === "OPTIONB") return "B";
    if (optionName === "OPTIONC") return "C";
    if (optionName === "OPTIOND") return "D";

    const optionA =
        String(question.optionA || "").trim();

    const optionB =
        String(question.optionB || "").trim();

    const optionC =
        String(question.optionC || "").trim();

    const optionD =
        String(question.optionD || "").trim();

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

function getOptionText(
    question,
    answer
) {

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

function shuffleArray(array) {

    const result = [...array];

    for (
        let i = result.length - 1;
        i > 0;
        i--
    ) {

        const j =
            Math.floor(
                Math.random() * (i + 1)
            );

        [
            result[i],
            result[j]
        ] = [
            result[j],
            result[i]
        ];
    }

    return result;
}

/*
========================================================
PASSWORD SECURITY
========================================================
*/

function hashPassword(password) {

    const salt =
        crypto.randomBytes(16)
            .toString("hex");

    const hash =
        crypto.scryptSync(
            password,
            salt,
            64
        ).toString("hex");

    return {
        salt,
        hash
    };
}

function verifyPassword(
    password,
    storedHash,
    storedSalt
) {

    try {

        const hash =
            crypto.scryptSync(
                password,
                storedSalt,
                64
            ).toString("hex");

        return crypto.timingSafeEqual(
            Buffer.from(hash, "hex"),
            Buffer.from(storedHash, "hex")
        );

    } catch (error) {

        return false;
    }
}

/*
========================================================
TOKEN / OTP HELPERS
========================================================
*/

function generateToken() {

    return crypto
        .randomBytes(32)
        .toString("hex");
}

function generateOTP() {

    return String(
        Math.floor(
            100000 +
            Math.random() * 900000
        )
    );
}

function hashOTP(otp) {

    return crypto
        .createHash("sha256")
        .update(otp)
        .digest("hex");
}

/*
========================================================
AUTHENTICATED USER
========================================================
*/

async function getAuthenticatedUser(req) {

    const authorization =
        req.headers.authorization || "";

    if (
        !authorization.startsWith(
            "Bearer "
        )
    ) {
        return null;
    }

    const token =
        authorization.substring(7).trim();

    if (!token) {
        return null;
    }

    const result =
        await pool.query(
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

/*
========================================================
RESEND EMAIL
========================================================
*/

async function sendPasswordResetOTP(
    email,
    otp
) {

    if (!RESEND_API_KEY) {
        throw new Error(
            "Resend email service is not configured."
        );
    }

    const response =
        await fetch(
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

                    from:
                        RESEND_FROM_EMAIL,

                    to: [email],

                    subject:
                        "Study Buddy AI - Password Reset OTP",

                    html: `
                        <div style="
                            font-family: Arial, sans-serif;
                            max-width: 600px;
                            margin: auto;
                            padding: 20px;
                        ">

                            <h2>
                                Study Buddy AI
                            </h2>

                            <p>
                                Your password reset OTP is:
                            </p>

                            <div style="
                                font-size: 32px;
                                font-weight: bold;
                                letter-spacing: 8px;
                                margin: 20px 0;
                            ">
                                ${otp}
                            </div>

                            <p>
                                This OTP will expire in
                                10 minutes.
                            </p>

                            <p>
                                If you did not request
                                a password reset, you
                                can safely ignore this email.
                            </p>

                        </div>
                    `
                })
            }
        );

    if (!response.ok) {

        const errorText =
            await response.text();

        throw new Error(
            `Resend API error: ${errorText}`
        );
    }

    return true;
}

/*
========================================================
ROOT
========================================================
*/

app.get("/", (req, res) => {

    res.json({
        success: true,
        message:
            "Study Buddy AI server is running.",
        database:
            "PostgreSQL",
        gemini:
            Boolean(GEMINI_API_KEY),
        resend:
            Boolean(RESEND_API_KEY)
    });
});

/*
========================================================
HEALTH
========================================================
*/

app.get(
    "/health",
    async (req, res) => {

        try {

            await pool.query(
                "SELECT 1"
            );

            res.json({
                success: true,
                status: "healthy",
                database:
                    "PostgreSQL connected"
            });

        } catch (error) {

            console.error(
                "Health check error:",
                error
            );

            res.status(500).json({
                success: false,
                status: "unhealthy",
                database:
                    "PostgreSQL connection failed"
            });
        }
    }
);

/*
========================================================
SIGN UP
========================================================
*/

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

            if (!cleanPassword) {

                return res.status(400).json({
                    success: false,
                    message:
                        "Please enter your password."
                });
            }

            if (cleanPassword.length < 6) {

                return res.status(400).json({
                    success: false,
                    message:
                        "Password must contain at least 6 characters."
                });
            }

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

            if (
                existingUser.rows.length > 0
            ) {

                return res.status(409).json({
                    success: false,
                    message:
                        "Account already exists. Please sign in."
                });
            }

            const {
                salt,
                hash
            } =
                hashPassword(
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
                `New user registered: ${user.email}`
            );

            return res.status(201).json({
                success: true,
                message:
                    "Account created successfully.",
                user
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
                        "Account already exists. Please sign in."
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

/*
========================================================
SIGN IN
========================================================
*/

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
                        password_salt,
                        created_at
                    FROM users
                    WHERE LOWER(email) = LOWER($1)
                    LIMIT 1
                    `,
                    [cleanEmail]
                );

            if (
                result.rows.length === 0
            ) {

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

            const authToken =
                generateToken();

            await pool.query(
                `
                UPDATE users
                SET auth_token = $1
                WHERE id = $2
                `,
                [
                    authToken,
                    user.id
                ]
            );

            return res.json({

                success: true,

                message:
                    "Sign in successful.",

                token:
                    authToken,

                user: {
                    id: user.id,
                    name: user.name,
                    email: user.email,
                    created_at:
                        user.created_at
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

/*
========================================================
GET CURRENT USER
========================================================
*/

app.get(
    "/api/auth/me",
    async (req, res) => {

        try {

            const user =
                await getAuthenticatedUser(
                    req
                );

            if (!user) {

                return res.status(401).json({
                    success: false,
                    message:
                        "Authentication required."
                });
            }

            return res.json({
                success: true,
                user
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

/*
========================================================
LOGOUT
========================================================
*/

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

/*
========================================================
FORGOT PASSWORD
========================================================
*/

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

            if (
                result.rows.length === 0
            ) {

                return res.status(404).json({
                    success: false,
                    message:
                        "No account found with this email."
                });
            }

            const user =
                result.rows[0];

            const otp =
                generateOTP();

            const otpHash =
                hashOTP(otp);

            const expiresAt =
                new Date(
                    Date.now() +
                    10 * 60 * 1000
                );

            await pool.query(
                `
                UPDATE users
                SET
                    reset_otp_hash = $1,
                    reset_otp_expires_at = $2,
                    reset_otp_verified_until = NULL
                WHERE id = $3
                `,
                [
                    otpHash,
                    expiresAt,
                    user.id
                ]
            );

            await sendPasswordResetOTP(
                user.email,
                otp
            );

            console.log(
                `Password reset OTP sent to ${user.email}`
            );

            return res.json({
                success: true,
                message:
                    "OTP sent to your email."
            });

        } catch (error) {

            console.error(
                "Forgot password error:",
                error
            );

            return res.status(500).json({
                success: false,
                message:
                    "Unable to send password reset OTP."
            });
        }
    }
);

/*
========================================================
VERIFY RESET OTP
========================================================
*/

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
                String(otp || "")
                    .trim();

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

            if (
                result.rows.length === 0
            ) {

                return res.status(404).json({
                    success: false,
                    message:
                        "No account found."
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
                        "No active OTP found."
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

            const otpHash =
                hashOTP(cleanOTP);

            if (
                otpHash !==
                user.reset_otp_hash
            ) {

                return res.status(400).json({
                    success: false,
                    message:
                        "Invalid OTP."
                });
            }

            const verifiedUntil =
                new Date(
                    Date.now() +
                    15 * 60 * 1000
                );

            await pool.query(
                `
                UPDATE users
                SET
                    reset_otp_verified_until = $1
                WHERE id = $2
                `,
                [
                    verifiedUntil,
                    user.id
                ]
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

/*
========================================================
RESET PASSWORD
========================================================
*/

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

            if (
                cleanPassword.length < 6
            ) {

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

            if (
                result.rows.length === 0
            ) {

                return res.status(404).json({
                    success: false,
                    message:
                        "No account found."
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
                        "Please verify the OTP first."
                });
            }

            const {
                salt,
                hash
            } =
                hashPassword(
                    cleanPassword
                );

            await pool.query(
                `
                UPDATE users
                SET
                    password_hash = $1,
                    password_salt = $2,
                    auth_token = NULL,
                    reset_otp_hash = NULL,
                    reset_otp_expires_at = NULL,
                    reset_otp_verified_until = NULL
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

/*
========================================================
QUIZ QUESTIONS
========================================================
*/

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
                loadQuestions();

            const requestedSubject =
                String(
                    subject || ""
                ).trim();

            const requestedDifficulty =
                String(
                    difficulty || ""
                ).trim();

            /*
            Subject filtering
            */

            if (
                requestedSubject &&
                requestedSubject.toLowerCase() !==
                "all"
            ) {

                questions =
                    questions.filter(
                        question =>
                            String(
                                question.subject || ""
                            ).toLowerCase() ===
                            requestedSubject.toLowerCase()
                    );
            }

            /*
            Difficulty filtering
            */

            if (
                requestedDifficulty &&
                requestedDifficulty.toLowerCase() !==
                "all"
            ) {

                questions =
                    questions.filter(
                        question =>
                            String(
                                question.difficulty || ""
                            ).toLowerCase() ===
                            requestedDifficulty.toLowerCase()
                    );
            }

            /*
            If no matching questions were found,
            try fallback questions.
            */

            if (
                questions.length === 0
            ) {

                questions =
                    FALLBACK_QUESTIONS;

                if (
                    requestedSubject &&
                    requestedSubject.toLowerCase() !==
                    "all"
                ) {

                    questions =
                        questions.filter(
                            question =>
                                String(
                                    question.subject || ""
                                ).toLowerCase() ===
                                requestedSubject.toLowerCase()
                        );
                }

                if (
                    requestedDifficulty &&
                    requestedDifficulty.toLowerCase() !==
                    "all"
                ) {

                    questions =
                        questions.filter(
                            question =>
                                String(
                                    question.difficulty || ""
                                ).toLowerCase() ===
                                requestedDifficulty.toLowerCase()
                        );
                }
            }

            if (
                questions.length === 0
            ) {

                return res.status(404).json({
                    success: false,
                    message:
                        "No questions found."
                });
            }

            const shuffled =
                shuffleArray(
                    questions
                );

            let requestedCount =
                parseInt(
                    count || "5",
                    10
                );

            if (
                !Number.isFinite(
                    requestedCount
                ) ||
                requestedCount < 1
            ) {
                requestedCount = 5;
            }

            requestedCount =
                Math.min(
                    requestedCount,
                    shuffled.length
                );

            const selected =
                shuffled.slice(
                    0,
                    requestedCount
                );

            /*
            NEVER send the correct answer
            to the Android app before the
            user answers.
            */

            const safeQuestions =
                selected.map(
                    question => {

                        const safeQuestion = {
                            id:
                                question.id,

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
                        };

                        return safeQuestion;
                    }
                );

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
                message:
                    "Unable to load quiz questions."
            });
        }
    }
);

/*
========================================================
QUIZ SUBMIT
========================================================

Supports BOTH:

1. Single question answer:

{
    questionId: 1,
    selectedAnswer: "B"
}

2. Complete quiz result:

{
    userId: 1,
    subject: "Biology",
    difficulty: "Easy",
    questions: [...],
    answers: [...],
    score: 4,
    totalQuestions: 5,
    correctAnswers: 4
}
========================================================
*/

app.post(
    "/api/quiz/submit",
    async (req, res) => {

        try {

            const body =
                req.body || {};

            /*
            ================================================
            SINGLE QUESTION MODE
            ================================================
            */

            if (
                body.questionId !== undefined &&
                body.selectedAnswer !== undefined
            ) {

                const questionId =
                    Number(
                        body.questionId
                    );

                const selectedAnswer =
                    String(
                        body.selectedAnswer || ""
                    ).trim();

                if (
                    !Number.isFinite(
                        questionId
                    )
                ) {

                    return res.status(400).json({
                        success: false,
                        message:
                            "Invalid question ID."
                    });
                }

                const questions =
                    loadQuestions();

                let question =
                    questions.find(
                        item =>
                            Number(item.id) ===
                            questionId
                    );

                /*
                Search fallback questions
                if question isn't found.
                */

                if (!question) {

                    question =
                        FALLBACK_QUESTIONS.find(
                            item =>
                                Number(item.id) ===
                                questionId
                        );
                }

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

                const selectedOption =
                    getOptionText(
                        question,
                        normalizedSelected
                    );

                const correctOption =
                    getOptionText(
                        question,
                        correctAnswer
                    );

                const solution =
                    getQuestionSolution(
                        question
                    );

                return res.json({

                    success: true,

                    questionId:
                        question.id,

                    selectedAnswer:
                        normalizedSelected,

                    selectedOption:
                        selectedOption,

                    correct:
                        isCorrect,

                    correctAnswer:
                        correctAnswer,

                    correctOption:
                        correctOption,

                    solution:
                        solution,

                    explanation:
                        solution
                });
            }

            /*
            ================================================
            COMPLETE QUIZ RESULT MODE
            ================================================
            */

            const {
                userId,
                subject,
                difficulty,
                questions,
                answers
            } = body;

            let quizQuestions =
                Array.isArray(
                    questions
                )
                    ? questions
                    : [];

            let quizAnswers =
                Array.isArray(
                    answers
                )
                    ? answers
                    : [];

            let correctAnswers = 0;

            const answerDetails = [];

            const allQuestions =
                loadQuestions();

            for (
                let i = 0;
                i < quizQuestions.length;
                i++
            ) {

                const submittedQuestion =
                    quizQuestions[i];

                const questionId =
                    Number(
                        submittedQuestion?.id ??
                        submittedQuestion?.questionId
                    );

                const question =
                    allQuestions.find(
                        item =>
                            Number(item.id) ===
                            questionId
                    ) ||
                    FALLBACK_QUESTIONS.find(
                        item =>
                            Number(item.id) ===
                            questionId
                    ) ||
                    submittedQuestion;

                const submittedAnswer =
                    quizAnswers[i] ??
                    submittedQuestion?.selectedAnswer ??
                    "";

                const selected =
                    normalizeAnswer(
                        submittedAnswer,
                        question
                    );

                const correctAnswer =
                    getCorrectAnswer(
                        question
                    );

                const isCorrect =
                    selected !== "" &&
                    correctAnswer !== "" &&
                    selected ===
                    correctAnswer;

                if (isCorrect) {
                    correctAnswers++;
                }

                answerDetails.push({

                    questionId:
                        question?.id ??
                        questionId,

                    selectedAnswer:
                        selected,

                    correct:
                        isCorrect,

                    correctAnswer:
                        correctAnswer,

                    selectedOption:
                        getOptionText(
                            question,
                            selected
                        ),

                    correctOption:
                        getOptionText(
                            question,
                            correctAnswer
                        ),

                    solution:
                        getQuestionSolution(
                            question
                        )
                });
            }

            const totalQuestions =
                quizQuestions.length;

            const score =
                totalQuestions > 0
                    ? correctAnswers
                    : 0;

            let numericUserId = null;

            if (
                userId !== undefined &&
                userId !== null &&
                String(userId).trim() !== ""
            ) {

                const parsedUserId =
                    Number(userId);

                if (
                    Number.isInteger(
                        parsedUserId
                    )
                ) {

                    numericUserId =
                        parsedUserId;
                }
            }

            const result =
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
                    (
                        $1,
                        $2,
                        $3,
                        $4,
                        $5,
                        $6,
                        $7,
                        $8,
                        $9
                    )
                    RETURNING
                        id,
                        user_id,
                        subject,
                        difficulty,
                        score,
                        total_questions,
                        correct_answers,
                        created_at
                    `,
                    [
                        numericUserId,
                        subject || "",
                        difficulty || "",
                        JSON.stringify(
                            quizQuestions
                        ),
                        JSON.stringify(
                            quizAnswers
                        ),
                        JSON.stringify(
                            answerDetails
                        ),
                        score,
                        totalQuestions,
                        correctAnswers
                    ]
                );

            return res.json({

                success: true,

                message:
                    "Quiz submitted successfully.",

                result:
                    result.rows[0],

                score:
                    score,

                totalQuestions:
                    totalQuestions,

                correctAnswers:
                    correctAnswers,

                answerDetails:
                    answerDetails
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

/*
========================================================
QUIZ HISTORY
========================================================
*/

app.get(
    "/api/quiz/history",
    async (req, res) => {

        try {

            const authenticatedUser =
                await getAuthenticatedUser(
                    req
                );

            let userId =
                req.query.userId;

            /*
            Prefer authenticated user
            when token is supplied.
            */

            if (
                authenticatedUser
            ) {

                userId =
                    authenticatedUser.id;
            }

            if (
                userId === undefined ||
                userId === null ||
                String(userId).trim() === ""
            ) {

                return res.status(400).json({
                    success: false,
                    message:
                        "User ID is required."
                });
            }

            const numericUserId =
                Number(userId);

            if (
                !Number.isInteger(
                    numericUserId
                )
            ) {

                return res.status(400).json({
                    success: false,
                    message:
                        "Invalid user ID."
                });
            }

            const result =
                await pool.query(
                    `
                    SELECT
                        id,
                        user_id,
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
                    [numericUserId]
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

/*
========================================================
CLEAN AI TEXT
========================================================
*/

function cleanAIResponse(text) {

    if (!text) {
        return "";
    }

    let result =
        String(text);

    /*
    Remove fenced code blocks
    */

    result =
        result.replace(
            /```[a-zA-Z]*\n?/g,
            ""
        );

    result =
        result.replace(
            /```/g,
            ""
        );

    /*
    Convert common Markdown headings
    */

    result =
        result.replace(
            /^\s*#{1,6}\s*/gm,
            ""
        );

    /*
    Remove LaTeX display wrappers
    */

    result =
        result.replace(
            /\$\$\s*/g,
            ""
        );

    result =
        result.replace(
            /\s*\$\$/g,
            ""
        );

    /*
    Remove inline dollar math wrappers
    */

    result =
        result.replace(
            /\$([^$]+)\$/g,
            "$1"
        );

    /*
    Convert common LaTeX commands
    */

    result =
        result.replace(
            /\\text\s*\{([^{}]*)\}/g,
            "$1"
        );

    result =
        result.replace(
            /\\times/g,
            "×"
        );

    result =
        result.replace(
            /\\cdot/g,
            "×"
        );

    result =
        result.replace(
            /\\div/g,
            "÷"
        );

    result =
        result.replace(
            /\\sqrt\s*\{([^{}]*)\}/g,
            "√($1)"
        );

    result =
        result.replace(
            /\\frac\s*\{([^{}]*)\}\s*\{([^{}]*)\}/g,
            "($1/$2)"
        );

    /*
    Remove remaining backslashes from
    common LaTeX formatting.
    */

    result =
        result.replace(
            /\\left/g,
            ""
        );

    result =
        result.replace(
            /\\right/g,
            ""
        );

    /*
    Convert Markdown bold / italic
    */

    result =
        result.replace(
            /\*\*([^*]+)\*\*/g,
            "$1"
        );

    result =
        result.replace(
            /\*([^*]+)\*/g,
            "$1"
        );

    /*
    Convert Markdown bullet points
    to simple bullet characters.
    */

    result =
        result.replace(
            /^\s*[-*]\s+/gm,
            "• "
        );

    /*
    Remove excessive blank lines.
    */

    result =
        result.replace(
            /\n{3,}/g,
            "\n\n"
        );

    /*
    Remove spaces before punctuation.
    */

    result =
        result.replace(
            /\s+([,.!?])/g,
            "$1"
        );

    return result.trim();
}

/*
========================================================
AI TUTOR
========================================================
*/

app.post(
    "/api/ask",
    async (req, res) => {

        try {

            if (!genAI) {

                return res.status(503).json({
                    success: false,
                    message:
                        "Gemini AI is not configured."
                });
            }

            const {
                question,
                subject
            } = req.body || {};

            const studentQuestion =
                String(
                    question || ""
                ).trim();

            const studentSubject =
                String(
                    subject || ""
                ).trim();

            if (!studentQuestion) {

                return res.status(400).json({
                    success: false,
                    message:
                        "Please enter a question."
                });
            }

            const prompt = `
You are Study Buddy AI, a helpful educational tutor.

Your job is to answer the student's question accurately,
clearly, and in a student-friendly way.

Subject:
${studentSubject || "General"}

Student question:
${studentQuestion}

IMPORTANT RESPONSE FORMAT RULES:

1. Return plain readable text only.

2. Do NOT use Markdown.

3. Do NOT use Markdown headings such as:
#
##
###
####
#####

4. Do NOT use:
$$
$...$
\\text{}
\\frac{}
\\times
\\sqrt{}

5. Do not return raw LaTeX.

6. Write mathematical expressions using normal text.

Examples:

Use:
Area = Length × Width

NOT:
$$\\text{Area} = \\text{Length} \\times \\text{Width}$$

Use:
10 feet

NOT:
$10\\text{ feet}$

Use:
6² = 36

NOT:
$6^2 = 36$

7. You may use simple numbered sections:

Step 1:
Step 2:
Step 3:

8. You may use the bullet character:
•

9. Do not use Markdown bold:
**text**

10. Do not use Markdown code blocks.

11. Do not start with unnecessary greetings such as:
"Hello! I am Study Buddy AI..."

12. Do not end with:
"Let me know if you need anything else."

13. Do not ask the student another question at the end.

14. Give the direct answer first, followed by a clear explanation.

15. For mathematics, show calculations using normal readable
characters.

16. Keep the explanation concise but useful.

Return ONLY the educational answer.
`;

            const response =
                await genAI.models.generateContent({

                    model:
                        GEMINI_MODEL,

                    contents:
                        prompt
                });

            let answer = "";

            if (
                response &&
                typeof response.text ===
                "string"
            ) {

                answer =
                    response.text;
            }

            if (
                !answer &&
                response?.candidates?.length
            ) {

                answer =
                    response.candidates[0]
                        ?.content
                        ?.parts
                        ?.map(
                            part =>
                                part.text || ""
                        )
                        .join("");
            }

            answer =
                cleanAIResponse(
                    answer
                );

            if (!answer) {

                return res.status(500).json({
                    success: false,
                    message:
                        "AI returned an empty response."
                });
            }

            return res.json({

                success: true,

                answer:
                    answer,

                response:
                    answer
            });

        } catch (error) {

            console.error(
                "AI Tutor error:",
                error
            );

            return res.status(500).json({
                success: false,
                message:
                    "Unable to get AI response."
            });
        }
    }
);

/*
========================================================
GENERATE PRACTICE QUESTIONS
========================================================
*/

app.post(
    "/api/quiz/practice",
    async (req, res) => {

        try {

            if (!genAI) {

                return res.status(503).json({
                    success: false,
                    message:
                        "Gemini AI is not configured."
                });
            }

            const {
                subject,
                topic,
                difficulty,
                count
            } = req.body || {};

            const requestedCount =
                Math.min(
                    Math.max(
                        Number(count) || 5,
                        1
                    ),
                    20
                );

            const prompt = `
Generate ${requestedCount} practice questions
for a student.

Subject:
${subject || "General"}

Topic:
${topic || "General"}

Difficulty:
${difficulty || "Medium"}

Return ONLY valid JSON.

The JSON must have this exact structure:

{
  "questions": [
    {
      "question": "Question text",
      "optionA": "Option A",
      "optionB": "Option B",
      "optionC": "Option C",
      "optionD": "Option D",
      "correctAnswer": "A",
      "solution": "Short clear explanation"
    }
  ]
}

Rules:

- correctAnswer must be A, B, C, or D.
- Make exactly four options.
- Make only one option correct.
- Solutions must be plain text.
- Do not use Markdown.
- Do not use LaTeX.
`;

            const response =
                await genAI.models.generateContent({

                    model:
                        GEMINI_MODEL,

                    contents:
                        prompt
                });

            let raw = "";

            if (
                response &&
                typeof response.text ===
                "string"
            ) {

                raw =
                    response.text;
            }

            raw =
                raw
                    .replace(
                        /```json/gi,
                        ""
                    )
                    .replace(
                        /```/g,
                        ""
                    )
                    .trim();

            let parsed;

            try {

                parsed =
                    JSON.parse(raw);

            } catch (parseError) {

                /*
                Try to extract JSON
                if Gemini returned extra text.
                */

                const start =
                    raw.indexOf("{");

                const end =
                    raw.lastIndexOf("}");

                if (
                    start >= 0 &&
                    end > start
                ) {

                    parsed =
                        JSON.parse(
                            raw.substring(
                                start,
                                end + 1
                            )
                        );

                } else {

                    throw parseError;
                }
            }

            if (
                !parsed ||
                !Array.isArray(
                    parsed.questions
                )
            ) {

                throw new Error(
                    "Invalid practice question response."
                );
            }

            return res.json({

                success: true,

                questions:
                    parsed.questions
            });

        } catch (error) {

            console.error(
                "Practice question error:",
                error
            );

            return res.status(500).json({
                success: false,
                message:
                    "Unable to generate practice questions."
            });
        }
    }
);

/*
========================================================
404
========================================================
*/

app.use(
    (req, res) => {

        res.status(404).json({
            success: false,
            message:
                "API endpoint not found."
        });
    }
);

/*
========================================================
GLOBAL ERROR HANDLER
========================================================
*/

app.use(
    (error, req, res, next) => {

        console.error(
            "Global server error:",
            error
        );

        res.status(500).json({
            success: false,
            message:
                "Internal server error."
        });
    }
);

/*
========================================================
START SERVER
========================================================
*/

async function startServer() {

    try {

        await initializeDatabase();

        /*
        Test PostgreSQL connection
        */

        await pool.query(
            "SELECT 1"
        );

        console.log(
            "PostgreSQL connection successful."
        );

        app.listen(
            PORT,
            "0.0.0.0",
            () => {

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
                        GEMINI_API_KEY
                            ? "configured"
                            : "not configured"
                    }`
                );

                console.log(
                    `Resend: ${
                        RESEND_API_KEY
                            ? "configured"
                            : "not configured"
                    }`
                );

                console.log(
                    "=========================================="
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