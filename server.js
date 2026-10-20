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

app.use((req, res, next) => {
    console.log(
        `[REQUEST] ${new Date().toISOString()} ${req.method} ${req.originalUrl}`
    );

    res.on("finish", () => {
        console.log(
            `[RESPONSE] ${req.method} ${req.originalUrl} ${res.statusCode}`
        );
    });

    next();
});

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
    ALTER TABLE quiz_results
    ADD COLUMN IF NOT EXISTS user_id_text TEXT
`);

await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_quiz_results_user_id_text
    ON quiz_results (user_id_text)
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

//

async function requireAuth(req, res, next) {
    try {
        const user = await getAuthenticatedUser(req);

        if (!user) {
            return res.status(401).json({
                success: false,
                message: "Authentication required. Please sign in again."
            });
        }

        // Use the database identity, never a client-supplied userId.
        req.user = user;
        return next();
    } catch (error) {
        console.error("Authentication middleware error:", error);

        return res.status(500).json({
            success: false,
            message: "Unable to verify authentication."
        });
    }
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

function formatMathText(value) {
    if (value === null || value === undefined) {
        return "";
    }

    return String(value)
        // Convert common LaTeX commands to readable text.
        .replace(/\\times\b/g, "×")
        .replace(/\\cdot\b/g, "·")
        .replace(/\\div\b/g, "÷")
        .replace(/\\pm\b/g, "±")
        .replace(/\\neq\b/g, "≠")
        .replace(/\\leq\b|\\le\b/g, "≤")
        .replace(/\\geq\b|\\ge\b/g, "≥")
        .replace(/\\sqrt\s*\{([^{}]*)\}/g, "√($1)")
        .replace(/\\frac\s*\{([^{}]*)\}\s*\{([^{}]*)\}/g, "($1)/($2)")
        .replace(/\\text\s*\{([^{}]*)\}/g, "$1")
        .replace(/\\mathrm\s*\{([^{}]*)\}/g, "$1")
        .replace(/\\mathbf\s*\{([^{}]*)\}/g, "$1")
        .replace(/\\,/g, " ")
        .replace(/\\;/g, " ")
        .replace(/\\!/g, "")
        .replace(/\$\$?/g, "")
        .replace(/\\\(/g, "")
        .replace(/\\\)/g, "")
        .replace(/\\\[/g, "")
        .replace(/\\\]/g, "");
}

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
 // DELETE ACCOUNT
 // ============================================================

 app.delete(
     "/api/auth/delete-account",
     requireAuth,
     async (req, res) => {
         const client = await pool.connect();

         try {
             const password = String(
                 req.body?.password || ""
             );

             if (!password) {
                 return res.status(400).json({
                     success: false,
                     message: "Please enter your password to confirm account deletion."
                 });
             }

             await client.query("BEGIN");

             // Fetch the authenticated user's credentials.
             const result = await client.query(
                 `SELECT id, password_hash, password_salt
                  FROM users
                  WHERE id = $1
                  FOR UPDATE`,
                 [req.user.id]
             );

             if (result.rows.length === 0) {
                 await client.query("ROLLBACK");

                 return res.status(404).json({
                     success: false,
                     message: "Account not found."
                 });
             }

             const user = result.rows[0];

             if (!verifyPassword(
                 password,
                 user.password_hash,
                 user.password_salt
             )) {
                 await client.query("ROLLBACK");

                 return res.status(401).json({
                     success: false,
                     message: "Incorrect password. Account was not deleted."
                 });
             }

             // Delete only the authenticated account.
             await client.query(
                 `DELETE FROM users WHERE id = $1`,
                 [user.id]
             );

             await client.query("COMMIT");

             console.log("Account deleted:", user.id);

             return res.json({
                 success: true,
                 message: "Account deleted successfully."
             });

         } catch (error) {
             try {
                 await client.query("ROLLBACK");
             } catch (rollbackError) {
                 console.error("Rollback error:", rollbackError);
             }

             console.error("Delete account error:", error);

             return res.status(500).json({
                 success: false,
                 message: "Unable to delete account. Please try again."
             });

         } finally {
             client.release();
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

            
const safeQuestions = questions.map(question => {
    const copy = { ...question };

    for (const key of [
        "question",
        "optionA",
        "optionB",
        "optionC",
        "optionD"
    ]) {
        if (copy[key] !== undefined) {
            copy[key] = formatMathText(copy[key]);
        }
    }

    // Never expose answers or solutions before submission.
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
});


// 
 // ============================================================
 // QUIZ SUBMIT
 // ============================================================



app.post(
    "/api/quiz/submit",
    async (req, res) => {
        try {
            const body = req.body || {};

            // SINGLE QUESTION MODE
            if (
                body.questionId !== undefined &&
                body.selectedAnswer !== undefined
            ) {
                const questionId = Number(body.questionId);
                const selectedAnswer = String(
                    body.selectedAnswer || ""
                ).trim();

                const questions = readQuestions();

                const question = questions.find(
                    item => Number(item.id) === questionId
                );

                if (!question) {
                    return res.status(404).json({
                        success: false,
                        message: "Question not found."
                    });
                }

                const normalizedSelected = normalizeAnswer(
                    selectedAnswer,
                    question
                );

                const correctAnswer =
                    getCorrectAnswer(question);

                const isCorrect =
                    normalizedSelected !== "" &&
                    correctAnswer !== "" &&
                    normalizedSelected === correctAnswer;

                const solution = formatMathText(
                    getQuestionSolution(question)
                );

                return res.json({
                    success: true,
                    correct: isCorrect,
                    questionId,
                    selectedAnswer: normalizedSelected,
                    selectedOption: formatMathText(
                        getOptionText(
                            question,
                            normalizedSelected
                        )
                    ),
                    correctAnswer,
                    correctOption: formatMathText(
                        getOptionText(
                            question,
                            correctAnswer
                        )
                    ),
                    solution,
                    explanation: solution
                });
            } // IMPORTANT: closes single-question mode

            // BATCH QUIZ MODE: requires authentication
            const user = await getAuthenticatedUser(req);

            if (!user) {
                return res.status(401).json({
                    success: false,
                    message:
                        "Please sign in to submit and save a quiz."
                });
            }

            const {
                subject,
                difficulty,
                questions: submittedQuestions,
                answers,
                score,
                totalQuestions
            } = body;

            const quizQuestions =
                Array.isArray(submittedQuestions)
                    ? submittedQuestions
                    : [];

            const submittedAnswers =
                answers && typeof answers === "object"
                    ? answers
                    : {};

            let correctAnswers = 0;

            const answerDetails = quizQuestions.map(question => {
                const questionId = Number(question.id);

                const selected =
                    submittedAnswers[questionId] ??
                    submittedAnswers[String(questionId)] ??
                    "";

                const normalizedSelected = normalizeAnswer(
                    selected,
                    question
                );

                const correctAnswer =
                    getCorrectAnswer(question);

                const correct =
                    normalizedSelected === correctAnswer &&
                    correctAnswer !== "";

                if (correct) {
                    correctAnswers++;
                }

                return {
                    questionId,
                    selectedAnswer: normalizedSelected,
                    correctAnswer,
                    correct,
                    solution: formatMathText(
                        getQuestionSolution(question)
                    )
                };
            });

            const finalTotal =
                Number(totalQuestions) ||
                quizQuestions.length;

            const finalScore =
                score !== undefined
                    ? Number(score)
                    : (
                        finalTotal > 0
                            ? Math.round(
                                (correctAnswers / finalTotal) * 100
                            )
                            : 0
                    );

            const insert = await pool.query(
                `
                INSERT INTO quiz_results
                (
                    user_id_text,
                    subject,
                    difficulty,
                    questions,
                    answers,
                    answer_details,
                    score,
                    total_questions,
                    correct_answers
                )
                VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
                RETURNING id, created_at
                `,
                [
                    user.id,
                    subject || "",
                    difficulty || "",
                    JSON.stringify(quizQuestions),
                    JSON.stringify(submittedAnswers),
                    JSON.stringify(answerDetails),
                    finalScore,
                    finalTotal,
                    correctAnswers
                ]
            );

            const savedResult = insert.rows[0];

            return res.json({
                success: true,
                score: finalScore,
                totalQuestions: finalTotal,
                correctAnswers,
                answerDetails,
                resultId: savedResult.id
            });

        } catch (error) {
            console.error("Quiz submit error:", error);

            return res.status(500).json({
                success: false,
                message: "Unable to submit quiz."
            });
        }
    }
);


// ============================================================
// QUIZ HISTORY
// ============================================================

app.get(
    "/api/quiz/history",
    requireAuth,
    async (req, res) => {
        try {
            const result = await pool.query(
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
                WHERE user_id_text = $1
                ORDER BY created_at DESC
                `,
                [req.user.id]
            );

            return res.json({
                success: true,
                history: result.rows
            });

        } catch (error) {
            console.error("Quiz history error:", error);

            return res.status(500).json({
                success: false,
                message: "Unable to load quiz history."
            });
        }
    }
);

