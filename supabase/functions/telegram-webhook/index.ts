import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const GATEWAY_URL = "https://connector-gateway.lovable.dev/telegram";
const AI_URL = "https://ai.gateway.lovable.dev/v1/chat/completions";
const OFFICIAL_GROUP_URL = "https://t.me/telegram"; // placeholder; admin can edit later

async function deriveSecret(apiKey: string): Promise<string> {
  const data = new TextEncoder().encode(`telegram-webhook:${apiKey}`);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return btoa(String.fromCharCode(...new Uint8Array(digest)))
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
  return fetch(`${GATEWAY_URL}/${path}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${lovKey}`,
      "X-Connection-Api-Key": tgKey,
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
    const d = await r.json();
    const fileId = d?.result?.photos?.[0]?.[0]?.file_id;
    if (!fileId) return null;
    const f = await tgCall("getFile", { file_id: fileId }, lovKey, tgKey);
    const fd = await f.json();
    const path = fd?.result?.file_path;
    if (!path) return null;
    return `${GATEWAY_URL}/file/${path}`;
  } catch (_e) {
    return null;
  }
}

async function aiReply(userText: string, lovKey: string): Promise<string | null> {
  try {
    const r = await fetch(AI_URL, {
      method: "POST",
      headers: { Authorization: `Bearer ${lovKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "google/gemini-2.5-flash",
        messages: [
          {
            role: "system",
            content:
              "You are a friendly support assistant for our service. Reply briefly (under 60 words) and helpfully. If you cannot answer, say a human agent will follow up shortly.",
          },
          { role: "user", content: userText },
        ],
      }),
    });
    if (!r.ok) return null;
    const d = await r.json();
    return d?.choices?.[0]?.message?.content ?? null;
  } catch {
    return null;
  }
}

Deno.serve(async (req) => {
  if (req.method !== "POST") return new Response("Method not allowed", { status: 405 });

  const TELEGRAM_API_KEY = Deno.env.get("TELEGRAM_API_KEY");
  const LOVABLE_API_KEY = Deno.env.get("LOVABLE_API_KEY");
  const SUPABASE_URL = Deno.env.get("SUPABASE_URL");
  const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!TELEGRAM_API_KEY || !LOVABLE_API_KEY || !SUPABASE_URL || !SERVICE_KEY) {
    return new Response("Server misconfigured", { status: 500 });
  }

  const expected = await deriveSecret(TELEGRAM_API_KEY);
  const got = req.headers.get("X-Telegram-Bot-Api-Secret-Token");
  if (!safeEq(got, expected)) return new Response("Unauthorized", { status: 401 });

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let update: any;
  try {
    update = await req.json();
  } catch {
    return new Response("Bad JSON", { status: 400 });
  }

  const admin = createClient(SUPABASE_URL, SERVICE_KEY);

  // Handle callback_query (button presses) — just acknowledge
  if (update.callback_query) {
    await tgCall(
      "answerCallbackQuery",
      { callback_query_id: update.callback_query.id },
      LOVABLE_API_KEY,
      TELEGRAM_API_KEY,
    );
    return new Response(JSON.stringify({ ok: true }));
  }

  const msg = update.message ?? update.edited_message;
  if (!msg?.chat?.id) return new Response(JSON.stringify({ ok: true, ignored: true }));

  const chatId = msg.chat.id as number;
  const from = msg.from ?? {};
  const isStart = typeof msg.text === "string" && msg.text.trim().startsWith("/start");
  const title =
    msg.chat.title ||
    [from.first_name, from.last_name].filter(Boolean).join(" ") ||
    from.username ||
    `Chat ${chatId}`;

  // --- Detect media ---
  let mediaType: string | null = null;
  let fileId: string | null = null;
  let fileName: string | null = null;
  let mimeType: string | null = null;
  let duration: number | null = null;
  if (msg.photo?.length) {
    mediaType = "photo";
    fileId = msg.photo[msg.photo.length - 1].file_id;
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
    mediaType = "document";
    fileId = msg.document.file_id;
    mimeType = msg.document.mime_type ?? null;
    fileName = msg.document.file_name ?? null;
  }

  let mediaPublicUrl: string | null = null;
  let fileSize: number | null = null;
  if (fileId) {
    try {
      const fr = await tgCall("getFile", { file_id: fileId }, LOVABLE_API_KEY, TELEGRAM_API_KEY);
      const fd = await fr.json();
      const path = fd?.result?.file_path;
      if (path) {
        const dl = await fetch(`${GATEWAY_URL}/file/${path}`, {
          headers: {
            Authorization: `Bearer ${LOVABLE_API_KEY}`,
            "X-Connection-Api-Key": TELEGRAM_API_KEY,
          },
        });
        const bytes = new Uint8Array(await dl.arrayBuffer());
        fileSize = bytes.byteLength;
        const ext = path.split(".").pop() ?? "bin";
        const storagePath = `incoming/${chatId}/${msg.message_id}_${Date.now()}.${ext}`;
        const tmpAdmin = createClient(SUPABASE_URL, SERVICE_KEY);
        const { error: upErr } = await tmpAdmin.storage
          .from("chat-media")
          .upload(storagePath, bytes, {
            contentType: mimeType ?? "application/octet-stream",
            upsert: true,
          });
        if (!upErr) {
          mediaPublicUrl = storagePath; // store path; signed URL generated on read
          if (!fileName) fileName = path.split("/").pop() ?? null;
        } else {
          console.error("storage upload", upErr);
        }
      }
    } catch (e) {
      console.error("media download", e);
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

  // Fetch profile photo once
  const photoUrl = from.id
    ? await fetchUserPhotoUrl(from.id, LOVABLE_API_KEY, TELEGRAM_API_KEY)
    : null;

  // Get owners (all users for now — single tenant)
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
        },
        { onConflict: "owner_user_id,telegram_chat_id" },
      )
      .select()
      .single();
    if (convErr || !conv) {
      console.error("conv upsert", convErr);
      continue;
    }

    // Idempotency
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
      })
      .eq("id", conv.id);
  }

  // --- /start welcome ---
  if (isStart) {
    const isReturning =
      (profiles ?? []).some(async () => true) &&
      (
        await admin
          .from("conversations")
          .select("started")
          .eq("telegram_chat_id", chatId)
          .limit(1)
          .maybeSingle()
      ).data?.started === true;

    const welcome = isReturning
      ? `👋 Welcome back, ${from.first_name ?? "friend"}! How can we help you today?`
      : `🎉 Welcome ${from.first_name ?? "friend"}!\n\nWe're glad to have you. Choose an option below to get started:`;

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

    await admin.from("conversations").update({ started: true }).eq("telegram_chat_id", chatId);
    return new Response(JSON.stringify({ ok: true }));
  }

  // --- AI auto-reply (only if no human has replied yet AND ai enabled) ---
  if (msg.text && !update.edited_message) {
    const { data: anyConv } = await admin
      .from("conversations")
      .select("id, human_replied, ai_enabled, telegram_chat_id")
      .eq("telegram_chat_id", chatId)
      .limit(1)
      .maybeSingle();

    if (anyConv && !anyConv.human_replied && anyConv.ai_enabled) {
      const reply = await aiReply(msg.text, LOVABLE_API_KEY);
      if (reply) {
        const sendRes = await tgCall(
          "sendMessage",
          { chat_id: chatId, text: reply },
          LOVABLE_API_KEY,
          TELEGRAM_API_KEY,
        );
        const sendData = await sendRes.json();
        const tgMsgId = sendData?.result?.message_id ?? null;

        // Persist AI reply as outgoing for every owner
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
            .update({ last_message_text: `🤖 ${reply}`, last_message_at: new Date().toISOString() })
            .eq("id", c.id);
        }
      }
    }
  }

  return new Response(JSON.stringify({ ok: true }));
});
