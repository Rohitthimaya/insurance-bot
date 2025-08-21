import axios from "axios";
import express, { Request, Response } from "express";
import { MilvusClient, DataType } from '@zilliz/milvus2-sdk-node';
import pdfParse from "pdf-parse";
import { Document, Packer } from "docx";
import * as mammoth from "mammoth";
import dotenv from "dotenv";
import * as XLSX from "xlsx";
import Tesseract from "tesseract.js";
import {SYSTEM_PROMPT} from "./prompt";

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;


const address = `${process.env.address}`;
const token = `${process.env.token}`
// connect to milvus
const client = new MilvusClient({ address, token });

// Your verify token (same as the one you entered in Meta Portal)
const VERIFY_TOKEN = process.env.VERIFY_TOKEN;

// Middleware
app.use(express.json());



// Webhook verification endpoint
app.get("/webhook", (req: Request, res: Response) => {
    const mode = req.query["hub.mode"];
    const token = req.query["hub.verify_token"];
    const challenge = req.query["hub.challenge"];

    if (mode === "subscribe" && token === VERIFY_TOKEN) {
        console.log("Webhook verified!");
        res.status(200).send(challenge); // must return the challenge
    } else {
        res.sendStatus(403); // Forbidden
    }
});

async function sendMessage(to: string, data: object) {
    try {
        await axios.post(
            `https://graph.facebook.com/v17.0/761375180391719/messages`,
            {
                messaging_product: "whatsapp",
                to,
                ...data,
            },
            {
                headers: {
                    Authorization: `Bearer ${process.env.WHATSAPP_ACCESS_TOKEN}`,
                    "Content-Type": "application/json",
                },
            }
        );
    } catch (error: any) {
        console.error("Error sending message:", error.response?.data || error.message);
    }
}

function runCommand(command: string): string {
    const { execSync } = require("child_process");
    try {
        return execSync(command, { encoding: "utf8" });
    } catch (err) {
        return `Error: ${err}`;
    }
}

function getClock(): string {
    return `Current time is ${new Date().toLocaleString("en-IN", { timeZone: "Asia/Kolkata" })}`;
}

const availableTools = {
    run_command: runCommand,
    clock: getClock,
};



// For incoming messages
// Store user states in memory (for demo; in production use DB/Redis)
// const userState: Record<string, string> = {};

// searchQuery will embed → search Milvus → ask AIML → return answer
// async function searchQuery(query: string) {
//   try {
//     // Step 1: Embed query
//     const embedResponse = await axios.post(
//       "https://api.cohere.ai/v1/embed",
//       {
//         texts: [query],
//         model: "embed-english-v3.0",
//         input_type: "search_document",
//       },
//       {
//         headers: {
//           Authorization: `Bearer ${process.env.COHERE_API_KEY}`,
//           "Content-Type": "application/json",
//         },
//       }
//     );

//     const queryEmbedding = embedResponse.data.embeddings[0];

//     // Step 2: Search Milvus
//     const searchResult = await client.search({
//       collection_name: "insurancembeddings",
//       vector: queryEmbedding,
//       limit: 3,
//       output_fields: ["text", "title"],
//     //   filter: `userId == "${userId}"`,
//       params: {
//         anns_field: "vector",
//         topk: 3,
//         metric_type: "COSINE",
//         params: JSON.stringify({ nprobe: 10 }),
//       },
//     });

//     const title = searchResult.results[0].title;
//     const relevantText = searchResult.results.map((hit) => hit.text);
//     const context = relevantText.join("\n\n");

//     // Step 3: AIML – Prompt tuned for Insurance Agent in India
//     const aimlResponse = await axios.post(
//       "https://api.aimlapi.com/v1/chat/completions",
//       {
//         model: "gpt-4",
//         messages: [
//           {
//             role: "system",
//             content: `You are an experienced insurance agent in India. 
// Your job is to clearly explain insurance policies, claims, and customer queries in a helpful and trustworthy tone. 
// Be concise, professional, and explain with relatable Indian insurance terms/examples.`,
//           },
//           {
//             role: "user",
//             content: `Use the following context to answer the question. 
// If unsure, say "Not enough information in the context." 
// Format the answer in simple steps or bullet points.

// ---CONTEXT START---
// ${context}
// ---CONTEXT END---

