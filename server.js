/**
 * server.js  —  Jazz Bar Instagram DM Agent
 * ─────────────────────────────────────────────────────────────
 * Flow: IG DM → Groq draft → WhatsApp notify → Owner approves → Send
 * Features:
 *  - Greeting + reservation link for first message from new users
 *  - Auto-send draft after 5 min if no owner action
 *  - Multi-message queue with job IDs
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

const jobQueue = new Map();  // jobId → job
let jobCounter = 1;
const seenUsers = new Set(); // track users we've greeted before

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

  // Generate AI draft
  const draft = await generateDraft(account.systemPrompt, messageText, isNewUser);

  // Build final reply with greeting and reservation link for new users
  let finalDraft = draft;
  if (isNewUser) {
    finalDraft =
      `Hi, thank you for reaching out to Jazz Bar ! \n\n` +
      `${draft}\n\n` +
      ` You can also make a reservation directly here:\n${RESERVATION_LINK}`;
  }

  const jobId = jobCounter++;
  const job = {
    accountKey,
    account,
    senderId,
    username,
    messageText,
    draft: finalDraft,
    isNewUser,
    autoSendTimer: null,
  };

  jobQueue.set(jobId, job);

  // ── Auto-send after 5 minutes if no owner action ──
  job.autoSendTimer = setTimeout(async () => {
    if (!jobQueue.has(jobId)) return; // already handled
    console.log(`⏱️  Auto-sending draft for job #${jobId} (@${username})`);
    try {
      await sendIGReply(senderId, finalDraft, account.accessToken);
      if (isNewUser) seenUsers.add(senderId);
      await sendWhatsApp(`⏱️ *Auto-sent* reply to @${username} (job #${jobId}) after ${AUTO_REPLY_MINUTES} min inaction.`);
      console.log(`✅ Auto-sent to @${username}`);
    } catch (err) {
      console.error(`❌ Auto-send failed for #${jobId}:`, err.message);
    }
    jobQueue.delete(jobId);
  }, AUTO_REPLY_MINUTES * 60 * 1000);

  // ── Notify owner on WhatsApp ──
  const waBody =
    `${account.emoji} *${account.name} · New DM #${jobId}*${isNewUser ? " 🆕" : ""}\n` +
    `From: @${username}\n\n` +
    `💬 *Message:*\n"${messageText}"\n\n` +
    `📝 *AI draft:*\n"${finalDraft}"\n\n` +
    `⏱️ _Auto-sends in ${AUTO_REPLY_MINUTES} min if no action_\n\n` +
    `Reply:\n` +
    `*YES ${jobId}* to send now\n` +
    `*EDIT ${jobId} your new text* to customise\n` +
    `*NO ${jobId}* to skip`;

  await sendWhatsApp(waBody);
  console.log(`📱 Approval sent for job #${jobId} (@${username})${isNewUser ? " [NEW USER]" : ""}`);
}

// ─────────────────────────────────────────────────────────────
// WHATSAPP APPROVAL REPLY
// ─────────────────────────────────────────────────────────────

app.post("/whatsapp-reply", async (req, res) => {
  res.sendStatus(200);

  const incomingBody = (req.body.Body || "").trim();
  console.log(`📲 Owner replied: "${incomingBody}"`);

  const parts = incomingBody.split(" ");
  const command = parts[0].toUpperCase();
  const jobId = parseInt(parts[1]);

  if (isNaN(jobId)) {
    await sendWhatsApp("⚠️ Please include the job number.\nExamples:\nYES 1\nNO 1\nEDIT 1 your new text");
    return;
  }

  const job = jobQueue.get(jobId);
  if (!job) {
    await sendWhatsApp(`⚠️ Job #${jobId} not found — it may have already been sent or skipped.`);
    return;
  }

  // Cancel auto-send timer
  clearTimeout(job.autoSendTimer);

  if (command === "YES") {
    await sendIGReply(job.senderId, job.draft, job.account.accessToken);
    if (job.isNewUser) seenUsers.add(job.senderId);
    console.log(`✅ Sent approved draft to @${job.username}`);
    jobQueue.delete(jobId);

  } else if (command === "NO") {
    console.log(`🚫 Skipped reply to @${job.username}`);
    jobQueue.delete(jobId);

  } else if (command === "EDIT") {
    const editedText = parts.slice(2).join(" ").trim();
    if (editedText) {
      await sendIGReply(job.senderId, editedText, job.account.accessToken);
      if (job.isNewUser) seenUsers.add(job.senderId);
      console.log(`✏️  Sent edited reply to @${job.username}`);
      jobQueue.delete(jobId);
    } else {
      await sendWhatsApp(`⚠️ No text found. Format: EDIT ${jobId} your new message`);
    }

  } else {
    await sendWhatsApp("⚠️ Commands:\nYES [#]\nNO [#]\nEDIT [#] new text");
  }
});

// ─────────────────────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────────────────────

async function generateDraft(systemPrompt, userMessage, isNewUser) {
  const extra = isNewUser
    ? `This is the first message from this user. Do NOT add a greeting or reservation link — that will be added automatically. Just answer their question naturally.`
    : `This is a returning user. Just answer their question naturally.`;

  const response = await groq.chat.completions.create({
    model: "llama-3.3-70b-versatile",
    max_tokens: 300,
    messages: [
      { role: "system", content: systemPrompt + "\n\n" + extra },
      { role: "user", content: userMessage },
    ],
  });
  return response.choices[0].message.content.trim();
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
    {
      recipient: { id: recipientId },
      message: { text },
    },
    { params: { access_token: accessToken } }
  );
}

async function sendWhatsApp(body) {
  const accountSid = process.env.TWILIO_ACCOUNT_SID;
  const authToken = process.env.TWILIO_AUTH_TOKEN;

  const params = new URLSearchParams({
    From: process.env.TWILIO_WHATSAPP_FROM,
    To: `whatsapp:${process.env.OWNER_WHATSAPP}`,
    Body: body,
  });

  const { data } = await axios.post(
    `https://api.twilio.com/2010-04-01/Accounts/${accountSid}/Messages.json`,
    params.toString(),
    {
      auth: { username: accountSid, password: authToken },
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
    }
  );

  return data.sid;
}

// ─────────────────────────────────────────────────────────────
app.listen(process.env.PORT || 3000, () => {
  console.log(`🚀 Agent running on port ${process.env.PORT || 3000}`);
  console.log(`📋 Accounts: ${Object.keys(ACCOUNTS).join(", ")}`);
});
