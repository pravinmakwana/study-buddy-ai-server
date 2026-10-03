import express from "express";
import cors from "cors";
import fs from "fs";
import path from "path";
import crypto from "crypto";
import { fileURLToPath } from "url";
import { GoogleGenAI } from "@google/genai";


// ============================================================
// APP CONFIGURATION
// ============================================================

const app = express();

const PORT = process.env.PORT || 10000;


// ============================================================
// PATH CONFIGURATION
// ============================================================

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const dataDirectory =
    path.join(__dirname, "data");

const questionsFile =
    path.join(dataDirectory, "questions.json");

const usersFile =
    path.join(dataDirectory, "users.json");

const quizResultsFile =
    path.join(dataDirectory, "quiz-results.json");


// ============================================================
// CREATE DATA DIRECTORY / FILES
// ============================================================

if (!fs.existsSync(dataDirectory)) {
    fs.mkdirSync(dataDirectory, {
        recursive: true
    });
}


if (!fs.existsSync(usersFile)) {
    fs.writeFileSync(
        usersFile,
        "[]",
        "utf8"
    );
}


if (!fs.existsSync(quizResultsFile)) {
    fs.writeFileSync(
        quizResultsFile,
        "[]",
        "utf8"
    );
}


// ============================================================
// MIDDLEWARE
// ============================================================

app.use(
    cors({
        origin: "*"
    })
);

app.use(
    express.json({
        limit: "2mb"
    })
);


// ============================================================
// GEMINI CONFIGURATION
// ============================================================

const GEMINI_API_KEY =
    process.env.GEMINI_API_KEY;

const GEMINI_MODEL =
    process.env.GEMINI_MODEL ||
    "gemini-3.5-flash-lite";

let gemini = null;

if (GEMINI_API_KEY) {

    gemini =
        new GoogleGenAI({
            apiKey: GEMINI_API_KEY
        });

    console.log(
        "Gemini AI service configured."
    );

} else {

    console.log(
        "Gemini AI service is not configured."
    );
}


// ============================================================
// RESEND CONFIGURATION
// ============================================================

const RESEND_API_KEY =
    process.env.RESEND_API_KEY;

const RESEND_FROM_EMAIL =
    process.env.RESEND_FROM_EMAIL ||
    "onboarding@resend.dev";

const resendConfigured =
    Boolean(RESEND_API_KEY);


if (resendConfigured) {

    console.log(
        "Resend email service configured."
    );

} else {

    console.log(
        "Resend email service is not configured."
    );
}


// ============================================================
// OTP CONFIGURATION
// ============================================================

const OTP_EXPIRY_MS =
    10 * 60 * 1000;

const RESET_VERIFIED_EXPIRY_MS =
    10 * 60 * 1000;


// ============================================================
// PASSWORD HASH CONFIGURATION
// ============================================================

const PASSWORD_KEY_LENGTH =
    64;

const PASSWORD_SALT_LENGTH =
    16;

const PASSWORD_HASH_OPTIONS = {
    N: 16384,
    r: 8,
    p: 1
};


// ============================================================
// GENERIC HELPERS
// ============================================================

function readJsonFile(
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
            );

        if (!content.trim()) {
            return fallback;
        }

        return JSON.parse(content);

    } catch (error) {

        console.error(
            "Unable to read JSON file:",
            filePath,
            error
        );

        return fallback;
    }
}