// Question: ${query}`,
//           },
//         ],
//         max_tokens: 500,
//         temperature: 0.7,
//       },
//       {
//         headers: {
//           Authorization: `Bearer ${process.env.AIMLAPI_KEY}`,
//           "Content-Type": "application/json",
//         },
//       }
//     );

//     const answer = aimlResponse.data.choices[0].message.content;

//     return answer;
//   } catch (error) {
//     console.error("Error in searchQuery:", error);
//     return "Sorry, something went wrong while processing your query.";
//   }
// }

async function searchQuery(query: string, userId: string) {
    try {
        // 1. Embed with Cohere
        const embedResponse = await axios.post(
            "https://api.cohere.ai/v1/embed",
            {
                texts: [query],
                model: "embed-english-v3.0",
                input_type: "search_document",
            },
            {
                headers: {
                    Authorization: `Bearer ${process.env.COHERE_API_KEY}`,
                    "Content-Type": "application/json",
                },
            }
        );
        const queryEmbedding = embedResponse.data.embeddings[0];

        // 2. Search Milvus
        const searchResult = await client.search({
            collection_name: "insurancembeddings",
            vector: queryEmbedding,
            limit: 3,
            output_fields: ["text", "title"],
            params: {
                anns_field: "vector",
                topk: 3,
                metric_type: "COSINE",
                params: JSON.stringify({ nprobe: 10 }),
            },
            expr: `userId == "${userId}"`,
        });

        const context = searchResult.results.map((hit) => hit.text).join("\n\n");

        // 3. Single LLM call (no plan/action/observe)
        const resp = await axios.post(
            "https://api.aimlapi.com/v1/chat/completions",
            {
                model: "gpt-4",
                messages: [
                    {
                        role: "system",
                        content: SYSTEM_PROMPT, // include your Q&A examples here
                    },
                    {
                        role: "user",
                        content: `Use the following context to answer the question.
  If unsure, say "Not enough information in the context."
  
  ---CONTEXT---
  ${context}
  ---END---
  
  Question: ${query}`,
                    },
                ],
                max_tokens: 500,
                temperature: 0.7,
            },
            {
                headers: {
                    Authorization: `Bearer ${process.env.AIMLAPI_KEY}`,
                    "Content-Type": "application/json",
                },
            }
        );
        console.log(resp.data.choices[0].message.content)
        return resp.data.choices[0].message.content;
    } catch (err) {
        console.error("Error in searchQuery:", err);
        return "Sorry, something went wrong.";
    }
}

// Extract text from PDF buffer
export async function extractTextFromPdfBuffer(buffer: Buffer): Promise<string> {
    try {
        const data = await pdfParse(buffer);
        return data.text;
    } catch (err) {
        console.error("❌ PDF processing failed:", err);
        throw new Error("Failed to extract text from PDF");
    }
}

// Extract text from DOCX buffer
export async function extractTextFromDocxBuffer(buffer: Buffer): Promise<string> {
    try {
        const result = await mammoth.extractRawText({ buffer });
        return result.value;
    } catch (err) {
        console.error("❌ DOCX processing failed:", err);
        throw new Error("Failed to extract text from DOCX");
    }
}

// Extract text from Excel buffer
export async function extractTextFromExcelBuffer(buffer: Buffer): Promise<string> {
    try {
        const workbook = XLSX.read(buffer, { type: "buffer" });
        let allText = "";

        workbook.SheetNames.forEach((sheetName) => {
            const sheet = workbook.Sheets[sheetName];
            const sheetData = XLSX.utils.sheet_to_json(sheet, { header: 1 }) as any[][];

            // Flatten rows and cells to plain text
            sheetData.forEach((row: any[]) => {
                allText += row.join(" ") + "\n";
            });
        });

        return allText;
    } catch (err) {
        console.error("❌ Excel processing failed:", err);
        throw new Error("Failed to extract text from Excel");
    }
}

async function downloadMedia(mediaId: string): Promise<Buffer> {
    try {
        // Step 1: Get media URL from WhatsApp Graph API
        const mediaRes = await axios.get(
            `https://graph.facebook.com/v20.0/${mediaId}`,
            { headers: { Authorization: `Bearer ${process.env.WHATSAPP_ACCESS_TOKEN}` } }
        );

        const mediaUrl = mediaRes.data.url;

        // Step 2: Download actual file
        const fileRes = await axios.get(mediaUrl, {
            headers: { Authorization: `Bearer ${process.env.WHATSAPP_ACCESS_TOKEN}` },
            responseType: "arraybuffer",
        });

        return Buffer.from(fileRes.data);
    } catch (err) {
        console.error("❌ Failed to download media:", err);
        throw new Error("Media download failed");
    }
}

