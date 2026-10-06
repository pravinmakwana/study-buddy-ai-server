import express from "express";
import cors from "cors";
import crypto from "crypto";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { Pool } from "pg";
import { GoogleGenAI } from "@google/genai";

// ======================================================
// BASIC CONFIGURATION
// ======================================================

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();

app.use(cors());

app.use(
    express.json({
        limit: "5mb"
    })
);

const PORT =
    process.env.PORT || 10000;

// ======================================================
// DATABASE
// ======================================================

const DATABASE_URL =
    process.env.DATABASE_URL;

if (!DATABASE_URL) {
    console.error(
        "DATABASE_URL is not configured."
    );
    process.exit(1);
}

const pool = new Pool({
    connectionString:
        DATABASE_URL,

    ssl:
        process.env.NODE_ENV === "production"
            ? {
                rejectUnauthorized: false
            }
            : false
});

// ======================================================
// DATA FILES
// ======================================================

const DATA_DIR =
    path.join(
        __dirname,
        "data"
    );

const USERS_FILE =
    path.join(
        DATA_DIR,
        "users.json"
    );

const QUESTIONS_FILE =
    path.join(
        DATA_DIR,
        "questions.json"
    );

if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(
        DATA_DIR,
        {
            recursive: true
        }
    );
}

// ======================================================
// ENVIRONMENT
// ======================================================

const RESEND_API_KEY =
    process.env.RESEND_API_KEY;

const RESEND_FROM_EMAIL =
    process.env.RESEND_FROM_EMAIL ||
    "onboarding@resend.dev";

const resendConfigured =
    Boolean(
        RESEND_API_KEY
    );

const GEMINI_API_KEY =
    process.env.GEMINI_API_KEY;

const GEMINI_MODEL =
    process.env.GEMINI_MODEL ||
    "gemini-3.5-flash-lite";

let gemini = null;

if (GEMINI_API_KEY) {

    gemini =
        new GoogleGenAI({
            apiKey:
                GEMINI_API_KEY
        });

    console.log(
        "Gemini AI service configured."
    );
} else {

    console.log(
        "Gemini AI service is not configured."
    );
}

if (resendConfigured) {

    console.log(
        "Resend email service configured."
    );
} else {

    console.log(
        "Resend email service is not configured."
    );
}

// ======================================================
// OTP CONFIGURATION
// ======================================================

const OTP_EXPIRY_MS =
    10 * 60 * 1000;

const RESET_VERIFIED_EXPIRY_MS =
    10 * 60 * 1000;

// ======================================================
// DATABASE INITIALIZATION
// ======================================================

async function initializeDatabase() {

    console.log(
        "Initializing PostgreSQL database..."
    );

    await pool.query(`
        CREATE TABLE IF NOT EXISTS users (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            email TEXT NOT NULL,
            password_hash TEXT NOT NULL,
            password_salt TEXT NOT NULL,
            auth_token TEXT,
            reset_otp_hash TEXT,
            reset_otp_expires_at TIMESTAMPTZ,
            reset_otp_verified_until TIMESTAMPTZ,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
    `);

    await pool.query(`
        CREATE UNIQUE INDEX IF NOT EXISTS
        users_email_unique
        ON users (LOWER(email))
    `);

    await pool.query(`
        CREATE UNIQUE INDEX IF NOT EXISTS
        users_auth_token_unique
        ON users (auth_token)
        WHERE auth_token IS NOT NULL
    `);

    await pool.query(`
        CREATE TABLE IF NOT EXISTS quiz_results (
            id TEXT PRIMARY KEY,
            user_id TEXT,
            subject TEXT,
            difficulty TEXT,
            questions JSONB NOT NULL DEFAULT '[]'::jsonb,
            answers JSONB NOT NULL DEFAULT '[]'::jsonb,
            score NUMERIC,
            total_questions INTEGER,
            correct_answers INTEGER,
            answer_details JSONB NOT NULL DEFAULT '[]'::jsonb,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
    `);

    await pool.query(`
        CREATE INDEX IF NOT EXISTS
        quiz_results_user_id_index
        ON quiz_results(user_id)
    `);

    console.log(
        "PostgreSQL database initialized successfully."
    );
}

