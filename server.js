import express from "express";
import pino from "pino";
import QRCode from "qrcode";
import {
  default as makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
} from "@whiskeysockets/baileys";

const PORT = process.env.PORT || 3000;
const TOKEN = process.env.SERVICE_TOKEN || "change-me";
const AUTH_DIR = process.env.AUTH_DIR || "/data/auth";

// ---- Firestore REST (no firebase npm package needed on Railway) ----
const FIREBASE_API_KEY = process.env.FIREBASE_API_KEY || "AIzaSyCsGDgxVWwZMg15Nmc__lCDj2DcfTH1MyM";
const FIREBASE_PROJECT_ID = process.env.FIREBASE_PROJECT_ID || "bahr-educational";
const FIRESTORE_BASE_URL = `https://firestore.googleapis.com/v1/projects/${FIREBASE_PROJECT_ID}/databases/(default)/documents`;

const logger = pino({ level: "warn" });
const app = express();
app.use(express.json({ limit: "1mb" }));

let sock = null;
let latestQR = null;
let connState = "disconnected";
let starting = false;
let lastError = null;
let lastUpdateAt = null;
let lastQrAt = null;
let lastRestartAt = null;
let lastInbound = null;
let lastActivation = null;
let activationSyncTimer = null;
const serviceStartedAt = Date.now();
const QR_TTL_MS = 5 * 60_000;

const activationPending = new Map();
const activationConfirmed = new Set();

// ---- Live chats store (built from Baileys events) ----
// Map<phone, { phone, name, jid, lastMessageAt }>
const liveChats = new Map();

function rememberChat({ jid, phone, name, ts }) {
  const p = normalizePhone(phone || phoneFromJid(jid));
  if (!p) return;
  const prev = liveChats.get(p) || {};
  const nextTs = Number(ts || prev.lastMessageAt || 0);
  liveChats.set(p, {
    phone: p,
    jid: jid || prev.jid || jidFor(p),
    name: name || prev.name || null,
    lastMessageAt: nextTs,
  });
}

function rememberFromMessage(msg) {
  if (!msg) return;
  const jid = msg.key?.remoteJid;
  if (!jid || jid.endsWith("@g.us") || jid === "status@broadcast") return;
  const senderPn = msg.key?.senderPn || msg.key?.participantPn || "";
  const phone = senderPn || phoneFromJid(jid);
  const name = msg.pushName || null;
  const ts = timestampToMs(msg.messageTimestamp);
  rememberChat({ jid, phone, name, ts });
}

function touch(error = null) {
  lastUpdateAt = new Date().toISOString();
  if (error) lastError = String(error?.message || error);
}

function qrIsFresh() {
  if (!latestQR || !lastQrAt) return false;
  return Date.now() - Date.parse(lastQrAt) < QR_TTL_MS;
}

function jidFor(to) {
  const phone = String(to).replace(/[^\d]/g, "");
  return phone.includes("@") ? phone : `${phone}@s.whatsapp.net`;
}
function phoneFromJid(jid) {
  return String(jid || "").replace(/@.*$/, "").replace(/[^\d]/g, "");
}

function normalizePhone(raw) {
  let phone = String(raw || "").replace(/\D/g, "");
  if (!phone) return "";
  if (phone.startsWith("00")) phone = phone.slice(2);
  if (phone.startsWith("968")) return phone;
  if (phone.startsWith("0")) phone = phone.slice(1);
  return phone.length === 8 ? `968${phone}` : phone;
}

function unwrapMessage(message) {
  let current = message;
  for (let i = 0; i < 8; i += 1) {
    const next =
      current?.ephemeralMessage?.message ||
      current?.viewOnceMessage?.message ||
      current?.viewOnceMessageV2?.message ||
      current?.viewOnceMessageV2Extension?.message ||
      current?.documentWithCaptionMessage?.message;
    if (!next) break;
    current = next;
  }
  return current || message || {};
}