// Extract text from Image buffer
export async function extractTextFromImageBuffer(buffer: Buffer): Promise<string> {
    try {
        const { data: { text } } = await Tesseract.recognize(buffer, "eng", {
            logger: (m) => console.log(m), // optional progress logs
        });
        return text;
    } catch (err) {
        console.error("❌ Image processing failed:", err);
        throw new Error("Failed to extract text from image");
    }
}

function chunkText(text: string, chunkSize = 8000): string[] {
    const chunks: string[] = [];
    for (let i = 0; i < text.length; i += chunkSize) {
        chunks.push(text.slice(i, i + chunkSize));
    }
    return chunks;
}

export async function indexChunks(
    texts: string[],
    fileName: string,
    userId: string,
    chunkSize = 8000 // ✅ keep under Milvus VARCHAR(10000) limit
) {
    const allChunks: string[] = [];

    for (const text of texts) {
        const parts = chunkText(text, chunkSize);
        allChunks.push(...parts);
    }

    const embeddings: number[][] = [];
    const batchSize = 100;

    for (let i = 0; i < allChunks.length; i += batchSize) {
        const batch = allChunks.slice(i, i + batchSize);

        try {
            const embedRes = await axios.post(
                "https://api.cohere.ai/v1/embed",
                {
                    texts: batch,
                    model: "embed-english-v3.0",
                    input_type: "search_document",
                },
                {
                    headers: {
                        Authorization: `Bearer ${process.env.COHERE_API_KEY}`,
                        "Content-Type": "application/json",
                    },
                }
            );

            embeddings.push(...embedRes.data.embeddings);
        } catch (err: any) {
            console.error("❌ Embedding batch failed:", err.response?.data || err.message || err);
        }
    }

    // ✅ Align chunks with embeddings
    const records = [];
    for (let idx = 0; idx < embeddings.length; idx++) {
        if (!embeddings[idx]) continue;
        records.push({
            text: allChunks[idx],       // guaranteed < 8000 chars
            vector: embeddings[idx],
            filename: fileName,         // ⚠️ must match schema
            userid: Number(userId),     // ⚠️ schema expects INT16
        });
    }

    console.log("📦 Ready to insert:", records.length, "records");

    if (records.length === 0) {
        console.warn("⚠️ No records to insert.");
        return false;
    }

    try {
        const insertResult = await client.insert({
            collection_name: "insurancembeddings",
            data: records,
        });

        console.log("✅ Insert result:", JSON.stringify(insertResult, null, 2));
        return true;
    } catch (err: any) {
        console.error("❌ Milvus insert failed:", err.message || err);
        return false;
    }
}

// app.post("/webhook", async (req: Request, res: Response) => {
//     console.log("Incoming webhook:", JSON.stringify(req.body, null, 2));

//     const value = req.body.entry?.[0]?.changes?.[0]?.value;

//     // ✅ Ignore status webhooks (sent, delivered, read, etc.)
//     if (value.statuses) {
//         return res.sendStatus(200);
//     }

//     const message = value?.messages?.[0];
//     const from = message?.from;
//     if (!from) {
//         return res.sendStatus(200);
//     }

//     // Handle text messages
//     if (message.type === "text") {
//         const text = message.text?.body?.toLowerCase();

//         // If user is in Q&A mode
//         if (userState[from] === "awaiting_question") {
//             if (["end", "exit", "quit"].includes(text)) {
//                 // End session
//                 delete userState[from];
//                 await sendMessage(from, {
//                     type: "text",
//                     text: { body: "✅ Session ended. Say 'hi' anytime to start again." },
//                 });
//             } else {
//                 // Answer their question
//                 const result = await searchQuery(text);
//                 await sendMessage(from, {
//                     type: "text",
//                     text: { body: result },
//                 });
//                 // 👉 Stay in Q&A mode until user types "end"
//             }
//         } else if (["hey", "hi", "hello"].includes(text)) {
//             // Show main menu buttons
//             await sendMessage(from, {
//                 type: "interactive",
//                 interactive: {
//                     type: "button",
//                     body: {
//                         text: "Welcome 👋 to your second brain, What would you like?",
//                     },
//                     action: {
//                         buttons: [
//                             {
//                                 type: "reply",
//                                 reply: { id: "ask_question", title: "Ask Question?" },
//                             },
//                             {
//                                 type: "reply",
//                                 reply: { id: "upload_document", title: "Upload Document?" },
//                             },
//                         ],
//                     },
//                 },
//             });
//         } else {
//             // Fallback if user is not in session
//             await sendMessage(from, {
//                 type: "text",
//                 text: { body: "Please type 'hi', 'hey', or 'hello' to start." },
//             });
//         }
//     }

