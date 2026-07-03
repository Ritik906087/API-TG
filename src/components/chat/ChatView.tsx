import { useEffect, useRef, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import {
  ArrowLeft,
  Send,
  MessageCircle,
  Check,
  CheckCheck,
  Paperclip,
  Image as ImageIcon,
  FileText,
  Mic,
  Smile,
  MoreVertical,
  X,
  Reply,
  Pencil,
  Trash2,
  Copy,
  Square,
  Sparkles,
  Bot,
} from "lucide-react";
import { format } from "date-fns";
import { toast } from "sonner";
import type { Conversation } from "./ChatSidebar";
import { useAuth } from "@/hooks/useAuth";

type Message = {
  id: string;
  conversation_id: string;
  direction: "outgoing" | "incoming";
  content: string | null;
  created_at: string;
  seen: boolean;
  is_edited: boolean;
  is_deleted: boolean;
  reply_to_id: string | null;
  media_url: string | null;
  media_type: string | null;
  file_name: string | null;
  mime_type: string | null;
  duration_seconds: number | null;
  reaction: string | null;
};

const EMOJIS = [
  "😀",
  "😁",
  "😂",
  "🤣",
  "😊",
  "😍",
  "😘",
  "😎",
  "🤔",
  "😴",
  "🙏",
  "👍",
  "👎",
  "👏",
  "🙌",
  "💪",
  "🔥",
  "❤️",
  "💯",
  "🎉",
  "🎊",
  "✨",
  "⭐",
  "💀",
  "😭",
  "😡",
  "🥳",
  "🤝",
  "👋",
  "✅",
  "❌",
  "⚡",
  "💡",
  "📌",
  "🚀",
  "💬",
  "📞",
  "📷",
  "🎵",
  "🎁",
];

export function ChatView({
  conversation,
  onBack,
}: {
  conversation: Conversation | null;
  onBack: () => void;
}) {
  const { user } = useAuth();
  const [messages, setMessages] = useState<Message[]>([]);
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const [replyTo, setReplyTo] = useState<Message | null>(null);
  const [editing, setEditing] = useState<Message | null>(null);
  const [profileOpen, setProfileOpen] = useState(false);
  const [recording, setRecording] = useState(false);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const recordChunksRef = useRef<Blob[]>([]);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const imageInputRef = useRef<HTMLInputElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  const [aiEnabled, setAiEnabled] = useState(conversation?.ai_enabled ?? false);
  const [suggesting, setSuggesting] = useState(false);

  useEffect(() => {
    setAiEnabled(conversation?.ai_enabled ?? false);
  }, [conversation?.id, conversation?.ai_enabled]);

  const toggleAi = async () => {
    if (!conversation) return;
    const newVal = !aiEnabled;
    setAiEnabled(newVal);
    const { error } = await supabase
      .from("conversations")
      .update({ ai_enabled: newVal })
      .eq("id", conversation.id);
    if (error) {
      toast.error("Failed to update AI settings");
      setAiEnabled(!newVal);
    } else {
      toast.success(newVal ? "AI Auto-reply enabled!" : "AI Auto-reply disabled");
    }
  };

  const getAiSuggestion = async () => {
    if (!conversation || suggesting) return;
    setSuggesting(true);
    try {
      const { data: s } = await supabase.auth.getSession();
      const res = await fetch("/api/ai/suggest", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${s.session?.access_token}`,
        },
        body: JSON.stringify({ conversationId: conversation.id }),
      });
      if (!res.ok) {
        throw new Error("Failed to generate AI suggestion");
      }
      const data = await res.json();
      if (data.suggestion) {
        setText(data.suggestion);
        toast.success("AI draft suggested!");
      } else {
        toast.error("AI couldn't generate a suggestion. Say hi first!");
      }
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : "Failed to generate suggestion";
      toast.error(errMsg);
    } finally {
      setSuggesting(false);
    }
  };

  const mediaSrc = (u: string | null) => {
    if (!u) return null;
    if (/^https?:\/\//i.test(u)) return u;
    const { data } = supabase.storage.from("chat-media").getPublicUrl(u);
    return data.publicUrl;
  };

  useEffect(() => {
    if (!conversation) return;
    let active = true;

    const load = async () => {
      let { data, error } = await supabase
        .from("messages")
        .select(
          "id,conversation_id,direction,content,created_at,seen,is_edited,is_deleted,reply_to_id,media_url,media_type,file_name,mime_type,duration_seconds,reaction",
        )
        .eq("conversation_id", conversation.id)
        .order("created_at", { ascending: true });

      if (
        error &&
        (error.message?.includes("column messages.reaction does not exist") ||
          error.code === "42703")
      ) {
        console.warn(
          "reaction column missing from messages table, retrying query without reaction...",
        );
        const fallback = await supabase
          .from("messages")
          .select(
            "id,conversation_id,direction,content,created_at,seen,is_edited,is_deleted,reply_to_id,media_url,media_type,file_name,mime_type,duration_seconds",
          )
          .eq("conversation_id", conversation.id)
          .order("created_at", { ascending: true });
        data = fallback.data;
        error = fallback.error;
      }

      if (active && data) setMessages(data as Message[]);
      await supabase.from("conversations").update({ unread_count: 0 }).eq("id", conversation.id);
      await supabase
        .from("messages")
        .update({ seen: true })
        .eq("conversation_id", conversation.id)
        .eq("direction", "incoming")
        .eq("seen", false);
    };
    load();

    const channel = supabase
      .channel(`messages-${conversation.id}`)
      .on(
        "postgres_changes",
        {
          event: "INSERT",
          schema: "public",
          table: "messages",
          filter: `conversation_id=eq.${conversation.id}`,
        },
        (payload) => {
          const newMsg = payload.new as Message;
          setMessages((m) => {
            if (m.some((x) => x.id === newMsg.id)) return m;
            return [...m, newMsg];
          });
        },
      )
      .on(
        "postgres_changes",
        {
          event: "UPDATE",
          schema: "public",
          table: "messages",
          filter: `conversation_id=eq.${conversation.id}`,
        },
        (payload) => {
          const updatedMsg = payload.new as Message;
          setMessages((m) => m.map((x) => (x.id === updatedMsg.id ? updatedMsg : x)));
        },
      )
      .on(
        "postgres_changes",
        {
          event: "*",
          schema: "public",
          table: "conversations",
          filter: `id=eq.${conversation.id}`,
        },
        () => {
          console.log("[ChatView] Active conversation updated in database, reloading messages...");
          load();
        },
      )
      .subscribe();
    return () => {
      active = false;
      supabase.removeChannel(channel);
    };
  }, [conversation]);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
  }, [messages]);

  const callSend = async (payload: Record<string, unknown>) => {
    const { data: s } = await supabase.auth.getSession();
    return fetch("/api/telegram-send", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${s.session?.access_token}`,
      },
      body: JSON.stringify(payload),
    });
  };

  const send = async () => {
    if (!conversation || !text.trim() || sending) return;
    setSending(true);
    const body = text.trim();
    setText("");
    try {
      if (editing) {
        const res = await callSend({ action: "edit", messageId: editing.id, text: body });
        if (!res.ok) toast.error("Edit failed");
        setEditing(null);
      } else {
        const replyMsgId = replyTo ? await getTgMessageId(replyTo.id) : null;
        const res = await callSend({
          conversationId: conversation.id,
          text: body,
          replyToTelegramMessageId: replyMsgId,
        });
        if (!res.ok) {
          toast.error("Send failed");
          setText(body);
        }
        setReplyTo(null);
      }
    } finally {
      setSending(false);
    }
  };

  const getTgMessageId = async (msgId: string): Promise<number | null> => {
    const { data } = await supabase
      .from("messages")
      .select("telegram_message_id")
      .eq("id", msgId)
      .single();
    return (data?.telegram_message_id as number | null) ?? null;
  };

  const uploadAndSend = async (file: File, mediaType: "photo" | "document" | "voice") => {
    if (!conversation || !user) return;
    setSending(true);
    try {
      const ext = file.name.split(".").pop() ?? "bin";
      const path = `${user.id}/${conversation.id}/${Date.now()}.${ext}`;
      const { error: upErr } = await supabase.storage.from("chat-media").upload(path, file, {
        contentType: file.type || undefined,
        upsert: false,
      });
      if (upErr) {
        toast.error(upErr.message);
        return;
      }
      const isGif = file.type === "image/gif" || file.name.toLowerCase().endsWith(".gif");
      const actualMediaType = isGif ? "animation" : mediaType;
      const replyMsgId = replyTo ? await getTgMessageId(replyTo.id) : null;
      const res = await callSend({
        conversationId: conversation.id,
        mediaUrl: path,
        mediaType: actualMediaType,
        fileName: file.name,
        mimeType: file.type,
        text: text.trim() || undefined,
        replyToTelegramMessageId: replyMsgId,
      });
      if (!res.ok) toast.error("Send failed");
      else {
        setText("");
        setReplyTo(null);
      }
    } finally {
      setSending(false);
    }
  };

  const handleFile = (e: React.ChangeEvent<HTMLInputElement>, kind: "photo" | "document") => {
    const f = e.target.files?.[0];
    if (f) uploadAndSend(f, kind);
    e.target.value = "";
  };

  const startRecording = async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const mr = new MediaRecorder(stream, { mimeType: "audio/webm" });
      recordChunksRef.current = [];
      mr.ondataavailable = (e) => {
        if (e.data.size) recordChunksRef.current.push(e.data);
      };
      mr.onstop = async () => {
        const blob = new Blob(recordChunksRef.current, { type: "audio/webm" });
        const file = new File([blob], `voice-${Date.now()}.webm`, { type: "audio/webm" });
        stream.getTracks().forEach((t) => t.stop());
        await uploadAndSend(file, "voice");
      };
      mr.start();
      recorderRef.current = mr;
      setRecording(true);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } catch (e: any) {
      toast.error(e.message ?? "Mic blocked");
    }
  };
  const stopRecording = () => {
    recorderRef.current?.stop();
    recorderRef.current = null;
    setRecording(false);
  };

  const onMsgAction = async (m: Message, action: "reply" | "edit" | "delete" | "copy") => {
    if (action === "copy") {
      await navigator.clipboard.writeText(m.content ?? "");
      toast.success("Copied");
      return;
    }
    if (action === "reply") {
      setReplyTo(m);
      setEditing(null);
      return;
    }
    if (action === "edit") {
      setEditing(m);
      setReplyTo(null);
      setText(m.content ?? "");
      return;
    }
    if (action === "delete") {
      const res = await callSend({ action: "delete", messageId: m.id });
      if (!res.ok) toast.error("Delete failed");
    }
  };

  const sendReaction = async (messageId: string, emoji: string) => {
    try {
      setMessages((prev) =>
        prev.map((msg) => (msg.id === messageId ? { ...msg, reaction: emoji || null } : msg)),
      );
      const res = await callSend({
        action: "react",
        messageId,
        emoji,
      });
      if (!res.ok) {
        toast.error("Failed to update reaction");
      }
    } catch (err) {
      toast.error("Failed to react");
    }
  };

  if (!conversation) {
    return (
      <div className="hidden md:flex flex-1 chat-bg items-center justify-center">
        <div className="text-center max-w-sm">
          <div className="w-20 h-20 rounded-full glass border border-border mx-auto mb-4 flex items-center justify-center">
            <MessageCircle className="w-10 h-10 text-primary" />
          </div>
          <h2 className="text-xl font-semibold mb-2">Select a chat</h2>
          <p className="text-sm text-muted-foreground">
            Open Telegram, message your bot, the chat will appear here.
          </p>
        </div>
      </div>
    );
  }

  const initials = (conversation.title ?? "?")
    .split(" ")
    .map((p) => p[0])
    .slice(0, 2)
    .join("")
    .toUpperCase();
  const findMsg = (id: string) => messages.find((m) => m.id === id);

  return (
    <div className="flex-1 flex flex-col h-full chat-bg">
      <header className="glass border-b border-border px-4 py-3 flex items-center gap-3">
        <Button variant="ghost" size="icon" className="md:hidden" onClick={onBack}>
          <ArrowLeft className="w-5 h-5" />
        </Button>
        <button
          onClick={() => setProfileOpen(true)}
          className="flex items-center gap-3 flex-1 min-w-0 text-left"
        >
          <Avatar className="w-10 h-10">
            {conversation.telegram_photo_url ? (
              <img
                src={conversation.telegram_photo_url}
                alt=""
                className="w-full h-full object-cover"
              />
            ) : (
              <AvatarFallback className="bg-gradient-to-br from-primary to-primary/60 text-primary-foreground">
                {initials}
              </AvatarFallback>
            )}
          </Avatar>
          <div className="flex-1 min-w-0">
            <div className="font-semibold truncate">{conversation.title}</div>
            <div className="text-xs text-muted-foreground truncate">
              {conversation.telegram_username
                ? `@${conversation.telegram_username}`
                : "via Telegram"}
            </div>
          </div>
        </button>

        <Button
          variant={aiEnabled ? "default" : "outline"}
          size="sm"
          onClick={toggleAi}
          className={`flex items-center gap-1.5 h-9 rounded-full px-3 text-xs font-medium transition-all shrink-0 ${
            aiEnabled
              ? "bg-primary text-primary-foreground shadow"
              : "text-muted-foreground hover:text-foreground"
          }`}
        >
          <Sparkles
            className={`w-3.5 h-3.5 ${aiEnabled ? "animate-pulse text-yellow-300" : "text-muted-foreground"}`}
          />
          <span className="hidden sm:inline">AI Auto-Reply</span>
          <span className="sm:hidden">AI</span>
          <span
            className={`w-1.5 h-1.5 rounded-full ${aiEnabled ? "bg-green-400" : "bg-muted-foreground/50"}`}
          />
        </Button>
      </header>

      <div
        ref={scrollRef}
        className="flex-1 overflow-y-auto scroll-thin px-3 md:px-8 py-4 space-y-1"
      >
        {messages.length === 0 && (
          <div className="text-center text-sm text-muted-foreground py-12">
            No messages yet. Say hi 👋
          </div>
        )}
        {messages.map((m, i) => {
          const prev = messages[i - 1];
          const showDate =
            !prev ||
            new Date(m.created_at).toDateString() !== new Date(prev.created_at).toDateString();
          const replied = m.reply_to_id ? findMsg(m.reply_to_id) : null;
          return (
            <div key={m.id}>
              {showDate && (
                <div className="text-center my-3">
                  <span className="text-xs glass px-3 py-1 rounded-full text-muted-foreground">
                    {format(new Date(m.created_at), "MMM d, yyyy")}
                  </span>
                </div>
              )}
              <div
                className={`flex group ${m.direction === "outgoing" ? "justify-end" : "justify-start"} ${m.reaction ? "mb-3.5" : ""}`}
              >
                <div
                  className={`max-w-[80%] md:max-w-[60%] px-3 py-2 animate-pop relative ${m.direction === "outgoing" ? "bubble-out" : "bubble-in"} ${m.is_deleted ? "italic opacity-60" : ""}`}
                >
                  {replied && (
                    <div className="border-l-2 border-primary/70 pl-2 mb-1 text-xs opacity-80 truncate">
                      <div className="font-medium">↪ Reply</div>
                      <div className="truncate">{replied.content ?? replied.media_type ?? ""}</div>
                    </div>
                  )}
                  {m.media_type === "animation" &&
                    mediaSrc(m.media_url) &&
                    (mediaSrc(m.media_url)!.toLowerCase().endsWith(".gif") ? (
                      <img
                        src={mediaSrc(m.media_url)!}
                        alt=""
                        className="rounded-lg max-w-full max-h-80 mb-1 cursor-pointer"
                        onClick={() => window.open(mediaSrc(m.media_url)!, "_blank")}
                      />
                    ) : (
                      <video
                        autoPlay
                        loop
                        muted
                        playsInline
                        src={mediaSrc(m.media_url)!}
                        className="rounded-lg max-w-full max-h-80 mb-1 cursor-pointer"
                        onClick={() => window.open(mediaSrc(m.media_url)!, "_blank")}
                      />
                    ))}
                  {m.media_type === "photo" && mediaSrc(m.media_url) && (
                    <img
                      src={mediaSrc(m.media_url)!}
                      alt=""
                      className="rounded-lg max-w-full max-h-80 mb-1 cursor-pointer"
                      onClick={() => window.open(mediaSrc(m.media_url)!, "_blank")}
                    />
                  )}
                  {(m.media_type === "voice" || m.media_type === "audio") &&
                    mediaSrc(m.media_url) && (
                      <audio controls src={mediaSrc(m.media_url)!} className="max-w-full mb-1" />
                    )}
                  {m.media_type === "video" && mediaSrc(m.media_url) && (
                    <video
                      controls
                      src={mediaSrc(m.media_url)!}
                      className="rounded-lg max-w-full max-h-80 mb-1"
                    />
                  )}
                  {m.media_type === "document" && mediaSrc(m.media_url) && (
                    <a
                      href={mediaSrc(m.media_url)!}
                      target="_blank"
                      rel="noopener"
                      className="flex items-center gap-2 p-2 rounded bg-background/50 mb-1 hover:bg-background/80"
                    >
                      <FileText className="w-5 h-5 shrink-0" />
                      <span className="text-sm truncate">{m.file_name ?? "Document"}</span>
                    </a>
                  )}
                  {m.content && (
                    <div className="whitespace-pre-wrap break-words text-[15px]">{m.content}</div>
                  )}
                  <div className="flex items-center justify-end gap-1 mt-0.5 -mb-1">
                    {m.is_edited && !m.is_deleted && (
                      <span className="text-[10px] opacity-60">edited</span>
                    )}
                    <span className="text-[10px] opacity-70">
                      {format(new Date(m.created_at), "HH:mm")}
                    </span>
                    {m.direction === "outgoing" &&
                      (m.seen ? (
                        <CheckCheck className="w-3.5 h-3.5 opacity-80" />
                      ) : (
                        <Check className="w-3.5 h-3.5 opacity-60" />
                      ))}
                  </div>

                  {m.reaction && (
                    <div
                      className={`absolute -bottom-3 ${m.direction === "outgoing" ? "right-3" : "left-3"} bg-accent border border-border px-1.5 py-0.5 rounded-full text-[13px] shadow-sm flex items-center gap-1 select-none z-10`}
                    >
                      <span>{m.reaction}</span>
                    </div>
                  )}

                  {!m.is_deleted && (
                    <div
                      className={`absolute -top-3.5 ${m.direction === "outgoing" ? "-left-16" : "-right-16"} opacity-0 group-hover:opacity-100 transition-opacity flex gap-1 z-20`}
                    >
                      <Popover>
                        <PopoverTrigger asChild>
                          <button
                            className="bg-card border border-border rounded-full w-7 h-7 flex items-center justify-center shadow hover:bg-accent text-muted-foreground hover:text-foreground"
                            title="React"
                          >
                            <Smile className="w-3.5 h-3.5" />
                          </button>
                        </PopoverTrigger>
                        <PopoverContent
                          side="top"
                          align="center"
                          className="w-auto p-1.5 flex gap-1 rounded-full shadow-lg border border-border bg-popover/90 backdrop-blur-sm"
                        >
                          {["👍", "❤️", "🔥", "😂", "😮", "😢"].map((emoji) => (
                            <button
                              key={emoji}
                              onClick={() => sendReaction(m.id, emoji)}
                              className="text-lg hover:scale-125 transition-transform p-1 rounded hover:bg-accent/50"
                            >
                              {emoji}
                            </button>
                          ))}
                          {m.reaction && (
                            <button
                              onClick={() => sendReaction(m.id, "")}
                              className="text-[10px] text-destructive hover:bg-destructive/10 px-2 py-1 rounded-full"
                            >
                              Clear
                            </button>
                          )}
                        </PopoverContent>
                      </Popover>

                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <button className="bg-card border border-border rounded-full w-7 h-7 flex items-center justify-center shadow hover:bg-accent text-muted-foreground hover:text-foreground">
                            <MoreVertical className="w-3.5 h-3.5" />
                          </button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align={m.direction === "outgoing" ? "start" : "end"}>
                          <DropdownMenuItem onClick={() => onMsgAction(m, "reply")}>
                            <Reply className="w-4 h-4 mr-2" />
                            Reply
                          </DropdownMenuItem>
                          {m.content && (
                            <DropdownMenuItem onClick={() => onMsgAction(m, "copy")}>
                              <Copy className="w-4 h-4 mr-2" />
                              Copy
                            </DropdownMenuItem>
                          )}
                          {m.direction === "outgoing" && m.content && !m.media_url && (
                            <DropdownMenuItem onClick={() => onMsgAction(m, "edit")}>
                              <Pencil className="w-4 h-4 mr-2" />
                              Edit
                            </DropdownMenuItem>
                          )}
                          {m.direction === "outgoing" && (
                            <DropdownMenuItem
                              onClick={() => onMsgAction(m, "delete")}
                              className="text-destructive"
                            >
                              <Trash2 className="w-4 h-4 mr-2" />
                              Delete
                            </DropdownMenuItem>
                          )}
                        </DropdownMenuContent>
                      </DropdownMenu>
                    </div>
                  )}
                </div>
              </div>
            </div>
          );
        })}
      </div>

      {(replyTo || editing) && (
        <div className="px-4 py-2 border-t border-border glass flex items-center gap-2">
          <div className="flex-1 min-w-0 border-l-2 border-primary pl-2">
            <div className="text-xs font-medium text-primary">
              {editing
                ? "Editing message"
                : `Replying to ${replyTo?.direction === "outgoing" ? "yourself" : conversation.title}`}
            </div>
            <div className="text-xs truncate text-muted-foreground">
              {(editing ?? replyTo)?.content ?? (editing ?? replyTo)?.media_type ?? ""}
            </div>
          </div>
          <Button
            variant="ghost"
            size="icon"
            onClick={() => {
              setReplyTo(null);
              setEditing(null);
              setText("");
            }}
          >
            <X className="w-4 h-4" />
          </Button>
        </div>
      )}

      <div className="p-3 md:p-4 border-t border-border glass">
        <div className="flex items-center gap-2">
          <Popover>
            <PopoverTrigger asChild>
              <Button variant="ghost" size="icon" className="shrink-0">
                <Smile className="w-5 h-5" />
              </Button>
            </PopoverTrigger>
            <PopoverContent side="top" className="w-72 p-2">
              <div className="grid grid-cols-8 gap-1 max-h-64 overflow-y-auto">
                {EMOJIS.map((e) => (
                  <button
                    key={e}
                    onClick={() => setText((t) => t + e)}
                    className="text-2xl hover:bg-accent rounded p-1"
                  >
                    {e}
                  </button>
                ))}
              </div>
            </PopoverContent>
          </Popover>

          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="icon" className="shrink-0">
                <Paperclip className="w-5 h-5" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent side="top" align="start">
              <DropdownMenuItem onClick={() => imageInputRef.current?.click()}>
                <ImageIcon className="w-4 h-4 mr-2" />
                Photo
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => fileInputRef.current?.click()}>
                <FileText className="w-4 h-4 mr-2" />
                Document
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>

          <input
            ref={imageInputRef}
            type="file"
            accept="image/*"
            hidden
            onChange={(e) => handleFile(e, "photo")}
          />
          <input
            ref={fileInputRef}
            type="file"
            hidden
            onChange={(e) => handleFile(e, "document")}
          />

          <Button
            type="button"
            variant="ghost"
            size="icon"
            onClick={getAiSuggestion}
            disabled={suggesting}
            title="Suggest AI Reply"
            className={`shrink-0 transition-all ${suggesting ? "animate-pulse text-amber-400" : "text-muted-foreground hover:text-amber-500 hover:bg-amber-500/10"}`}
          >
            <Sparkles className="w-5 h-5" />
          </Button>

          <Input
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                send();
              }
            }}
            placeholder={editing ? "Edit message…" : "Message"}
            className="rounded-full h-11 bg-card border-border"
          />

          {text.trim() || editing ? (
            <Button
              onClick={send}
              disabled={sending}
              size="icon"
              className="rounded-full w-11 h-11 shrink-0"
            >
              <Send className="w-4 h-4" />
            </Button>
          ) : recording ? (
            <Button
              onClick={stopRecording}
              size="icon"
              variant="destructive"
              className="rounded-full w-11 h-11 shrink-0 animate-pulse"
            >
              <Square className="w-4 h-4" />
            </Button>
          ) : (
            <Button
              onClick={startRecording}
              size="icon"
              className="rounded-full w-11 h-11 shrink-0"
            >
              <Mic className="w-4 h-4" />
            </Button>
          )}
        </div>
        {recording && (
          <div className="text-xs text-destructive mt-1 text-center">
            ● Recording… tap stop to send
          </div>
        )}
      </div>

      <Sheet open={profileOpen} onOpenChange={setProfileOpen}>
        <SheetContent side="right" className="w-full sm:max-w-sm">
          <SheetHeader>
            <SheetTitle>User info</SheetTitle>
          </SheetHeader>
          <div className="mt-6 flex flex-col items-center text-center">
            <Avatar className="w-24 h-24 mb-3">
              {conversation.telegram_photo_url ? (
                <img
                  src={conversation.telegram_photo_url}
                  alt=""
                  className="w-full h-full object-cover"
                />
              ) : (
                <AvatarFallback className="text-2xl bg-gradient-to-br from-primary to-primary/60 text-primary-foreground">
                  {initials}
                </AvatarFallback>
              )}
            </Avatar>
            <div className="text-lg font-semibold">{conversation.title}</div>
            {conversation.telegram_username && (
              <div className="text-sm text-muted-foreground">@{conversation.telegram_username}</div>
            )}
            <div className="mt-6 w-full space-y-3 text-sm">
              <Row label="Telegram chat ID" value={String(conversation.telegram_chat_id)} />
              {conversation.telegram_first_name && (
                <Row label="First name" value={conversation.telegram_first_name} />
              )}
              {conversation.telegram_last_name && (
                <Row label="Last name" value={conversation.telegram_last_name} />
              )}
            </div>
          </div>
        </SheetContent>
      </Sheet>
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between items-center py-2 border-b border-border">
      <span className="text-muted-foreground">{label}</span>
      <span className="font-medium truncate ml-2">{value}</span>
    </div>
  );
}
