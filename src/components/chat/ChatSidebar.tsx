import { useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { useAuth } from "@/hooks/useAuth";
import { useTheme } from "@/hooks/useTheme";
import {
  Moon,
  Sun,
  Search,
  LogOut,
  MessageCircle,
  RefreshCw,
  AlertTriangle,
  CheckCircle2,
} from "lucide-react";
import { formatDistanceToNowStrict } from "date-fns";

export type Conversation = {
  id: string;
  title: string | null;
  telegram_chat_id: number;
  last_message_text: string | null;
  last_message_at: string | null;
  unread_count: number;
  telegram_username?: string | null;
  telegram_first_name?: string | null;
  telegram_last_name?: string | null;
  telegram_photo_url?: string | null;
  ai_enabled?: boolean;
  human_replied?: boolean;
};

export function ChatSidebar({
  selectedId,
  onSelect,
}: {
  selectedId: string | null;
  onSelect: (c: Conversation) => void;
}) {
  const { user, signOut } = useAuth();
  const { theme, toggle } = useTheme();
  const [convs, setConvs] = useState<Conversation[]>([]);
  const [search, setSearch] = useState("");
  const [webhookInfo, setWebhookInfo] = useState<{
    url: string;
    pendingCount: number;
    hasError?: string;
    isDev?: boolean;
  } | null>(null);
  const [isSyncing, setIsSyncing] = useState(false);

  const syncWebhook = async () => {
    setIsSyncing(true);
    try {
      const res = await fetch("/api/tg-auth/setup-webhook");
      const d = await res.json();
      if (d.success) {
        setWebhookInfo({
          url: d.currentWebhookInfo?.result?.url || d.webhookUrl || "",
          pendingCount: d.currentWebhookInfo?.result?.pending_update_count ?? 0,
          isDev: d.isDev,
        });
      } else {
        setWebhookInfo({
          url: "",
          pendingCount: 0,
          hasError: d.error || "Failed to set up Telegram Webhook",
        });
      }
    } catch (err) {
      setWebhookInfo({
        url: "",
        pendingCount: 0,
        hasError: "Unable to reach verification server.",
      });
    } finally {
      setIsSyncing(false);
    }
  };

  useEffect(() => {
    if (!user) return;
    syncWebhook();
    // Poll every 30 seconds to monitor bot health and updates
    const timer = setInterval(syncWebhook, 30000);
    return () => clearInterval(timer);
  }, [user]);

  useEffect(() => {
    if (!user) return;
    let active = true;

    const load = async () => {
      const { data } = await supabase
        .from("conversations")
        .select(
          "id,title,telegram_chat_id,last_message_text,last_message_at,unread_count,telegram_username,telegram_first_name,telegram_last_name,telegram_photo_url,ai_enabled,human_replied",
        )
        .order("last_message_at", { ascending: false, nullsFirst: false });
      if (active && data) setConvs(data as Conversation[]);
    };
    load();

    const channel = supabase
      .channel("conversations-changes")
      .on("postgres_changes", { event: "*", schema: "public", table: "conversations" }, () =>
        load(),
      )
      .subscribe();

    return () => {
      active = false;
      supabase.removeChannel(channel);
    };
  }, [user]);

  const q = search.toLowerCase();
  const filtered = convs.filter((c) =>
    [c.title, c.telegram_username, c.telegram_first_name, c.telegram_last_name]
      .filter(Boolean)
      .some((s) => (s as string).toLowerCase().includes(q)),
  );

  const initials = (s: string | null) =>
    (s ?? "?")
      .split(" ")
      .map((p) => p[0])
      .filter(Boolean)
      .slice(0, 2)
      .join("")
      .toUpperCase();

  return (
    <aside className="w-full md:w-80 lg:w-96 border-r border-border bg-sidebar flex flex-col h-full">
      <header className="p-4 border-b border-border flex items-center gap-3">
        <Avatar className="w-10 h-10">
          <AvatarFallback className="bg-primary text-primary-foreground">
            {initials(user?.email ?? "U")}
          </AvatarFallback>
        </Avatar>
        <div className="flex-1 min-w-0">
          <div className="font-semibold truncate">{user?.email}</div>
          <div className="text-xs text-muted-foreground">Online</div>
        </div>
        <Button variant="ghost" size="icon" onClick={toggle} aria-label="Toggle theme">
          {theme === "dark" ? <Sun className="w-4 h-4" /> : <Moon className="w-4 h-4" />}
        </Button>
        <Button variant="ghost" size="icon" onClick={signOut} aria-label="Sign out">
          <LogOut className="w-4 h-4" />
        </Button>
      </header>

      {/* Bot Webhook Connection Health Monitor */}
      <div className="px-4 py-2.5 bg-muted/40 border-b border-border text-xs flex flex-col gap-1.5">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-1.5">
            <span
              className={`w-2 h-2 rounded-full ${webhookInfo?.url || webhookInfo?.isDev ? "bg-emerald-500 animate-pulse" : webhookInfo?.hasError ? "bg-destructive animate-pulse" : "bg-amber-500 animate-pulse"}`}
            />
            <span className="font-semibold uppercase tracking-wider text-[10px] text-muted-foreground">
              Bot Connection:{" "}
              {webhookInfo?.url
                ? "Online (Webhook)"
                : webhookInfo?.isDev
                  ? "Online (Polling)"
                  : webhookInfo?.hasError
                    ? "Config Error"
                    : "Connecting..."}
            </span>
          </div>
          <Button
            variant="ghost"
            size="sm"
            className="h-6 px-2 text-[10px] hover:bg-accent flex items-center gap-1 font-medium text-primary"
            onClick={syncWebhook}
            disabled={isSyncing}
          >
            <RefreshCw className={`w-2.5 h-2.5 ${isSyncing ? "animate-spin" : ""}`} />
            Sync Status
          </Button>
        </div>
        {webhookInfo && (
          <div className="space-y-0.5 text-muted-foreground text-[11px] leading-relaxed">
            {webhookInfo.hasError ? (
              <div className="flex items-start gap-1 text-destructive font-medium bg-destructive/10 p-1.5 rounded">
                <AlertTriangle className="w-3.5 h-3.5 shrink-0 mt-0.5" />
                <p>{webhookInfo.hasError}</p>
              </div>
            ) : (
              <>
                <div className="flex items-center gap-1 truncate text-emerald-600 dark:text-emerald-400 font-medium">
                  <CheckCircle2 className="w-3 h-3 shrink-0" />
                  <span>
                    {webhookInfo.isDev
                      ? "Polling Active (Auto-Refresh)"
                      : "Webhook Active (24/7 Enabled)"}
                  </span>
                </div>
                {webhookInfo.pendingCount > 0 && (
                  <div className="flex items-center gap-1 text-amber-600 dark:text-amber-400 font-medium">
                    <AlertTriangle className="w-3 h-3 shrink-0" />
                    <span>{webhookInfo.pendingCount} pending messages in queue</span>
                  </div>
                )}
              </>
            )}
          </div>
        )}
      </div>

      <div className="p-3 border-b border-border">
        <div className="relative">
          <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search chats"
            className="pl-9 rounded-full bg-muted border-0"
          />
        </div>
      </div>

      <div className="flex-1 overflow-y-auto scroll-thin">
        {filtered.length === 0 ? (
          <div className="p-8 text-center text-sm text-muted-foreground">
            <MessageCircle className="w-10 h-10 mx-auto mb-3 opacity-40" />
            <p className="font-medium mb-1">No chats yet</p>
            <p className="text-xs">
              Open Telegram and send a message to your bot. It will appear here instantly.
            </p>
          </div>
        ) : (
          filtered.map((c) => (
            <button
              key={c.id}
              onClick={() => onSelect(c)}
              className={`w-full flex items-center gap-3 px-4 py-3 hover:bg-accent/50 transition-colors text-left ${
                selectedId === c.id ? "bg-accent" : ""
              }`}
            >
              <Avatar className="w-12 h-12">
                {c.telegram_photo_url ? (
                  <img
                    src={c.telegram_photo_url}
                    alt={c.title ?? ""}
                    className="w-full h-full object-cover"
                  />
                ) : (
                  <AvatarFallback className="bg-gradient-to-br from-primary to-primary/60 text-primary-foreground font-medium">
                    {initials(c.title)}
                  </AvatarFallback>
                )}
              </Avatar>
              <div className="flex-1 min-w-0">
                <div className="flex items-center justify-between gap-2">
                  <span className="font-medium truncate">
                    {c.title ?? `Chat ${c.telegram_chat_id}`}
                  </span>
                  {c.last_message_at && (
                    <span className="text-xs text-muted-foreground shrink-0">
                      {formatDistanceToNowStrict(new Date(c.last_message_at), { addSuffix: false })}
                    </span>
                  )}
                </div>
                <div className="flex items-center justify-between gap-2 mt-0.5">
                  <span className="text-sm text-muted-foreground truncate">
                    {c.last_message_text ?? "No messages yet"}
                  </span>
                  {c.unread_count > 0 && (
                    <span className="bg-primary text-primary-foreground text-xs font-medium rounded-full min-w-5 h-5 px-1.5 flex items-center justify-center">
                      {c.unread_count}
                    </span>
                  )}
                </div>
              </div>
            </button>
          ))
        )}
      </div>
    </aside>
  );
}
