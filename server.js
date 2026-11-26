import express from "express";
import compression from "compression";
import helmet from "helmet";
import rateLimit from "express-rate-limit";
import { GoogleGenAI } from "@google/genai";
import dotenv from "dotenv";

dotenv.config();

const PORT = process.env.PORT || 3000;

// Agar ek model busy ho toh agla model try hota hai
const MODELS = ["gemini-3.6-flash", "gemini-3.5-flash-lite", "gemini-3.8-flash"];

const apiKey = process.env.GEMINI_API_KEY;
if (!apiKey) {
  console.error("API key not found. Set GEMINI_API_KEY.");
  process.exit(1);
}

const ai = new GoogleGenAI({ apiKey });

const systemPrompt = `
You are Tripgenic, a friendly and expert AI trip planning assistant.

You help users plan trips: destinations, day-by-day itineraries, budget, stays, food, transport and travel tips.

How to answer:
- Reply in the same language as the user (English, Hindi, or Hinglish).
- Use clean Markdown: short headings, bullet points and tables.
- For itineraries use "### Day 1 - Place" headings, with Morning / Afternoon / Evening bullets.
- End a full plan with a budget table (Stay, Food, Travel, Activities, Total) in Indian Rupees (₹) unless the user asks for another currency.
- Add 3 to 4 short practical tips, and the best time to visit, when relevant.
- If days, budget or number of travellers are missing, still give a helpful draft plan using sensible assumptions, state those assumptions, and then ask one short follow-up question.
- Prices and timings are approximate, so say they should be checked before booking.
- Keep the tone warm and concise. Use a few relevant emojis.
- If the question is not about travel, politely say you only help with trip planning.
`;

const app = express();

// Render proxy ke peeche chalta hai, isliye real IP ke liye zaroori
app.set("trust proxy", 1);

app.use(helmet({ contentSecurityPolicy: false }));
// /chat ko compress nahi karte, warna live typing (streaming) ruk jaati hai
app.use(
  compression({
    filter: (req, res) => (req.path === "/chat" ? false : compression.filter(req, res)),
  })
);
app.use(express.json({ limit: "50kb" }));
app.use(express.static("public"));

// Link public hai, isliye 1 minute mein 15 sawal tak allow (quota bachane ke liye)
const chatLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 15,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many questions too quickly. Please wait a minute and try again." },
});
app.use("/chat", chatLimiter);

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Gemini se live (stream) jawab leta hai; model busy ho toh next model par jaata hai
async function streamWithFallback(contents, onText) {
  for (const model of MODELS) {
    for (let attempt = 0; attempt < 2; attempt++) {
      let sentSomething = false;
      try {
        const stream = await ai.models.generateContentStream({
          model,
          contents,
          config: {
            systemInstruction: systemPrompt,
            temperature: 0.7,
            maxOutputTokens: 2000,
          },
        });

        for await (const chunk of stream) {
          if (chunk.text) {
            sentSomething = true;
            onText(chunk.text);
          }
        }
        if (sentSomething) return;
      } catch (error) {
        // Jawab aadha aa chuka ho toh dobara try nahi kar sakte
        if (sentSomething) throw error;

        const text = String(error?.message || error);
        const busy =
          text.includes("503") || text.includes("UNAVAILABLE") || text.includes("429");
        const notFound = text.includes("404") || text.includes("NOT_FOUND");

        console.log(
          `${model} failed (try ${attempt + 1}): ${busy ? "busy" : notFound ? "not found" : text}`
        );

        if (notFound) break; // is model ko chhodo, agle par jao
        if (!busy) throw error; // koi aur error hai
        if (attempt === 0) await sleep(1500);
      }
    }
  }
  throw new Error("All models are busy. Please try again in a few minutes.");
}

app.post("/chat", async (req, res) => {
  const incoming = Array.isArray(req.body?.messages) ? req.body.messages : [];

  // Sirf last 12 messages bhejte hain, taaki chat yaad rahe par request chhoti rahe
  const contents = incoming
    .slice(-12)
    .filter((m) => m && typeof m.text === "string" && m.text.trim())
    .map((m) => ({
      role: m.role === "model" ? "model" : "user",
      parts: [{ text: m.text.slice(0, 4000) }],
    }));

  // Gemini ki conversation hamesha user message se shuru honi chahiye
  while (contents.length && contents[0].role === "model") contents.shift();

  if (!contents.length || contents[contents.length - 1].role !== "user") {
    return res.status(400).json({ error: "Please enter your trip question." });
  }

  res.setHeader("Content-Type", "text/plain; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("X-Accel-Buffering", "no");

  try {
    await streamWithFallback(contents, (text) => res.write(text));
    res.end();
  } catch (error) {
    console.error("AI request failed:", error.message);
    if (!res.headersSent) {
      res.status(503).json({ error: "Tripgenic is busy right now. Please try again in a minute." });
    } else {
      res.write("\n\n⚠️ The answer was cut short. Please ask again.");
      res.end();
    }
  }
});

app.listen(PORT, () => {
  console.log(`Server running at http://localhost:${PORT}`);
});