// ======================================================
// PASSWORD HASHING
// ======================================================

function hashPassword(
    password,
    salt = crypto
        .randomBytes(16)
        .toString("hex")
) {

    const passwordHash =
        crypto
            .scryptSync(
                password,
                salt,
                64
            )
            .toString("hex");

    return {
        passwordHash,
        passwordSalt:
            salt
    };
}

function verifyPassword(
    password,
    passwordHash,
    passwordSalt
) {

    try {

        const hash =
            crypto
                .scryptSync(
                    password,
                    passwordSalt,
                    64
                )
                .toString("hex");

        return crypto.timingSafeEqual(
            Buffer.from(
                hash,
                "hex"
            ),
            Buffer.from(
                passwordHash,
                "hex"
            )
        );

    } catch {

        return false;
    }
}

// ======================================================
// TOKEN
// ======================================================

function createAuthToken() {

    return crypto
        .randomBytes(32)
        .toString("hex");
}

// ======================================================
// OTP
// ======================================================

function generateOtp() {

    return Math.floor(
        100000 +
        Math.random() * 900000
    ).toString();
}

function hashOtp(
    otp
) {

    return crypto
        .createHash("sha256")
        .update(otp)
        .digest("hex");
}

// ======================================================
// QUESTIONS
// ======================================================

function loadQuestions() {

    try {

        if (
            !fs.existsSync(
                QUESTIONS_FILE
            )
        ) {
            return [];
        }

        const content =
            fs.readFileSync(
                QUESTIONS_FILE,
                "utf8"
            ).trim();

        if (!content) {
            return [];
        }

        const data =
            JSON.parse(content);

        if (Array.isArray(data)) {
            return data;
        }

        if (
            data &&
            Array.isArray(
                data.questions
            )
        ) {
            return data.questions;
        }

        return [];

    } catch (error) {

        console.error(
            "Unable to load questions:",
            error
        );

        return [];
    }
}

// ======================================================
// QUIZ ANSWER HELPERS
// ======================================================

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

function getCorrectAnswer(
    question
) {

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

function getQuestionSolution(
    question
) {

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

// ======================================================
// RESEND EMAIL
// ======================================================

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
                    "Content-Type":
                        "application/json",

                    "Authorization":
                        `Bearer ${RESEND_API_KEY}`
                },

                body: JSON.stringify({

                    from:
                        RESEND_FROM_EMAIL,

                    to: [
                        email
                    ],

                    subject:
                        "Study Buddy AI - Password Reset OTP",

                    html: `
                        <div style="
                            font-family: Arial, sans-serif;
                            max-width: 600px;
                            margin: 0 auto;
                            padding: 20px;
                        ">

                            <h2>
                                Study Buddy AI
                            </h2>

                            <p>
                                We received a request
                                to reset your password.
                            </p>

                            <p>
                                Your password reset OTP is:
                            </p>

                            <div style="
                                font-size: 32px;
                                font-weight: bold;
                                letter-spacing: 8px;
                                margin: 25px 0;
                            ">
                                ${otp}
                            </div>

                            <p>
                                This OTP is valid for
                                10 minutes.
                            </p>

                            <p>
                                If you did not request
                                a password reset, you can
                                safely ignore this email.
                            </p>

                            <p>
                                Regards,<br>
                                Study Buddy AI
                            </p>

                        </div>
                    `
                })
            }
        );

    const text =
        await response.text();

    if (!response.ok) {

        console.error(
            "Resend API error:",
            response.status,
            text
        );

        throw new Error(
            `Resend API error: ${response.status}`
        );
    }

    return text;
}

// ======================================================
// AUTH TOKEN
// ======================================================

function getTokenFromRequest(
    req
) {

    const header =
        req.headers.authorization;

    if (
        !header ||
        !header.startsWith(
            "Bearer "
        )
    ) {
        return null;
    }

    return header
        .substring(7)
        .trim();
}

