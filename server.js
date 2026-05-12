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

// Pending approvals: Map<whatsappMsgId, { account, senderId, username, draft }>
const pending = new Map();

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

  const waBody =
    `${account.emoji} *${account.name} · New DM*\n` +
    `From: @${username}\n\n` +
    `💬 *Message:*\n"${messageText}"\n\n` +
    `📝 *AI draft:*\n"${draft}"\n\n` +
    `Reply *YES* to send  |  *EDIT your new text*  |  *NO* to skip`;

  const waMsgSid = await sendWhatsApp(waBody);
  pending.set(waMsgSid, { accountKey, account, senderId, username, messageText, draft });
  console.log(`📱 Approval sent to owner. SID: ${waMsgSid}`);
}

// ─────────────────────────────────────────────────────────────
// WHATSAPP APPROVAL REPLY
// ─────────────────────────────────────────────────────────────

app.post("/whatsapp-reply", async (req, res) => {
  res.sendStatus(200);

  const incomingBody = (req.body.Body || "").trim();
  const originalSid = req.body.OriginalRepliedMessageSid;

  const job = pending.get(originalSid);
  if (!job) {
    console.log("⚠️  No pending job for SID:", originalSid);
    return;
  }

  const upper = incomingBody.toUpperCase();

  if (upper === "YES") {
    await sendIGReply(job.senderId, job.draft, job.account.accessToken);
    console.log(`✅ Sent approved draft to @${job.username}`);
    pending.delete(originalSid);

  } else if (upper === "NO") {
    console.log(`🚫 Skipped reply to @${job.username}`);
    pending.delete(originalSid);

  } else if (upper.startsWith("EDIT ")) {
    const editedText = incomingBody.slice(5).trim();
    if (editedText) {
      await sendIGReply(job.senderId, editedText, job.account.accessToken);
      console.log(`✏️  Sent edited reply to @${job.username}`);
      pending.delete(originalSid);
    }

  } else {
    console.log("❓ Unrecognised reply:", incomingBody);
  }
});

// ─────────────────────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────────────────────

async function generateDraft(systemPrompt, userMessage) {
  const response = await groq.chat.completions.create({
    model: "llama3-8b-8192",
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
