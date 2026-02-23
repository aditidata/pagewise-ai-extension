import express from "express";
import cors from "cors";
import dotenv from "dotenv";

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json());

const OLLAMA = "http://localhost:11434/api/generate";
const MODEL  = "llama-3.1-8b-instant";

// ── Helper: call Ollama ───────────────────────────────────
async function ollamaCall(prompt) {
  const response = await fetch(OLLAMA, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "llama3.2:1b",
      prompt: prompt,   // ✅ use the parameter
      stream: false,
      options: {
        temperature: 0.7,
        num_predict: 500
      }
    }),
  });
  const data = await response.json();
  return data.response || "";
}

// ── /summarize ────────────────────────────────────────────
app.post("/summarize", async (req, res) => {
  const { text } = req.body || {};
  if (!text) return res.status(400).json({ error: "No text provided" });

  try {
    const prompt = `
You are an exam-focused academic assistant.

Summarize the following text into clear bullet points for quick student revision.
Each bullet should start with "•" and be one concise sentence.
Focus on key facts, definitions, and important concepts.

Text:
${text.slice(0, 2000)}

Summary:`;

    const summary = await ollamaCall(
  `Summarize this into bullet points for exam revision:\n\n${text.slice(0, 2000)}`
);
    return res.json({ summary: summary.trim(), fallback: false });

  } catch (err) {
    console.error("Summarize error:", err);
    const fallback = `• Content from this page could not be summarized\n• Local AI temporarily unavailable`;
    return res.json({ summary: fallback, fallback: true });
  }
});

// ── /keywords ─────────────────────────────────────────────
app.post("/keywords", async (req, res) => {
  const { text } = req.body || {};
  if (!text) return res.status(400).json({ error: "No text provided" });

  try {
    const prompt = `
Extract exactly 8 important keywords or key phrases from the text below.
Return ONLY a JSON array of strings, nothing else. No explanation, no markdown.
Example: ["keyword1", "keyword2", "keyword3"]

Text:
${text.slice(0, 1500)}

Keywords:`;

    const raw = await ollamaCall(prompt);

    // Try to parse JSON array from response
    const match = raw.match(/\[.*?\]/s);
    if (match) {
      const keywords = JSON.parse(match[0]);
      return res.json({ keywords });
    }

    // Fallback: split by commas/newlines
    const keywords = raw
      .replace(/[\[\]"]/g, "")
      .split(/[,\n]/)
      .map(k => k.trim())
      .filter(k => k.length > 2)
      .slice(0, 8);

    return res.json({ keywords });

  } catch (err) {
    console.error("Keywords error:", err);
    return res.json({ keywords: [] });
  }
});

// ── /chat ─────────────────────────────────────────────────
app.post("/chat", async (req, res) => {
  const { question, context, history = [] } = req.body || {};
  if (!question || !context) return res.status(400).json({ error: "question and context required" });

  try {
    // Build conversation history string
    const historyStr = history
      .map(h => `User: ${h.user}\nAssistant: ${h.assistant}`)
      .join("\n\n");

    const prompt = `
You are a helpful AI reading assistant. The user is reading a PDF document.
Answer questions based ONLY on the provided page context below.
If the answer is not in the context, say "I don't see that in this page."
Be concise and direct.

--- Page Context ---
${context.slice(0, 2000)}
--- End Context ---

${historyStr ? `Previous conversation:\n${historyStr}\n\n` : ""}
User question: ${question}

Answer:`;

    const answer = await ollamaCall(prompt);
    return res.json({ answer: answer.trim() });

  } catch (err) {
    console.error("Chat error:", err);
    return res.json({ answer: "❌ Could not get a response. Is Ollama running?" });
  }
});

app.listen(5000, () => {
  console.log("🚀 PageWise AI server running on http://localhost:5000");
  console.log("   Endpoints: /summarize  /keywords  /chat");
});