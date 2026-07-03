import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { useAuth } from "@/hooks/useAuth";
import { ChatSidebar, type Conversation } from "@/components/chat/ChatSidebar";
import { ChatView } from "@/components/chat/ChatView";

export const Route = createFileRoute("/")({
  component: ChatApp,
});

function ChatApp() {
  const { user, loading } = useAuth();
  const navigate = useNavigate();
  const [selected, setSelected] = useState<Conversation | null>(null);

  useEffect(() => {
    if (!loading && !user) navigate({ to: "/auth" });
  }, [loading, user, navigate]);

  if (loading || !user) {
    return (
      <div className="min-h-screen flex items-center justify-center chat-bg">
        <div className="text-sm text-muted-foreground">Loading…</div>
      </div>
    );
  }

  return (
    <div className="h-screen flex bg-background overflow-hidden">
      <div className={`${selected ? "hidden md:flex" : "flex"} w-full md:w-auto`}>
        <ChatSidebar selectedId={selected?.id ?? null} onSelect={setSelected} />
      </div>
      <div className={`${selected ? "flex" : "hidden md:flex"} flex-1`}>
        <ChatView conversation={selected} onBack={() => setSelected(null)} />
      </div>
    </div>
  );
}