async function getAuthenticatedUser(
    req
) {

    const token =
        getTokenFromRequest(
            req
        );

    if (!token) {
        return null;
    }

    const result =
        await pool.query(
            `
            SELECT *
            FROM users
            WHERE auth_token = $1
            LIMIT 1
            `,
            [
                token
            ]
        );

    if (
        result.rows.length === 0
    ) {
        return null;
    }

    return result.rows[0];
}

// ======================================================
// HOME
// ======================================================

app.get(
    "/",
    (req, res) => {

        res.json({

            success:
                true,

            message:
                "Study Buddy AI server is running.",

            database:
                "PostgreSQL",

            gemini:
                Boolean(
                    GEMINI_API_KEY
                ),

            resend:
                resendConfigured
        });
    }
);

// ======================================================
// HEALTH
// ======================================================

app.get(
    "/health",
    async (req, res) => {

        try {

            await pool.query(
                "SELECT 1"
            );

            res.json({

                success:
                    true,

                status:
                    "healthy",

                database:
                    "connected"
            });

        } catch (error) {

            console.error(
                "Health database error:",
                error
            );

            res.status(500).json({

                success:
                    false,

                status:
                    "unhealthy",

                database:
                    "disconnected"
            });
        }
    }
);

// ======================================================
// SIGN UP
// ======================================================

app.post(
    "/api/auth/signup",
    async (req, res) => {

        try {

            const {
                name,
                email,
                password,
                confirmPassword
            } = req.body || {};

            if (
                !name ||
                !email ||
                !password ||
                !confirmPassword
            ) {

                return res.status(400).json({

                    success:
                        false,

                    message:
                        "All fields are required."
                });
            }

            const cleanName =
                String(name).trim();

            const cleanEmail =
                String(email)
                    .trim()
                    .toLowerCase();

            if (!cleanName) {

                return res.status(400).json({

                    success:
                        false,

                    message:
                        "Name is required."
                });
            }

            if (
                !/^[^\s@]+@[^\s@]+\.[^\s@]+$/
                    .test(cleanEmail)
            ) {

                return res.status(400).json({

                    success:
                        false,

                    message:
                        "Enter a valid email."
                });
            }

            if (
                String(password).length < 6
            ) {

                return res.status(400).json({

                    success:
                        false,

                    message:
                        "Password must contain at least 6 characters."
                });
            }

            if (
                password !==
                confirmPassword
            ) {

                return res.status(400).json({

                    success:
                        false,

                    message:
                        "Passwords do not match."
                });
            }

            // ==========================================
            // CHECK EXISTING USER
            // ==========================================

            const existingUser =
                await pool.query(
                    `
                    SELECT id
                    FROM users
                    WHERE LOWER(email) = LOWER($1)
                    LIMIT 1
                    `,
                    [
                        cleanEmail
                    ]
                );

            if (
                existingUser.rows.length > 0
            ) {

                return res.status(409).json({

                    success:
                        false,

                    message:
                        "Account already exists. Please sign in."
                });
            }

            const {
                passwordHash,
                passwordSalt
            } =
                hashPassword(
                    password
                );

            const userId =
                crypto.randomUUID();

            await pool.query(
                `
                INSERT INTO users (
                    id,
                    name,
                    email,
                    password_hash,
                    password_salt
                )
                VALUES (
                    $1,
                    $2,
                    $3,
                    $4,
                    $5
                )
                `,
                [
                    userId,
                    cleanName,
                    cleanEmail,
                    passwordHash,
                    passwordSalt
                ]
            );

            console.log(
                `New PostgreSQL user registered: ${cleanEmail}`
            );

            return res.status(201).json({

                success:
                    true,

                message:
                    "Account created successfully.",

                user: {

                    id:
                        userId,

                    name:
                        cleanName,

                    email:
                        cleanEmail
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

                    success:
                        false,

                    message:
                        "Account already exists. Please sign in."
                });
            }

            return res.status(500).json({

                success:
                    false,

                message:
                    "Unable to create account. Please try again."
            });
        }
    }
);

