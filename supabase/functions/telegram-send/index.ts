import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const GATEWAY_URL = "https://connector-gateway.lovable.dev/telegram";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

async function tg(path: string, body: unknown, lov: string, tk: string) {
  return fetch(`${GATEWAY_URL}/${path}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${lov}`,
      "X-Connection-Api-Key": tk,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  try {
    const LOVABLE_API_KEY = Deno.env.get("LOVABLE_API_KEY")!;
    const TELEGRAM_API_KEY = Deno.env.get("TELEGRAM_API_KEY")!;
    const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
    const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const ANON_KEY =
      Deno.env.get("SUPABASE_ANON_KEY") ?? Deno.env.get("SUPABASE_PUBLISHABLE_KEY") ?? "";

    const authHeader = req.headers.get("Authorization") ?? "";
    const userClient = createClient(SUPABASE_URL, ANON_KEY, {
      global: { headers: { Authorization: authHeader } },
    });
    const { data: userData, error: userErr } = await userClient.auth.getUser();
    if (userErr || !userData.user) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
    const userId = userData.user.id;
    const admin = createClient(SUPABASE_URL, SERVICE_KEY);

    const body = await req.json();
    const action = body.action ?? "send_text";

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
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
      const { data: c } = await admin
        .from("conversations")
        .select("telegram_chat_id")
        .eq("id", m.conversation_id)
        .single();
      if (m.telegram_message_id && c) {
        await tg(
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
      await admin.from("messages").update({ content: text, is_edited: true }).eq("id", messageId);
      return new Response(JSON.stringify({ ok: true }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
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
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
      const { data: c } = await admin
        .from("conversations")
        .select("telegram_chat_id")
        .eq("id", m.conversation_id)
        .single();
      if (m.telegram_message_id && c) {
        await tg(
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
        headers: { ...corsHeaders, "Content-Type": "application/json" },
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
        headers: { ...corsHeaders, "Content-Type": "application/json" },
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
        headers: { ...corsHeaders, "Content-Type": "application/json" },
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
            headers: { ...corsHeaders, "Content-Type": "application/json" },
          });
        }
        tgMediaUrl = signed.signedUrl;
      }
    }

    const replyParams = replyToTelegramMessageId
      ? { reply_parameters: { message_id: replyToTelegramMessageId } }
      : {};
    let tgRes: Response;
    if (mediaType === "photo" && tgMediaUrl) {
      tgRes = await tg(
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
      tgRes = await tg(
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
      tgRes = await tg(
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
        return new Response(JSON.stringify({ error: "Invalid input" }), {
          status: 400,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
      tgRes = await tg(
        "sendMessage",
        { chat_id: conv.telegram_chat_id, text, ...replyParams },
        LOVABLE_API_KEY,
        TELEGRAM_API_KEY,
      );
    }

    const tgData = await tgRes.json();
    if (!tgRes.ok || !tgData.ok) {
      return new Response(JSON.stringify({ error: "Telegram error", details: tgData }), {
        status: 502,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

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
        media_type: mediaType ?? null,
        file_name: fileName ?? null,
        mime_type: mimeType ?? null,
      })
      .select()
      .single();

    const preview =
      mediaType === "photo"
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
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (e) {
    console.error("telegram-send error:", e);
    return new Response(JSON.stringify({ error: e instanceof Error ? e.message : "Unknown" }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