function writeJsonFile(
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


function normalizeEmail(email) {

    return String(email || "")
        .trim()
        .toLowerCase();
}


function isValidEmail(email) {

    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/
        .test(email);
}


function generateId() {

    return crypto
        .randomUUID();
}


function generateAuthToken() {

    return crypto
        .randomBytes(48)
        .toString("hex");
}


function generateOtp() {

    return String(
        crypto.randomInt(
            100000,
            1000000
        )
    );
}


function hashOtp(otp) {

    return crypto
        .createHash("sha256")
        .update(String(otp))
        .digest("hex");
}


function hashPassword(password) {

    const salt =
        crypto
            .randomBytes(
                PASSWORD_SALT_LENGTH
            )
            .toString("hex");

    const hash =
        crypto.scryptSync(
            password,
            salt,
            PASSWORD_KEY_LENGTH,
            PASSWORD_HASH_OPTIONS
        );

    return {
        salt,
        hash: hash.toString("hex")
    };
}


function verifyPassword(
    password,
    salt,
    storedHash
) {

    try {

        const hash =
            crypto.scryptSync(
                password,
                salt,
                PASSWORD_KEY_LENGTH,
                PASSWORD_HASH_OPTIONS
            );

        const stored =
            Buffer.from(
                storedHash,
                "hex"
            );

        return (
            stored.length === hash.length &&
            crypto.timingSafeEqual(
                stored,
                hash
            )
        );

    } catch (error) {

        return false;
    }
}


function getBearerToken(req) {

    const authorization =
        req.headers.authorization;

    if (!authorization) {
        return null;
    }

    if (
        !authorization
            .toLowerCase()
            .startsWith("bearer ")
    ) {
        return null;
    }

    return authorization
        .substring(7)
        .trim();
}


// ============================================================
// USER HELPERS
// ============================================================

function getUsers() {

    return readJsonFile(
        usersFile,
        []
    );
}


function saveUsers(users) {

    writeJsonFile(
        usersFile,
        users
    );
}


function findUserByEmail(email) {

    const normalizedEmail =
        normalizeEmail(email);

    const users =
        getUsers();

    return users.find(
        user =>
            normalizeEmail(
                user.email
            ) === normalizedEmail
    );
}


function findUserByToken(token) {

    if (!token) {
        return null;
    }

    const users =
        getUsers();

    return users.find(
        user =>
            user.authToken === token
    );
}


// ============================================================
// RESEND EMAIL
// ============================================================

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
<!DOCTYPE html>

<html>

<head>

    <meta charset="UTF-8">

    <meta
        name="viewport"
        content="width=device-width, initial-scale=1.0"
    >

    <title>
        Study Buddy AI Password Reset
    </title>

</head>

<body
    style="
        margin:0;
        padding:0;
        background:#f6f7fb;
        font-family:Arial,Helvetica,sans-serif;
    "
>

    <div
        style="
            max-width:600px;
            margin:30px auto;
            padding:20px;
        "
    >

        <div
            style="
                background:#ffffff;
                border-radius:16px;
                padding:30px;
                box-shadow:
                    0 2px 10px
                    rgba(0,0,0,0.08);
            "
        >

            <h2
                style="
                    margin-top:0;
                    color:#111827;
                "
            >
                Study Buddy AI
            </h2>


            <p
                style="
                    color:#374151;
                    font-size:16px;
                    line-height:1.6;
                "
            >
                We received a request to reset
                your password.
            </p>


            <p
                style="
                    color:#374151;
                    font-size:16px;
                "
            >
                Your password reset OTP is:
            </p>


            <div
                style="
                    margin:25px 0;
                    padding:20px;
                    background:#f3f4f6;
                    border-radius:12px;
                    text-align:center;
                "
            >

                <span
                    style="
                        font-size:34px;
                        font-weight:bold;
                        letter-spacing:8px;
                        color:#111827;
                    "
                >
                    ${otp}
                </span>

            </div>


            <p
                style="
                    color:#374151;
                    font-size:15px;
                    line-height:1.6;
                "
            >
                This OTP is valid for
                <strong>10 minutes</strong>.
            </p>


            <p
                style="
                    color:#6b7280;
                    font-size:14px;
                    line-height:1.6;
                "
            >
                If you did not request a password
                reset, you can safely ignore this email.
            </p>


            <hr
                style="
                    border:none;
                    border-top:1px solid #e5e7eb;
                    margin:25px 0;
                "
            >


            <p
                style="
                    color:#9ca3af;
                    font-size:13px;
                "
            >
                Study Buddy AI
            </p>

        </div>

    </div>

</body>

</html>
`
                })
            }
        );


    let result = null;

    try {

        result =
            await response.json();

    } catch (error) {

        result = {};
    }


    if (!response.ok) {

        console.error(
            "Resend email error:",
            result
        );

        throw new Error(
            result?.message ||
            result?.error ||
            "Unable to send password reset email."
        );
    }


    console.log(
        "Password reset email sent successfully:",
        result?.id || "unknown"
    );


    return result;
}


// ============================================================
// HOME / HEALTH CHECK
// ============================================================

app.get(
    "/",
    (req, res) => {

        res.json({

            message:
                "Study Buddy AI Backend is running!",

            ai:
                gemini
                    ? "Gemini configured"
                    : "Gemini not configured",

            auth:
                "Authentication API configured",

            passwordReset:
                resendConfigured
                    ? "Email OTP configured"
                    : "Email OTP not configured"
        });
    }
);


// ============================================================
// AUTH - SIGN UP
// ============================================================

app.post(
    "/api/auth/signup",
    (req, res) => {

        try {

            const {
                name,
                email,
                password,
                confirmPassword
            } = req.body;


            const cleanName =
                String(name || "").trim();

            const cleanEmail =
                normalizeEmail(email);


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


            if (!isValidEmail(cleanEmail)) {

                return res.status(400).json({
                    success: false,
                    message:
                        "Please enter a valid email."
                });
            }


            if (
                typeof password !== "string" ||
                password.length < 6
            ) {

                return res.status(400).json({
                    success: false,
                    message:
                        "Password must contain at least 6 characters."
                });
            }


            if (
                password !== confirmPassword
            ) {

                return res.status(400).json({
                    success: false,
                    message:
                        "Passwords do not match."
                });
            }


            const users =
                getUsers();


            const existingUser =
                users.find(
                    user =>
                        normalizeEmail(
                            user.email
                        ) === cleanEmail
                );


            if (existingUser) {

                return res.status(409).json({
                    success: false,
                    message:
                        "An account with this email already exists. Please sign in."
                });
            }


            const passwordData =
                hashPassword(password);


            const user = {

                id:
                    generateId(),

                name:
                    cleanName,

                email:
                    cleanEmail,

                passwordHash:
                    passwordData.hash,

                passwordSalt:
                    passwordData.salt,

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


            users.push(user);

            saveUsers(users);


            return res.status(201).json({

                success: true,

                message:
                    "Account created successfully.",

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
                "Signup error:",
                error
            );

            return res.status(500).json({

                success: false,

                message:
                    "Unable to create account. Please try again."
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

            const {
                email,
                password
            } = req.body;


            const cleanEmail =
                normalizeEmail(email);


            if (!cleanEmail) {

                return res.status(400).json({
                    success: false,
                    message:
                        "Please enter your email."
                });
            }


            if (!isValidEmail(cleanEmail)) {

                return res.status(400).json({
                    success: false,
                    message:
                        "Please enter a valid email."
                });
            }


            if (
                typeof password !== "string" ||
                !password
            ) {

                return res.status(400).json({
                    success: false,
                    message:
                        "Please enter your password."
                });
            }


            const users =
                getUsers();


            const user =
                users.find(
                    item =>
                        normalizeEmail(
                            item.email
                        ) === cleanEmail
                );


            if (!user) {

                return res.status(401).json({
                    success: false,
                    message:
                        "Incorrect email or password."
                });
            }


            const passwordCorrect =
                verifyPassword(
                    password,
                    user.passwordSalt,
                    user.passwordHash
                );


            if (!passwordCorrect) {

                return res.status(401).json({
                    success: false,
                    message:
                        "Incorrect email or password."
                });
            }


            const token =
                generateAuthToken();


            user.authToken =
                token;


            saveUsers(users);


            return res.json({

                success: true,

                message:
                    "Sign in successful.",

                token:

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

                success: false,

                message:
                    "Unable to sign in. Please try again."
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

            const token =
                getBearerToken(req);


            if (!token) {

                return res.status(401).json({
                    success: false,
                    message:
                        "Authentication token is required."
                });
            }


            const user =
                findUserByToken(token);


            if (!user) {

                return res.status(401).json({
                    success: false,
                    message:
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
                "Get current user error:",
                error
            );

            return res.status(500).json({

                success: false,

                message:
                    "Unable to get user information."
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
                getBearerToken(req);


            if (token) {

                const users =
                    getUsers();


                const user =
                    users.find(
                        item =>
                            item.authToken === token
                    );


                if (user) {

                    user.authToken =
                        null;

                    saveUsers(users);
                }
            }


            return res.json({

                success: true,

                message:
                    "Logout successful."
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
// AUTH - FORGOT PASSWORD
// ============================================================

app.post(
    "/api/auth/forgot-password",
    async (req, res) => {

        try {

            const email =
                normalizeEmail(
                    req.body?.email
                );


            if (!email) {

                return res.status(400).json({

                    success: false,

                    message:
                        "Please enter your email."
                });
            }


            if (!isValidEmail(email)) {

                return res.status(400).json({

                    success: false,

                    message:
                        "Please enter a valid email."
                });
            }


            if (!resendConfigured) {

                console.error(
                    "Forgot password requested but Resend is not configured."
                );

                return res.status(500).json({

                    success: false,

                    message:
                        "Password reset email service is not configured."
                });
            }


            const users =
                getUsers();


            const user =
                users.find(
                    item =>
                        normalizeEmail(
                            item.email
                        ) === email
                );


            /*
             * Keep response generic so the API does not
             * reveal whether an email is registered.
             */

            const genericMessage =
                "If an account exists with this email, a password reset OTP has been sent.";


            if (!user) {

                return res.json({

                    success: true,

                    message:
                        genericMessage
                });
            }


            const otp =
                generateOtp();


            const otpHash =
                hashOtp(otp);


            /*
             * IMPORTANT:
             *
             * Send the email first.
             * Save OTP only after Resend accepts it.
             */

            await sendPasswordResetOTP(
                email,
                otp
            );


            user.resetOtpHash =
                otpHash;


            user.resetOtpExpiresAt =
                Date.now() +
                OTP_EXPIRY_MS;


            user.resetOtpVerifiedUntil =
                null;


            saveUsers(users);


            return res.json({

                success: true,

                message:
                    genericMessage
            });


        } catch (error) {

            console.error(
                "Forgot password error:",
                error
            );

            return res.status(500).json({

                success: false,

                message:
                    "Unable to send password reset OTP. Please try again."
            });
        }
    }
);


// ============================================================
// AUTH - VERIFY RESET OTP
// ============================================================

app.post(
    "/api/auth/verify-reset-otp",
    (req, res) => {

        try {

            const email =
                normalizeEmail(
                    req.body?.email
                );

            const otp =
                String(
                    req.body?.otp || ""
                ).trim();


            if (!email) {

                return res.status(400).json({

                    success: false,

                    message:
                        "Email is required."
                });
            }


            if (!otp) {

                return res.status(400).json({

                    success: false,

                    message:
                        "OTP is required."
                });
            }


            const users =
                getUsers();


            const user =
                users.find(
                    item =>
                        normalizeEmail(
                            item.email
                        ) === email
                );


            if (!user) {

                return res.status(400).json({

                    success: false,

                    message:
                        "Invalid or expired OTP."
                });
            }


            if (
                !user.resetOtpHash ||
                !user.resetOtpExpiresAt
            ) {

                return res.status(400).json({

                    success: false,

                    message:
                        "Invalid or expired OTP."
                });
            }


            if (
                Date.now() >
                Number(
                    user.resetOtpExpiresAt
                )
            ) {

                user.resetOtpHash =
                    null;

                user.resetOtpExpiresAt =
                    null;

                user.resetOtpVerifiedUntil =
                    null;

                saveUsers(users);


                return res.status(400).json({

                    success: false,

                    message:
                        "OTP has expired. Please request a new OTP."
                });
            }


            const incomingHash =
                hashOtp(otp);


            if (
                incomingHash !==
                user.resetOtpHash
            ) {

                return res.status(400).json({

                    success: false,

                    message:
                        "Invalid OTP."
                });
            }


            user.resetOtpVerifiedUntil =
                Date.now() +
                RESET_VERIFIED_EXPIRY_MS;


            saveUsers(users);


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
                    "Unable to verify OTP. Please try again."
            });
        }
    }
);


// ============================================================
// AUTH - RESET PASSWORD
// ============================================================

app.post(
    "/api/auth/reset-password",
    (req, res) => {

        try {

            const {
                email,
                password,
                confirmPassword
            } = req.body;


            const cleanEmail =
                normalizeEmail(email);


            if (!cleanEmail) {

                return res.status(400).json({

                    success: false,

                    message:
                        "Email is required."
                });
            }


            if (
                typeof password !== "string" ||
                password.length < 6
            ) {

                return res.status(400).json({

                    success: false,

                    message:
                        "Password must contain at least 6 characters."
                });
            }


            if (
                password !== confirmPassword
            ) {

                return res.status(400).json({

                    success: false,

                    message:
                        "Passwords do not match."
                });
            }


            const users =
                getUsers();


            const user =
                users.find(
                    item =>
                        normalizeEmail(
                            item.email
                        ) === cleanEmail
                );


            if (!user) {

                return res.status(400).json({

                    success: false,

                    message:
                        "Unable to reset password."
                });
            }


            if (
                !user.resetOtpVerifiedUntil ||
                Date.now() >
                Number(
                    user.resetOtpVerifiedUntil
                )
            ) {

                return res.status(400).json({

                    success: false,

                    message:
                        "OTP verification has expired. Please request a new OTP."
                });
            }


            const passwordData =
                hashPassword(password);


            user.passwordHash =
                passwordData.hash;


            user.passwordSalt =
                passwordData.salt;


            /*
             * Invalidate existing sessions
             * after password reset.
             */

            user.authToken =
                null;


            user.resetOtpHash =
                null;


            user.resetOtpExpiresAt =
                null;


            user.resetOtpVerifiedUntil =
                null;


            saveUsers(users);


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
                    "Unable to reset password. Please try again."
            });
        }
    }
);


// ============================================================
// QUIZ HELPERS
// ============================================================

function getQuestions() {

    if (!fs.existsSync(questionsFile)) {

        return [];
    }


    return readJsonFile(
        questionsFile,
        []
    );
}


function normalizeQuestion(question) {

    return {

        id:
            question.id ??
            question.questionId ??
            generateId(),

        subject:
            question.subject ??
            "",

        difficulty:
            question.difficulty ??
            "Medium",

        question:
            question.question ??
            question.questionText ??
            question.text ??
            "",

        options:
            Array.isArray(
                question.options
            )
                ? question.options
                : [],

        answer:
            question.answer ??
            question.correctAnswer ??
            question.correctOption ??
            "",

        solution:
            question.solution ??
            question.explanation ??
            question.explanationText ??
            "",

        explanation:
            question.explanation ??
            question.solution ??
            ""
    };
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
                    req.query.subject || ""
                ).trim();


            const difficulty =
                String(
                    req.query.difficulty || ""
                ).trim();


            let count =
                Number(
                    req.query.count || 10
                );


            if (
                !Number.isFinite(count) ||
                count <= 0
            ) {
                count = 10;
            }


            count =
                Math.min(
                    Math.floor(count),
                    100
                );


            if (!subject) {

                return res.status(400).json({

                    success: false,

                    message:
                        "Subject is required."
                });
            }


            let questions =
                getQuestions()
                    .map(
                        normalizeQuestion
                    );


            questions =
                questions.filter(
                    question => {

                        const sameSubject =
                            String(
                                question.subject
                            )
                                .trim()
                                .toLowerCase() ===
                            subject
                                .toLowerCase();


                        const sameDifficulty =
                            !difficulty ||
                            String(
                                question.difficulty
                            )
                                .trim()
                                .toLowerCase() ===
                            difficulty
                                .toLowerCase();


                        return (
                            sameSubject &&
                            sameDifficulty
                        );
                    }
                );


            /*
             * Shuffle questions.
             */

            questions.sort(
                () =>
                    Math.random() - 0.5
            );


            questions =
                questions.slice(
                    0,
                    count
                );


            /*
             * Never send the correct answer
             * in the question-loading API.
             */

            const safeQuestions =
                questions.map(
                    question => ({

                        id:
                            question.id,

                        subject:
                            question.subject,

                        difficulty:
                            question.difficulty,

                        question:
                            question.question,

                        options:
                            question.options
                    })
                );


            return res.json({

                success: true,

                subject:
                    subject,

                difficulty:
                    difficulty || null,

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
// QUIZ - SUBMIT
// ============================================================

app.post(
    "/api/quiz/submit",
    (req, res) => {

        try {

            const body =
                req.body || {};


            const subject =
                String(
                    body.subject || ""
                ).trim();


            const difficulty =
                String(
                    body.difficulty || ""
                ).trim();


            const questions =
                Array.isArray(
                    body.questions
                )
                    ? body.questions
                    : [];


            const answers =
                Array.isArray(
                    body.answers
                )
                    ? body.answers
                    : [];


            /*
             * If Android already calculates
             * score, accept it.
             */

            let score =
                Number(
                    body.score
                );


            let totalQuestions =
                Number(
                    body.totalQuestions
                );


            let correctAnswers =
                Number(
                    body.correctAnswers
                );


            if (
                !Number.isFinite(
                    totalQuestions
                ) ||
                totalQuestions <= 0
            ) {

                totalQuestions =
                    questions.length;
            }


            if (
                !Number.isFinite(
                    score
                )
            ) {

                score = 0;
            }


            if (
                !Number.isFinite(
                    correctAnswers
                )
            ) {

                correctAnswers =
                    score;
            }


            if (
                totalQuestions > 0
            ) {

                score =
                    Math.max(
                        0,
                        Math.min(
                            score,
                            totalQuestions
                        )
                    );
            }


            const percentage =
                totalQuestions > 0
                    ? Number(
                        (
                            (
                                score /
                                totalQuestions
                            ) * 100
                        ).toFixed(2)
                    )
                    : 0;


            const result = {

                id:
                    generateId(),

                subject,

                difficulty,

                score,

                correctAnswers,

                totalQuestions,

                percentage,

                answers,

                createdAt:
                    new Date().toISOString()
            };


            const results =
                readJsonFile(
                    quizResultsFile,
                    []
                );


            results.push(result);


            /*
             * Keep the result file manageable.
             */

            const limitedResults =
                results.slice(-500);


            writeJsonFile(
                quizResultsFile,
                limitedResults
            );


            return res.json({

                success: true,

                message:
                    "Quiz submitted successfully.",

                result: {

                    id:
                        result.id,

                    subject:
                        result.subject,

                    difficulty:
                        result.difficulty,

                    score:
                        result.score,

                    correctAnswers:
                        result.correctAnswers,

                    totalQuestions:
                        result.totalQuestions,

                    percentage:
                        result.percentage,

                    createdAt:
                        result.createdAt
                }
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
// QUIZ - GET HISTORY
// ============================================================

app.get(
    "/api/quiz/history",
    (req, res) => {

        try {

            const results =
                readJsonFile(
                    quizResultsFile,
                    []
                );


            const sortedResults =
                results
                    .slice()
                    .sort(
                        (
                            a,
                            b
                        ) =>
                            new Date(
                                b.createdAt
                            ) -
                            new Date(
                                a.createdAt
                            )
                    );


            return res.json({

                success: true,

                results:
                    sortedResults
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


            const body =
                req.body || {};


            let userMessage =
                body.message ??
                body.question ??
                body.prompt ??
                "";


            userMessage =
                String(
                    userMessage
                ).trim();


            if (!userMessage) {

                return res.status(400).json({

                    success: false,

                    message:
                        "Please enter a question."
                });
            }


            /*
             * Prevent unnecessarily huge prompts.
             */

            if (
                userMessage.length >
                12000
            ) {

                userMessage =
                    userMessage.substring(
                        0,
                        12000
                    );
            }


            const systemInstruction = `

You are Study Buddy AI, a helpful educational
assistant for students.

Your goals are:

1. Explain concepts clearly.
2. Use simple language when possible.
3. Give step-by-step explanations for difficult topics.
4. Help students understand rather than simply giving
   unexplained answers.
5. For mathematics and science, show important formulas
   and calculation steps.
6. For exam preparation, provide concise and useful
   explanations.
7. If the student asks for a definition, give the
   definition first and then a short explanation.
8. If the student asks a multiple-choice question,
   identify the correct option and explain why.
9. Do not claim information that you are uncertain about.
10. Be friendly and encouraging.

The user may ask questions from:
Biology, Physics, Chemistry, Mathematics, English,
General Knowledge and other school/competitive-exam topics.

Answer in the language requested by the student.
`;


            const prompt =
                systemInstruction +
                "\n\nStudent question:\n" +
                userMessage;


            const response =
                await gemini.models.generateContent({

                    model:
                        GEMINI_MODEL,

                    contents:
                        prompt,

                    config: {

                        temperature:
                            0.7,

                        maxOutputTokens:
                            2048
                    }
                });


            const answer =
                response?.text ||
                "";


            if (!answer.trim()) {

                return res.status(500).json({

                    success: false,

                    message:
                        "AI did not return a response."
                });
            }


            return res.json({

                success: true,

                answer:
                    answer.trim(),

                response:
                    answer.trim()
            });


        } catch (error) {

            console.error(
                "AI Tutor error:",
                error
            );


            const errorMessage =
                String(
                    error?.message ||
                    ""
                );


            if (
                errorMessage
                    .toLowerCase()
                    .includes("quota")
            ) {

                return res.status(429).json({

                    success: false,

                    message:
                        "AI usage limit has been reached. Please try again later."
                });
            }


            return res.status(500).json({

                success: false,

                message:
                    "Unable to get an AI response. Please try again."
            });
        }
    }
);


// ============================================================
// 404 HANDLER
// ============================================================

app.use(
    (req, res) => {

        res.status(404).json({

            success: false,

            message:
                "API endpoint not found.",

            path:
                req.path
        });
    }
);


// ============================================================
// GLOBAL ERROR HANDLER
// ============================================================

app.use(
    (
        error,
        req,
        res,
        next
    ) => {

        console.error(
            "Unhandled server error:",
            error
        );


        if (res.headersSent) {
            return next(error);
        }


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

app.listen(
    PORT,
    () => {

        console.log(
            "=========================================="
        );

        console.log(
            "Study Buddy AI server running on port",
            PORT
        );

        console.log(
            "Users file:",
            usersFile
        );

        console.log(
            "Questions file:",
            questionsFile
        );

        console.log(
            "Quiz results file:",
            quizResultsFile
        );

        console.log(
            "Gemini model:",
            GEMINI_MODEL
        );

        console.log(
            "Gemini:",
            gemini
                ? "configured"
                : "not configured"
        );

        console.log(
            "Resend:",
            resendConfigured
                ? "configured"
                : "not configured"
        );

        console.log(
            "Password reset email:",
            resendConfigured
                ? "configured"
                : "not configured"
        );

        console.log(
            "=========================================="
        );
    }
);