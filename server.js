/**
 * server.js  —  Jazz Bar Instagram DM Agent
 * ─────────────────────────────────────────────────────────────
 * Flow: IG DM → 3 Groq drafts → WhatsApp notify → Owner picks → Send
 * Features:
 *  - 3 tone options per DM (A/B/C)
 *  - Greeting + reservation link for new users
 *  - Auto-send option A after 5 min if no owner action
 *  - Multi-message queue with job IDs
 *  - Batch replies: "A 1, C 2, B 3" all at once
 *
 * Install: npm install express axios groq-sdk dotenv
 * Run:     node server.js
 */

require("dotenv").config();
const express = require("express");
const axios = require("axios");
const Groq = require("groq-sdk");
const ACCOUNTS = require("./accounts");

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

const jobQueue = new Map();
let jobCounter = 1;
const seenUsers = new Set();

const RESERVATION_LINK = "https://www.sevenrooms.com/reservations/jazzbarabudhabi";
const AUTO_REPLY_MINUTES = 5;

function resolveAccount(pageId) {
  return Object.entries(ACCOUNTS).find(
    ([, acct]) => acct.pageId === pageId
  );
}

// ─────────────────────────────────────────────────────────────
// INSTAGRAM WEBHOOK
// ─────────────────────────────────────────────────────────────

app.get("/webhook", (req, res) => {
  if (
    req.query["hub.mode"] === "subscribe" &&
    req.query["hub.verify_token"] === process.env.IG_VERIFY_TOKEN
  ) {
    console.log("✅ Webhook verified");
    return res.send(req.query["hub.challenge"]);
  }
  res.sendStatus(403);
});

app.post("/webhook", async (req, res) => {
  res.sendStatus(200);

  const body = req.body;
  if (body.object !== "instagram") return;

  for (const entry of body.entry || []) {
    const pageId = entry.id;
    const accountEntry = resolveAccount(pageId);
    if (!accountEntry) {
      console.log(`⚠️  Unknown page ID: ${pageId}`);
      continue;
    }

    const [accountKey, account] = accountEntry;

    for (const event of entry.messaging || []) {
      if (event.message?.is_echo) continue;
      const senderId = event.sender?.id;
      const text = event.message?.text;
      if (!senderId || !text) continue;

      console.log(`📩 [${account.name}] DM from ${senderId}: "${text}"`);
      handleDM(accountKey, account, senderId, text).catch(console.error);
    }
  }
});

// ─────────────────────────────────────────────────────────────
// CORE FLOW
// ─────────────────────────────────────────────────────────────

async function handleDM(accountKey, account, senderId, messageText) {
  const username = await getIGUsername(senderId, account.accessToken);
  const isNewUser = !seenUsers.has(senderId);

  const [draftA, draftB, draftC] = await generateThreeDrafts(account.systemPrompt, messageText, isNewUser);

  const wrapDraft = (draft) => {
    if (!isNewUser) return draft;
    return `Thank you for reaching out to Jazz Bar Abu Dhabi.\n\n${draft}\n\nYou can make a reservation here: ${RESERVATION_LINK}`;
  };

  const finalA = wrapDraft(draftA);
  const finalB = wrapDraft(draftB);
  const finalC = wrapDraft(draftC);

  const jobId = jobCounter++;
  const job = {
    accountKey, account, senderId, username, messageText,
    drafts: { A: finalA, B: finalB, C: finalC },
    isNewUser,
    autoSendTimer: null,
  };

  jobQueue.set(jobId, job);

  // Auto-send option A after 5 minutes
  job.autoSendTimer = setTimeout(async () => {
    if (!jobQueue.has(jobId)) return;
    console.log(`⏱️  Auto-sending draft A for job #${jobId} (@${username})`);
    try {
      await sendIGReply(senderId, finalA, account.accessToken);
      if (isNewUser) seenUsers.add(senderId);
      await sendWhatsApp(`Auto-sent option A to @${username} (job #${jobId}) after ${AUTO_REPLY_MINUTES} min.`);
    } catch (err) {
      console.error(`Auto-send failed for #${jobId}:`, err.message);
    }
    jobQueue.delete(jobId);
  }, AUTO_REPLY_MINUTES * 60 * 1000);

  // Notify owner — compact format for easy batch handling
  const waBody =
    `--- JOB #${jobId}${isNewUser ? " NEW" : ""} ---\n` +
    `@${username}: "${messageText}"\n\n` +
    `[A] ${finalA}\n\n` +
    `[B] ${finalB}\n\n` +
    `[C] ${finalC}\n\n` +
    `Auto-sends A in ${AUTO_REPLY_MINUTES} min\n` +
    `Reply: A ${jobId} / B ${jobId} / C ${jobId} / EDIT ${jobId} text / NO ${jobId}\n` +
    `Batch: A 1, C 2, B 3`;

  await sendWhatsApp(waBody);
  console.log(`📱 3 options sent for job #${jobId} (@${username})`);
}

// ─────────────────────────────────────────────────────────────
// WHATSAPP APPROVAL REPLY — supports batch: "A 1, C 2, B 3"
// ─────────────────────────────────────────────────────────────