// ======================================================
// SIGN IN
// ======================================================

app.post(
    "/api/auth/signin",
    async (req, res) => {

        try {

            const {
                email,
                password
            } = req.body || {};

            if (
                !email ||
                !password
            ) {

                return res.status(400).json({

                    success:
                        false,

                    message:
                        "Email and password are required."
                });
            }

            const cleanEmail =
                String(email)
                    .trim()
                    .toLowerCase();

            const result =
                await pool.query(
                    `
                    SELECT *
                    FROM users
                    WHERE LOWER(email) = LOWER($1)
                    LIMIT 1
                    `,
                    [
                        cleanEmail
                    ]
                );

            if (
                result.rows.length === 0
            ) {

                return res.status(401).json({

                    success:
                        false,

                    message:
                        "Incorrect email or password."
                });
            }

            const user =
                result.rows[0];

            const validPassword =
                verifyPassword(
                    password,
                    user.password_hash,
                    user.password_salt
                );

            if (!validPassword) {

                return res.status(401).json({

                    success:
                        false,

                    message:
                        "Incorrect email or password."
                });
            }

            const token =
                createAuthToken();

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

            return res.json({

                success:
                    true,

                message:
                    "Sign in successful.",

                token,

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

                success:
                    false,

                message:
                    "Unable to sign in. Please try again."
            });
        }
    }
);

// ======================================================
// CURRENT USER
// ======================================================

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

                    success:
                        false,

                    message:
                        "Unauthorized."
                });
            }

            return res.json({

                success:
                    true,

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

                success:
                    false,

                message:
                    "Unable to get user."
            });
        }
    }
);

// ======================================================
// LOGOUT
// ======================================================

app.post(
    "/api/auth/logout",
    async (req, res) => {

        try {

            const token =
                getTokenFromRequest(
                    req
                );

            if (token) {

                await pool.query(
                    `
                    UPDATE users
                    SET auth_token = NULL
                    WHERE auth_token = $1
                    `,
                    [
                        token
                    ]
                );
            }

            return res.json({

                success:
                    true,

                message:
                    "Signed out successfully."
            });

        } catch (error) {

            console.error(
                "Logout error:",
                error
            );

            return res.status(500).json({

                success:
                    false,

                message:
                    "Unable to sign out."
            });
        }
    }
);

// ======================================================
// FORGOT PASSWORD
// ======================================================

app.post(
    "/api/auth/forgot-password",
    async (req, res) => {

        try {

            const {
                email
            } = req.body || {};

            if (!email) {

                return res.status(400).json({

                    success:
                        false,

                    message:
                        "Email is required."
                });
            }

            const cleanEmail =
                String(email)
                    .trim()
                    .toLowerCase();

            const result =
                await pool.query(
                    `
                    SELECT *
                    FROM users
                    WHERE LOWER(email) = LOWER($1)
                    LIMIT 1
                    `,
                    [
                        cleanEmail
                    ]
                );

            if (
                result.rows.length === 0
            ) {

                return res.status(404).json({

                    success:
                        false,

                    message:
                        "No account found with this email."
                });
            }

            if (!resendConfigured) {

                return res.status(500).json({

                    success:
                        false,

                    message:
                        "Password reset email service is not configured."
                });
            }

            const otp =
                generateOtp();

            const otpHash =
                hashOtp(
                    otp
                );

            const expiresAt =
                new Date(
                    Date.now() +
                    OTP_EXPIRY_MS
                );

            await sendPasswordResetOTP(
                cleanEmail,
                otp
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
                    result.rows[0].id
                ]
            );

            return res.json({

                success:
                    true,

                message:
                    "OTP sent successfully."
            });

        } catch (error) {

            console.error(
                "Forgot password error:",
                error
            );

            return res.status(500).json({

                success:
                    false,

                message:
                    "Unable to send OTP. Please try again."
            });
        }
    }
);

// ======================================================
// VERIFY RESET OTP
// ======================================================

