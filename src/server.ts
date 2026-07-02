// SSR polyfill: supabase browser client references localStorage at module scope.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
if (typeof (globalThis as any).localStorage === "undefined") {
  const store = new Map<string, string>();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (globalThis as any).localStorage = {
    getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
    setItem: (k: string, v: string) => void store.set(k, String(v)),
    removeItem: (k: string) => void store.delete(k),
    clear: () => store.clear(),
    key: (i: number) => Array.from(store.keys())[i] ?? null,
    get length() {
      return store.size;
    },
  };
}

import "./lib/error-capture";

import { consumeLastCapturedError } from "./lib/error-capture";
import { renderErrorPage } from "./lib/error-page";
import { createClient } from "@supabase/supabase-js";
import crypto from "crypto";
// Groq API integration (replacing Gemini)

// Interfaces for Telegram Auth Session
interface AuthSession {
  token: string;
  telegramId?: number;
  username?: string;
  firstName?: string;
  lastName?: string;
  chatId?: number;
  otp?: string;
  status: "pending" | "otp_sent" | "verified";
  createdAt: number;
}

const authSessions = new Map<string, AuthSession>();
let webhookRegistered = false;

// Cleanup expired sessions every minute
if (typeof globalThis !== "undefined") {
  setInterval(() => {
    const now = Date.now();
    for (const [token, session] of authSessions.entries()) {
      if (now - session.createdAt > 10 * 60 * 1000) {
        // 10 minutes expiry
        authSessions.delete(token);
      }
    }
  }, 60 * 1000);
}

const AI_URL = "https://ai.gateway.lovable.dev/v1/chat/completions";
const OFFICIAL_GROUP_URL = "https://t.me/telegram";

async function deriveSecret(apiKey: string): Promise<string> {
  const data = new TextEncoder().encode(`telegram-webhook:${apiKey}`);
  const digest = await globalThis.crypto.subtle.digest("SHA-256", data);
  return Buffer.from(digest)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

function safeEq(a: string | null, b: string): boolean {
  if (!a || a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}

async function tgCall(path: string, body: unknown, lovKey: string, tgKey: string) {
  return fetch(`https://api.telegram.org/bot${tgKey}/${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
}

async function fetchUserPhotoUrl(
  userId: number,
  lovKey: string,
  tgKey: string,
): Promise<string | null> {
  try {
    const r = await tgCall("getUserProfilePhotos", { user_id: userId, limit: 1 }, lovKey, tgKey);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const d = (await r.json()) as any;
    const fileId = d?.result?.photos?.[0]?.[0]?.file_id;
    if (!fileId) return null;
    const f = await tgCall("getFile", { file_id: fileId }, lovKey, tgKey);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const fd = (await f.json()) as any;
    const path = fd?.result?.file_path;
    if (!path) return null;
    return `/api/telegram-file/${path}`;
  } catch (_e) {
    return null;
  }
}

async function aiReplyWithHistory(
  conversationId: string,
  userText: string,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  adminClient: any,
  lovKey: string,
): Promise<string | null> {
  let isQuotaExceeded = false;
  try {
    // Fetch last 10 messages of the conversation for rich context
    const { data: recentMessages } = await adminClient
      .from("messages")
      .select("direction, content")
      .eq("conversation_id", conversationId)
      .order("created_at", { ascending: false })
      .limit(10);

    const history = (recentMessages || []).reverse();

    if (process.env.GROQ_API_KEY) {
      try {
        console.log(`[Groq] Generating context-aware reply using llama-3.3-70b-versatile`);

        const response = await fetch("https://api.groq.com/openai/v1/chat/completions", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${process.env.GROQ_API_KEY}`,
          },
          body: JSON.stringify({
            model: "llama-3.3-70b-versatile",
            messages: [
              {
                role: "system",
                content:
                  "You are an exceptionally friendly, sweet, and conversational support companion. Keep chatting with the user continuously to build a friendly, warm, and comfortable relationship. Talk to them in the same language they use (e.g., Hindi, Hinglish, English). CRITICAL MANDATES: 1. NEVER refer the user to a human agent, and NEVER say 'एक ह्यूमन एजेंट जल्द ही आपसे संपर्क करेगा' or 'human agent will follow up'. Keep the conversation active yourself! 2. If the user asks for image editing, photo modifications, coding, programming, writing scripts, software development, or any technical coding tasks, you must politely but firmly refuse (mana kar do) in a sweet way, stating that you cannot edit images or write code, but you are always here to chat and help with other friendly talks. 3. Keep your replies sweet, friendly, and under 80 words.",
              },
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              ...history.map((m: any) => ({
                role: m.direction === "outgoing" ? "assistant" : "user",
                content: m.content || "",
              })),
              { role: "user", content: userText },
            ],
            temperature: 0.7,
            max_tokens: 256,
          }),
        });

        if (!response.ok) {
          const errText = await response.text();
          throw new Error(`Groq API error (status ${response.status}): ${errText}`);
        }

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const data = (await response.json()) as any;
        const reply = data.choices?.[0]?.message?.content?.trim();
        if (reply) {
          return reply;
        }
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } catch (groqError: any) {
        const errMsg = String(groqError?.message || groqError);
        console.error("[Groq AI Auto-Reply Error]:", groqError);
        if (
          errMsg.includes("RESOURCE_EXHAUSTED") ||
          errMsg.includes("429") ||
          errMsg.includes("quota") ||
          errMsg.includes("limit")
        ) {
          isQuotaExceeded = true;
        }
        console.log("[Groq] Falling back to Lovable gateway API due to error");
      }
    }

    // Try Lovable gateway fallback
    console.log(`[Groq/Lovable] Generating reply using Lovable gateway API`);
    const r = await fetch(AI_URL, {
      method: "POST",
      headers: { Authorization: `Bearer ${lovKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "google/gemini-2.5-flash",
        messages: [
          {
            role: "system",
            content:
              "You are an exceptionally friendly, sweet, and conversational support companion. Keep chatting with the user continuously to build a friendly, warm, and comfortable relationship. Talk to them in the same language they use (e.g., Hindi, Hinglish, English). CRITICAL MANDATES: 1. NEVER refer the user to a human agent, and NEVER say 'एक ह्यूमन एजेंट जल्द ही आपसे संपर्क करेगा' or 'human agent will follow up'. Keep the conversation active yourself! 2. If the user asks for image editing, photo modifications, coding, programming, writing scripts, software development, or any technical coding tasks, you must politely but firmly refuse (mana kar do) in a sweet way, stating that you cannot edit images or write code, but you are always here to chat and help with other friendly talks. 3. Keep your replies sweet, friendly, and under 80 words.",
          },
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          ...history.map((m: any) => ({
            role: m.direction === "outgoing" ? "assistant" : "user",
            content: m.content || "",
          })),
          { role: "user", content: userText },
        ],
      }),
    });
    if (r.ok) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const d = (await r.json()) as any;
      return d?.choices?.[0]?.message?.content ?? null;
    } else {
      const responseText = await r.text();
      console.error(`[Lovable Gateway Error]: Status ${r.status}, response:`, responseText);
      if (
        r.status === 429 ||
        responseText.includes("RESOURCE_EXHAUSTED") ||
        responseText.includes("quota")
      ) {
        isQuotaExceeded = true;
      }
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } catch (error: any) {
    console.error("[Groq/Lovable AI Auto-Reply Error]:", error);
    const errMsg = String(error?.message || error);
    if (
      errMsg.includes("RESOURCE_EXHAUSTED") ||
      errMsg.includes("429") ||
      errMsg.includes("quota") ||
      errMsg.includes("limit")
    ) {
      isQuotaExceeded = true;
    }
  }

  // If we couldn't generate a reply and it was a quota exhaustion or general failure, insert a helpful system message in the chat
  try {
    const { data: profiles } = await adminClient.from("profiles").select("user_id");
    for (const p of profiles ?? []) {
      const errorLabel = isQuotaExceeded
        ? "⚠️ [Bot Error]: The Groq API quota limit (429) was reached. Please reply to this user manually."
        : "⚠️ [Bot Error]: The Groq AI auto-reply could not be generated due to an error. Please reply manually.";

      await adminClient.from("messages").insert({
        conversation_id: conversationId,
        owner_user_id: p.user_id,
        direction: "outgoing",
        content: errorLabel,
        seen: false,
      });
    }
  } catch (dbErr) {
    console.error("Failed to insert AI failure notification message in database:", dbErr);
  }

  return null;
}

async function registerTelegramWebhook(appUrl: string) {
  const telegramApiKey = process.env.TELEGRAM_API_KEY;
  if (!telegramApiKey) {
    console.warn("[Telegram] TELEGRAM_API_KEY not set, cannot register webhook");
    return;
  }

  const webhookUrl = `${appUrl}/api/telegram-webhook`;
  console.log(`[Telegram] Registering webhook to: ${webhookUrl}`);

  try {
    const secretToken = await deriveSecret(telegramApiKey);
    const r = await fetch(`https://api.telegram.org/bot${telegramApiKey}/setWebhook`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        url: webhookUrl,
        secret_token: secretToken,
      }),
    });
    const d = await r.json();
    console.log("[Telegram] Webhook registration response:", d);
  } catch (error) {
    console.error("[Telegram] Error registering webhook:", error);
  }
}