app.post("/whatsapp-reply", async (req, res) => {
  res.sendStatus(200);

  const incomingBody = (req.body.Body || "").trim();
  console.log(`📲 Owner replied: "${incomingBody}"`);

  // Split by comma to support batch replies like "A 1, C 2, B 3"
  const instructions = incomingBody.split(",").map(s => s.trim()).filter(Boolean);
  const results = [];

  for (const instruction of instructions) {
    const parts = instruction.split(" ");
    const command = parts[0].toUpperCase();
    const jobId = parseInt(parts[1]);

    if (isNaN(jobId)) {
      results.push(`Job ID missing in: "${instruction}"`);
      continue;
    }

    const job = jobQueue.get(jobId);
    if (!job) {
      results.push(`#${jobId} not found or already sent`);
      continue;
    }

    clearTimeout(job.autoSendTimer);

    if (command === "A" || command === "B" || command === "C") {
      const chosen = job.drafts[command];
      try {
        await sendIGReply(job.senderId, chosen, job.account.accessToken);
        if (job.isNewUser) seenUsers.add(job.senderId);
        results.push(`Sent ${command} to @${job.username} (#${jobId})`);
        console.log(`✅ Sent option ${command} to @${job.username}`);
      } catch (err) {
        results.push(`Failed to send #${jobId}: ${err.message}`);
      }
      jobQueue.delete(jobId);

    } else if (command === "EDIT") {
      const editedText = parts.slice(2).join(" ").trim();
      if (editedText) {
        try {
          await sendIGReply(job.senderId, editedText, job.account.accessToken);
          if (job.isNewUser) seenUsers.add(job.senderId);
          results.push(`Sent custom reply to @${job.username} (#${jobId})`);
          console.log(`✏️  Sent custom reply to @${job.username}`);
        } catch (err) {
          results.push(`Failed to send #${jobId}: ${err.message}`);
        }
        jobQueue.delete(jobId);
      } else {
        results.push(`EDIT #${jobId} missing text. Format: EDIT ${jobId} your message`);
      }

    } else if (command === "NO") {
      results.push(`Skipped #${jobId} (@${job.username})`);
      console.log(`🚫 Skipped #${jobId}`);
      jobQueue.delete(jobId);

    } else {
      results.push(`Unknown command "${command}" for #${jobId}`);
    }
  }

  // Send confirmation back to owner
  if (results.length > 0) {
    await sendWhatsApp(results.join("\n"));
  }
});

// ─────────────────────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────────────────────

async function generateThreeDrafts(systemPrompt, userMessage, isNewUser) {
  const extra = isNewUser
    ? "This is the first message from this user. Do NOT add a greeting or reservation link - those will be added automatically. Just answer their question."
    : "This is a returning user. Just answer their question.";

  const prompt =
    `Write 3 replies to this customer message, each in a different tone.\n` +
    `Format EXACTLY like this with no extra text:\n` +
    `TONE_A: [warm and friendly reply]\n` +
    `TONE_B: [sophisticated and cool reply]\n` +
    `TONE_C: [direct and concise reply]\n\n` +
    `Customer message: "${userMessage}"`;

  const response = await groq.chat.completions.create({
    model: "llama-3.3-70b-versatile",
    max_tokens: 600,
    messages: [
      { role: "system", content: systemPrompt + "\n\n" + extra },
      { role: "user", content: prompt },
    ],
  });

  const text = response.choices[0].message.content.trim();

  const extractTone = (label, nextLabel) => {
    const regex = nextLabel
      ? new RegExp(`${label}:\\s*(.+?)(?=${nextLabel}:)`, "s")
      : new RegExp(`${label}:\\s*(.+)$`, "s");
    const match = text.match(regex);
    return match ? match[1].trim() : "We would love to help. Please reach out for more details.";
  };

  return [
    extractTone("TONE_A", "TONE_B"),
    extractTone("TONE_B", "TONE_C"),
    extractTone("TONE_C", null),
  ];
}

async function getIGUsername(userId, accessToken) {
  try {
    const { data } = await axios.get(
      `https://graph.instagram.com/${userId}`,
      { params: { fields: "username", access_token: accessToken } }
    );
    return data.username || userId;
  } catch {
    return userId;
  }
}

async function sendIGReply(recipientId, text, accessToken) {
  await axios.post(
    `https://graph.instagram.com/v19.0/me/messages`,
    { recipient: { id: recipientId }, message: { text } },
    { params: { access_token: accessToken } }
  );
}

async function sendWhatsApp(body) {
  const accountSid = process.env.TWILIO_ACCOUNT_SID;
  const authToken = process.env.TWILIO_AUTH_TOKEN;
  const numbers = process.env.OWNER_WHATSAPP.split(",").map(n => n.trim());

  await Promise.all(numbers.map(number => {
    const params = new URLSearchParams({
      From: process.env.TWILIO_WHATSAPP_FROM,
      To: `whatsapp:${number}`,
      Body: body,
    });
    return axios.post(
      `https://api.twilio.com/2010-04-01/Accounts/${accountSid}/Messages.json`,
      params.toString(),
      {
        auth: { username: accountSid, password: authToken },
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
      }
    );
  }));
}

// ─────────────────────────────────────────────────────────────
app.listen(process.env.PORT || 3000, () => {
  console.log(`🚀 Agent running on port ${process.env.PORT || 3000}`);
  console.log(`📋 Accounts: ${Object.keys(ACCOUNTS).join(", ")}`);
});