//     // Handle button clicks
//     else if (message.type === "interactive") {
//         const buttonId = message.interactive?.button_reply?.id;

//         if (buttonId === "ask_question") {
//             userState[from] = "awaiting_question";
//             await sendMessage(from, {
//                 type: "text",
//                 text: { body: "What's your question? 🤔 (type 'end' to finish)" },
//             });
//         } else if (buttonId === "upload_document") {
//             await sendMessage(from, {
//                 type: "text",
//                 text: { body: "Please upload your document 📄 or image 🖼️" },
//             });
//         }
//     }

//     // Handle document uploads
//     else if (message.type === "document") {
//         const fileName = message.document?.filename || "file";
//         const mimeType = message.document?.mime_type;
//         const mediaId = message.document?.id;

//         try {
//             const buffer = await downloadMedia(mediaId);
//             let extractedText = "";

//             if (mimeType === "application/pdf") {
//                 extractedText = await extractTextFromPdfBuffer(buffer);
//             } else if (
//                 mimeType ===
//                 "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
//             ) {
//                 extractedText = await extractTextFromDocxBuffer(buffer);
//             } else if (mimeType === "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet") {
//                 extractedText = await extractTextFromExcelBuffer(buffer);
//             } else {
//                 await sendMessage(from, {
//                     type: "text",
//                     text: { body: "❌ Unsupported file type. Please upload PDF, DOCX or Excel" },
//                 });
//                 return;
//             }

//             const res = await indexChunks([extractedText], fileName, from);

//             if (res) {
//                 await sendMessage(from, {
//                     type: "text",
//                     text: { body: `✅ Received and processed ${fileName}` },
//                 });

//                 delete userState[from];

//                 await sendMessage(from, {
//                     type: "text",
//                     text: { body: "✅ Session ended. Say 'hi' anytime to start again." },
//                 });
//             }
//         } catch (err) {
//             await sendMessage(from, {
//                 type: "text",
//                 text: { body: "❌ Failed to process your document." },
//             });
//         }
//     }

//     // Handle image uploads (OCR)
//     else if (message.type === "image") {
//         const mediaId = message.image?.id;
//         const fileName = `image_${Date.now()}.png`;

//         try {
//             const buffer = await downloadMedia(mediaId);
//             const extractedText = await extractTextFromImageBuffer(buffer); // ⬅️ OCR

//             const res = await indexChunks([extractedText], fileName, from);

//             if (res) {
//                 await sendMessage(from, {
//                     type: "text",
//                     text: { body: `✅ Received and processed your image as text` },
//                 });
//             }
//         } catch (err) {
//             await sendMessage(from, {
//                 type: "text",
//                 text: { body: "❌ Failed to process your image." },
//             });
//         }
//     }

//     res.sendStatus(200);
// });

// ✅ Track user sessions
interface UserSession {
    mode?: "awaiting_question" | "uploading";
    lastActive: number;
}

const userState: Record<string, UserSession> = {};

// ✅ Session cleaner (runs every minute)
setInterval(async () => {
    const now = Date.now();
    const oneHour = 60 * 60 * 1000;;

    for (const [user, session] of Object.entries(userState)) {
        if (now - session.lastActive > oneHour) {
            await sendMessage(user, {
                type: "text",
                text: { body: "⏰ Session ended due to inactivity. Please type 'hi', 'hey', or 'hello' to start again." },
            });
            delete userState[user];
        }
    }
}, 60 * 1000); // check every 1 min