// Global variable to track long polling status across server restarts in dev
declare global {
  var telegramPollingStarted: boolean | undefined;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function handleTelegramUpdate(update: any) {
  const TELEGRAM_API_KEY = process.env.TELEGRAM_API_KEY;
  const LOVABLE_API_KEY = process.env.LOVABLE_API_KEY || "placeholder_lovable_key";
  const SUPABASE_URL = process.env.SUPABASE_URL || "https://ybsivojduiwcuetdcuov.supabase.co";
  const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!TELEGRAM_API_KEY || !SUPABASE_URL || !SERVICE_KEY) {
    console.warn("[Telegram Webhook] Server misconfigured, skipping update");
    return;
  }

  const admin = createClient(SUPABASE_URL, SERVICE_KEY);

  if (update.callback_query) {
    await tgCall(
      "answerCallbackQuery",
      { callback_query_id: update.callback_query.id },
      LOVABLE_API_KEY,
      TELEGRAM_API_KEY,
    );
    return;
  }

  if (update.message_reaction) {
    const reactionUpdate = update.message_reaction;
    const chatId = reactionUpdate.chat.id;
    const messageId = reactionUpdate.message_id;
    const newReactions = reactionUpdate.new_reaction || [];
    const emoji = newReactions[0]?.emoji || null;

    const { data: convs } = await admin
      .from("conversations")
      .select("id")
      .eq("telegram_chat_id", chatId);

    if (convs && convs.length > 0) {
      const convIds = convs.map((c) => c.id);
      await admin
        .from("messages")
        .update({ reaction: emoji })
        .in("conversation_id", convIds)
        .eq("telegram_message_id", messageId);
    }
    return;
  }

  const msg = update.message ?? update.edited_message;
  if (!msg?.chat?.id) return;

  const chatId = msg.chat.id as number;
  const from = msg.from ?? {};
  const isStart = typeof msg.text === "string" && msg.text.trim().startsWith("/start");
  const title =
    msg.chat.title ||
    [from.first_name, from.last_name].filter(Boolean).join(" ") ||
    from.username ||
    `Chat ${chatId}`;

  // --- LOGIN HANDLE IN WEBHOOK ---
  if (isStart) {
    const startParts = (msg.text || "").trim().split(" ");
    const startParam = startParts.length > 1 ? startParts[1] : null;

    if (startParam) {
      const session = authSessions.get(startParam);
      if (!session) {
        await tgCall(
          "sendMessage",
          {
            chat_id: chatId,
            text: "⚠️ This login session has expired or is invalid. Please click the button on the website to generate a new login link.",
          },
          LOVABLE_API_KEY,
          TELEGRAM_API_KEY,
        );
        return;
      }

      // Generate a random 6-digit OTP
      const otp = Math.floor(100000 + Math.random() * 900000).toString();

      // Save Telegram info to session
      session.telegramId = from.id;
      session.username = from.username;
      session.firstName = from.first_name;
      session.lastName = from.last_name;
      session.chatId = chatId;
      session.otp = otp;
      session.status = "otp_sent";
      authSessions.set(startParam, session);

      // Send OTP message to the Telegram user
      await tgCall(
        "sendMessage",
        {
          chat_id: chatId,
          text: `🔑 Your verification OTP is: *${otp}*\n\nPlease enter this code on the website to verify your identity and log in.`,
          parse_mode: "Markdown",
        },
        LOVABLE_API_KEY,
        TELEGRAM_API_KEY,
      );

      // We also insert or update this conversation in Supabase to log that they started the chat
      const { data: profiles } = await admin.from("profiles").select("user_id");
      const photoUrl = from.id
        ? await fetchUserPhotoUrl(from.id, LOVABLE_API_KEY, TELEGRAM_API_KEY)
        : null;

      for (const p of profiles ?? []) {
        await admin.from("conversations").upsert(
          {
            owner_user_id: p.user_id,
            telegram_chat_id: chatId,
            title,
            telegram_user_id: from.id ?? null,
            telegram_username: from.username ?? null,
            telegram_first_name: from.first_name ?? null,
            telegram_last_name: from.last_name ?? null,
            telegram_photo_url: photoUrl,
            last_message_text: "/start (Login Session)",
            last_message_at: new Date().toISOString(),
          },
          { onConflict: "owner_user_id,telegram_chat_id" },
        );
      }

      return;
    }
  }

  // --- REGULAR WEBHOOK MESSAGE PERSISTENCE & AI ---
  let mediaType: string | null = null;
  let fileId: string | null = null;
  let fileName: string | null = null;
  let mimeType: string | null = null;
  let duration: number | null = null;
  if (msg.photo?.length) {
    mediaType = "photo";
    fileId = msg.photo[msg.photo.length - 1].file_id;
  } else if (msg.animation) {
    mediaType = "animation";
    fileId = msg.animation.file_id;
    mimeType = msg.animation.mime_type ?? null;
    fileName = msg.animation.file_name ?? null;
  } else if (msg.voice) {
    mediaType = "voice";
    fileId = msg.voice.file_id;
    duration = msg.voice.duration ?? null;
    mimeType = msg.voice.mime_type ?? null;
  } else if (msg.audio) {
    mediaType = "audio";
    fileId = msg.audio.file_id;
    duration = msg.audio.duration ?? null;
    mimeType = msg.audio.mime_type ?? null;
    fileName = msg.audio.file_name ?? null;
  } else if (msg.video) {
    mediaType = "video";
    fileId = msg.video.file_id;
    duration = msg.video.duration ?? null;
    mimeType = msg.video.mime_type ?? null;
  } else if (msg.document) {
    const isGif =
      msg.document.mime_type === "image/gif" ||
      msg.document.file_name?.toLowerCase().endsWith(".gif");
    mediaType = isGif ? "animation" : "document";
    fileId = msg.document.file_id;
    mimeType = msg.document.mime_type ?? null;
    fileName = msg.document.file_name ?? null;
  }

  let mediaPublicUrl: string | null = null;
  let fileSize: number | null = null;
  if (fileId) {
    try {
      const fr = await tgCall("getFile", { file_id: fileId }, LOVABLE_API_KEY, TELEGRAM_API_KEY);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const fd = (await fr.json()) as any;
      const filePath = fd?.result?.file_path;
      if (filePath) {
        const dl = await fetch(`https://api.telegram.org/file/bot${TELEGRAM_API_KEY}/${filePath}`);
        const arrayBuf = await dl.arrayBuffer();
        const bytes = new Uint8Array(arrayBuf);
        fileSize = bytes.byteLength;
        const ext = filePath.split(".").pop() ?? "bin";
        const storagePath = `incoming/${chatId}/${msg.message_id}_${Date.now()}.${ext}`;
        const { error: upErr } = await admin.storage.from("chat-media").upload(storagePath, bytes, {
          contentType: mimeType ?? "application/octet-stream",
          upsert: true,
        });
        if (!upErr) {
          mediaPublicUrl = storagePath;
          if (!fileName) fileName = filePath.split("/").pop() ?? null;
        } else {
          console.error("storage upload", upErr);
        }
      }
    } catch (e) {
      console.error("media download error", e);
    }
  }

  const captionOrText = msg.text ?? msg.caption ?? null;
  const previewText =
    captionOrText ??
    (mediaType === "photo"
      ? "📷 Photo"
      : mediaType === "voice"
        ? "🎤 Voice"
        : mediaType === "video"
          ? "🎬 Video"
          : mediaType === "document"
            ? "📎 File"
            : mediaType === "audio"
              ? "🎵 Audio"
              : msg.sticker
                ? "[sticker]"
                : "[message]");
  const text = previewText;

  const photoUrl = from.id
    ? await fetchUserPhotoUrl(from.id, LOVABLE_API_KEY, TELEGRAM_API_KEY)
    : null;

  const { data: profiles } = await admin.from("profiles").select("user_id");

  for (const p of profiles ?? []) {
    const { data: conv, error: convErr } = await admin
      .from("conversations")
      .upsert(
        {
          owner_user_id: p.user_id,
          telegram_chat_id: chatId,
          title,
          telegram_user_id: from.id ?? null,
          telegram_username: from.username ?? null,
          telegram_first_name: from.first_name ?? null,
          telegram_last_name: from.last_name ?? null,
          telegram_photo_url: photoUrl,
          last_message_text: text,
          last_message_at: new Date().toISOString(),
          human_replied: false,
        },
        { onConflict: "owner_user_id,telegram_chat_id" },
      )
      .select()
      .single();
    if (convErr || !conv) {
      console.error("conv upsert error", convErr);
      continue;
    }

    if (update.message) {
      const { data: existing } = await admin
        .from("messages")
        .select("id")
        .eq("conversation_id", conv.id)
        .eq("telegram_message_id", msg.message_id)
        .maybeSingle();
      if (existing) continue;
    }

    await admin.from("messages").insert({
      conversation_id: conv.id,
      owner_user_id: p.user_id,
      direction: "incoming",
      content: captionOrText,
      telegram_message_id: msg.message_id,
      is_edited: !!update.edited_message,
      media_url: mediaPublicUrl,
      media_type: mediaType,
      file_name: fileName,
      file_size_bytes: fileSize,
      duration_seconds: duration,
      mime_type: mimeType,
    });

    await admin
      .from("conversations")
      .update({
        unread_count: (conv.unread_count ?? 0) + 1,
        last_message_text: text,
        last_message_at: new Date().toISOString(),
        human_replied: false,
      })
      .eq("id", conv.id);
  }

  if (isStart) {
    const welcome = `🎉 Welcome ${from.first_name ?? "friend"}!\n\nWe're glad to have you. Choose an option below to get started:`;
    await tgCall(
      "sendMessage",
      {
        chat_id: chatId,
        text: welcome,
        reply_markup: {
          inline_keyboard: [
            [
              { text: "📝 Register", callback_data: "register" },
              { text: "🔐 Login", callback_data: "login" },
            ],
            [{ text: "💬 Official Group", url: OFFICIAL_GROUP_URL }],
          ],
        },
      },
      LOVABLE_API_KEY,
      TELEGRAM_API_KEY,
    );
    for (const p of profiles ?? []) {
      await admin
        .from("conversations")
        .update({ started: true })
        .eq("telegram_chat_id", chatId)
        .eq("owner_user_id", p.user_id);
    }
    return;
  }

  if (msg.text && !update.edited_message) {
    const { data: anyConv } = await admin
      .from("conversations")
      .select("id, human_replied, ai_enabled, telegram_chat_id")
      .eq("telegram_chat_id", chatId)
      .limit(1)
      .maybeSingle();

    if (anyConv && !anyConv.human_replied && anyConv.ai_enabled) {
      const reply = await aiReplyWithHistory(anyConv.id, msg.text, admin, LOVABLE_API_KEY);
      if (reply) {
        const sendRes = await tgCall(
          "sendMessage",
          { chat_id: chatId, text: reply },
          LOVABLE_API_KEY,
          TELEGRAM_API_KEY,
        );
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const sendData = (await sendRes.json()) as any;
        const tgMsgId = sendData?.result?.message_id ?? null;

        for (const p of profiles ?? []) {
          const { data: c } = await admin
            .from("conversations")
            .select("id")
            .eq("owner_user_id", p.user_id)
            .eq("telegram_chat_id", chatId)
            .maybeSingle();
          if (!c) continue;
          await admin.from("messages").insert({
            conversation_id: c.id,
            owner_user_id: p.user_id,
            direction: "outgoing",
            content: `🤖 ${reply}`,
            telegram_message_id: tgMsgId,
            seen: true,
          });
          await admin
            .from("conversations")
            .update({
              last_message_text: `🤖 ${reply}`,
              last_message_at: new Date().toISOString(),
            })
            .eq("id", c.id);
        }
      }
    }
  }
}