function parseNativeFlowText(message) {
  const paramsJson = message?.interactiveResponseMessage?.nativeFlowResponseMessage?.paramsJson;
  if (!paramsJson) return "";
  try {
    const params = JSON.parse(paramsJson);
    return params?.display_text || params?.title || params?.id || params?.name || "";
  } catch {
    return "";
  }
}

function extractMessageText(message) {
  const m = unwrapMessage(message);
  return String(
    m.conversation ||
    m.extendedTextMessage?.text ||
    m.imageMessage?.caption ||
    m.videoMessage?.caption ||
    m.buttonsResponseMessage?.selectedDisplayText ||
    m.buttonsResponseMessage?.selectedButtonId ||
    m.templateButtonReplyMessage?.selectedDisplayText ||
    m.templateButtonReplyMessage?.selectedId ||
    m.listResponseMessage?.title ||
    m.listResponseMessage?.singleSelectReply?.selectedRowId ||
    m.interactiveResponseMessage?.body?.text ||
    parseNativeFlowText(m) ||
    ""
  ).trim();
}

function isActivationYes(text) {
  const normalized = String(text || "")
    .normalize("NFKD")
    .replace(/[\u064B-\u065F\u0670\u200C\u200Dـ*~_`]/g, "")
    .replace(/[إأآ]/g, "ا")
    .replace(/\s+/g, " ")
    .trim();
  return normalized === "نعم" || /(^|[\s,.!?؟،؛:\-])نعم([\s,.!?؟،؛:\-]|$)/u.test(normalized) || /^yes$/i.test(normalized) || normalized === "ACTIVATE_YES";
}

function firestoreValue(value) {
  if (value === "SERVER_TIMESTAMP") return { timestampValue: new Date().toISOString() };
  if (typeof value === "number") return Number.isInteger(value) ? { integerValue: value } : { doubleValue: value };
  if (typeof value === "boolean") return { booleanValue: value };
  return { stringValue: String(value ?? "") };
}

function firestoreDocument(fields) {
  return {
    fields: Object.fromEntries(
      Object.entries(fields).filter(([, value]) => value !== undefined).map(([key, value]) => [key, firestoreValue(value)])
    ),
  };
}

async function firestoreRequest(path, { method = "PATCH", body } = {}) {
  const url = `${FIRESTORE_BASE_URL}/${path}?key=${encodeURIComponent(FIREBASE_API_KEY)}`;
  const response = await fetch(url, {
    method,
    headers: { "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!response.ok) throw new Error(`Firestore ${response.status}: ${await response.text()}`);
  return response.json();
}

async function mergeFirestoreDoc(path, fields) {
  const keys = Object.keys(fields).filter((key) => fields[key] !== undefined);
  const query = keys.map((key) => `updateMask.fieldPaths=${encodeURIComponent(key)}`).join("&");
  const url = `${FIRESTORE_BASE_URL}/${path}?key=${encodeURIComponent(FIREBASE_API_KEY)}${query ? `&${query}` : ""}`;
  const response = await fetch(url, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(firestoreDocument(fields)),
  });
  if (!response.ok) throw new Error(`Firestore ${response.status}: ${await response.text()}`);
  return response.json();
}

async function incrementFirestoreField(path, fieldPath, amount = 1) {
  const url = `${FIRESTORE_BASE_URL}:commit?key=${encodeURIComponent(FIREBASE_API_KEY)}`;
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      writes: [{
        transform: {
          document: `projects/${FIREBASE_PROJECT_ID}/databases/(default)/documents/${path}`,
          fieldTransforms: [{ fieldPath, increment: { integerValue: amount } }],
        },
      }],
    }),
  });
  if (!response.ok) throw new Error(`Firestore ${response.status}: ${await response.text()}`);
  return response.json();
}

function safeDocId(value) {
  return encodeURIComponent(normalizePhone(value) || String(value)).replaceAll("%", "_");
}

function timestampToMs(value) {
  const n = Number(value || 0);
  if (!n) return 0;
  return n > 10_000_000_000 ? n : n * 1000;
}

function shouldProcessIncoming(msg) {
  if (!msg?.message || msg.key?.fromMe) return false;
  const ts = timestampToMs(msg.messageTimestamp);
  return !ts || ts >= serviceStartedAt - 5 * 60 * 1000;
}

// ---- Firestore helpers ----
async function logMessage({ phone, direction, text, parentName }) {
  if (!phone) return;
  try {
    await firestoreRequest(`conversations/${safeDocId(phone)}/messages`, {
      method: "POST",
      body: firestoreDocument({
      direction,                 // "in" | "out"
      text: String(text || ""),
      createdAt: "SERVER_TIMESTAMP",
      }),
    });
    const patch = {
      phone,
      lastMessage: String(text || ""),
      lastDirection: direction,
      lastMessageAt: "SERVER_TIMESTAMP",
    };
    if (parentName) patch.parentName = parentName;
    const conversationPath = `conversations/${safeDocId(phone)}`;
    await mergeFirestoreDoc(conversationPath, patch);
    if (direction === "in") await incrementFirestoreField(conversationPath, "unread", 1);
  } catch (e) {
    console.error("logMessage failed", e?.message || e);
  }
}

async function setParentActivation({ phone, parentName, activated }) {
  const normalizedPhone = normalizePhone(phone);
  if (!normalizedPhone) return;
  try {
    const patch = {
      phone: normalizedPhone,
      activated: !!activated,
    };
    if (parentName) patch.parentName = parentName;
    if (activated) patch.activatedAt = "SERVER_TIMESTAMP";
    await mergeFirestoreDoc(`parents/${safeDocId(normalizedPhone)}`, patch);
  } catch (e) {
    console.error("setParentActivation failed", e?.message || e);
  }
}

async function getParentDoc(phone) {
  const normalizedPhone = normalizePhone(phone);
  if (!normalizedPhone) return null;
  try {
    const url = `${FIRESTORE_BASE_URL}/parents/${safeDocId(normalizedPhone)}?key=${encodeURIComponent(FIREBASE_API_KEY)}`;
    const r = await fetch(url);
    if (!r.ok) return null;
    const json = await r.json();
    const fields = json?.fields || {};
    return {
      phone: normalizedPhone,
      parentName: fields.parentName?.stringValue || null,
      activated: !!fields.activated?.booleanValue,
    };
  } catch {
    return null;
  }
}

function firestoreString(fields, key) {
  const value = fields?.[key];
  return String(value?.stringValue || value?.integerValue || value?.doubleValue || "");
}

function docIdFromName(name) {
  return String(name || "").split("/").pop() || "";
}

async function listConversations() {
  try {
    const url = `${FIRESTORE_BASE_URL}/conversations?key=${encodeURIComponent(FIREBASE_API_KEY)}`;
    const r = await fetch(url);
    if (!r.ok) return [];
    const json = await r.json();
    return (json?.documents || []).map((document) => {
      const fields = document?.fields || {};
      return {
        phone: normalizePhone(firestoreString(fields, "phone") || docIdFromName(document?.name)),
        parentName: firestoreString(fields, "parentName") || null,
        lastDirection: firestoreString(fields, "lastDirection"),
        lastMessage: firestoreString(fields, "lastMessage"),
      };
    });
  } catch (e) {
    console.error("listConversations failed", e?.message || e);
    return [];
  }
}

async function confirmActivation({ phone, jid, parentName }) {
  const normalizedPhone = normalizePhone(phone);
  if (!normalizedPhone) return;
  const existing = await getParentDoc(normalizedPhone);
  const alreadyActivated = !!existing?.activated;
  const name = parentName || existing?.parentName || null;

  activationConfirmed.add(normalizedPhone);
  if (jid) activationConfirmed.add(jid);
  await setParentActivation({ phone: normalizedPhone, parentName: name, activated: true });

  const reply = alreadyActivated
    ? "✅ اشتراككم في نظام «غيابي» مفعّل بالفعل.\nستصلكم إشعارات حضور وغياب أبنائكم بإذن الله."
    : "✅ تم تفعيل اشتراككم في نظام «غيابي» بنجاح.\nستصلكم إشعارات حضور وغياب أبنائكم بإذن الله.";

  try {
    await sock.sendMessage(jid || jidFor(normalizedPhone), { text: reply });
    await logMessage({ phone: normalizedPhone, direction: "out", text: reply, parentName: name });
    lastActivation = { phone: normalizedPhone, jid: jid || jidFor(normalizedPhone), at: new Date().toISOString(), replied: true, alreadyActivated };
  } catch (e) {
    console.error("auto-reply send failed", e?.message || e);
    lastActivation = { phone: normalizedPhone, jid: jid || jidFor(normalizedPhone), at: new Date().toISOString(), replied: false, error: String(e?.message || e) };
  }
}

async function syncActivationRepliesFromConversations() {
  if (connState !== "open" || !sock) return;
  const rows = await listConversations();
  for (const row of rows) {
    if (!row.phone || row.lastDirection !== "in" || !isActivationYes(row.lastMessage)) continue;
    await confirmActivation({ phone: row.phone, jid: jidFor(row.phone), parentName: row.parentName });
  }
}

async function start() {
  if (starting) return;
  starting = true;
  if (!qrIsFresh()) connState = "starting";
  touch();
  try {
    const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
    const { version } = await fetchLatestBaileysVersion();

    sock = makeWASocket({
      version, auth: state, logger,
      printQRInTerminal: false,
      browser: ["Ghiyabi", "Chrome", "1.0"],
    });

    sock.ev.on("creds.update", saveCreds);

    // Initial history sync: WhatsApp pushes existing chats/contacts after login.
    sock.ev.on("messaging-history.set", (h) => {
      try {
        for (const c of h?.chats || []) {
          if (!c?.id || c.id.endsWith("@g.us") || c.id === "status@broadcast") continue;
          rememberChat({
            jid: c.id,
            phone: phoneFromJid(c.id),
            name: c.name || null,
            ts: timestampToMs(c.conversationTimestamp),
          });
        }
        for (const ct of h?.contacts || []) {
          if (!ct?.id || !ct.id.endsWith?.("@s.whatsapp.net")) continue;
          rememberChat({ jid: ct.id, phone: phoneFromJid(ct.id), name: ct.notify || ct.name || null });
        }
        for (const m of h?.messages || []) rememberFromMessage(m);
      } catch (e) {
        console.error("messaging-history.set handler error", e?.message || e);
      }
    });

    sock.ev.on("chats.upsert", (chats) => {
      for (const c of chats || []) {
        if (!c?.id || c.id.endsWith?.("@g.us") || c.id === "status@broadcast") continue;
        rememberChat({ jid: c.id, phone: phoneFromJid(c.id), name: c.name || null, ts: timestampToMs(c.conversationTimestamp) });
      }
    });
    sock.ev.on("contacts.upsert", (cts) => {
      for (const ct of cts || []) {
        if (!ct?.id || !ct.id.endsWith?.("@s.whatsapp.net")) continue;
        rememberChat({ jid: ct.id, phone: phoneFromJid(ct.id), name: ct.notify || ct.name || null });
      }
    });

    sock.ev.on("connection.update", async (u) => {
      const { connection, lastDisconnect, qr } = u;
      touch(lastDisconnect?.error || null);
      if (connection === "connecting" && !qrIsFresh()) connState = "connecting";
      if (qr) {
        latestQR = await QRCode.toDataURL(qr);
        lastQrAt = new Date().toISOString();
        connState = "qr";
        lastError = null;
      }
      if (connection === "open") {
        latestQR = null;
        lastQrAt = null;
        connState = "open";
        if (!activationSyncTimer) {
          activationSyncTimer = setInterval(() => syncActivationRepliesFromConversations().catch((e) => console.error("activation sync failed", e?.message || e)), 15_000);
        }
        syncActivationRepliesFromConversations().catch((e) => console.error("activation sync failed", e?.message || e));
      }
      if (connection === "close") {
        if (activationSyncTimer) { clearInterval(activationSyncTimer); activationSyncTimer = null; }
        const code = lastDisconnect?.error?.output?.statusCode;
        const loggedOut = code === DisconnectReason.loggedOut;
        if (loggedOut) {
          connState = "disconnected"; latestQR = null; lastQrAt = null;
        } else {
          connState = qrIsFresh() ? "qr" : "connecting";
          if (!qrIsFresh()) { latestQR = null; lastQrAt = null; }
        }
        if (loggedOut) {
          try { const fs = await import("fs/promises"); await fs.rm(AUTH_DIR, { recursive: true, force: true }); } catch {}
        }
        setTimeout(() => { starting = false; start(); }, 2000);
      }
    });

    sock.ev.on("messages.upsert", async (m) => {
      try {
        for (const msg of m.messages || []) {
          // Track every direct chat (in or out) for the /contacts endpoint.
          rememberFromMessage(msg);
          if (!shouldProcessIncoming(msg)) continue;
          const jid = msg.key.remoteJid;
          if (!jid || jid.endsWith("@g.us") || jid === "status@broadcast") continue;

          const trimmed = extractMessageText(msg.message);
          if (!trimmed) continue;

          // Prefer the real phone number even when the JID is a LID
          const senderPn = msg.key?.senderPn || msg.key?.participantPn || "";
          const phone = normalizePhone(senderPn || phoneFromJid(jid));
          if (!phone) continue;

          // Try to find pending activation by phone or by jid
          let pending = activationPending.get(phone) || activationPending.get(jid);
          let parentName = pending?.parentName || null;

          // Fallback: look up parent doc in Firestore (covers service restart / LID mismatch)
          if (!parentName) {
            const doc = await getParentDoc(phone);
            if (doc?.parentName) parentName = doc.parentName;
          }

          lastInbound = { phone, jid, text: trimmed, at: new Date().toISOString() };
          console.log("incoming WhatsApp message", { phone, jid, text: trimmed });

          // Log inbound message
          await logMessage({ phone, direction: "in", text: trimmed, parentName });

          const looksLikeYes = isActivationYes(trimmed);

          if (looksLikeYes) {
            await confirmActivation({ phone, jid, parentName });
          }
        }
      } catch (e) {
        console.error("messages.upsert handler error", e?.message || e);
      }
    });
  } catch (e) {
    touch(e);
    connState = "error";
    console.error("start error", e);
    setTimeout(() => { starting = false; start(); }, 3000);
  }
}

async function restart() {
  lastRestartAt = new Date().toISOString();
  try { await sock?.logout(); } catch {}
  try { sock?.end?.(undefined); } catch {}
  try { const fs = await import("fs/promises"); await fs.rm(AUTH_DIR, { recursive: true, force: true }); } catch {}
  sock = null; latestQR = null; lastQrAt = null; connState = "restarting"; starting = false;
  start();
}

function auth(req, res, next) {
  const t = req.headers.authorization?.replace(/^Bearer\s+/i, "");
  if (t !== TOKEN) return res.status(401).json({ error: "unauthorized" });
  next();
}

app.get("/", (_req, res) => res.json({ ok: true, state: connState }));
app.get("/status", auth, (_req, res) => {
  const hasQR = qrIsFresh();
  if (!hasQR && latestQR) { latestQR = null; lastQrAt = null; if (connState === "qr") connState = "disconnected"; }
  res.json({ state: connState, hasQR, qr: hasQR ? latestQR : null, lastError, lastUpdateAt, lastQrAt, lastRestartAt, starting, lastInbound, lastActivation });
});
app.get("/qr", auth, (_req, res) => {
  if (!qrIsFresh()) return res.status(404).json({ error: "no_qr", state: connState, lastError, lastUpdateAt });
  res.json({ qr: latestQR, state: connState, lastQrAt });
});
app.post("/logout", auth, async (_req, res) => { await restart(); res.json({ ok: true, restarted: true }); });
app.post("/restart", auth, async (_req, res) => { await restart(); res.json({ ok: true }); });

app.post("/send", auth, async (req, res) => {
  try {
    const { to, message, parentName, logConversation, imageUrl } = req.body || {};
    if (!to || (!message && !imageUrl)) return res.status(400).json({ error: "missing_to_or_message" });
    if (connState !== "open") return res.status(503).json({ error: "not_connected", state: connState });
    const jid = jidFor(to);
    let r;
    if (imageUrl) {
      r = await sock.sendMessage(jid, { image: { url: String(imageUrl) }, caption: message ? String(message) : undefined });
    } else {
      r = await sock.sendMessage(jid, { text: String(message) });
    }
    if (logConversation !== false) {
      const logText = imageUrl ? `[صورة] ${message || ""}`.trim() : String(message || "");
      await logMessage({ phone: phoneFromJid(jid), direction: "out", text: logText, parentName });
    }
    res.json({ ok: true, id: r?.key?.id });
  } catch (e) {
    res.status(500).json({ ok: false, error: e?.message || "send_failed" });
  }
});

app.post("/send-activation", auth, async (req, res) => {
  try {
    const { to, parentName } = req.body || {};
    if (!to) return res.status(400).json({ error: "missing_to" });
    if (connState !== "open") return res.status(503).json({ error: "not_connected", state: connState });

    const name = (parentName && String(parentName).trim()) || "ولي الأمر";
    const jid = jidFor(to);
    const phone = normalizePhone(phoneFromJid(jid));

    const bodyText =
      "السلام عليكم ورحمة الله وبركاته،\n\n" +
      `إلى الفاضل: ${name}\n\n` +
      "نود إعلامكم بأنه تم إرسال هذه الرسالة لتأكيد تفعيل نظام «غيابي»، " +
      "والذي يتيح لكم استقبال إشعارات غياب أبنائكم ومتابعة حضورهم بشكل مستمر.\n\n" +
      "هل تودون تفعيل نظام «غيابي» لتصلكم إشعارات الحضور والغياب بشكل مباشر؟";

    const pendingEntry = { sentAt: Date.now(), parentName: name };
    activationPending.set(jid, pendingEntry);
    if (phone) activationPending.set(phone, pendingEntry);
    activationConfirmed.delete(jid);
    if (phone) activationConfirmed.delete(phone);
    await setParentActivation({ phone, parentName: name, activated: false });

    const fullText = bodyText + "\n\n👈 للتفعيل، يكفي الرد على هذه الرسالة بكلمة: نعم\n\nوسيتم تفعيل اشتراككم تلقائيًا خلال ثوانٍ.";

    const r = await sock.sendMessage(jid, { text: fullText });
    await logMessage({ phone, direction: "out", text: fullText, parentName: name });
    res.json({ ok: true, id: r?.key?.id });
  } catch (e) {
    res.status(500).json({ ok: false, error: e?.message || "send_failed" });
  }
});

app.post("/sync-activation-replies", auth, async (_req, res) => {
  try {
    if (connState !== "open") return res.status(503).json({ ok: false, error: "not_connected", state: connState });
    await syncActivationRepliesFromConversations();
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ ok: false, error: e?.message || "sync_failed" });
  }
});

// Live contacts from the currently-connected WhatsApp account (Baileys store).
// Returns ONLY direct (1:1) chats — not groups, not status broadcast.
app.get("/contacts", auth, (_req, res) => {
  if (connState !== "open") {
    return res.status(503).json({ ok: false, error: "not_connected", state: connState, contacts: [] });
  }
  const contacts = Array.from(liveChats.values())
    .filter((c) => c.phone)
    .sort((a, b) => (b.lastMessageAt || 0) - (a.lastMessageAt || 0))
    .map((c) => ({ phone: c.phone, name: c.name || null, lastMessageAt: c.lastMessageAt || 0 }));
  res.json({ ok: true, state: connState, count: contacts.length, contacts });
});

app.listen(PORT, () => console.log(`WhatsApp service on :${PORT}`));
start().catch((e) => { console.error(e); process.exit(1); });
