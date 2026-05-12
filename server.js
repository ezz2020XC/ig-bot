/**
 * server.js  —  Jazz Bar Instagram DM Agent
 * ─────────────────────────────────────────────────────────────
 * Flow: IG DM → Groq draft → WhatsApp notify → Owner approves → Send
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

// Queue of pending approvals — each DM gets a unique ID
// Owner replies with: YES 1, EDIT 1 new text, NO 1
const jobQueue = new Map();
let jobCounter = 1;

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
  const draft = await generateDraft(account.systemPrompt, messageText);

  const jobId = jobCounter++;
  jobQueue.set(jobId, { accountKey, account, senderId, username, messageText, draft });

  const waBody =
    `${account.emoji} *${account.name} · New DM #${jobId}*\n` +
    `From: @${username}\n\n` +
    `💬 *Message:*\n"${messageText}"\n\n` +
    `📝 *AI draft:*\n"${draft}"\n\n` +
    `Reply:\n` +
    `*YES ${jobId}* to send\n` +
    `*EDIT ${jobId} your new text* to customise\n` +
    `*NO ${jobId}* to skip`;

  await sendWhatsApp(waBody);
  console.log(`📱 Approval sent for job #${jobId} (@${username})`);
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
    console.log("⚠️  No job ID found in reply. Format: YES 1 / NO 1 / EDIT 1 new text");
    await sendWhatsApp("⚠️ Please include the job number. Example:\nYES 1\nNO 1\nEDIT 1 your new text");
    return;
  }

  const job = jobQueue.get(jobId);
  if (!job) {
    console.log(`⚠️  No job found for ID #${jobId}`);
    await sendWhatsApp(`⚠️ No pending message found for #${jobId}`);
    return;
  }

  if (command === "YES") {
    await sendIGReply(job.senderId, job.draft, job.account.accessToken);
    console.log(`✅ Sent approved draft to @${job.username}`);
    jobQueue.delete(jobId);

  } else if (command === "NO") {
    console.log(`🚫 Skipped reply to @${job.username}`);
    jobQueue.delete(jobId);

  } else if (command === "EDIT") {
    const editedText = parts.slice(2).join(" ").trim();
    if (editedText) {
      await sendIGReply(job.senderId, editedText, job.account.accessToken);
      console.log(`✏️  Sent edited reply to @${job.username}`);
      jobQueue.delete(jobId);
    } else {
      await sendWhatsApp(`⚠️ No text found. Format: EDIT ${jobId} your new message`);
    }

  } else {
    console.log("❓ Unrecognised command:", command);
    await sendWhatsApp("⚠️ Commands: YES [#] / NO [#] / EDIT [#] new text");
  }
});

// ─────────────────────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────────────────────

async function generateDraft(systemPrompt, userMessage) {
  const response = await groq.chat.completions.create({
    model: "llama-3.3-70b-versatile",
    max_tokens: 300,
    messages: [
      { role: "system", content: systemPrompt },
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