async function startTelegramLongPolling() {
  const telegramApiKey = process.env.TELEGRAM_API_KEY;
  if (!telegramApiKey) {
    console.warn("[Telegram Long Polling] TELEGRAM_API_KEY not set. Polling disabled.");
    return;
  }

  console.log("[Telegram Long Polling] Starting background polling...");

  // First, delete the webhook so getUpdates is allowed
  try {
    const delRes = await fetch(`https://api.telegram.org/bot${telegramApiKey}/deleteWebhook`);
    const delData = (await delRes.json()) as { ok: boolean };
    console.log("[Telegram Long Polling] Webhook deletion status:", delData);
  } catch (err) {
    console.error("[Telegram Long Polling] Failed to delete webhook:", err);
  }

  let lastUpdateId = 0;

  const poll = async () => {
    try {
      const url = `https://api.telegram.org/bot${telegramApiKey}/getUpdates?offset=${lastUpdateId + 1}&timeout=10&limit=50`;
      const res = await fetch(url);
      if (!res.ok) {
        if (res.status === 401) {
          console.error(
            "[Telegram Long Polling] Unauthorized. Please check your TELEGRAM_API_KEY.",
          );
          return;
        }
        throw new Error(`HTTP error! status: ${res.status}`);
      }

      const data = (await res.json()) as {
        ok: boolean;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        result?: Array<{ update_id: number; [key: string]: any }>;
      };
      if (data.ok && data.result && data.result.length > 0) {
        for (const update of data.result) {
          lastUpdateId = Math.max(lastUpdateId, update.update_id);
          console.log(`[Telegram Long Polling] Processing update ${update.update_id}`);
          try {
            await handleTelegramUpdate(update);
          } catch (err) {
            console.error(
              `[Telegram Long Polling] Error handling update ${update.update_id}:`,
              err,
            );
          }
        }
      }
    } catch (err) {
      console.error("[Telegram Long Polling] Error during polling:", err);
      // Wait before retrying to avoid spamming on error
      await new Promise((resolve) => setTimeout(resolve, 5000));
    }

    setTimeout(poll, 1500);
  };

  poll();
}