app.post(
    "/api/auth/verify-reset-otp",
    async (req, res) => {

        try {

            const {
                email,
                otp
            } = req.body || {};

            if (
                !email ||
                !otp
            ) {

                return res.status(400).json({

                    success:
                        false,

                    message:
                        "Email and OTP are required."
                });
            }

            const cleanEmail =
                String(email)
                    .trim()
                    .toLowerCase();

            const result =
                await pool.query(
                    `
                    SELECT *
                    FROM users
                    WHERE LOWER(email) = LOWER($1)
                    LIMIT 1
                    `,
                    [
                        cleanEmail
                    ]
                );

            if (
                result.rows.length === 0
            ) {

                return res.status(404).json({

                    success:
                        false,

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

                    success:
                        false,

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

                await pool.query(
                    `
                    UPDATE users
                    SET
                        reset_otp_hash = NULL,
                        reset_otp_expires_at = NULL
                    WHERE id = $1
                    `,
                    [
                        user.id
                    ]
                );

                return res.status(400).json({

                    success:
                        false,

                    message:
                        "OTP has expired. Please request a new OTP."
                });
            }

            const submittedOtpHash =
                hashOtp(
                    String(
                        otp
                    ).trim()
                );

            if (
                submittedOtpHash !==
                user.reset_otp_hash
            ) {

                return res.status(400).json({

                    success:
                        false,

                    message:
                        "Invalid OTP."
                });
            }

            const verifiedUntil =
                new Date(
                    Date.now() +
                    RESET_VERIFIED_EXPIRY_MS
                );

            await pool.query(
                `
                UPDATE users
                SET reset_otp_verified_until = $1
                WHERE id = $2
                `,
                [
                    verifiedUntil,
                    user.id
                ]
            );

            return res.json({

                success:
                    true,

                message:
                    "OTP verified successfully."
            });

        } catch (error) {

            console.error(
                "Verify OTP error:",
                error
            );

            return res.status(500).json({

                success:
                    false,

                message:
                    "Unable to verify OTP."
            });
        }
    }
);

// ======================================================
// RESET PASSWORD
// ======================================================

app.post(
    "/api/auth/reset-password",
    async (req, res) => {

        try {

            const {
                email,
                newPassword,
                confirmPassword
            } = req.body || {};

            if (
                !email ||
                !newPassword ||
                !confirmPassword
            ) {

                return res.status(400).json({

                    success:
                        false,

                    message:
                        "All fields are required."
                });
            }

            if (
                String(
                    newPassword
                ).length < 6
            ) {

                return res.status(400).json({

                    success:
                        false,

                    message:
                        "Password must contain at least 6 characters."
                });
            }

            if (
                newPassword !==
                confirmPassword
            ) {

                return res.status(400).json({

                    success:
                        false,

                    message:
                        "Passwords do not match."
                });
            }

            const cleanEmail =
                String(email)
                    .trim()
                    .toLowerCase();

            const result =
                await pool.query(
                    `
                    SELECT *
                    FROM users
                    WHERE LOWER(email) = LOWER($1)
                    LIMIT 1
                    `,
                    [
                        cleanEmail
                    ]
                );

            if (
                result.rows.length === 0
            ) {

                return res.status(404).json({

                    success:
                        false,

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

                    success:
                        false,

                    message:
                        "OTP verification expired. Please request a new OTP."
                });
            }

            const {
                passwordHash,
                passwordSalt
            } =
                hashPassword(
                    newPassword
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
                    passwordHash,
                    passwordSalt,
                    user.id
                ]
            );

            return res.json({

                success:
                    true,

                message:
                    "Password reset successfully."
            });

        } catch (error) {

            console.error(
                "Reset password error:",
                error
            );

            return res.status(500).json({

                success:
                    false,

                message:
                    "Unable to reset password."
            });
        }
    }
);

// ======================================================
// QUIZ QUESTIONS
// ======================================================

app.get(
    "/api/quiz/questions",
    (req, res) => {

        try {

            const {
                subject,
                difficulty,
                count
            } = req.query;

            let questions =
                loadQuestions();

            // ==========================================
            // SUBJECT
            // ==========================================

            if (
                subject &&
                String(subject).trim()
            ) {

                const requestedSubject =
                    String(subject)
                        .trim()
                        .toLowerCase();

                questions =
                    questions.filter(
                        question =>
                            String(
                                question.subject ||
                                ""
                            )
                                .trim()
                                .toLowerCase() ===
                            requestedSubject
                    );
            }

            // ==========================================
            // DIFFICULTY
            //
            // ALL = NO DIFFICULTY FILTER
            // ==========================================

            if (
                difficulty &&
                String(difficulty).trim() &&
                String(difficulty)
                    .trim()
                    .toLowerCase() !== "all"
            ) {

                const requestedDifficulty =
                    String(difficulty)
                        .trim()
                        .toLowerCase();

                questions =
                    questions.filter(
                        question =>
                            String(
                                question.difficulty ||
                                ""
                            )
                                .trim()
                                .toLowerCase() ===
                            requestedDifficulty
                    );
            }

            // ==========================================
            // SHUFFLE
            // ==========================================

            questions =
                [...questions].sort(
                    () =>
                        Math.random() -
                        0.5
                );

            // ==========================================
            // COUNT
            // ==========================================

            let requestedCount =
                parseInt(
                    count,
                    10
                );

            if (
                !Number.isInteger(
                    requestedCount
                ) ||
                requestedCount <= 0
            ) {

                requestedCount =
                    10;
            }

            questions =
                questions.slice(
                    0,
                    requestedCount
                );

            // ==========================================
            // HIDE ANSWERS
            // ==========================================

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

            if (
                safeQuestions.length === 0
            ) {

                return res.status(404).json({

                    success:
                        false,

                    message:
                        "No questions found.",

                    questions:
                        []
                });
            }

            return res.json({

                success:
                    true,

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

                success:
                    false,

                message:
                    "Unable to load quiz questions."
            });
        }
    }
);

// ======================================================
// QUIZ SUBMIT
// ======================================================

app.post(
    "/api/quiz/submit",
    async (req, res) => {

        try {

            const body =
                req.body || {};

            // ==========================================
            // SINGLE QUESTION ANSWER
            // ==========================================

            if (
                body.questionId !== undefined &&
                body.selectedAnswer !== undefined
            ) {

                const questionId =
                    String(
                        body.questionId
                    );

                const questions =
                    loadQuestions();

                const question =
                    questions.find(
                        item =>
                            item &&
                            String(
                                item.id
                            ) ===
                            questionId
                    );

                if (!question) {

                    return res.status(404).json({

                        success:
                            false,

                        message:
                            "Question not found."
                    });
                }

                const selectedAnswer =
                    normalizeAnswer(
                        body.selectedAnswer,
                        question
                    );

                const correctAnswer =
                    getCorrectAnswer(
                        question
                    );

                const isCorrect =
                    selectedAnswer !== "" &&
                    correctAnswer !== "" &&
                    selectedAnswer ===
                        correctAnswer;

                const solution =
                    getQuestionSolution(
                        question
                    );

                return res.json({

                    success:
                        true,

                    correct:
                        isCorrect,

                    questionId:
                        question.id,

                    selectedAnswer:
                        selectedAnswer,

                    selectedOption:
                        getOptionText(
                            question,
                            selectedAnswer
                        ),

                    correctAnswer:
                        correctAnswer,

                    correctOption:
                        getOptionText(
                            question,
                            correctAnswer
                        ),

                    solution:
                        solution,

                    explanation:
                        solution
                });
            }

            // ==========================================
            // COMPLETE QUIZ
            // ==========================================

            const {
                userId,
                subject,
                difficulty,
                questions:
                    submittedQuestions,
                answers,
                score,
                totalQuestions,
                correctAnswers
            } = body;

            const allQuestions =
                loadQuestions();

            let calculatedCorrectAnswers =
                0;

            const answerDetails =
                [];

            if (
                Array.isArray(
                    submittedQuestions
                )
            ) {

                submittedQuestions.forEach(
                    (
                        submittedQuestion,
                        index
                    ) => {

                        if (
                            !submittedQuestion
                        ) {
                            return;
                        }

                        const questionId =
                            String(
                                submittedQuestion.id
                            );

                        const serverQuestion =
                            allQuestions.find(
                                item =>
                                    item &&
                                    String(
                                        item.id
                                    ) ===
                                    questionId
                            );

                        if (!serverQuestion) {
                            return;
                        }

                        let userAnswer =
                            "";

                        if (
                            Array.isArray(
                                answers
                            )
                        ) {

                            if (
                                answers[index] &&
                                typeof answers[index] ===
                                    "object"
                            ) {

                                userAnswer =
                                    answers[index].selectedAnswer ||
                                    answers[index].answer ||
                                    "";

                            } else if (
                                typeof answers[index] ===
                                    "string"
                            ) {

                                userAnswer =
                                    answers[index];
                            }
                        }

                        const normalizedUserAnswer =
                            normalizeAnswer(
                                userAnswer,
                                serverQuestion
                            );

                        const correctAnswer =
                            getCorrectAnswer(
                                serverQuestion
                            );

                        const isCorrect =
                            normalizedUserAnswer !== "" &&
                            correctAnswer !== "" &&
                            normalizedUserAnswer ===
                                correctAnswer;

                        if (isCorrect) {
                            calculatedCorrectAnswers++;
                        }

                        answerDetails.push({

                            questionId:
                                serverQuestion.id,

                            selectedAnswer:
                                normalizedUserAnswer,

                            selectedOption:
                                getOptionText(
                                    serverQuestion,
                                    normalizedUserAnswer
                                ),

                            correctAnswer:
                                correctAnswer,

                            correctOption:
                                getOptionText(
                                    serverQuestion,
                                    correctAnswer
                                ),

                            correct:
                                isCorrect,

                            solution:
                                getQuestionSolution(
                                    serverQuestion
                                )
                        });
                    }
                );
            }

            const finalCorrectAnswers =
                answerDetails.length > 0
                    ? calculatedCorrectAnswers
                    : Number(
                        correctAnswers
                    ) || 0;

            const finalTotalQuestions =
                Number(
                    totalQuestions
                ) ||
                (
                    Array.isArray(
                        submittedQuestions
                    )
                        ? submittedQuestions.length
                        : 0
                );

            let finalScore =
                Number(
                    score
                );

            if (
                !Number.isFinite(
                    finalScore
                )
            ) {

                finalScore =
                    finalTotalQuestions > 0
                        ? (
                            finalCorrectAnswers /
                            finalTotalQuestions
                        ) * 100
                        : 0;
            }

            const resultId =
                crypto.randomUUID();

            await pool.query(
                `
                INSERT INTO quiz_results (
                    id,
                    user_id,
                    subject,
                    difficulty,
                    questions,
                    answers,
                    score,
                    total_questions,
                    correct_answers,
                    answer_details
                )
                VALUES (
                    $1,
                    $2,
                    $3,
                    $4,
                    $5::jsonb,
                    $6::jsonb,
                    $7,
                    $8,
                    $9,
                    $10::jsonb
                )
                `,
                [
                    resultId,
                    userId || null,
                    subject || "",
                    difficulty || "",
                    JSON.stringify(
                        submittedQuestions || []
                    ),
                    JSON.stringify(
                        answers || []
                    ),
                    Number(
                        finalScore.toFixed(2)
                    ),
                    finalTotalQuestions,
                    finalCorrectAnswers,
                    JSON.stringify(
                        answerDetails
                    )
                ]
            );

            return res.json({

                success:
                    true,

                message:
                    "Quiz result saved successfully.",

                result: {

                    id:
                        resultId,

                    userId:
                        userId || null,

                    subject:
                        subject || "",

                    difficulty:
                        difficulty || "",

                    score:
                        Number(
                            finalScore.toFixed(2)
                        ),

                    totalQuestions:
                        finalTotalQuestions,

                    correctAnswers:
                        finalCorrectAnswers,

                    answerDetails:
                        answerDetails
                }
            });

        } catch (error) {

            console.error(
                "Quiz submit error:",
                error
            );

            return res.status(500).json({

                success:
                    false,

                message:
                    "Unable to save quiz result."
            });
        }
    }
);

// ======================================================
// QUIZ HISTORY
// ======================================================

app.get(
    "/api/quiz/history",
    async (req, res) => {

        try {

            const {
                userId
            } = req.query;

            let query = `
                SELECT
                    id,
                    user_id,
                    subject,
                    difficulty,
                    questions,
                    answers,
                    score,
                    total_questions,
                    correct_answers,
                    answer_details,
                    created_at
                FROM quiz_results
            `;

            const values = [];

            if (userId) {

                query += `
                    WHERE user_id = $1
                `;

                values.push(
                    String(userId)
                );
            }

            query += `
                ORDER BY created_at DESC
            `;

            const result =
                await pool.query(
                    query,
                    values
                );

            const results =
                result.rows.map(
                    row => ({

                        id:
                            row.id,

                        userId:
                            row.user_id,

                        subject:
                            row.subject,

                        difficulty:
                            row.difficulty,

                        questions:
                            row.questions,

                        answers:
                            row.answers,

                        score:
                            Number(
                                row.score || 0
                            ),

                        totalQuestions:
                            row.total_questions,

                        correctAnswers:
                            row.correct_answers,

                        answerDetails:
                            row.answer_details,

                        createdAt:
                            row.created_at
                    })
                );

            return res.json({

                success:
                    true,

                results:
                    results
            });

        } catch (error) {

            console.error(
                "Quiz history error:",
                error
            );

            return res.status(500).json({

                success:
                    false,

                message:
                    "Unable to load quiz history."
            });
        }
    }
);

// ======================================================
// AI TUTOR
// ======================================================

app.post(
    "/api/ask",
    async (req, res) => {

        try {

            const {
                question,
                prompt,
                message,
                subject
            } = req.body || {};

            const userQuestion =
                question ||
                prompt ||
                message;

            if (
                !userQuestion ||
                !String(
                    userQuestion
                ).trim()
            ) {

                return res.status(400).json({

                    success:
                        false,

                    message:
                        "Question is required."
                });
            }

            if (!gemini) {

                return res.status(500).json({

                    success:
                        false,

                    message:
                        "Gemini AI service is not configured."
                });
            }

            const aiPrompt = `
You are Study Buddy AI, a helpful educational tutor.

Subject:
${subject || "General"}

Student question:
${String(
    userQuestion
).trim()}

Instructions:
- Explain clearly and simply.
- Use student-friendly language.
- Give step-by-step explanations when useful.
- Do not invent facts.
- For mathematics and science, show calculations when appropriate.
- Keep the response focused on learning.
`;

            const response =
                await gemini.models.generateContent({

                    model:
                        GEMINI_MODEL,

                    contents:
                        aiPrompt
                });

            return res.json({

                success:
                    true,

                answer:
                    response.text || ""
            });

        } catch (error) {

            console.error(
                "AI Tutor error:",
                error
            );

            return res.status(500).json({

                success:
                    false,

                message:
                    "Unable to get AI response. Please try again."
            });
        }
    }
);

// ======================================================
// 404
// ======================================================

app.use(
    (req, res) => {

        res.status(404).json({

            success:
                false,

            message:
                "API endpoint not found."
        });
    }
);

// ======================================================
// GLOBAL ERROR
// ======================================================

app.use(
    (
        error,
        req,
        res,
        next
    ) => {

        console.error(
            "Global server error:",
            error
        );

        res.status(500).json({

            success:
                false,

            message:
                "Internal server error."
        });
    }
);

// ======================================================
// START SERVER
// ======================================================

async function startServer() {

    try {

        await initializeDatabase();

        await pool.query(
            "SELECT NOW()"
        );

        console.log(
            "PostgreSQL connection successful."
        );

        app.listen(
            PORT,
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
                        resendConfigured
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
            "Unable to start server:",
            error
        );

        process.exit(1);
    }
}

startServer();