app.post("/webhook", async (req: Request, res: Response) => {
    console.log("Incoming webhook:", JSON.stringify(req.body, null, 2));

    const value = req.body.entry?.[0]?.changes?.[0]?.value;

    // ✅ Ignore status webhooks (sent, delivered, read, etc.)
    if (value.statuses) {
        return res.sendStatus(200);
    }

    const message = value?.messages?.[0];
    const from = message?.from;
    if (!from) {
        return res.sendStatus(200);
    }

    // ✅ Update user session activity timestamp
    if (!userState[from]) userState[from] = { lastActive: Date.now() };
    else userState[from].lastActive = Date.now();

    // helper: send main menu
    const sendMainMenu = async (to: string, text: string) => {
        await sendMessage(to, {
            type: "interactive",
            interactive: {
                type: "button",
                body: { text },
                action: {
                    buttons: [
                        {
                            type: "reply",
                            reply: { id: "ask_question", title: "Ask Question?" },
                        },
                        {
                            type: "reply",
                            reply: { id: "upload_document", title: "Upload Document?" },
                        },
                    ],
                },
            },
        });
    };

    // Handle text messages
    if (message.type === "text") {
        const text = message.text?.body?.toLowerCase();

        // If user is in Q&A mode
        if (userState[from]?.mode === "awaiting_question") {
            if (["end", "exit", "quit"].includes(text)) {
                delete userState[from];
                await sendMainMenu(from, "✅ Session ended. What would you like to do next?");
            } else {
                // Answer their question
                const result = await searchQuery(text, from);
                await sendMessage(from, {
                    type: "text",
                    text: { body: result },
                });
                // 👉 Immediately show menu again
                await sendMainMenu(from, "What would you like to do next?");
            }
        } else if (["hey", "hi", "hello"].includes(text)) {
            // Show main menu buttons
            await sendMainMenu(from, "Welcome 👋 to your second brain, What would you like?");
        } else {
            // Fallback if user is not in session
            await sendMessage(from, {
                type: "text",
                text: { body: "Please type 'hi', 'hey', or 'hello' to start." },
            });
        }
    }

    // Handle button clicks
    else if (message.type === "interactive") {
        const buttonId = message.interactive?.button_reply?.id;

        if (buttonId === "ask_question") {
            userState[from] = { mode: "awaiting_question", lastActive: Date.now() };
            await sendMessage(from, {
                type: "text",
                text: { body: "What's your question? 🤔" },
            });
        } else if (buttonId === "upload_document") {
            userState[from] = { mode: "uploading", lastActive: Date.now() };
            await sendMessage(from, {
                type: "text",
                text: { body: "Please upload your document 📄 or image 🖼️" },
            });
        }
    }

    // Handle document uploads
    else if (message.type === "document") {
        const fileName = message.document?.filename || "file";
        const mimeType = message.document?.mime_type;
        const mediaId = message.document?.id;

        try {
            const buffer = await downloadMedia(mediaId);
            let extractedText = "";

            if (mimeType === "application/pdf") {
                extractedText = await extractTextFromPdfBuffer(buffer);
            } else if (
                mimeType === "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
            ) {
                extractedText = await extractTextFromDocxBuffer(buffer);
            } else if (mimeType === "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet") {
                extractedText = await extractTextFromExcelBuffer(buffer);
            } else {
                await sendMessage(from, {
                    type: "text",
                    text: { body: "❌ Unsupported file type. Please upload PDF, DOCX or Excel" },
                });
                return;
            }

            const res = await indexChunks([extractedText], fileName, from);

            if (res) {
                await sendMessage(from, {
                    type: "text",
                    text: { body: `✅ Received and processed ${fileName}` },
                });

                delete userState[from];

                // 👉 Show menu again
                await sendMainMenu(from, "What would you like to do next?");
            }
        } catch (err) {
            await sendMessage(from, {
                type: "text",
                text: { body: "❌ Failed to process your document." },
            });
        }
    }

    // Handle image uploads (OCR)
    else if (message.type === "image") {
        const mediaId = message.image?.id;
        const fileName = `image_${Date.now()}.png`;

        try {
            const buffer = await downloadMedia(mediaId);
            const extractedText = await extractTextFromImageBuffer(buffer); // ⬅️ OCR

            const res = await indexChunks([extractedText], fileName, from);

            if (res) {
                await sendMessage(from, {
                    type: "text",
                    text: { body: `✅ Received and processed your image as text` },
                });

                delete userState[from];

                // 👉 Show menu again
                await sendMainMenu(from, "What would you like to do next?");
            }
        } catch (err) {
            await sendMessage(from, {
                type: "text",
                text: { body: "❌ Failed to process your image." },
            });
        }
    }

    res.sendStatus(200);
});



app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});