// Start background polling ONLY in local development to prevent deleting webhook in production
if (typeof globalThis !== "undefined") {
  const isLocalDev = process.env.NODE_ENV !== "production";

  if (isLocalDev) {
    if (!globalThis.telegramPollingStarted) {
      globalThis.telegramPollingStarted = true;
      setTimeout(() => {
        startTelegramLongPolling().catch((err) => {
          console.error("[Telegram Long Polling] Start failed:", err);
        });
      }, 1500);
    }
  } else {
    console.log(
      "[Telegram] Server running in production. Webhooks will be used for incoming updates to keep bot online 24/7.",
    );
  }
}

type ServerEntry = {
  fetch: (request: Request, env: unknown, ctx: unknown) => Promise<Response> | Response;
};

let serverEntryPromise: Promise<ServerEntry> | undefined;

async function getServerEntry(): Promise<ServerEntry> {
  if (!serverEntryPromise) {
    serverEntryPromise = import("@tanstack/react-start/server-entry").then(
      (m) => (m as { default?: ServerEntry }).default ?? (m as unknown as ServerEntry),
    );
  }
  return serverEntryPromise;
}

function brandedErrorResponse(): Response {
  return new Response(renderErrorPage(), {
    status: 500,
    headers: { "content-type": "text/html; charset=utf-8" },
  });
}

function isCatastrophicSsrErrorBody(body: string, responseStatus: number): boolean {
  let payload: unknown;
  try {
    payload = JSON.parse(body);
  } catch {
    return false;
  }

  if (!payload || Array.isArray(payload) || typeof payload !== "object") {
    return false;
  }

  const fields = payload as Record<string, unknown>;
  const expectedKeys = new Set(["message", "status", "unhandled"]);
  if (!Object.keys(fields).every((key) => expectedKeys.has(key))) {
    return false;
  }

  return (
    fields.unhandled === true &&
    fields.message === "HTTPError" &&
    (fields.status === undefined || fields.status === responseStatus)
  );
}

