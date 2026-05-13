/**
 * server.js  —  Jazz Bar Instagram DM Agent
 * ─────────────────────────────────────────────────────────────
 * Flow: IG DM → Groq draft → WhatsApp notify → Owner approves → Send
 * Features:
 *  - 2 tone options (A/B) per DM
 *  - Greeting + reservation link for new users
 *  - Auto-send option A after 5 min if no owner action
 *  - Multi-message queue with job IDs
 *  - No emojis in AI replies
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
    if (!accountEntry) continue;

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

async function handleDM(accountKey, account, senderId, messageText) {
  const username = await getIGUsername(senderId, account.accessToken);
  const isNewUser = !seenUsers.has(senderId);

  const [draftA, draftB] = await generateTwoDrafts(account.systemPrompt, messageText, isNewUser);

  const wrapDraft = (draft) => {
    if (!isNewUser) return draft;
    return (
      `Hey @${username}, thank you for reaching out to Jazz Bar!\n\n` +
      `${draft}\n\n` +
      `Reservations: ${RESERVATION_LINK}`
    );
  };

  const finalA = wrapDraft(draftA);
  const finalB = wrapDraft(draftB);

  const jobId = jobCounter++;
  const job = {
    accountKey, account, senderId, username, messageText,
    drafts: { A: finalA, B: finalB },
    isNewUser,
    autoSendTimer: null,
  };

  jobQueue.set(jobId, job);

  // Auto-send option A after 5 minutes if no action
  job.autoSendTimer = setTimeout(async () => {
    if (!jobQueue.has(jobId)) return;
    try {
      await sendIGReply(senderId, finalA, account.accessToken);
      if (isNewUser) seenUsers.add(senderId);
      await sendWhatsApp(`Auto-sent reply to @${username} (#${jobId})`);
      console.log(`⏱️ Auto-sent to @${username}`);
    } catch (err) {
      console.error(`Auto-send failed:`, err.message);
    }
    jobQueue.delete(jobId);
  }, AUTO_REPLY_MINUTES * 60 * 1000);

  const waBody =
    `#${jobId}${isNewUser ? " NEW" : ""} @${username}\n` +
    `"${messageText}"\n\n` +
    `Option A:\n${finalA}\n\n` +
    `Option B:\n${finalB}\n\n` +
    `A ${jobId} / B ${jobId} / EDIT ${jobId} text / NO ${jobId}\n` +
    `Auto-sends A in ${AUTO_REPLY_MINUTES} min`;

  await sendWhatsApp(waBody);
  console.log(`📱 Sent job #${jobId} to owner (@${username})`);
}

app.post("/whatsapp-reply", async (req, res) => {
  res.sendStatus(200);

  const incomingBody = (req.body.Body || "").trim();
  console.log(`📲 Owner replied: "${incomingBody}"`);

  const parts = incomingBody.split(" ");
  const command = parts[0].toUpperCase();
  const jobId = parseInt(parts[1]);

  if (isNaN(jobId)) {
    await sendWhatsApp("Format:\nA 1 / B 1 / NO 1\nEDIT 1 your text");
    return;
  }

  const job = jobQueue.get(jobId);
  if (!job) {
    await sendWhatsApp(`Job #${jobId} not found.`);
    return;
  }

  clearTimeout(job.autoSendTimer);

  if (command === "A" || command === "B") {
    const chosen = job.drafts[command];
    await sendIGReply(job.senderId, chosen, job.account.accessToken);
    if (job.isNewUser) seenUsers.add(job.senderId);
    console.log(`✅ Sent option ${command} to @${job.username}`);
    await sendWhatsApp(`Sent ${command} to @${job.username} (#${jobId})`);
    jobQueue.delete(jobId);

  } else if (command === "EDIT") {
    const editedText = parts.slice(2).join(" ").trim();
    if (editedText) {
      await sendIGReply(job.senderId, editedText, job.account.accessToken);
      if (job.isNewUser) seenUsers.add(job.senderId);
      console.log(`✏️ Sent custom reply to @${job.username}`);
      await sendWhatsApp(`Sent custom reply to @${job.username} (#${jobId})`);
      jobQueue.delete(jobId);
    } else {
      await sendWhatsApp(`Format: EDIT ${jobId} your message`);
    }

  } else if (command === "NO") {
    console.log(`🚫 Skipped #${jobId}`);
    await sendWhatsApp(`Skipped #${jobId}`);
    jobQueue.delete(jobId);

  } else {
    await sendWhatsApp("Format:\nA 1 / B 1 / NO 1\nEDIT 1 your text");
  }
});

async function generateTwoDrafts(systemPrompt, userMessage, isNewUser) {
  const extra = isNewUser
    ? "First message from this user. Do NOT add greeting or reservation link - added automatically. Just answer their question."
    : "Returning user. Just answer their question.";

  const prompt =
    `Write 2 replies to this customer message in 2 different tones.\n` +
    `Format EXACTLY like this:\n` +
    `TONE_A: [warm and friendly reply]\n` +
    `TONE_B: [sophisticated and cool reply]\n\n` +
    `Customer message: "${userMessage}"`;

  const response = await groq.chat.completions.create({
    model: "llama-3.3-70b-versatile",
    max_tokens: 400,
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
    extractTone("TONE_B", null),
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

  for (const number of numbers) {
    const params = new URLSearchParams({
      From: process.env.TWILIO_WHATSAPP_FROM,
      To: `whatsapp:${number}`,
      Body: body,
    });
    await axios.post(
      `https://api.twilio.com/2010-04-01/Accounts/${accountSid}/Messages.json`,
      params.toString(),
      {
        auth: { username: accountSid, password: authToken },
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
      }
    );
    if (numbers.length > 1) await new Promise(r => setTimeout(r, 500));
  }
}

app.listen(process.env.PORT || 3000, () => {
  console.log(`🚀 Agent running on port ${process.env.PORT || 3000}`);
  console.log(`📋 Accounts: ${Object.keys(ACCOUNTS).join(", ")}`);
});
