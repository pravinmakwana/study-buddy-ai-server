import express from "express";
import cors from "cors";
import fs from "fs";
import path from "path";
import crypto from "crypto";
import { fileURLToPath } from "url";
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

const PORT = process.env.PORT || 10000;

// ======================================================
// DATA FILES
// ======================================================

const DATA_DIR = path.join(
    __dirname,
    "data"
);

const USERS_FILE = path.join(
    DATA_DIR,
    "users.json"
);

const QUESTIONS_FILE = path.join(
    DATA_DIR,
    "questions.json"
);

const QUIZ_RESULTS_FILE = path.join(
    DATA_DIR,
    "quiz-results.json"
);

// ======================================================
// CREATE DATA DIRECTORY / FILES
// ======================================================

if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, {
        recursive: true
    });
}

function ensureFile(
    filePath,
    defaultValue
) {
    if (!fs.existsSync(filePath)) {
        fs.writeFileSync(
            filePath,
            JSON.stringify(
                defaultValue,
                null,
                2
            ),
            "utf8"
        );
    }
}

ensureFile(
    USERS_FILE,
    []
);

ensureFile(
    QUESTIONS_FILE,
    []
);

ensureFile(
    QUIZ_RESULTS_FILE,
    []
);

// ======================================================
// JSON HELPERS
// ======================================================

function readJson(
    filePath,
    fallback
) {
    try {

        if (!fs.existsSync(filePath)) {
            return fallback;
        }

        const content =
            fs.readFileSync(
                filePath,
                "utf8"
            ).trim();

        if (!content) {
            return fallback;
        }

        return JSON.parse(
            content
        );

    } catch (error) {

        console.error(
            `Unable to read JSON file: ${filePath}`,
            error
        );

        return fallback;
    }
}

function writeJson(
    filePath,
    data
) {
    fs.writeFileSync(
        filePath,
        JSON.stringify(
            data,
            null,
            2
        ),
        "utf8"
    );
}

// ======================================================
// USERS
// ======================================================

function loadUsers() {

    const data =
        readJson(
            USERS_FILE,
            []
        );

    if (Array.isArray(data)) {
        return data;
    }

    if (
        data &&
        Array.isArray(data.users)
    ) {
        return data.users;
    }

    return [];
}

function saveUsers(
    users
) {
    writeJson(
        USERS_FILE,
        users
    );
}

// ======================================================
// QUIZ RESULTS
// ======================================================

function loadQuizResults() {

    const data =
        readJson(
            QUIZ_RESULTS_FILE,
            []
        );

    if (Array.isArray(data)) {
        return data;
    }

    if (
        data &&
        Array.isArray(data.results)
    ) {
        return data.results;
    }

    return [];
}

function saveQuizResults(
    results
) {
    writeJson(
        QUIZ_RESULTS_FILE,
        results
    );
}

// ======================================================
// QUESTIONS
// ======================================================

function loadQuestions() {

    const data =
        readJson(
            QUESTIONS_FILE,
            []
        );

    if (Array.isArray(data)) {
        return data;
    }

    if (
        data &&
        Array.isArray(data.questions)
    ) {
        return data.questions;
    }

    return [];
}

// ======================================================
// GEMINI CONFIGURATION
// ======================================================

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

// ======================================================
// RESEND EMAIL CONFIGURATION
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

    } catch (error) {

        return false;
    }
}

// ======================================================
// AUTH TOKEN
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
// EMAIL - RESEND
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

    const responseText =
        await response.text();

    if (!response.ok) {

        console.error(
            "Resend API error:",
            response.status,
            responseText
        );

        throw new Error(
            `Resend API error: ${response.status}`
        );
    }

    let result = {};

    try {

        result =
            JSON.parse(
                responseText
            );

    } catch {

        result = {};
    }

    return result;
}

// ======================================================
// AUTHENTICATION HELPER
// ======================================================

function getTokenFromRequest(
    req
) {

    const header =
        req.headers.authorization;

    if (
        !header ||
        !header.startsWith("Bearer ")
    ) {
        return null;
    }

    return header
        .substring(7)
        .trim();
}

function getAuthenticatedUser(
    req
) {

    const token =
        getTokenFromRequest(
            req
        );

    if (!token) {
        return null;
    }

    const users =
        loadUsers();

    return (
        users.find(
            user =>
                user &&
                user.authToken ===
                token
        ) ||
        null
    );
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
        String(
            question?.optionA ||
            ""
        ).trim();

    const optionB =
        String(
            question?.optionB ||
            ""
        ).trim();

    const optionC =
        String(
            question?.optionC ||
            ""
        ).trim();

    const optionD =
        String(
            question?.optionD ||
            ""
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

            gemini:
                Boolean(
                    GEMINI_API_KEY
                ),

            passwordReset:
                resendConfigured
                    ? "Email OTP configured"
                    : "Email OTP not configured"
        });
    }
);