// h3 swallows in-handler throws into a normal 500 Response with body
// {"unhandled":true,"message":"HTTPError"} — try/catch alone never fires for those.
async function normalizeCatastrophicSsrResponse(response: Response): Promise<Response> {
  if (response.status < 500) return response;
  const contentType = response.headers.get("content-type") ?? "";
  if (!contentType.includes("application/json")) return response;

  const body = await response.clone().text();
  if (!isCatastrophicSsrErrorBody(body, response.status)) {
    return response;
  }

  console.error(consumeLastCapturedError() ?? new Error(`h3 swallowed SSR error: ${body}`));
  return brandedErrorResponse();
}

export default {
  async fetch(request: Request, env: unknown, ctx: unknown) {
    const url = new URL(request.url);

    // Dynamic webhook registration (only in production)
    if (
      !webhookRegistered &&
      process.env.NODE_ENV === "production" &&
      !url.hostname.includes("localhost") &&
      !url.hostname.includes("127.0.0.1")
    ) {
      webhookRegistered = true;
      const appUrl = `https://${url.host}`;
      registerTelegramWebhook(appUrl);
    }

    // CORS preflight
    if (request.method === "OPTIONS") {
      return new Response(null, {
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
          "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
        },
      });
    }

    // API: Proxy Telegram file download to hide bot token
    if (url.pathname.startsWith("/api/telegram-file/")) {
      const filePath = url.pathname.replace("/api/telegram-file/", "");
      const telegramApiKey = process.env.TELEGRAM_API_KEY;
      if (!telegramApiKey) {
        return new Response("Bot token not configured", { status: 500 });
      }
      const fileUrl = `https://api.telegram.org/file/bot${telegramApiKey}/${filePath}`;
      try {
        const fileRes = await fetch(fileUrl);
        if (!fileRes.ok) {
          return new Response("Failed to fetch file from Telegram", { status: fileRes.status });
        }
        const headers = new Headers(fileRes.headers);
        headers.set("Access-Control-Allow-Origin", "*");
        return new Response(fileRes.body, {
          status: fileRes.status,
          headers,
        });
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        return new Response(errMsg, { status: 500 });
      }
    }

    // API 1: Create session
    if (url.pathname === "/api/tg-auth/create") {
      const token = crypto.randomUUID();
      authSessions.set(token, {
        token,
        status: "pending",
        createdAt: Date.now(),
      });

      // Automatically register/update webhook on session creation to ensure it points to this dynamic host (only in production)
      if (
        process.env.NODE_ENV === "production" &&
        !url.hostname.includes("localhost") &&
        !url.hostname.includes("127.0.0.1")
      ) {
        registerTelegramWebhook(`https://${url.host}`);
      }

      return new Response(JSON.stringify({ success: true, token }), {
        headers: {
          "Content-Type": "application/json",
          "Access-Control-Allow-Origin": "*",
        },
      });
    }

    // API: Manual Webhook Setup and Diagnostics
    if (url.pathname === "/api/tg-auth/setup-webhook") {
      const telegramApiKey = process.env.TELEGRAM_API_KEY;
      if (!telegramApiKey) {
        return new Response(
          JSON.stringify({ success: false, error: "TELEGRAM_API_KEY not configured in .env" }),
          {
            status: 500,
            headers: {
              "Content-Type": "application/json",
              "Access-Control-Allow-Origin": "*",
            },
          },
        );
      }

      const isDev = process.env.NODE_ENV !== "production";

      if (isDev) {
        try {
          const r = await fetch(`https://api.telegram.org/bot${telegramApiKey}/deleteWebhook`);
          await r.json();
          const infoRes = await fetch(
            `https://api.telegram.org/bot${telegramApiKey}/getWebhookInfo`,
          );
          const webhookInfoData = (await infoRes.json()) as { ok: boolean; result?: unknown };

          return new Response(
            JSON.stringify({
              success: true,
              isDev: true,
              message: "Polling active (Development mode)",
              currentWebhookInfo: webhookInfoData,
            }),
            {
              headers: {
                "Content-Type": "application/json",
                "Access-Control-Allow-Origin": "*",
              },
            },
          );
        } catch (err) {
          const errMsg = err instanceof Error ? err.message : String(err);
          return new Response(JSON.stringify({ success: false, error: errMsg }), {
            status: 500,
            headers: {
              "Content-Type": "application/json",
              "Access-Control-Allow-Origin": "*",
            },
          });
        }
      }

      const appUrl =
        url.hostname.includes("localhost") || url.hostname.includes("127.0.0.1")
          ? "http://localhost:3000"
          : `https://${url.host}`;
      const webhookUrl = `${appUrl}/api/telegram-webhook`;
      const secretToken = await deriveSecret(telegramApiKey);

      try {
        console.log(`[Telegram] Setup Webhook manual trigger for URL: ${webhookUrl}`);
        const r = await fetch(`https://api.telegram.org/bot${telegramApiKey}/setWebhook`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            url: webhookUrl,
            secret_token: secretToken,
          }),
        });

        const setWebhookData = (await r.json()) as { ok: boolean; description?: string };

        // Fetch webhook status info
        const infoRes = await fetch(`https://api.telegram.org/bot${telegramApiKey}/getWebhookInfo`);
        const webhookInfoData = (await infoRes.json()) as { ok: boolean; result?: unknown };

        return new Response(
          JSON.stringify({
            success: setWebhookData.ok,
            message:
              setWebhookData.description ||
              (setWebhookData.ok ? "Webhook set successfully" : "Failed to set webhook"),
            webhookUrl,
            telegramResponse: setWebhookData,
            currentWebhookInfo: webhookInfoData,
          }),
          {
            headers: {
              "Content-Type": "application/json",
              "Access-Control-Allow-Origin": "*",
            },
          },
        );
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        return new Response(JSON.stringify({ success: false, error: errMsg }), {
          status: 500,
          headers: {
            "Content-Type": "application/json",
            "Access-Control-Allow-Origin": "*",
          },
        });
      }
    }

    // API 2: Check status of session
    if (url.pathname === "/api/tg-auth/status") {
      const token = url.searchParams.get("token");
      if (!token) {
        return new Response(JSON.stringify({ success: false, error: "Missing token" }), {
          status: 400,
          headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
        });
      }
      const session = authSessions.get(token);
      if (!session) {
        return new Response(
          JSON.stringify({ success: false, error: "Session expired or invalid" }),
          {
            status: 404,
            headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
          },
        );
      }
      return new Response(
        JSON.stringify({ success: true, status: session.status, username: session.username }),
        {
          headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
        },
      );
    }

    // API 3: Verify OTP and log in
    if (url.pathname === "/api/tg-auth/verify") {
      if (request.method !== "POST") {
        return new Response("Method not allowed", { status: 405 });
      }
      try {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const body = (await request.json()) as any;
        const { token, otp } = body;

        const session = authSessions.get(token);
        if (!session) {
          return new Response(
            JSON.stringify({
              success: false,
              error: "Session expired or invalid. Please try again.",
            }),
            {
              status: 400,
              headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
            },
          );
        }

        if (session.status !== "otp_sent" || session.otp !== otp) {
          return new Response(
            JSON.stringify({ success: false, error: "Incorrect OTP code. Please check Telegram." }),
            {
              status: 400,
              headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
            },
          );
        }

        const supabaseUrl = process.env.SUPABASE_URL || "https://ybsivojduiwcuetdcuov.supabase.co";
        const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

        if (!supabaseServiceKey) {
          return new Response(
            JSON.stringify({ success: false, error: "Server misconfigured: missing service key" }),
            {
              status: 500,
              headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
            },
          );
        }

        const adminClient = createClient(supabaseUrl, supabaseServiceKey);

        const telegramId = session.telegramId!;
        const email = `tg_${telegramId}@telegram.chat`;

        const password = crypto
          .createHmac("sha256", supabaseServiceKey)
          .update(telegramId.toString())
          .digest("hex");

        const displayName =
          [session.firstName, session.lastName].filter(Boolean).join(" ") ||
          session.username ||
          `User ${telegramId}`;

        const { data: userList, error: listError } = await adminClient.auth.admin.listUsers();
        if (listError) {
          console.error("Error listing users:", listError);
        }

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        let targetUser = userList?.users?.find((u: any) => u.email === email);

        if (!targetUser) {
          const { data: newUser, error: createError } = await adminClient.auth.admin.createUser({
            email,
            password,
            email_confirm: true,
            user_metadata: {
              display_name: displayName,
            },
          });

          if (createError) {
            console.error("Error creating user:", createError);
            return new Response(
              JSON.stringify({ success: false, error: "Failed to register account." }),
              {
                status: 500,
                headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
              },
            );
          }

          targetUser = newUser.user;
        }

        if (targetUser) {
          const { data: profile } = await adminClient
            .from("profiles")
            .select("id, telegram_chat_id")
            .eq("user_id", targetUser.id)
            .maybeSingle();

          if (profile) {
            if (profile.telegram_chat_id !== session.chatId) {
              await adminClient
                .from("profiles")
                .update({ telegram_chat_id: session.chatId })
                .eq("id", profile.id);
            }
          } else {
            await adminClient.from("profiles").insert({
              user_id: targetUser.id,
              display_name: displayName,
              telegram_chat_id: session.chatId,
            });
          }
        }

        authSessions.delete(token);

        return new Response(
          JSON.stringify({
            success: true,
            email,
            password,
          }),
          {
            headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
          },
        );
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } catch (err: any) {
        console.error("Verify OTP error:", err);
        return new Response(JSON.stringify({ success: false, error: err.message }), {
          status: 500,
          headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
        });
      }
    }

    // API 5: Local Telegram Message and Media Sender proxy
    if (url.pathname === "/api/telegram-send") {
      if (request.method !== "POST") return new Response("Method not allowed", { status: 405 });

      const authHeader = request.headers.get("Authorization") ?? "";
      const supabaseUrl = process.env.SUPABASE_URL || "https://ybsivojduiwcuetdcuov.supabase.co";
      const anonKey = process.env.SUPABASE_PUBLISHABLE_KEY || "";
      const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

      const userClient = createClient(supabaseUrl, anonKey, {
        global: { headers: { Authorization: authHeader } },
      });
      const { data: userData, error: userErr } = await userClient.auth.getUser();
      if (userErr || !userData?.user) {
        return new Response(JSON.stringify({ error: "Unauthorized" }), {
          status: 401,
          headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
        });
      }
      const userId = userData.user.id;

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      let body: any;
      try {
        body = await request.json();
      } catch {
        return new Response("Bad JSON", { status: 400 });
      }

      const LOVABLE_API_KEY = process.env.LOVABLE_API_KEY || "placeholder_lovable_key";
      const TELEGRAM_API_KEY = process.env.TELEGRAM_API_KEY;
      if (!TELEGRAM_API_KEY || !serviceKey) {
        return new Response(JSON.stringify({ error: "Server misconfigured" }), {
          status: 500,
          headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
        });
      }

      const admin = createClient(supabaseUrl, serviceKey);
      const action = body.action ?? "send_text";

      try {
        // --- EDIT ---
        if (action === "edit") {
          const { messageId, text } = body;
          const { data: m } = await admin
            .from("messages")
            .select("id, owner_user_id, telegram_message_id, conversation_id")
            .eq("id", messageId)
            .single();
          if (!m || m.owner_user_id !== userId) {
            return new Response(JSON.stringify({ error: "Not found" }), {
              status: 404,
              headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
            });
          }
          const { data: c } = await admin
            .from("conversations")
            .select("telegram_chat_id")
            .eq("id", m.conversation_id)
            .single();
          if (m.telegram_message_id && c) {
            await tgCall(
              "editMessageText",
              {
                chat_id: c.telegram_chat_id,
                message_id: m.telegram_message_id,
                text,
              },
              LOVABLE_API_KEY,
              TELEGRAM_API_KEY,
            );
          }
          await admin
            .from("messages")
            .update({ content: text, is_edited: true })
            .eq("id", messageId);
          return new Response(JSON.stringify({ ok: true }), {
            headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
          });
        }

        // --- DELETE ---
        if (action === "delete") {
          const { messageId } = body;
          const { data: m } = await admin
            .from("messages")
            .select("id, owner_user_id, telegram_message_id, conversation_id")
            .eq("id", messageId)
            .single();
          if (!m || m.owner_user_id !== userId) {
            return new Response(JSON.stringify({ error: "Not found" }), {
              status: 404,
              headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
            });
          }
          const { data: c } = await admin
            .from("conversations")
            .select("telegram_chat_id")
            .eq("id", m.conversation_id)
            .single();
          if (m.telegram_message_id && c) {
            await tgCall(
              "deleteMessage",
              {
                chat_id: c.telegram_chat_id,
                message_id: m.telegram_message_id,
              },
              LOVABLE_API_KEY,
              TELEGRAM_API_KEY,
            );
          }
          await admin
            .from("messages")
            .update({ is_deleted: true, content: "[deleted]" })
            .eq("id", messageId);
          return new Response(JSON.stringify({ ok: true }), {
            headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
          });
        }

        // --- REACT ---
        if (action === "react") {
          const { messageId, emoji } = body;
          const { data: m } = await admin
            .from("messages")
            .select("id, owner_user_id, telegram_message_id, conversation_id")
            .eq("id", messageId)
            .single();
          if (!m || m.owner_user_id !== userId) {
            return new Response(JSON.stringify({ error: "Not found" }), {
              status: 404,
              headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
            });
          }
          const { data: c } = await admin
            .from("conversations")
            .select("telegram_chat_id")
            .eq("id", m.conversation_id)
            .single();
          if (m.telegram_message_id && c) {
            const reaction = emoji ? [{ type: "emoji", emoji }] : [];
            await tgCall(
              "setMessageReaction",
              {
                chat_id: c.telegram_chat_id,
                message_id: m.telegram_message_id,
                reaction: reaction,
              },
              LOVABLE_API_KEY,
              TELEGRAM_API_KEY,
            );
          }
          await admin
            .from("messages")
            .update({ reaction: emoji || null })
            .eq("id", messageId);
          return new Response(JSON.stringify({ ok: true }), {
            headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
          });
        }

        // --- SEND (text / media) ---
        const {
          conversationId,
          text,
          mediaUrl,
          mediaType,
          fileName,
          mimeType,
          replyToTelegramMessageId,
        } = body;
        if (!conversationId) {
          return new Response(JSON.stringify({ error: "Missing conversationId" }), {
            status: 400,
            headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
          });
        }

        const { data: conv } = await admin
          .from("conversations")
          .select("id, owner_user_id, telegram_chat_id")
          .eq("id", conversationId)
          .single();
        if (!conv || conv.owner_user_id !== userId) {
          return new Response(JSON.stringify({ error: "Conversation not found" }), {
            status: 404,
            headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
          });
        }

        // Resolve media URL for Telegram: if mediaUrl is a storage path, sign it.
        let tgMediaUrl: string | null = null;
        if (mediaUrl) {
          if (/^https?:\/\//i.test(mediaUrl)) {
            tgMediaUrl = mediaUrl;
          } else {
            const { data: signed, error: signErr } = await admin.storage
              .from("chat-media")
              .createSignedUrl(mediaUrl, 60 * 60 * 24);
            if (signErr || !signed) {
              return new Response(JSON.stringify({ error: "Media sign failed" }), {
                status: 500,
                headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
              });
            }
            tgMediaUrl = signed.signedUrl;
          }
        }

        const isGif =
          mediaType === "animation" ||
          mediaUrl?.toLowerCase().endsWith(".gif") ||
          mimeType?.toLowerCase() === "image/gif";
        const replyParams = replyToTelegramMessageId
          ? { reply_parameters: { message_id: replyToTelegramMessageId } }
          : {};
        let tgRes: Response;
        if (isGif && tgMediaUrl) {
          tgRes = await tgCall(
            "sendAnimation",
            {
              chat_id: conv.telegram_chat_id,
              animation: tgMediaUrl,
              caption: text ?? undefined,
              ...replyParams,
            },
            LOVABLE_API_KEY,
            TELEGRAM_API_KEY,
          );
        } else if (mediaType === "photo" && tgMediaUrl) {
          tgRes = await tgCall(
            "sendPhoto",
            {
              chat_id: conv.telegram_chat_id,
              photo: tgMediaUrl,
              caption: text ?? undefined,
              ...replyParams,
            },
            LOVABLE_API_KEY,
            TELEGRAM_API_KEY,
          );
        } else if (mediaType === "voice" && tgMediaUrl) {
          tgRes = await tgCall(
            "sendVoice",
            {
              chat_id: conv.telegram_chat_id,
              voice: tgMediaUrl,
              caption: text ?? undefined,
              ...replyParams,
            },
            LOVABLE_API_KEY,
            TELEGRAM_API_KEY,
          );
        } else if (mediaType === "document" && tgMediaUrl) {
          tgRes = await tgCall(
            "sendDocument",
            {
              chat_id: conv.telegram_chat_id,
              document: tgMediaUrl,
              caption: text ?? undefined,
              ...replyParams,
            },
            LOVABLE_API_KEY,
            TELEGRAM_API_KEY,
          );
        } else {
          if (!text || typeof text !== "string" || text.length === 0 || text.length > 4000) {
            return new Response(JSON.stringify({ error: "Invalid text input" }), {
              status: 400,
              headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
            });
          }
          tgRes = await tgCall(
            "sendMessage",
            { chat_id: conv.telegram_chat_id, text, ...replyParams },
            LOVABLE_API_KEY,
            TELEGRAM_API_KEY,
          );
        }

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const tgData = (await tgRes.json()) as any;
        if (!tgRes.ok || !tgData.ok) {
          return new Response(JSON.stringify({ error: "Telegram error", details: tgData }), {
            status: 502,
            headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
          });
        }

        const resolvedMediaType = isGif ? "animation" : (mediaType ?? null);

        const { data: inserted } = await admin
          .from("messages")
          .insert({
            conversation_id: conversationId,
            owner_user_id: userId,
            direction: "outgoing",
            content: text ?? null,
            telegram_message_id: tgData.result.message_id,
            seen: true,
            media_url: mediaUrl ?? null,
            media_type: resolvedMediaType,
            file_name: fileName ?? null,
            mime_type: mimeType ?? null,
          })
          .select()
          .single();

        const preview =
          resolvedMediaType === "animation"
            ? "🎬 GIF"
            : mediaType === "photo"
              ? "📷 Photo"
              : mediaType === "voice"
                ? "🎤 Voice"
                : mediaType === "document"
                  ? "📎 File"
                  : (text ?? "");
        await admin
          .from("conversations")
          .update({
            last_message_text: preview,
            last_message_at: new Date().toISOString(),
            human_replied: true,
          })
          .eq("telegram_chat_id", conv.telegram_chat_id);

        return new Response(JSON.stringify({ message: inserted }), {
          headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
        });
      } catch (e) {
        console.error("Local telegram-send handler error:", e);
        return new Response(JSON.stringify({ error: e instanceof Error ? e.message : "Unknown" }), {
          status: 500,
          headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
        });
      }
    }

    // API: Suggest AI Reply
    if (url.pathname === "/api/ai/suggest") {
      if (request.method !== "POST") return new Response("Method not allowed", { status: 405 });

      const authHeader = request.headers.get("Authorization") ?? "";
      const supabaseUrl = process.env.SUPABASE_URL || "https://ybsivojduiwcuetdcuov.supabase.co";
      const anonKey = process.env.SUPABASE_PUBLISHABLE_KEY || "";
      const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

      const userClient = createClient(supabaseUrl, anonKey, {
        global: { headers: { Authorization: authHeader } },
      });
      const { data: userData, error: userErr } = await userClient.auth.getUser();
      if (userErr || !userData?.user) {
        return new Response(JSON.stringify({ error: "Unauthorized" }), {
          status: 401,
          headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
        });
      }
      const userId = userData.user.id;

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      let body: any;
      try {
        body = await request.json();
      } catch {
        return new Response("Bad JSON", { status: 400 });
      }

      const { conversationId } = body;
      if (!conversationId) {
        return new Response(JSON.stringify({ error: "Missing conversationId" }), {
          status: 400,
          headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
        });
      }

      const admin = createClient(supabaseUrl, serviceKey!);
      const { data: conv } = await admin
        .from("conversations")
        .select("id, owner_user_id, title")
        .eq("id", conversationId)
        .single();

      if (!conv || conv.owner_user_id !== userId) {
        return new Response(JSON.stringify({ error: "Conversation not found" }), {
          status: 404,
          headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
        });
      }

      // Fetch last 12 messages to build rich context
      const { data: recentMessages } = await admin
        .from("messages")
        .select("direction, content")
        .eq("conversation_id", conversationId)
        .order("created_at", { ascending: false })
        .limit(12);

      const history = (recentMessages || []).reverse();

      let suggestion = "";

      try {
        if (process.env.GROQ_API_KEY) {
          const response = await fetch("https://api.groq.com/openai/v1/chat/completions", {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${process.env.GROQ_API_KEY}`,
            },
            body: JSON.stringify({
              model: "llama-3.3-70b-versatile",
              messages: [
                {
                  role: "system",
                  content:
                    "You are a brilliant AI co-pilot assisting a customer support agent. Generate a helpful, professional, and natural-sounding draft reply to the user's latest message based on the conversation history. Keep the draft natural, concise, and helpful. Write in the same language as the user. Match the user's tone (polite, tech-oriented, friendly). Do not add any metadata, brackets, or 'Agent:' prefixes. Just output the final message draft.",
                },
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                ...history.map((m: any) => ({
                  role: m.direction === "outgoing" ? "assistant" : "user",
                  content: m.content || "",
                })),
              ],
              temperature: 0.7,
              max_tokens: 256,
            }),
          });

          if (!response.ok) {
            const errText = await response.text();
            throw new Error(`Groq API error (status ${response.status}): ${errText}`);
          }

          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const data = (await response.json()) as any;
          suggestion = data.choices?.[0]?.message?.content?.trim() || "";
        } else {
          // Fallback to Lovable Gateway API
          const LOVABLE_API_KEY = process.env.LOVABLE_API_KEY || "placeholder_lovable_key";
          const r = await fetch(AI_URL, {
            method: "POST",
            headers: {
              Authorization: `Bearer ${LOVABLE_API_KEY}`,
              "Content-Type": "application/json",
            },
            body: JSON.stringify({
              model: "google/gemini-2.5-flash",
              messages: [
                {
                  role: "system",
                  content:
                    "You are a brilliant AI co-pilot assisting a customer support agent. Generate a helpful, professional, and natural-sounding draft reply to the user's latest message based on the conversation history. Do not include any agent prefixes, just output the reply.",
                },
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                ...history.map((m: any) => ({
                  role: m.direction === "outgoing" ? "assistant" : "user",
                  content: m.content || "",
                })),
              ],
            }),
          });
          if (r.ok) {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const d = (await r.json()) as any;
            suggestion = d?.choices?.[0]?.message?.content?.trim() || "";
          }
        }
      } catch (err) {
        console.error("Groq/Lovable Suggest Error:", err);
      }

      return new Response(JSON.stringify({ suggestion }), {
        headers: {
          "Content-Type": "application/json",
          "Access-Control-Allow-Origin": "*",
        },
      });
    }

    // API 4: Unified Telegram Webhook
    if (url.pathname === "/api/telegram-webhook") {
      if (request.method !== "POST") return new Response("Method not allowed", { status: 405 });

      const TELEGRAM_API_KEY = process.env.TELEGRAM_API_KEY;
      if (!TELEGRAM_API_KEY) {
        return new Response("Server misconfigured", { status: 500 });
      }

      const expected = await deriveSecret(TELEGRAM_API_KEY);
      const got = request.headers.get("X-Telegram-Bot-Api-Secret-Token");
      if (!safeEq(got, expected)) return new Response("Unauthorized", { status: 401 });

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      let update: any;
      try {
        update = await request.json();
      } catch {
        return new Response("Bad JSON", { status: 400 });
      }

      try {
        await handleTelegramUpdate(update);
      } catch (err) {
        console.error("[Telegram Webhook] Error processing update:", err);
      }

      return new Response(JSON.stringify({ ok: true }), {
        headers: { "Content-Type": "application/json" },
      });
    }

    // Default to TanStack Start rendering engine
    try {
      const handler = await getServerEntry();
      const response = await handler.fetch(request, env, ctx);
      return await normalizeCatastrophicSsrResponse(response);
    } catch (error) {
      console.error(error);
      return brandedErrorResponse();
    }
  },
};