/* 
/* ============================================================
   ASK AI - WITH RETRY HANDLING
   ============================================================ */

app.post("/api/ask", async (req, res) => {
    const sleep = (ms) =>
        new Promise(resolve => setTimeout(resolve, ms));

    try {
        const body = req.body || {};

        const prompt = String(
            body.prompt ??
            body.question ??
            body.message ??
            body.text ??
            ""
        ).trim();

        if (!prompt) {
            return res.status(400).json({
                success: false,
                message: "Please enter a question."
            });
        }

        if (!gemini || !GEMINI_API_KEY) {
            console.error(
                "Ask AI failed: Gemini is not configured."
            );

            return res.status(503).json({
                success: false,
                message:
                    "AI service is not configured. Please try again later."
            });
        }

        console.log("Ask AI request received.");

        let result = null;
        let lastError = null;

        // Maximum 3 attempts, including the first request.
        for (let attempt = 1; attempt <= 3; attempt++) {
            try {
                console.log(
                    `Gemini request attempt ${attempt}/3.`
                );

                result = await gemini.models.generateContent({
                    model: GEMINI_MODEL,
                    contents: prompt
                });

                lastError = null;
                break;

            } catch (error) {
                lastError = error;

                const status = Number(
                    error?.status ??
                    error?.code ??
                    error?.response?.status ??
                    0
                );

                const errorText = String(
                    error?.message || error || ""
                );

                const temporaryError =
                    [408, 429, 500, 502, 503, 504]
                        .includes(status) ||
                    /UNAVAILABLE|RESOURCE_EXHAUSTED|overloaded|high demand|temporarily unavailable/i
                        .test(errorText);

                console.error(
                    `Gemini attempt ${attempt} failed. ` +
                    `Status: ${status || "unknown"}. ` +
                    `Message: ${errorText}`
                );

                if (!temporaryError || attempt === 3) {
                    break;
                }

                // Wait 1 second, then 2 seconds before retrying.
                await sleep(attempt * 1000);
            }
        }

        if (lastError) {
            const status = Number(
                lastError?.status ??
                lastError?.code ??
                lastError?.response?.status ??
                0
            );

            const errorText = String(
                lastError?.message || lastError || ""
            );

            console.error(
                "Ask AI failed after retries:",
                errorText
            );

            if (
                status === 429 ||
                /RESOURCE_EXHAUSTED/i.test(errorText)
            ) {
                return res.status(429).json({
                    success: false,
                    message:
                        "The AI service is busy or has reached its usage limit. Please wait a moment and try again."
                });
            }

            if (
                [408, 500, 502, 503, 504].includes(status) ||
                /UNAVAILABLE|overloaded|high demand|temporarily unavailable/i
                    .test(errorText)
            ) {
                return res.status(503).json({
                    success: false,
                    message:
                        "The AI service is temporarily busy. Please try again in a moment."
                });
            }

            if (
                status === 400 ||
                status === 401 ||
                status === 403
            ) {
                return res.status(502).json({
                    success: false,
                    message:
                        "The AI request could not be processed. Please check the server's Gemini model and API key configuration."
                });
            }

            return res.status(502).json({
                success: false,
                message:
                    "Unable to get an AI response. Please try again later."
            });
        }

        const answer = formatMathText(
    String(result?.text || "").trim()
);

        if (!answer) {
            console.error(
                "Ask AI returned an empty response."
            );

            return res.status(502).json({
                success: false,
                message:
                    "AI returned an empty response. Please try again."
            });
        }

        console.log(
            "Ask AI response generated successfully."
        );

        return res.json({
            success: true,
            answer: answer,
            response: answer,
            message: answer
        });

    } catch (error) {
        console.error(
            "Unexpected Ask AI error:",
            error?.stack || error?.message || error
        );

        return res.status(500).json({
            success: false,
            message:
                "An unexpected error occurred while getting the AI response. Please try again."
        });
    }
});

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