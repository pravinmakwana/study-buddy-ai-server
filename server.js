import express from "express";
import cors from "cors";
import fs from "fs";
import path from "path";
import crypto from "crypto";
import nodemailer from "nodemailer";
import { fileURLToPath } from "url";
import { GoogleGenAI } from "@google/genai";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();

app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 10000;

// =====================================================
// FILES
// =====================================================

const dataDirectory = path.join(__dirname, "data");

const questionsFile =
    path.join(dataDirectory, "questions.json");

const usersFile =
    path.join(dataDirectory, "users.json");

if (!fs.existsSync(dataDirectory)) {
    fs.mkdirSync(dataDirectory, {
        recursive: true
    });
}

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
}

// =====================================================
// GEMINI
// =====================================================

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

}

// =====================================================
// EMAIL / SMTP
// =====================================================

const SMTP_EMAIL =
    process.env.SMTP_EMAIL;

const SMTP_APP_PASSWORD =
    process.env.SMTP_APP_PASSWORD;

let mailTransporter = null;

if (
    SMTP_EMAIL &&
    SMTP_APP_PASSWORD
) {

    mailTransporter =
        nodemailer.createTransport({
            service: "gmail",
            auth: {
                user: SMTP_EMAIL,
                pass: SMTP_APP_PASSWORD
            }
        });

    console.log(
        "SMTP email service configured."
    );

} else {

    console.log(
        "SMTP email service is not configured."
    );

}

// =====================================================
// CONSTANTS
// =====================================================

const OTP_EXPIRY_MS =
    10 * 60 * 1000;

const RESET_VERIFIED_EXPIRY_MS =
    10 * 60 * 1000;

// =====================================================
// USER HELPERS
// =====================================================

function loadUsers() {

    try {

        const data =
            fs.readFileSync(
                usersFile,
                "utf8"
            );

        const parsed =
            JSON.parse(data);

        if (
            !parsed.users ||
            !Array.isArray(parsed.users)
        ) {

            return [];

        }

        return parsed.users;

    } catch (error) {

        console.error(
            "Unable to load users:",
            error
        );

        return [];
    }
}

function saveUsers(users) {

    fs.writeFileSync(
        usersFile,
        JSON.stringify(
            {
                users
            },
            null,
            2
        )
    );
}

function normalizeEmail(email) {

    return String(email || "")
        .trim()
        .toLowerCase();
}

// =====================================================
// PASSWORD HASHING
// =====================================================

function hashPassword(password) {

    return new Promise(
        (resolve, reject) => {

            const salt =
                crypto
                    .randomBytes(16)
                    .toString("hex");

            crypto.scrypt(
                password,
                salt,
                64,
                (
                    error,
                    derivedKey
                ) => {

                    if (error) {

                        reject(error);

                        return;
                    }

                    resolve({
                        hash:
                            derivedKey.toString(
                                "hex"
                            ),

                        salt
                    });
                }
            );
        }
    );
}

function verifyPassword(
    password,
    storedHash,
    storedSalt
) {

    return new Promise(
        (resolve, reject) => {

            crypto.scrypt(
                password,
                storedSalt,
                64,
                (
                    error,
                    derivedKey
                ) => {

                    if (error) {

                        reject(error);

                        return;
                    }

                    const derivedHash =
                        derivedKey.toString(
                            "hex"
                        );

                    resolve(
                        crypto.timingSafeEqual(
                            Buffer.from(
                                derivedHash,
                                "hex"
                            ),
                            Buffer.from(
                                storedHash,
                                "hex"
                            )
                        )
                    );
                }
            );
        }
    );
}

// =====================================================
// TOKEN
// =====================================================

function createAuthToken() {

    return crypto
        .randomBytes(32)
        .toString("hex");
}

function getTokenFromRequest(req) {

    const authorization =
        req.headers.authorization;

    if (!authorization) {

        return null;
    }

    if (
        !authorization
            .startsWith("Bearer ")
    ) {

        return null;
    }

    return authorization
        .substring(7)
        .trim();
}

function getUserFromRequest(req) {

    const token =
        getTokenFromRequest(req);

    if (!token) {

        return null;
    }

    const users =
        loadUsers();

    return (
        users.find(
            user =>
                user.authToken === token
        ) || null
    );
}

// =====================================================
// OTP HELPERS
// =====================================================

function generateOTP() {

    return Math.floor(
        100000 +
        Math.random() * 900000
    ).toString();
}