// ======================================================
// HEALTH
// ======================================================

app.get(
    "/health",
    (req, res) => {

        res.json({

            success:
                true,

            status:
                "healthy"
        });
    }
);

// ======================================================
// SIGN UP
// ======================================================

app.post(
    "/api/auth/signup",
    (req, res) => {

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

            const users =
                loadUsers();

            const existingUser =
                users.find(
                    user =>
                        user &&
                        String(
                            user.email || ""
                        )
                            .trim()
                            .toLowerCase() ===
                        cleanEmail
                );

            if (existingUser) {

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

            const newUser = {

                id:
                    crypto.randomUUID(),

                name:
                    cleanName,

                email:
                    cleanEmail,

                passwordHash:
                    passwordHash,

                passwordSalt:
                    passwordSalt,

                authToken:
                    null,

                resetOtpHash:
                    null,

                resetOtpExpiresAt:
                    null,

                resetOtpVerifiedUntil:
                    null,

                createdAt:
                    new Date().toISOString()
            };

            users.push(
                newUser
            );

            saveUsers(
                users
            );

            console.log(
                `New user registered: ${cleanEmail}`
            );

            return res.status(201).json({

                success:
                    true,

                message:
                    "Account created successfully.",

                user: {

                    id:
                        newUser.id,

                    name:
                        newUser.name,

                    email:
                        newUser.email
                }
            });

        } catch (error) {

            console.error(
                "Signup error:",
                error
            );

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
    (req, res) => {

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

            const users =
                loadUsers();

            const user =
                users.find(
                    item =>
                        item &&
                        String(
                            item.email || ""
                        )
                            .trim()
                            .toLowerCase() ===
                        cleanEmail
                );

            if (!user) {

                return res.status(401).json({

                    success:
                        false,

                    message:
                        "Incorrect email or password."
                });
            }

            const validPassword =
                verifyPassword(
                    password,
                    user.passwordHash,
                    user.passwordSalt
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

            user.authToken =
                token;

            saveUsers(
                users
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
    (req, res) => {

        try {

            const user =
                getAuthenticatedUser(
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
    (req, res) => {

        try {

            const token =
                getTokenFromRequest(
                    req
                );

            if (token) {

                const users =
                    loadUsers();

                const user =
                    users.find(
                        item =>
                            item &&
                            item.authToken ===
                            token
                    );

                if (user) {

                    user.authToken =
                        null;

                    saveUsers(
                        users
                    );
                }
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

            const users =
                loadUsers();

            const user =
                users.find(
                    item =>
                        item &&
                        String(
                            item.email || ""
                        )
                            .trim()
                            .toLowerCase() ===
                        cleanEmail
                );

            if (!user) {

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
                hashOtp(otp);

            const expiresAt =
                Date.now() +
                OTP_EXPIRY_MS;

            await sendPasswordResetOTP(
                cleanEmail,
                otp
            );

            user.resetOtpHash =
                otpHash;

            user.resetOtpExpiresAt =
                expiresAt;

            user.resetOtpVerifiedUntil =
                null;

            saveUsers(
                users
            );

            console.log(
                `Password reset OTP sent to ${cleanEmail}`
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
    (req, res) => {

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

            const users =
                loadUsers();

            const user =
                users.find(
                    item =>
                        item &&
                        String(
                            item.email || ""
                        )
                            .trim()
                            .toLowerCase() ===
                        cleanEmail
                );

            if (!user) {

                return res.status(404).json({

                    success:
                        false,

                    message:
                        "No account found."
                });
            }

            if (
                !user.resetOtpHash ||
                !user.resetOtpExpiresAt
            ) {

                return res.status(400).json({

                    success:
                        false,

                    message:
                        "OTP not found. Please request a new OTP."
                });
            }

            if (
                Date.now() >
                user.resetOtpExpiresAt
            ) {

                user.resetOtpHash =
                    null;

                user.resetOtpExpiresAt =
                    null;

                saveUsers(
                    users
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
                user.resetOtpHash
            ) {

                return res.status(400).json({

                    success:
                        false,

                    message:
                        "Invalid OTP."
                });
            }

            user.resetOtpVerifiedUntil =
                Date.now() +
                RESET_VERIFIED_EXPIRY_MS;

            saveUsers(
                users
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
    (req, res) => {

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

            const users =
                loadUsers();

            const user =
                users.find(
                    item =>
                        item &&
                        String(
                            item.email || ""
                        )
                            .trim()
                            .toLowerCase() ===
                        cleanEmail
                );

            if (!user) {

                return res.status(404).json({

                    success:
                        false,

                    message:
                        "No account found."
                });
            }

            if (
                !user.resetOtpVerifiedUntil ||
                Date.now() >
                user.resetOtpVerifiedUntil
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

            user.passwordHash =
                passwordHash;

            user.passwordSalt =
                passwordSalt;

            user.resetOtpHash =
                null;

            user.resetOtpExpiresAt =
                null;

            user.resetOtpVerifiedUntil =
                null;

            user.authToken =
                null;

            saveUsers(
                users
            );

            console.log(
                `Password reset successful for ${cleanEmail}`
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
// QUIZ - GET QUESTIONS
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

            // ==================================================
            // FILTER SUBJECT
            // ==================================================

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
                        question => {

                            const questionSubject =
                                String(
                                    question.subject ||
                                    ""
                                )
                                    .trim()
                                    .toLowerCase();

                            return (
                                questionSubject ===
                                requestedSubject
                            );
                        }
                    );
            }

            // ==================================================
            // FILTER DIFFICULTY
            //
            // IMPORTANT:
            // "All" means ALL difficulty levels.
            // Do NOT filter when difficulty = All.
            // ==================================================

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
                        question => {

                            const questionDifficulty =
                                String(
                                    question.difficulty ||
                                    ""
                                )
                                    .trim()
                                    .toLowerCase();

                            return (
                                questionDifficulty ===
                                requestedDifficulty
                            );
                        }
                    );
            }

            // ==================================================
            // SHUFFLE QUESTIONS
            // ==================================================

            questions =
                [...questions].sort(
                    () =>
                        Math.random() -
                        0.5
                );

            // ==================================================
            // QUESTION COUNT
            // ==================================================

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

            // ==================================================
            // REMOVE ANSWER DATA
            //
            // Correct answer and solution should not be
            // sent before the student answers.
            // ==================================================

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

            console.log(
                "Quiz questions request:",
                {
                    subject:
                        subject || "All",

                    difficulty:
                        difficulty || "All",

                    requestedCount:
                        requestedCount,

                    returnedCount:
                        safeQuestions.length
                }
            );

            // ==================================================
            // NO QUESTIONS FOUND
            // ==================================================

            if (
                safeQuestions.length === 0
            ) {

                return res.status(404).json({

                    success:
                        false,

                    message:
                        "No questions found.",

                    subject:
                        subject || "",

                    difficulty:
                        difficulty || "",

                    count:
                        0,

                    questions:
                        []
                });
            }

            // ==================================================
            // RESPONSE
            // ==================================================

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
// QUIZ - SUBMIT
//
// Supports:
// 1. Single question answer
// 2. Complete quiz submission
// ======================================================

app.post(
    "/api/quiz/submit",
    (req, res) => {

        try {

            const body =
                req.body || {};

            // ==================================================
            // SINGLE QUESTION ANSWER
            // ==================================================

            if (
                body.questionId !== undefined &&
                body.selectedAnswer !== undefined
            ) {

                const questionId =
                    String(
                        body.questionId
                    );

                const selectedAnswer =
                    String(
                        body.selectedAnswer
                    ).trim();

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

                const normalizedSelectedAnswer =
                    normalizeAnswer(
                        selectedAnswer,
                        question
                    );

                const correctAnswer =
                    getCorrectAnswer(
                        question
                    );

                const isCorrect =
                    normalizedSelectedAnswer !== "" &&
                    correctAnswer !== "" &&
                    normalizedSelectedAnswer ===
                        correctAnswer;

                const solution =
                    getQuestionSolution(
                        question
                    );

                const selectedOptionText =
                    getOptionText(
                        question,
                        normalizedSelectedAnswer
                    );

                const correctOptionText =
                    getOptionText(
                        question,
                        correctAnswer
                    );

                console.log(
                    "Quiz answer:",
                    {
                        questionId:
                            questionId,

                        selectedAnswer:
                            normalizedSelectedAnswer,

                        correctAnswer:
                            correctAnswer,

                        correct:
                            isCorrect
                    }
                );

                return res.json({

                    success:
                        true,

                    correct:
                        isCorrect,

                    questionId:
                        question.id,

                    selectedAnswer:
                        normalizedSelectedAnswer,

                    selectedOption:
                        selectedOptionText,

                    correctAnswer:
                        correctAnswer,

                    correctOption:
                        correctOptionText,

                    solution:
                        solution,

                    explanation:
                        solution
                });
            }

            // ==================================================
            // COMPLETE QUIZ SUBMISSION
            // ==================================================

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

            // ==================================================
            // CALCULATE ANSWERS
            // ==================================================

            if (
                Array.isArray(
                    submittedQuestions
                )
            ) {

                submittedQuestions.forEach(
                    submittedQuestion => {

                        if (!submittedQuestion) {
                            return;
                        }

                        const questionId =
                            submittedQuestion.id !== undefined
                                ? String(
                                    submittedQuestion.id
                                )
                                : null;

                        if (!questionId) {
                            return;
                        }

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

                            const answerItem =
                                answers.find(
                                    item => {

                                        if (
                                            item &&
                                            typeof item ===
                                                "object"
                                        ) {

                                            return (
                                                String(
                                                    item.questionId
                                                ) ===
                                                questionId
                                            );
                                        }

                                        return false;
                                    }
                                );

                            if (answerItem) {

                                userAnswer =
                                    answerItem.selectedAnswer ||
                                    answerItem.answer ||
                                    "";
                            }
                        }

                        if (
                            !userAnswer &&
                            Array.isArray(
                                answers
                            )
                        ) {

                            const index =
                                submittedQuestions.indexOf(
                                    submittedQuestion
                                );

                            if (
                                index >= 0 &&
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

            // ==================================================
            // FINAL CORRECT ANSWERS
            // ==================================================

            let finalCorrectAnswers =
                calculatedCorrectAnswers;

            if (
                answerDetails.length === 0 &&
                Number.isFinite(
                    Number(
                        correctAnswers
                    )
                )
            ) {

                finalCorrectAnswers =
                    Number(
                        correctAnswers
                    );
            }

            // ==================================================
            // TOTAL QUESTIONS
            // ==================================================

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

            // ==================================================
            // SCORE
            // ==================================================

            let finalScore =
                Number(
                    score
                );

            if (
                !Number.isFinite(
                    finalScore
                ) ||
                finalScore < 0
            ) {

                if (
                    finalTotalQuestions > 0
                ) {

                    finalScore =
                        (
                            finalCorrectAnswers /
                            finalTotalQuestions
                        ) *
                        100;

                } else {

                    finalScore =
                        0;
                }
            }

            // ==================================================
            // SAVE RESULT
            // ==================================================

            const results =
                loadQuizResults();

            const result = {

                id:
                    crypto.randomUUID(),

                userId:
                    userId || null,

                subject:
                    subject || "",

                difficulty:
                    difficulty || "",

                questions:
                    Array.isArray(
                        submittedQuestions
                    )
                        ? submittedQuestions
                        : [],

                answers:
                    Array.isArray(
                        answers
                    )
                        ? answers
                        : [],

                score:
                    Number(
                        finalScore.toFixed(2)
                    ),

                totalQuestions:
                    finalTotalQuestions,

                correctAnswers:
                    finalCorrectAnswers,

                answerDetails:
                    answerDetails,

                createdAt:
                    new Date()
                        .toISOString()
            };

            results.push(
                result
            );

            saveQuizResults(
                results
            );

            return res.json({

                success:
                    true,

                message:
                    "Quiz result saved successfully.",

                result
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
    (req, res) => {

        try {

            const {
                userId
            } = req.query;

            let results =
                loadQuizResults();

            if (userId) {

                results =
                    results.filter(
                        item =>
                            String(
                                item.userId
                            ) ===
                            String(
                                userId
                            )
                    );
            }

            results =
                [...results].reverse();

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
- If the question is ambiguous, explain the reasonable interpretation.
- Keep the response focused on learning.
`;

            const response =
                await gemini.models.generateContent({

                    model:
                        GEMINI_MODEL,

                    contents:
                        aiPrompt
                });

            const answer =
                response.text ||
                "";

            return res.json({

                success:
                    true,

                answer:
                    answer
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
// GLOBAL ERROR HANDLER
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
            `Users file: ${USERS_FILE}`
        );

        console.log(
            `Questions file: ${QUESTIONS_FILE}`
        );

        console.log(
            `Quiz results file: ${QUIZ_RESULTS_FILE}`
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
            `Password reset email: ${
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