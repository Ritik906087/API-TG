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
import { GoogleGenAI } from "@google/genai";
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
      .select("direction, content, media_url, media_type")
      .eq("conversation_id", conversationId)
      .order("created_at", { ascending: false })
      .limit(10);

    const history = (recentMessages || []).reverse();

    const cfToken = process.env.CLOUDFLARE_API_TOKEN;
    const cfAccountId = process.env.CLOUDFLARE_ACCOUNT_ID;

    // 1. Cloudflare Workers AI - Image Generation & Editing
    if (cfToken && cfAccountId) {
      const lowerText = userText.toLowerCase().trim();
      const isImageCmd =
        lowerText.startsWith("/image") ||
        lowerText.startsWith("/draw") ||
        lowerText.startsWith("/generate") ||
        lowerText.startsWith("/paint") ||
        lowerText.startsWith("/img");

      let isImageReq = isImageCmd;
      let imagePrompt = "";

      const hasImageKeyword =
        lowerText.includes("image") ||
        lowerText.includes("photo") ||
        lowerText.includes("pic") ||
        lowerText.includes("drawing") ||
        lowerText.includes("sketch") ||
        lowerText.includes("painting") ||
        lowerText.includes("art") ||
        lowerText.includes("dp") ||
        lowerText.includes("tasveer") ||
        lowerText.includes("chitra");

      const hasActionKeyword =
        lowerText.includes("draw") ||
        lowerText.includes("generate") ||
        lowerText.includes("create") ||
        lowerText.includes("make") ||
        lowerText.includes("paint") ||
        lowerText.includes("bana") ||
        lowerText.includes("edit") ||
        lowerText.includes("clear") ||
        lowerText.includes("nikal") ||
        lowerText.includes("design") ||
        lowerText.includes("crop") ||
        lowerText.includes("clean") ||
        lowerText.includes("gora");

      const lastPhotoMsg = (recentMessages || []).find(
        (m: { direction: string; media_type: string | null; media_url: string | null }) =>
          m.media_type === "photo" && m.media_url,
      );

      const isOcrKeyword =
        lowerText.includes("ocr") ||
        lowerText.includes("read") ||
        lowerText.includes("padho") ||
        lowerText.includes("padhna") ||
        lowerText.includes("extract") ||
        lowerText.includes("scan") ||
        lowerText.includes("kya likha") ||
        lowerText.includes("what is written") ||
        lowerText.includes("transcribe") ||
        lowerText.includes("describe") ||
        lowerText.includes("analyze") ||
        lowerText.includes("explain this") ||
        lowerText.includes("ye kya") ||
        lowerText.includes("what is this") ||
        lowerText.includes("real") ||
        lowerText.includes("fake") ||
        lowerText.includes("sach") ||
        lowerText.includes("jhooth") ||
        lowerText.includes("jhoot") ||
        lowerText.includes("scam") ||
        lowerText.includes("fraud") ||
        lowerText.includes("spam") ||
        lowerText.includes("check") ||
        lowerText.includes("verify") ||
        lowerText.includes("kya h") ||
        lowerText.includes("kya hai") ||
        lowerText.includes("batao");

      const isEditReference =
        !!lastPhotoMsg &&
        !isOcrKeyword &&
        (hasActionKeyword ||
          lowerText.includes("isko") ||
          lowerText.includes("isey") ||
          lowerText.includes("it") ||
          lowerText.includes("this") ||
          lowerText.includes("photo") ||
          lowerText.includes("image"));

      const isOcrReq =
        !!lastPhotoMsg &&
        !isImageCmd &&
        !isEditReference &&
        (isOcrKeyword || userText.trim().length > 0);

      // 1.1 Handle OCR / Image Reading first if requested
      if (isOcrReq) {
        let imageBytes: number[] | null = null;
        let base64Data: string | null = null;
        let imageMimeType = "image/jpeg";

        if (lastPhotoMsg && lastPhotoMsg.media_url) {
          try {
            console.log(
              `[Image Analysis] Downloading original photo for analysis: ${lastPhotoMsg.media_url}`,
            );
            const { data: fileData, error: downloadErr } = await adminClient.storage
              .from("chat-media")
              .download(lastPhotoMsg.media_url);
            if (!downloadErr && fileData) {
              const arrayBuf = await fileData.arrayBuffer();
              const buffer = Buffer.from(arrayBuf);
              base64Data = buffer.toString("base64");
              imageBytes = Array.from(new Uint8Array(arrayBuf));

              if (lastPhotoMsg.mime_type) {
                imageMimeType = lastPhotoMsg.mime_type;
              } else {
                const ext = lastPhotoMsg.media_url.split(".").pop()?.toLowerCase();
                if (ext === "png") imageMimeType = "image/png";
                else if (ext === "gif") imageMimeType = "image/gif";
                else if (ext === "webp") imageMimeType = "image/webp";
              }

              console.log(
                `[Image Analysis] Successfully downloaded image. Size: ${imageBytes.length} bytes. Mime: ${imageMimeType}`,
              );
            } else {
              console.error(`[Image Analysis] Failed to download image from storage:`, downloadErr);
            }
          } catch (err) {
            console.error(`[Image Analysis] Error downloading/parsing image:`, err);
          }
        }

        if (base64Data || imageBytes) {
          // A. If Gemini API Key is configured, use Gemini 3.5 Flash (much more powerful and handles Hindi/Hinglish/English perfectly)
          if (process.env.GEMINI_API_KEY && base64Data) {
            try {
              console.log("[Gemini AI Vision] Analyzing image using gemini-3.5-flash...");
              const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

              const systemPrompt = `You are an exceptionally smart assistant, helpful companion, and security analyst.
Your job is to analyze the content in the user's uploaded image (typically a screenshot of an SMS, transaction notification, chat, or mail) and answer their question: "${userText}".

CRITICAL INSTRUCTIONS:
1. Ignore any Telegram UI overlays, status bars, keyboard overlays, or chat bubbles at the bottom of the screenshot (like the user's own text "Ye real he ya fake" or the telegram input field). Focus on the core content of the image (the actual message, notification, or document).
2. If the user asks about the reality/validity of the message/notification (e.g. "Ye real he ya fake", "is it a scam", "sach hai ya jhooth", "verify"):
   - Carefully check for spam, fraud, phishing, or scam indicators.
   - Indicators include: suspicious short links (like bit.ly, tinyurl, or sketchy domains), unofficial mobile numbers masquerading as official bank/brand headers, high prize promises (lottery, kbc), fear-inducing warnings (your account is blocked, electricity will be cut), or grammatical errors.
   - Answer clearly and directly in Hindi/Hinglish (or English, matching the user's vibe/language) whether the notification is **Real** or **Fake/Scam**.
   - Explain the reasons for your judgment clearly (e.g., "Yeh message ek SCAM/FAKE hai kyuki isme bit.ly link diya gaya hai aur yeh ek private number se aaya hai...").
3. Do NOT output any dummy headers like "Photo ke Text:", "Translation:", or fake progress lines like "Photo ke Text: 50% complete". Speak directly and conversationally like a human assistant. Keep it highly readable and properly formatted using markdown.`;

              let response;
              let attempt = 1;
              const maxAttempts = 3;
              let delay = 1000;

              while (attempt <= maxAttempts) {
                try {
                  response = await ai.models.generateContent({
                    model: "gemini-3.5-flash",
                    contents: [
                      {
                        inlineData: {
                          mimeType: imageMimeType,
                          data: base64Data,
                        },
                      },
                      systemPrompt,
                    ],
                  });
                  break;
                } catch (geminiCallErr: unknown) {
                  let errMsg = "Unknown error";
                  if (
                    geminiCallErr &&
                    typeof geminiCallErr === "object" &&
                    "message" in geminiCallErr
                  ) {
                    errMsg = String((geminiCallErr as { message: unknown }).message);
                  } else {
                    errMsg = String(geminiCallErr);
                  }
                  const isTransient =
                    errMsg.includes("503") ||
                    errMsg.includes("504") ||
                    errMsg.includes("429") ||
                    errMsg.includes("temporary") ||
                    errMsg.includes("high demand") ||
                    errMsg.includes("UNAVAILABLE");
                  if (isTransient && attempt < maxAttempts) {
                    console.warn(
                      `[Gemini AI Vision] Transient error on attempt ${attempt}: ${errMsg}. Retrying in ${delay}ms...`,
                    );
                    await new Promise((resolve) => setTimeout(resolve, delay));
                    delay *= 2;
                    attempt++;
                  } else {
                    throw geminiCallErr;
                  }
                }
              }

              if (response) {
                const reply = response.text?.trim();
                if (reply) {
                  console.log(`[Gemini AI Vision] Successfully generated analysis response.`);
                  return reply;
                }
              }
            } catch (geminiErr) {
              console.error(`[Gemini AI Vision] Error calling Gemini API:`, geminiErr);
            }
          }

          // B. Fallback to Cloudflare Workers AI Vision model if Gemini fails or is missing
          if (imageBytes && cfAccountId && cfToken) {
            try {
              console.log(
                `[Cloudflare AI OCR] Sending image to @cf/meta/llama-3.2-11b-vision-instruct for text reading/analysis...`,
              );
              const ocrUrl = `https://api.cloudflare.com/client/v4/accounts/${cfAccountId}/ai/run/@cf/meta/llama-3.2-11b-vision-instruct`;

              const ocrPrompt = `You are an exceptionally smart assistant and security analyst. Analyze this image (which is a screenshot) and answer the user's question: "${userText}".

CRITICAL INSTRUCTIONS:
1. Ignore any Telegram UI overlays, chat bubbles, or status bars at the bottom/top (like a pink/blue bubble containing "Ye real he ya fake"). Focus entirely on the main content of the screenshot (e.g., the SMS text, transaction alert, email).
2. If the user is asking whether the message/alert in the screenshot is real or fake ("Ye real he ya fake"):
   - Check if there are sketchy links (like bit.ly, tinyurl, unknown domains), private sender numbers instead of official headers, promises of prizes/refunds, or block warnings.
   - Answer clearly, directly, and conversationally in friendly Hinglish/Hindi (or English) whether the message/alert is **Real** or **Fake/Scam**, and explain the exact reasons why.
3. NEVER output simulated progress (like "Photo ke Text: 50% complete"), meta-descriptions of your reading process, or placeholders. Just provide your final, beautifully formatted markdown answer directly.`;

              let ocrRes = await fetch(ocrUrl, {
                method: "POST",
                headers: {
                  "Content-Type": "application/json",
                  Authorization: `Bearer ${cfToken}`,
                },
                body: JSON.stringify({
                  prompt: ocrPrompt,
                  image: imageBytes,
                }),
              });

              if (!ocrRes.ok) {
                const errText = await ocrRes.text();
                console.error(`[Cloudflare AI OCR] Failed response: ${errText}`);
                if (
                  errText.includes("must submit the prompt 'agree'") ||
                  errText.includes("agree")
                ) {
                  console.log(
                    `[Cloudflare AI OCR] Agreement needed. Automatically sending 'agree' handshake to register Community License terms...`,
                  );
                  const agreeRes = await fetch(ocrUrl, {
                    method: "POST",
                    headers: {
                      "Content-Type": "application/json",
                      Authorization: `Bearer ${cfToken}`,
                    },
                    body: JSON.stringify({
                      prompt: "agree",
                    }),
                  });
                  if (agreeRes.ok) {
                    console.log(
                      `[Cloudflare AI OCR] Successfully registered Llama Community License agreement. Retrying original OCR request...`,
                    );
                    ocrRes = await fetch(ocrUrl, {
                      method: "POST",
                      headers: {
                        "Content-Type": "application/json",
                        Authorization: `Bearer ${cfToken}`,
                      },
                      body: JSON.stringify({
                        prompt: ocrPrompt,
                        image: imageBytes,
                      }),
                    });
                  } else {
                    const agreeErrText = await agreeRes.text();
                    console.error(
                      `[Cloudflare AI OCR] Failed to auto-agree to Community License: ${agreeErrText}`,
                    );
                  }
                }
              }

              if (ocrRes.ok) {
                const ocrData = (await ocrRes.json()) as { result?: { response?: string } };
                const reply = ocrData.result?.response?.trim();
                if (reply) {
                  console.log(
                    `[Cloudflare AI OCR] Successfully read image text: "${reply.slice(0, 100)}..."`,
                  );
                  return reply;
                }
              } else {
                console.error(
                  `[Cloudflare AI OCR] Response failed to complete even after checking agreement.`,
                );
              }
            } catch (ocrErr) {
              console.error(`[Cloudflare AI OCR] Error calling Workers AI:`, ocrErr);
            }
          }
        }
      }

      if (isImageCmd) {
        const parts = userText.split(/\s+/);
        imagePrompt = parts.slice(1).join(" ").trim();
      } else if (
        lowerText.includes("draw a") ||
        lowerText.includes("draw an") ||
        lowerText.includes("generate an image of") ||
        lowerText.includes("generate a picture of") ||
        lowerText.includes("create an image of") ||
        lowerText.includes("create a picture of") ||
        lowerText.includes("make a picture of") ||
        lowerText.includes("make an image of") ||
        lowerText.includes("image edit") ||
        lowerText.includes("edit image") ||
        lowerText.includes("photo edit") ||
        lowerText.includes("edit photo") ||
        (hasImageKeyword && hasActionKeyword)
      ) {
        isImageReq = true;
        const match = userText.match(
          /(?:draw|generate|create|make|edit|clear|nikal|nikala)\s+(?:an?\s+)?(?:image|picture|photo|drawing|sketch|painting)?\s*(?:of)?\s*(.*)/i,
        );
        imagePrompt = match ? match[1].trim() : userText;
      } else if (isEditReference) {
        isImageReq = true;
        imagePrompt = `A beautifully enhanced, highly clean, and polished version of the previous photo, modified according to: "${userText}"`;
      }

      if (isImageReq) {
        if (!imagePrompt) {
          imagePrompt = "A beautiful sci-fi city with advanced neon structures and flying cars";
        }
        try {
          let finalPrompt = imagePrompt;
          // Refine image prompt to high quality English description using Llama
          try {
            console.log(
              `[Cloudflare AI] Refining image prompt: "${imagePrompt}" using Llama-3.1-8b-instruct`,
            );
            const refineUrl = `https://api.cloudflare.com/client/v4/accounts/${cfAccountId}/ai/run/@cf/meta/llama-3.1-8b-instruct`;
            const refineRes = await fetch(refineUrl, {
              method: "POST",
              headers: {
                "Content-Type": "application/json",
                Authorization: `Bearer ${cfToken}`,
              },
              body: JSON.stringify({
                messages: [
                  {
                    role: "system",
                    content:
                      "You are a professional image generation prompt engineering assistant. Translate the user's image creation/edit request (which might be in Hindi, Hinglish, English, or mixed) into a highly descriptive English prompt suitable for Stable Diffusion. Focus on the core subject, composition, background elements, lighting (e.g. professional studio lighting, warm soft glow), quality parameters (e.g. photorealistic, sharp focus, high-resolution details, 8k). Output ONLY the refined English prompt. Do not write any explanations, intro text, or extra words.",
                  },
                  { role: "user", content: imagePrompt },
                ],
              }),
            });

            if (refineRes.ok) {
              const refineData = (await refineRes.json()) as { result?: { response?: string } };
              const refined = refineData.result?.response?.trim();
              if (refined) {
                finalPrompt = refined;
                console.log(`[Cloudflare AI] Refined prompt: "${finalPrompt}"`);
              }
            } else {
              const errText = await refineRes.text();
              console.warn(`[Cloudflare AI] Refine prompt API failed: ${errText}`);
            }
          } catch (refineErr) {
            console.error("Failed to refine image prompt", refineErr);
          }

          console.log(`[Cloudflare AI] Generating image for prompt: "${finalPrompt}"`);
          const cfUrl = `https://api.cloudflare.com/client/v4/accounts/${cfAccountId}/ai/run/@cf/stabilityai/stable-diffusion-xl-base-1.0`;

          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const payload: Record<string, any> = {
            prompt: finalPrompt,
          };

          if (isEditReference && lastPhotoMsg && lastPhotoMsg.media_url) {
            try {
              console.log(
                `[Cloudflare AI Edit] Downloading original photo for editing: ${lastPhotoMsg.media_url}`,
              );
              const { data: fileData, error: downloadErr } = await adminClient.storage
                .from("chat-media")
                .download(lastPhotoMsg.media_url);
              if (!downloadErr && fileData) {
                const arrayBuf = await fileData.arrayBuffer();
                payload.image = Array.from(new Uint8Array(arrayBuf));
                payload.strength = 0.55;
                console.log(
                  `[Cloudflare AI Edit] Base image included for Image-to-Image editing. Size: ${payload.image.length} bytes.`,
                );
              } else {
                console.error(`[Cloudflare AI Edit] Download failed:`, downloadErr);
              }
            } catch (dlErr) {
              console.error(`[Cloudflare AI Edit] Error parsing base image:`, dlErr);
            }
          }

          const cfRes = await fetch(cfUrl, {
            method: "POST",
            headers: {
              Authorization: `Bearer ${cfToken}`,
              "Content-Type": "application/json",
            },
            body: JSON.stringify(payload),
          });

          if (cfRes.ok) {
            const arrayBuf = await cfRes.arrayBuffer();
            const bytes = new Uint8Array(arrayBuf);
            const storagePath = `outgoing/${conversationId}/ai_gen_${Date.now()}.png`;
            const { error: upErr } = await adminClient.storage
              .from("chat-media")
              .upload(storagePath, bytes, {
                contentType: "image/png",
                upsert: true,
              });

            if (!upErr) {
              let photoUrl = "";
              const { data: signed } = await adminClient.storage
                .from("chat-media")
                .createSignedUrl(storagePath, 60 * 60 * 24);
              if (signed?.signedUrl) {
                photoUrl = signed.signedUrl;
              } else {
                const { data: pub } = adminClient.storage
                  .from("chat-media")
                  .getPublicUrl(storagePath);
                photoUrl = pub.publicUrl;
              }

              if (photoUrl) {
                const { data: conv } = await adminClient
                  .from("conversations")
                  .select("telegram_chat_id")
                  .eq("id", conversationId)
                  .single();

                if (conv?.telegram_chat_id) {
                  const TELEGRAM_API_KEY = process.env.TELEGRAM_API_KEY || "";
                  const tgRes = await tgCall(
                    "sendPhoto",
                    {
                      chat_id: conv.telegram_chat_id,
                      photo: photoUrl,
                      caption: isEditReference
                        ? `🎨 Here is your edited image: "${userText}"`
                        : `🎨 Here is your generated image for: "${imagePrompt}"`,
                    },
                    lovKey,
                    TELEGRAM_API_KEY,
                  );
                  const tgData = (await tgRes.json()) as Record<string, unknown>;
                  const tgMsgId =
                    ((tgData?.result as Record<string, unknown>)?.message_id as number | null) ??
                    null;

                  // Save to database for all operators
                  const { data: profiles } = await adminClient.from("profiles").select("user_id");
                  for (const p of profiles ?? []) {
                    const { data: userConv } = await adminClient
                      .from("conversations")
                      .select("id")
                      .eq("owner_user_id", p.user_id)
                      .eq("telegram_chat_id", conv.telegram_chat_id)
                      .maybeSingle();

                    if (userConv) {
                      await adminClient.from("messages").insert({
                        conversation_id: userConv.id,
                        owner_user_id: p.user_id,
                        direction: "outgoing",
                        content: isEditReference
                          ? `🎨 Edited image: "${userText}"`
                          : `🎨 Generated image: "${imagePrompt}"`,
                        telegram_message_id: tgMsgId,
                        seen: true,
                        media_url: storagePath,
                        media_type: "photo",
                        file_name: `ai_gen_${Date.now()}.png`,
                        mime_type: "image/png",
                      });

                      await adminClient
                        .from("conversations")
                        .update({
                          last_message_text: "📷 🤖 Photo",
                          last_message_at: new Date().toISOString(),
                          human_replied: false,
                        })
                        .eq("id", userConv.id);
                    }
                  }

                  return isEditReference
                    ? `🎨 Edited and sent your image according to "${userText}"!`
                    : `🎨 Generated and sent your image for "${imagePrompt}"!`;
                }
              }
            }
          } else {
            const errText = await cfRes.text();
            console.error("[Cloudflare AI Image Gen Error Response]:", errText);
          }
        } catch (err) {
          console.error("[Cloudflare AI Image Gen Catch Error]:", err);
        }
      }
    }

    // 2. Cloudflare Workers AI - Text & Code Generation
    if (cfToken && cfAccountId) {
      try {
        console.log(
          `[Cloudflare AI] Generating text/code reply using @cf/meta/llama-3.1-8b-instruct`,
        );
        const cfUrl = `https://api.cloudflare.com/client/v4/accounts/${cfAccountId}/ai/run/@cf/meta/llama-3.1-8b-instruct`;
        const response = await fetch(cfUrl, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${cfToken}`,
          },
          body: JSON.stringify({
            messages: [
              {
                role: "system",
                content:
                  "You are an exceptionally brilliant, friendly, sweet, and highly intelligent AI companion (similar to ChatGPT or Gemini). Talk to the user in the same language they use (e.g., Hindi, Hinglish, English, or any other language). CRITICAL MANDATES:\n1. NEVER refer the user to a human agent, and NEVER say 'human agent will follow up'. Keep the conversation active yourself!\n2. If the user asks for coding, programming, writing scripts, software development, or any technical task, you MUST write highly professional, complete, clean, and beautifully formatted code blocks for them.\n3. If the user asks to generate, create, draw, paint, or edit an image, say something like 'Sure! I am generating the image for you right now...' in a friendly way. NEVER output simulated progress text, fake percentages, or dummy markdown links/placeholders like '[Aapka Image Link]' or '[Naya Image]'. Simply confirm you are starting image generation/processing and let the background process handle it.\n4. Keep your replies friendly, conversational, smart, and beautifully structured with markdown.",
              },
              ...history.map((m: { direction: string; content: string | null }) => ({
                role: m.direction === "outgoing" ? "assistant" : "user",
                content: m.content || "",
              })),
              { role: "user", content: userText },
            ],
          }),
        });

        if (response.ok) {
          const data = (await response.json()) as { result?: { response?: string } };
          const reply = data.result?.response?.trim();
          if (reply) {
            return reply;
          }
        } else {
          const errText = await response.text();
          console.error(
            `[Cloudflare AI Text Gen Error]: Status ${response.status}, response:`,
            errText,
          );
        }
      } catch (cfError) {
        console.error("[Cloudflare AI Text Gen Error]:", cfError);
      }
    }

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
      const { error: rErr } = await admin
        .from("messages")
        .update({ reaction: emoji })
        .in("conversation_id", convIds)
        .eq("telegram_message_id", messageId);
      if (rErr) {
        console.warn(
          "Could not update reaction in db (probably column does not exist):",
          rErr.message,
        );
      }
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

  const incomingUserText = msg.text ?? msg.caption ?? null;
  if (incomingUserText && !update.edited_message) {
    const { data: anyConv } = await admin
      .from("conversations")
      .select("id, human_replied, ai_enabled, telegram_chat_id")
      .eq("telegram_chat_id", chatId)
      .limit(1)
      .maybeSingle();

    if (anyConv && !anyConv.human_replied && anyConv.ai_enabled) {
      const reply = await aiReplyWithHistory(anyConv.id, incomingUserText, admin, LOVABLE_API_KEY);
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
          const { error: rErr } = await admin
            .from("messages")
            .update({ reaction: emoji || null })
            .eq("id", messageId);
          if (rErr) {
            console.warn(
              "Could not update reaction in db (probably column does not exist):",
              rErr.message,
            );
          }
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
            const { data: signed } = await admin.storage
              .from("chat-media")
              .createSignedUrl(mediaUrl, 60 * 60 * 24);
            if (signed?.signedUrl) {
              tgMediaUrl = signed.signedUrl;
            } else {
              const { data: pub } = admin.storage.from("chat-media").getPublicUrl(mediaUrl);
              tgMediaUrl = pub.publicUrl;
            }
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

        // Fetch all operator conversations for this Telegram chat ID to synchronize message history
        const { data: operatorConvs } = await admin
          .from("conversations")
          .select("id, owner_user_id")
          .eq("telegram_chat_id", conv.telegram_chat_id);

        let inserted = null;

        for (const opConv of operatorConvs ?? []) {
          const { data: msgIns } = await admin
            .from("messages")
            .insert({
              conversation_id: opConv.id,
              owner_user_id: opConv.owner_user_id,
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

          if (opConv.owner_user_id === userId) {
            inserted = msgIns;
          }
        }

        // Fallback if current operator's conversation wasn't in operatorConvs
        if (!inserted) {
          const { data: fallbackInserted } = await admin
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
          inserted = fallbackInserted;
        }

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
        const cfToken = process.env.CLOUDFLARE_API_TOKEN;
        const cfAccountId = process.env.CLOUDFLARE_ACCOUNT_ID;

        if (cfToken && cfAccountId) {
          try {
            console.log(
              `[Cloudflare AI] Generating draft suggestion using @cf/meta/llama-3.1-8b-instruct`,
            );
            const cfUrl = `https://api.cloudflare.com/client/v4/accounts/${cfAccountId}/ai/run/@cf/meta/llama-3.1-8b-instruct`;
            const response = await fetch(cfUrl, {
              method: "POST",
              headers: {
                "Content-Type": "application/json",
                Authorization: `Bearer ${cfToken}`,
              },
              body: JSON.stringify({
                messages: [
                  {
                    role: "system",
                    content:
                      "You are a brilliant AI co-pilot assisting a customer support agent. Generate a helpful, professional, and natural-sounding draft reply to the user's latest message based on the conversation history. Keep the draft natural, concise, and helpful. Write in the same language as the user. Match the user's tone (polite, tech-oriented, friendly). Do not add any metadata, brackets, or 'Agent:' prefixes. Just output the final message draft. If the user asks for code or scripts, generate high-quality code blocks.",
                  },
                  ...history.map((m: { direction: string; content: string | null }) => ({
                    role: m.direction === "outgoing" ? "assistant" : "user",
                    content: m.content || "",
                  })),
                ],
              }),
            });

            if (response.ok) {
              const data = (await response.json()) as { result?: { response?: string } };
              suggestion = data.result?.response?.trim() || "";
            } else {
              const errText = await response.text();
              console.error(`[Cloudflare AI Suggestion Error]: ${errText}`);
            }
          } catch (cfErr) {
            console.error("[Cloudflare AI Suggestion Catch Error]:", cfErr);
          }
        }

        if (!suggestion && process.env.GROQ_API_KEY) {
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