function hashOTP(otp) {

    return crypto
        .createHash("sha256")
        .update(otp)
        .digest("hex");
}

// =====================================================
// EMAIL OTP
// =====================================================

async function sendPasswordResetOTP(
    email,
    otp
) {

    if (!mailTransporter) {

        throw new Error(
            "Email service is not configured."
        );
    }

    await mailTransporter.sendMail({

        from:
            `"Study Buddy AI" <${SMTP_EMAIL}>`,

        to: email,

        subject:
            "Study Buddy AI - Password Reset OTP",

        text:
            `Your Study Buddy AI password reset OTP is ${otp}.\n\n` +
            `This OTP is valid for 10 minutes.\n\n` +
            `If you did not request a password reset, please ignore this email.`,

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
                    We received a request to reset
                    your password.
                </p>

                <p>
                    Your password reset OTP is:
                </p>

                <div style="
                    font-size: 32px;
                    font-weight: bold;
                    letter-spacing: 8px;
                    padding: 20px;
                    text-align: center;
                    background: #F6F7FB;
                ">
                    ${otp}
                </div>

                <p>
                    This OTP is valid for
                    <strong>10 minutes</strong>.
                </p>

                <p>
                    If you did not request a password
                    reset, you can safely ignore this email.
                </p>

                <p>
                    Regards,<br>
                    Study Buddy AI
                </p>

            </div>
        `
    });
}

// =====================================================
// HOME
// =====================================================

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
                mailTransporter
                    ? "Email OTP configured"
                    : "Email OTP not configured"
        });
    }
);

// =====================================================
// SIGN UP
// =====================================================

app.post(
    "/api/auth/signup",
    async (req, res) => {

        try {

            const name =
                String(
                    req.body.name || ""
                ).trim();

            const email =
                normalizeEmail(
                    req.body.email
                );

            const password =
                String(
                    req.body.password || ""
                );

            const confirmPassword =
                String(
                    req.body.confirmPassword || ""
                );

            if (!name) {

                return res.status(400).json({
                    success: false,
                    message:
                        "Please enter your name."
                });
            }

            if (!email) {

                return res.status(400).json({
                    success: false,
                    message:
                        "Please enter your email."
                });
            }

            const emailRegex =
                /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

            if (!emailRegex.test(email)) {

                return res.status(400).json({
                    success: false,
                    message:
                        "Enter a valid email."
                });
            }

            if (password.length < 6) {

                return res.status(400).json({
                    success: false,
                    message:
                        "Password must contain at least 6 characters."
                });
            }

            if (
                password !==
                confirmPassword
            ) {

                return res.status(400).json({
                    success: false,
                    message:
                        "Passwords do not match."
                });
            }

            const users =
                loadUsers();

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
                    message:
                        "Account already exists. Please Sign In."
                });
            }

            const passwordData =
                await hashPassword(
                    password
                );

            const newUser = {

                id:
                    crypto
                        .randomUUID(),

                name,

                email,

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

            users.push(
                newUser
            );

            saveUsers(users);

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

                message:
                    "Unable to create account."
            });
        }
    }
);

// =====================================================
// SIGN IN
// =====================================================

app.post(
    "/api/auth/signin",
    async (req, res) => {

        try {

            const email =
                normalizeEmail(
                    req.body.email
                );

            const password =
                String(
                    req.body.password || ""
                );

            if (!email || !password) {

                return res.status(400).json({

                    success: false,

                    message:
                        "Email and password are required."
                });
            }

            const users =
                loadUsers();

            const user =
                users.find(
                    item =>
                        normalizeEmail(
                            item.email
                        ) === email
                );

            if (!user) {

                return res.status(401).json({

                    success: false,

                    message:
                        "Incorrect email or password"
                });
            }

            const passwordCorrect =
                await verifyPassword(
                    password,
                    user.passwordHash,
                    user.passwordSalt
                );

            if (!passwordCorrect) {

                return res.status(401).json({

                    success: false,

                    message:
                        "Incorrect email or password"
                });
            }

            const token =
                createAuthToken();

            user.authToken =
                token;

            saveUsers(users);

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

// =====================================================
// GET CURRENT USER
// =====================================================

app.get(
    "/api/auth/me",
    (req, res) => {

        const user =
            getUserFromRequest(req);

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

                id: user.id,

                name: user.name,

                email: user.email
            }
        });
    }
);

// =====================================================
// LOGOUT
// =====================================================

app.post(
    "/api/auth/logout",
    (req, res) => {

        const user =
            getUserFromRequest(req);

        if (user) {

            const users =
                loadUsers();

            const storedUser =
                users.find(
                    item =>
                        item.id === user.id
                );

            if (storedUser) {

                storedUser.authToken =
                    null;

                saveUsers(users);
            }
        }

        return res.json({

            success: true,

            message:
                "Logout successful."
        });
    }
);

// =====================================================
// FORGOT PASSWORD - SEND OTP
// =====================================================

app.post(
    "/api/auth/forgot-password",
    async (req, res) => {

        try {

            const email =
                normalizeEmail(
                    req.body.email
                );

            if (!email) {

                return res.status(400).json({

                    success: false,

                    message:
                        "Please enter your email."
                });
            }

            const emailRegex =
                /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

            if (!emailRegex.test(email)) {

                return res.status(400).json({

                    success: false,

                    message:
                        "Enter a valid email."
                });
            }

            /*
             * Always return the same response
             * whether the email exists or not.
             */
            const genericMessage =
                "If an account exists with this email, a password reset OTP has been sent.";

            if (!mailTransporter) {

                console.error(
                    "SMTP is not configured."
                );

                return res.status(500).json({

                    success: false,

                    message:
                        "Password reset email service is not configured."
                });
            }

            const users =
                loadUsers();

            const user =
                users.find(
                    item =>
                        normalizeEmail(
                            item.email
                        ) === email
                );

            if (!user) {

                return res.json({

                    success: true,

                    message:
                        genericMessage
                });
            }

            const otp =
                generateOTP();

            const otpHash =
                hashOTP(otp);

            user.resetOtpHash =
                otpHash;

            user.resetOtpExpiresAt =
                Date.now() +
                OTP_EXPIRY_MS;

            user.resetOtpVerifiedUntil =
                null;

            saveUsers(users);

            await sendPasswordResetOTP(
                email,
                otp
            );

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

// =====================================================
// VERIFY RESET OTP
// =====================================================

app.post(
    "/api/auth/verify-reset-otp",
    (req, res) => {

        try {

            const email =
                normalizeEmail(
                    req.body.email
                );

            const otp =
                String(
                    req.body.otp || ""
                ).trim();

            if (!email || !otp) {

                return res.status(400).json({

                    success: false,

                    message:
                        "Email and OTP are required."
                });
            }

            const users =
                loadUsers();

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

            const enteredOtpHash =
                hashOTP(otp);

            if (
                enteredOtpHash !==
                user.resetOtpHash
            ) {

                return res.status(400).json({

                    success: false,

                    message:
                        "Invalid OTP. Please enter the correct OTP."
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
                "OTP verification error:",
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

// =====================================================
// RESET PASSWORD
// =====================================================

app.post(
    "/api/auth/reset-password",
    async (req, res) => {

        try {

            const email =
                normalizeEmail(
                    req.body.email
                );

            const newPassword =
                String(
                    req.body.newPassword || ""
                );

            const confirmPassword =
                String(
                    req.body.confirmPassword || ""
                );

            if (!email) {

                return res.status(400).json({

                    success: false,

                    message:
                        "Email is required."
                });
            }

            if (
                newPassword.length < 6
            ) {

                return res.status(400).json({

                    success: false,

                    message:
                        "Password must contain at least 6 characters."
                });
            }

            if (
                newPassword !==
                confirmPassword
            ) {

                return res.status(400).json({

                    success: false,

                    message:
                        "Passwords do not match."
                });
            }

            const users =
                loadUsers();

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
                await hashPassword(
                    newPassword
                );

            user.passwordHash =
                passwordData.hash;

            user.passwordSalt =
                passwordData.salt;

            // Invalidate old login session
            user.authToken =
                null;

            // Clear OTP
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
                    "Unable to reset password."
            });
        }
    }
);

// =====================================================
// QUIZ QUESTIONS
// =====================================================

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

            const count =
                parseInt(
                    req.query.count || "10",
                    10
                );

            const data =
                fs.readFileSync(
                    questionsFile,
                    "utf8"
                );

            let questions =
                JSON.parse(data);

            if (!Array.isArray(questions)) {

                questions =
                    questions.questions || [];
            }

            if (subject) {

                questions =
                    questions.filter(
                        q =>
                            String(
                                q.subject || ""
                            ).toLowerCase()
                            ===
                            subject.toLowerCase()
                    );
            }

            if (
                difficulty &&
                difficulty.toLowerCase() !==
                "all"
            ) {

                questions =
                    questions.filter(
                        q =>
                            String(
                                q.difficulty || ""
                            ).toLowerCase()
                            ===
                            difficulty.toLowerCase()
                    );
            }

            questions =
                questions
                    .sort(
                        () =>
                            Math.random() - 0.5
                    )
                    .slice(
                        0,
                        Math.max(1, count)
                    );

            const safeQuestions =
                questions.map(
                    q => {

                        const {
                            correctAnswer,
                            solution,
                            explanation,
                            ...safeQuestion
                        } = q;

                        return safeQuestion;
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

// =====================================================
// QUIZ SUBMIT
// =====================================================

app.post(
    "/api/quiz/submit",
    (req, res) => {

        try {

            const questionId =
                req.body.questionId ??
                req.body.id;

            const selectedAnswer =
                req.body.selectedAnswer ??
                req.body.answer ??
                req.body.selectedOption;

            const data =
                fs.readFileSync(
                    questionsFile,
                    "utf8"
                );

            let questions =
                JSON.parse(data);

            if (!Array.isArray(questions)) {

                questions =
                    questions.questions || [];
            }

            const question =
                questions.find(
                    q =>
                        String(q.id) ===
                        String(questionId)
                );

            if (!question) {

                return res.status(404).json({

                    success: false,

                    message:
                        "Question not found."
                });
            }

            let normalizedAnswer =
                String(
                    selectedAnswer || ""
                )
                    .trim()
                    .toUpperCase();

            const optionMap = {

                A:
                    question.optionA,

                B:
                    question.optionB,

                C:
                    question.optionC,

                D:
                    question.optionD
            };

            for (
                const letter of
                Object.keys(optionMap)
            ) {

                if (
                    String(
                        optionMap[letter] || ""
                    )
                        .trim()
                        .toUpperCase()
                    ===
                    normalizedAnswer
                ) {

                    normalizedAnswer =
                        letter;

                    break;
                }
            }

            const correctAnswer =
                String(
                    question.correctAnswer || ""
                )
                    .trim()
                    .toUpperCase();

            const correct =
                normalizedAnswer ===
                correctAnswer;

            return res.json({

                success: true,

                correct,

                correctAnswer,

                solution:
                    question.solution ||
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

                message:
                    "Unable to submit answer."
            });
        }
    }
);

// =====================================================
// AI TUTOR
// =====================================================

app.post(
    "/api/ask",
    async (req, res) => {

        try {

            const question =
                String(
                    req.body.question || ""
                ).trim();

            const subject =
                String(
                    req.body.subject ||
                    "General"
                ).trim();

            if (!question) {

                return res.status(400).json({

                    success: false,

                    message:
                        "Please enter a question."
                });
            }

            if (!gemini) {

                return res.status(500).json({

                    success: false,

                    message:
                        "AI service is not configured."
                });
            }

            const prompt = `
You are Study Buddy AI, an educational AI tutor.

Subject:
${subject}

Student question:
${question}

Give a clear, accurate, student-friendly answer.

Use simple explanations where possible.

For calculations:
- Show Formula
- Show Steps
- Show Answer

For science:
- Explain important concepts clearly.
- Use correct chemical formulas and mathematical notation.

Do not mention that you are an AI unless necessary.
            `.trim();

            const response =
                await gemini.models.generateContent({

                    model:
                        GEMINI_MODEL,

                    contents:
                        prompt
                });

            const answer =
                response.text ||
                "";

            if (!answer) {

                return res.status(500).json({

                    success: false,

                    message:
                        "AI returned an empty response."
                });
            }

            return res.json({

                success: true,

                answer
            });

        } catch (error) {

            console.error(
                "AI error:",
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

// =====================================================
// START SERVER
// =====================================================

app.listen(
    PORT,
    () => {

        console.log(
            `Study Buddy AI server running on port ${PORT}`
        );

        console.log(
            `Users file: ${usersFile}`
        );

        console.log(
            `Gemini model: ${GEMINI_MODEL}`
        );

        console.log(
            `Password reset email: ${
                mailTransporter
                    ? "configured"
                    : "not configured"
            }`
        );
    }
);