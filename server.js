const express = require("express");
const cors = require("cors");

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static("public"));

// --- Simple in-memory conversation store (per browser session) ---
const sessions = new Map(); // sessionId -> [{role, content}, ...]
const SESSION_TTL_MS = 1000 * 60 * 60; // 1 hour
const sessionLastSeen = new Map();

function getSessionId(req) {
  // Very simple cookie parsing (no extra libs)
  const cookie = req.headers.cookie || "";
  const match = cookie.match(/sessionId=([^;]+)/);
  if (match) return match[1];

  // Create a session id if none exists
  return "s_" + Math.random().toString(36).slice(2) + Date.now().toString(36);
}

function systemPrompt(mode) {
  const prompts = {
    customer_support:
      "You are a professional customer support agent. Be polite, calm, and step-by-step. Ask for missing details and offer clear solutions. If unsure, ask clarifying questions.",
    study_helper:
      "You are a study tutor. Explain clearly with examples, then give a short quiz. Encourage the student to try first.",
    business_assistant:
      "You are a business assistant. Provide structured, actionable answers with bullet points, templates, and next steps.",
    virtual_assistant:
      "You are a general virtual assistant. Be fast, practical, and friendly. Ask at most 1–2 questions if needed.",
    interview_ai:
      "You are an interview coach. Ask ONE interview question at a time. After the user answers: give feedback + a stronger version + a score (1–10)."
  };
  return prompts[mode] || prompts.virtual_assistant;
}

function buildPrompt(mode, history, userMessage) {
  // Keep history short to avoid slowdowns
  const trimmed = history.slice(-16);

  let prompt = `${systemPrompt(mode)}\n\n`;
  for (const m of trimmed) {
    prompt += `${m.role === "user" ? "User" : "Assistant"}: ${m.content}\n`;
  }
  prompt += `User: ${userMessage}\nAssistant:`;
  return prompt;
}

// Cleanup old sessions occasionally
setInterval(() => {
  const now = Date.now();
  for (const [sid, last] of sessionLastSeen.entries()) {
    if (now - last > SESSION_TTL_MS) {
      sessionLastSeen.delete(sid);
      sessions.delete(sid);
    }
  }
}, 1000 * 60 * 10);

// --- STREAMING endpoint (Server-Sent Events) ---
app.get("/chat-stream", async (req, res) => {
  try {
    const message = (req.query.message || "").toString();
    const mode = (req.query.mode || "virtual_assistant").toString();

    if (!message.trim()) {
      res.status(400).end("Missing message");
      return;
    }

    const sessionId = getSessionId(req);

    // Set cookie if new
    if (!(req.headers.cookie || "").includes("sessionId=")) {
      res.setHeader("Set-Cookie", `sessionId=${sessionId}; Path=/; SameSite=Lax`);
    }

    sessionLastSeen.set(sessionId, Date.now());

    const history = sessions.get(sessionId) || [];
    const prompt = buildPrompt(mode, history, message);

    // SSE headers
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache, no-transform");
    res.setHeader("Connection", "keep-alive");

    // Call Ollama streaming API
    const r = await fetch("http://localhost:11434/api/generate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "llama3.2:3b",
        prompt,
        stream: true
      })
    });

    if (!r.ok || !r.body) {
      const text = await r.text().catch(() => "");
      res.write(`event: error\ndata: ${JSON.stringify({ error: text || "Ollama error" })}\n\n`);
      res.end();
      return;
    }

    let assistantText = "";

    const reader = r.body.getReader();
    const decoder = new TextDecoder();

    while (true) {
      const { value, done } = await reader.read();
      if (done) break;

      const chunk = decoder.decode(value, { stream: true });

      // Ollama streams NDJSON: one JSON object per line
      const lines = chunk.split("\n").filter(Boolean);
      for (const line of lines) {
        let obj;
        try {
          obj = JSON.parse(line);
        } catch {
          continue;
        }

        if (obj.response) {
          assistantText += obj.response;
          res.write(`data: ${JSON.stringify({ token: obj.response })}\n\n`);
        }

        if (obj.done) {
          break;
        }
      }
    }

    // Save memory
    history.push({ role: "user", content: message });
    history.push({ role: "assistant", content: assistantText.trim() });
    sessions.set(sessionId, history);

    res.write(`event: done\ndata: ${JSON.stringify({ done: true })}\n\n`);
    res.end();
  } catch (err) {
    console.error(err);
    res.status(500).end("Stream error");
  }
});

// Optional: clear memory button support
app.post("/clear", (req, res) => {
  const sessionId = getSessionId(req);
  sessions.delete(sessionId);
  sessionLastSeen.delete(sessionId);
  res.json({ ok: true });
});

app.listen(3000, () => {
  console.log("Local AI server running at http://localhost:3000");
});
