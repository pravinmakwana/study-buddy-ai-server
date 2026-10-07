import express from "express";
import cors from "cors";
import crypto from "crypto";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { Pool } from "pg";
import { GoogleGenAI } from "@google/genai";

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


// ============================================================
// FILE PATHS
// ============================================================

const DATA_DIR = path.join(__dirname, "data");

const QUESTIONS_FILE =
    path.join(DATA_DIR, "questions.json");


// ============================================================
// DATABASE
// ============================================================

if (!DATABASE_URL) {
    console.error(
        "DATABASE_URL environment variable is missing."
    );

    process.exit(1);
}

const pool = new Pool({
    connectionString: DATABASE_URL,

    ssl:
        process.env.NODE_ENV === "production"
            ? {
                rejectUnauthorized: false
            }
            : false,

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

    console.log(
        "Gemini AI service configured."
    );

} else {

    console.log(
        "Gemini AI service not configured."
    );
}


// ============================================================
// RESEND
// ============================================================

if (RESEND_API_KEY) {

    console.log(
        "Resend email service configured."
    );

} else {

    console.log(
        "Resend email service not configured."
    );
}


// ============================================================
// DATABASE INITIALIZATION
// ============================================================

async function initializeDatabase() {

    console.log(
        "Initializing PostgreSQL database..."
    );

    await pool.query(`
        CREATE TABLE IF NOT EXISTS users (
            id SERIAL PRIMARY KEY,

            name VARCHAR(150) NOT NULL,

            email VARCHAR(255) NOT NULL UNIQUE,

            password_hash TEXT NOT NULL,

            password_salt TEXT NOT NULL,

            auth_token TEXT,

            reset_otp_hash TEXT,

            reset_otp_expires_at TIMESTAMP,

            reset_otp_verified_until TIMESTAMP,

            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,

            updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        );
    `);


    await pool.query(`
        CREATE UNIQUE INDEX IF NOT EXISTS
        users_email_lower_unique
        ON users (LOWER(email));
    `);


    await pool.query(`
        CREATE INDEX IF NOT EXISTS
        users_auth_token_index
        ON users (auth_token);
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

            score NUMERIC,

            total_questions INTEGER,

            correct_answers INTEGER,

            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        );
    `);


    await pool.query(`
        CREATE INDEX IF NOT EXISTS
        quiz_results_user_id_index
        ON quiz_results (user_id);
    `);


    console.log(
        "PostgreSQL database initialized successfully."
    );
}


// ============================================================
// PASSWORD FUNCTIONS
// ============================================================

function hashPassword(password) {

    const salt =
        crypto.randomBytes(16).toString("hex");

    const hash =
        crypto.scryptSync(
            password,
            salt,
            64
        ).toString("hex");

    return {
        hash,
        salt
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


// ============================================================
// QUESTIONS
// ============================================================

function loadQuestions() {

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
            "Unable to load questions.json:",
            error
        );

        return [];
    }
}


// ============================================================
// QUIZ ANSWER HELPERS
// ============================================================

function normalizeAnswer(
    value,
    question
) {

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
        upper.replace(
            /\s+/g,
            ""
        );


    if (
        optionName === "OPTIONA"
    ) {
        return "A";
    }

    if (
        optionName === "OPTIONB"
    ) {
        return "B";
    }

    if (
        optionName === "OPTIONC"
    ) {
        return "C";
    }

    if (
        optionName === "OPTIOND"
    ) {
        return "D";
    }


    const optionA =
        String(
            question?.optionA || ""
        ).trim();

    const optionB =
        String(
            question?.optionB || ""
        ).trim();

    const optionC =
        String(
            question?.optionC || ""
        ).trim();

    const optionD =
        String(
            question?.optionD || ""
        ).trim();


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

    if (
        !question ||
        !answer
    ) {
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
// AUTHENTICATED USER
// ============================================================

async function getAuthenticatedUser(req) {

    const authHeader =
        req.headers.authorization || "";

    if (
        !authHeader.startsWith("Bearer ")
    ) {
        return null;
    }

    const token =
        authHeader
            .substring(7)
            .trim();

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

    if (
        result.rows.length === 0
    ) {
        return null;
    }

    return result.rows[0];
}


// ============================================================
// SEND PASSWORD RESET EMAIL
// ============================================================

async function sendPasswordResetOTP(
    email,
    otp
) {

    if (!RESEND_API_KEY) {

        throw new Error(
            "Resend is not configured."
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
                        <div style="font-family: Arial, sans-serif;">
                            <h2>Study Buddy AI</h2>

                            <p>
                                Your password reset OTP is:
                            </p>

                            <h1
                                style="
                                    letter-spacing: 6px;
                                    font-size: 32px;
                                "
                            >
                                ${otp}
                            </h1>

                            <p>
                                This OTP is valid for 10 minutes.
                            </p>

                            <p>
                                If you did not request a password reset,
                                please ignore this email.
                            </p>
                        </div>
                    `
                })
            }
        );


    const responseText =
        await response.text();


    if (!response.ok) {

        console.error(
            "Resend API error:",
            response.status,
            responseText
        );

        throw new Error(
            "Unable to send password reset email."
        );
    }


    return true;
}


// ============================================================
// HOME
// ============================================================

app.get(
    "/",
    (req, res) => {

        res.json({
            success: true,
            message:
                "Study Buddy AI API is running.",
            database:
                "PostgreSQL",
            gemini:
                Boolean(GEMINI_API_KEY),
            resend:
                Boolean(RESEND_API_KEY)
        });
    }
);


// ============================================================
// HEALTH
// ============================================================

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
                    "connected",

                timestamp:
                    new Date().toISOString()
            });

        } catch (error) {

            console.error(
                "Health check failed:",
                error
            );

            res.status(500).json({

                success: false,

                status: "unhealthy",

                database:
                    "disconnected"
            });
        }
    }
);


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
                String(
                    name || ""
                ).trim();


            const cleanEmail =
                String(
                    email || ""
                ).trim()
                .toLowerCase();


            const cleanPassword =
                String(
                    password || ""
                );


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


            if (
                !/^[^\s@]+@[^\s@]+\.[^\s@]+$/
                    .test(cleanEmail)
            ) {

                return res.status(400).json({
                    success: false,
                    message:
                        "Please enter a valid email."
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


            // Check existing user
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
                hash,
                salt
            } = hashPassword(
                cleanPassword
            );


            const result =
                await pool.query(
                    `
                    INSERT INTO users (
                        name,
                        email,
                        password_hash,
                        password_salt
                    )
                    VALUES ($1, $2, $3, $4)
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
                "New user registered:",
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
                String(
                    email || ""
                ).trim()
                .toLowerCase();


            const cleanPassword =
                String(
                    password || ""
                );


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


            const valid =
                verifyPassword(
                    cleanPassword,
                    user.password_hash,
                    user.password_salt
                );


            if (!valid) {

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
                SET
                    auth_token = $1,
                    updated_at = CURRENT_TIMESTAMP
                WHERE id = $2
                `,
                [
                    token,
                    user.id
                ]
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
// CURRENT USER
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
                        "Not authenticated."
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

            const authHeader =
                req.headers.authorization || "";


            if (
                authHeader.startsWith("Bearer ")
            ) {

                const token =
                    authHeader
                        .substring(7)
                        .trim();


                if (token) {

                    await pool.query(
                        `
                        UPDATE users
                        SET
                            auth_token = NULL,
                            updated_at = CURRENT_TIMESTAMP
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
                String(
                    email || ""
                ).trim()
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
                    reset_otp_verified_until = NULL,
                    updated_at = CURRENT_TIMESTAMP
                WHERE id = $3
                `,
                [
                    otpHash,
                    expiresAt,
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
                String(
                    email || ""
                ).trim()
                .toLowerCase();


            const cleanOTP =
                String(
                    otp || ""
                ).trim();


            if (
                !cleanEmail ||
                !cleanOTP
            ) {

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
                        "Account not found."
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
                        "No OTP request found."
                });
            }


            const expiresAt =
                new Date(
                    user.reset_otp_expires_at
                );


            if (
                Date.now() >
                expiresAt.getTime()
            ) {

                return res.status(400).json({

                    success: false,

                    message:
                        "OTP has expired. Please request a new OTP."
                });
            }


            const submittedHash =
                hashOTP(cleanOTP);


            if (
                submittedHash !==
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
                    reset_otp_verified_until = $1,
                    reset_otp_hash = NULL,
                    reset_otp_expires_at = NULL,
                    updated_at = CURRENT_TIMESTAMP
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


// ============================================================
// RESET PASSWORD
// ============================================================

app.post(
    "/api/auth/reset-password",
    async (req, res) => {

        try {

            const {
                email,
                password,
                newPassword
            } = req.body || {};


            const cleanEmail =
                String(
                    email || ""
                ).trim()
                .toLowerCase();


            const finalPassword =
                String(
                    newPassword ||
                    password ||
                    ""
                );


            if (!cleanEmail) {

                return res.status(400).json({

                    success: false,

                    message:
                        "Email is required."
                });
            }


            if (
                finalPassword.length < 6
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
                        "Account not found."
                });
            }


            const user =
                result.rows[0];


            if (
                !user.reset_otp_verified_until
            ) {

                return res.status(403).json({

                    success: false,

                    message:
                        "Please verify the OTP first."
                });
            }


            const verifiedUntil =
                new Date(
                    user.reset_otp_verified_until
                );


            if (
                Date.now() >
                verifiedUntil.getTime()
            ) {

                return res.status(403).json({

                    success: false,

                    message:
                        "Password reset session has expired. Please request a new OTP."
                });
            }


            const {
                hash,
                salt
            } = hashPassword(
                finalPassword
            );


            const newToken =
                generateToken();


            await pool.query(
                `
                UPDATE users
                SET
                    password_hash = $1,
                    password_salt = $2,
                    auth_token = $3,
                    reset_otp_verified_until = NULL,
                    updated_at = CURRENT_TIMESTAMP
                WHERE id = $4
                `,
                [
                    hash,
                    salt,
                    newToken,
                    user.id
                ]
            );


            return res.json({

                success: true,

                message:
                    "Password reset successfully.",

                token:
                    newToken
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
// GET QUIZ QUESTIONS
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
                loadQuestions();


            if (
                questions.length === 0
            ) {

                return res.status(404).json({

                    success: false,

                    message:
                        "No questions found."
                });
            }


            if (
                subject &&
                String(subject).trim()
            ) {

                const requestedSubject =
                    String(
                        subject
                    ).trim()
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
                String(difficulty)
                    .trim()
                    .toLowerCase() !== "all"
            ) {

                const requestedDifficulty =
                    String(
                        difficulty
                    ).trim()
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


            if (
                questions.length === 0
            ) {

                return res.status(404).json({

                    success: false,

                    message:
                        "No questions found for the selected subject or difficulty."
                });
            }


            // Shuffle questions
            questions =
                questions.sort(
                    () => Math.random() - 0.5
                );


            const requestedCount =
                Number(count);


            if (
                Number.isInteger(
                    requestedCount
                ) &&
                requestedCount > 0
            ) {

                questions =
                    questions.slice(
                        0,
                        requestedCount
                    );
            }


            // IMPORTANT:
            // Never send the correct answer to Android
            // before the user answers.
            const safeQuestions =
                questions.map(
                    question => {

                        const safeQuestion = {
                            ...question
                        };


                        delete safeQuestion.correctAnswer;
                        delete safeQuestion.correct_answer;
                        delete safeQuestion.correctOption;
                        delete safeQuestion.correct_option;
                        delete safeQuestion.answer;
                        delete safeQuestion.correct;
                        delete safeQuestion.solution;
                        delete safeQuestion.explanation;
                        delete safeQuestion.answerExplanation;
                        delete safeQuestion.answer_explanation;


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
                "Get quiz questions error:",
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
// SUBMIT SINGLE QUESTION ANSWER
// ============================================================

app.post(
    "/api/quiz/submit",
    async (req, res) => {

        try {

            const body =
                req.body || {};


            // ==================================================
            // SINGLE QUESTION MODE
            // ==================================================

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
                    !Number.isInteger(
                        questionId
                    )
                ) {

                    return res.status(400).json({

                        success: false,

                        message:
                            "Invalid questionId."
                    });
                }


                const questions =
                    loadQuestions();


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


                if (!correctAnswer) {

                    return res.status(500).json({

                        success: false,

                        message:
                            "Correct answer is not configured for this question."
                    });
                }


                const isCorrect =
                    normalizedSelected ===
                    correctAnswer;


                const solution =
                    getQuestionSolution(
                        question
                    );


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


                return res.json({

                    success: true,

                    correct:
                        isCorrect,

                    questionId,

                    selectedAnswer:
                        normalizedSelected,

                    selectedOption,

                    correctAnswer,

                    correctOption,

                    solution,

                    explanation:
                        solution
                });
            }


            // ==================================================
            // BATCH QUIZ RESULT MODE
            // ==================================================

            const {
                userId,
                subject,
                difficulty,
                questions,
                answers,
                score,
                totalQuestions
            } = body;


            const questionList =
                Array.isArray(questions)
                    ? questions
                    : [];


            const answerList =
                Array.isArray(answers)
                    ? answers
                    : [];


            const loadedQuestions =
                loadQuestions();


            let calculatedCorrect =
                0;


            const answerDetails =
                questionList.map(
                    questionItem => {

                        const questionId =
                            Number(
                                questionItem.id
                            );


                        const fullQuestion =
                            loadedQuestions.find(
                                q =>
                                    Number(q.id) ===
                                    questionId
                            ) ||
                            questionItem;


                        let selectedAnswer = "";


                        const answerObject =
                            answerList.find(
                                answer => {

                                    if (
                                        answer &&
                                        typeof answer ===
                                        "object"
                                    ) {

                                        return Number(
                                            answer.questionId
                                        ) ===
                                        questionId;
                                    }

                                    return false;
                                }
                            );


                        if (
                            answerObject
                        ) {

                            selectedAnswer =
                                answerObject.selectedAnswer ||
                                answerObject.answer ||
                                "";
                        }


                        const correctAnswer =
                            getCorrectAnswer(
                                fullQuestion
                            );


                        const normalizedSelected =
                            normalizeAnswer(
                                selectedAnswer,
                                fullQuestion
                            );


                        const correct =
                            normalizedSelected !== "" &&
                            normalizedSelected ===
                            correctAnswer;


                        if (correct) {
                            calculatedCorrect++;
                        }


                        return {

                            questionId,

                            selectedAnswer:
                                normalizedSelected,

                            correctAnswer,

                            correct,

                            selectedOption:
                                getOptionText(
                                    fullQuestion,
                                    normalizedSelected
                                ),

                            correctOption:
                                getOptionText(
                                    fullQuestion,
                                    correctAnswer
                                ),

                            solution:
                                getQuestionSolution(
                                    fullQuestion
                                )
                        };
                    }
                );


            const finalTotal =
                Number.isInteger(
                    Number(totalQuestions)
                )
                    ? Number(totalQuestions)
                    : questionList.length;


            const finalCorrect =
                questionList.length > 0
                    ? calculatedCorrect
                    : Number(
                        body.correctAnswers || 0
                    );


            const finalScore =
                finalTotal > 0
                    ? Math.round(
                        (
                            finalCorrect /
                            finalTotal
                        ) * 100
                    )
                    : Number(score || 0);


            let databaseUserId = null;


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

                    databaseUserId =
                        parsedUserId;
                }
            }


            const insertResult =
                await pool.query(
                    `
                    INSERT INTO quiz_results (
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
                    VALUES (
                        $1,
                        $2,
                        $3,
                        $4::jsonb,
                        $5::jsonb,
                        $6::jsonb,
                        $7,
                        $8,
                        $9
                    )
                    RETURNING
                        id,
                        created_at
                    `,
                    [
                        databaseUserId,
                        subject || "",
                        difficulty || "",
                        JSON.stringify(
                            questionList
                        ),
                        JSON.stringify(
                            answerList
                        ),
                        JSON.stringify(
                            answerDetails
                        ),
                        finalScore,
                        finalTotal,
                        finalCorrect
                    ]
                );


            return res.json({

                success: true,

                resultId:
                    insertResult.rows[0].id,

                score:
                    finalScore,

                totalQuestions:
                    finalTotal,

                correctAnswers:
                    finalCorrect,

                answerDetails,

                createdAt:
                    insertResult.rows[0]
                        .created_at
            });


        } catch (error) {

            console.error(
                "Submit quiz error:",
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

            const authenticatedUser =
                await getAuthenticatedUser(req);


            let userId =
                authenticatedUser
                    ? authenticatedUser.id
                    : null;


            if (!userId && req.query.userId) {

                const parsed =
                    Number(
                        req.query.userId
                    );


                if (
                    Number.isInteger(parsed)
                ) {

                    userId = parsed;
                }
            }


            if (!userId) {

                return res.status(401).json({

                    success: false,

                    message:
                        "Authentication required."
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

            if (!gemini) {

                return res.status(503).json({

                    success: false,

                    message:
                        "Gemini AI service is not configured."
                });
            }


            const {
                question,
                prompt,
                message,
                subject
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


            const subjectText =
                subject
                    ? `The student's subject is ${subject}.`
                    : "";


            const tutorPrompt = `
You are Study Buddy AI, a friendly and knowledgeable tutor.

${subjectText}

Help the student understand the topic clearly.

Student question:
${userQuestion}

Instructions:

- Give a clear educational explanation.
- Use simple language.
- Explain step by step when useful.
- Use examples where helpful.
- For mathematics, show calculations clearly.
- For science, explain concepts accurately.
- Use headings and bullet points where useful.
- Do not unnecessarily repeat the question.
- Do not ask unnecessary follow-up questions.
- Focus on helping the student learn.
`;


            const response =
                await gemini.models.generateContent({

                    model:
                        GEMINI_MODEL,

                    contents:
                        tutorPrompt
                });


            const answer =
                response.text ||
                "";


            return res.json({

                success: true,

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
                    "Unable to generate AI answer."
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
// GLOBAL ERROR HANDLER
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

        await initializeDatabase();


        // Test PostgreSQL connection
        await pool.query(
            "SELECT NOW()"
        );


        console.log(
            "PostgreSQL connection successful."
        );


        app.listen(
            PORT,
            "0.0.0.0",
            () => {

                console.log(
                    "============================================"
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
                    "============================================"
                );
            }
        );


    } catch (error) {

        console.error(
            "Failed to start server:"
        );

        console.error(error);

        process.exit(1);
    }
}


startServer();