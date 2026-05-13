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

  const draft = await generateDraft(account.systemPrompt, messageText, isNewUser);

  let finalDraft = draft;
  if (isNewUser) {
    finalDraft =
      `Thank you for reaching out to Jazz Bar Abu Dhabi.\n\n` +
      `${draft}\n\n` +
      `Reservations: ${RESERVATION_LINK}`;
  }

  const jobId = jobCounter++;
  const job = {
    accountKey, account, senderId, username,
    messageText, draft: finalDraft, isNewUser,
    autoSendTimer: null,
  };

  jobQueue.set(jobId, job);

  job.autoSendTimer = setTimeout(async () => {
    if (!jobQueue.has(jobId)) return;
    try {
      await sendIGReply(senderId, finalDraft, account.accessToken);
      if (isNewUser) seenUsers.add(senderId);
      console.log(`⏱️ Auto-sent to @${username}`);
    } catch (err) {
      console.error(`Auto-send failed:`, err.message);
    }
    jobQueue.delete(jobId);
  }, AUTO_REPLY_MINUTES * 60 * 1000);

  const waBody =
    `#${jobId} @${username}\n` +
    `"${messageText}"\n\n` +
    `${finalDraft}\n\n` +
    `YES ${jobId} / EDIT ${jobId} text / NO ${jobId}`;

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
    await sendWhatsApp("Format: YES 1 / NO 1 / EDIT 1 your text");
    return;
  }

  const job = jobQueue.get(jobId);
  if (!job) {
    await sendWhatsApp(`Job #${jobId} not found.`);
    return;
  }

  clearTimeout(job.autoSendTimer);

  if (command === "YES") {
    await sendIGReply(job.senderId, job.draft, job.account.accessToken);
    if (job.isNewUser) seenUsers.add(job.senderId);
    console.log(`✅ Sent to @${job.username}`);
    jobQueue.delete(jobId);

  } else if (command === "NO") {
    console.log(`🚫 Skipped #${jobId}`);
    jobQueue.delete(jobId);

  } else if (command === "EDIT") {
    const editedText = parts.slice(2).join(" ").trim();
    if (editedText) {
      await sendIGReply(job.senderId, editedText, job.account.accessToken);
      if (job.isNewUser) seenUsers.add(job.senderId);
      console.log(`✏️ Sent edited to @${job.username}`);
      jobQueue.delete(jobId);
    } else {
      await sendWhatsApp(`Format: EDIT ${jobId} your message`);
    }

  } else {
    await sendWhatsApp("Format: YES 1 / NO 1 / EDIT 1 your text");
  }
});

async function generateDraft(systemPrompt, userMessage, isNewUser) {
  const extra = isNewUser
    ? "First message from this user. Do NOT add greeting or reservation link. Just answer their question."
    : "Returning user. Just answer their question.";

  const response = await groq.chat.completions.create({
    model: "llama-3.3-70b-versatile",
    max_tokens: 200,
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
    { recipient: { id: recipientId }, message: { text } },
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

  await axios.post(
    `https://api.twilio.com/2010-04-01/Accounts/${accountSid}/Messages.json`,
    params.toString(),
    {
      auth: { username: accountSid, password: authToken },
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
    }
  );
}

app.listen(process.env.PORT || 3000, () => {
  console.log(`🚀 Agent running on port ${process.env.PORT || 3000}`);
  console.log(`📋 Accounts: ${Object.keys(ACCOUNTS).join(", ")}`);
});
