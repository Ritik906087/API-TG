import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect, useState, useRef } from "react";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { toast } from "sonner";
import {
  MessageCircle,
  ExternalLink,
  Loader2,
  ArrowLeft,
  KeyRound,
  CheckCircle2,
  AlertTriangle,
  Info,
} from "lucide-react";

export const Route = createFileRoute("/auth")({
  component: AuthPage,
});

function AuthPage() {
  const navigate = useNavigate();
  const [step, setStep] = useState<"init" | "verify">("init");
  const [token, setToken] = useState<string | null>(null);
  const [otp, setOtp] = useState("");
  const [loading, setLoading] = useState(false);
  const [botStatus, setBotStatus] = useState<"pending" | "otp_sent" | "verified">("pending");
  const [telegramUsername, setTelegramUsername] = useState<string | null>(null);
  const [showTroubleshooting, setShowTroubleshooting] = useState(false);
  const [isIframe, setIsIframe] = useState(false);

  const pollingRef = useRef<NodeJS.Timeout | null>(null);

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => {
      if (data.session) {
        navigate({ to: "/" });
      }
    });

    setIsIframe(typeof window !== "undefined" && window.self !== window.top);

    return () => {
      if (pollingRef.current) clearInterval(pollingRef.current);
    };
  }, [navigate]);

  // Handle "Check to Login" initialization
  const handleCheckToLogin = async () => {
    setLoading(true);
    try {
      const response = await fetch("/api/tg-auth/create", { method: "POST" });
      if (!response.ok) throw new Error("Failed to initialize login session");

      const data = await response.json();
      const sessionToken = data.token;
      setToken(sessionToken);
      setStep("verify");
      setBotStatus("pending");
      setOtp("");

      // Automatically open Telegram bot in a new tab
      const botUrl = `https://t.me/FLEX_PAY_ROBOT?start=${sessionToken}`;
      window.open(botUrl, "_blank");

      toast.success("Opening Telegram bot! Please click Start.");

      // Start polling status
      startPolling(sessionToken);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } catch (err: any) {
      console.error("Login initialization error:", err);
      const errStr = String(err).toLowerCase();
      const isFetchError =
        errStr.includes("failed to fetch") ||
        err.message?.toLowerCase()?.includes("failed to fetch");
      if (isFetchError) {
        setShowTroubleshooting(true);
        toast.error("Network or Cookie check blocked. Please see the troubleshooting guide.");
      } else {
        toast.error(err.message ?? "Failed to connect to login server");
      }
    } finally {
      setLoading(false);
    }
  };

  // Poll server for session status updates
  const startPolling = (sessionToken: string) => {
    if (pollingRef.current) clearInterval(pollingRef.current);

    pollingRef.current = setInterval(async () => {
      try {
        const response = await fetch(`/api/tg-auth/status?token=${sessionToken}`);
        if (!response.ok) return; // ignore transient errors

        const data = await response.json();
        if (data.success) {
          setBotStatus(data.status);
          if (data.username) {
            setTelegramUsername(data.username);
          }

          if (data.status === "otp_sent") {
            // We can notify the user
            toast.success("Code received on Telegram!");
          }
        }
      } catch (err) {
        console.error("Polling error:", err);
      }
    }, 2000);
  };

  // Verify the OTP and log in
  const handleVerifyOtp = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!token) return;
    if (otp.length < 6) {
      toast.error("Please enter the complete 6-digit code.");
      return;
    }

    setLoading(true);
    try {
      const response = await fetch("/api/tg-auth/verify", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token, otp }),
      });

      const data = await response.json();
      if (!response.ok || !data.success) {
        throw new Error(data.error ?? "Invalid OTP code");
      }

      if (pollingRef.current) {
        clearInterval(pollingRef.current);
        pollingRef.current = null;
      }

      // Sign in locally with Supabase
      const { error: signInError } = await supabase.auth.signInWithPassword({
        email: data.email,
        password: data.password,
      });

      if (signInError) throw signInError;

      toast.success("Successfully logged in!");
      navigate({ to: "/" });
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } catch (err: any) {
      console.error("Login verification error:", err);
      const errStr = String(err).toLowerCase();
      const isFetchError =
        errStr.includes("failed to fetch") ||
        err.message?.toLowerCase()?.includes("failed to fetch");
      if (isFetchError) {
        setShowTroubleshooting(true);
        toast.error("Network or Cookie check blocked. Please see the troubleshooting guide.");
      } else {
        toast.error(err.message ?? "Verification failed");
      }
    } finally {
      setLoading(false);
    }
  };

  const handleBackToStart = () => {
    if (pollingRef.current) {
      clearInterval(pollingRef.current);
      pollingRef.current = null;
    }
    setStep("init");
    setToken(null);
    setBotStatus("pending");
    setTelegramUsername(null);
  };

  return (
    <div className="min-h-screen flex flex-col items-center justify-center chat-bg p-4 bg-slate-950 text-slate-100 gap-4">
      <div className="glass rounded-2xl shadow-2xl p-8 w-full max-w-md border border-slate-800 animate-pop bg-slate-900/60 backdrop-blur-md">
        {isIframe && (
          <div className="mb-6 p-4 rounded-xl bg-amber-950/40 border border-amber-900/40 text-amber-200 text-xs flex flex-col gap-2">
            <div className="flex items-start gap-2">
              <AlertTriangle className="w-4 h-4 text-amber-500 shrink-0 mt-0.5" />
              <div>
                <span className="font-semibold">Embedded Preview Sandbox:</span> Browser privacy
                controls may block secure Telegram Bot requests inside iframes.
              </div>
            </div>
            <Button
              onClick={() => window.open(window.location.href, "_blank")}
              variant="outline"
              className="w-full h-9 text-xs border-amber-700/60 bg-amber-950/30 hover:bg-amber-900/40 text-amber-100 hover:text-white"
            >
              Open in New Tab for 100% Success
              <ExternalLink className="w-3.5 h-3.5 ml-1" />
            </Button>
          </div>
        )}

        {step === "init" ? (
          <div className="flex flex-col items-center">
            <div className="w-20 h-20 rounded-full bg-[#0088cc] text-white flex items-center justify-center mb-6 shadow-lg shadow-[#0088cc]/20 animate-pulse">
              <MessageCircle className="w-10 h-10" />
            </div>

            <h1 className="text-3xl font-bold text-center tracking-tight text-white mb-2">
              Cloudflare Chat Spark
            </h1>
            <p className="text-sm text-slate-400 text-center mb-8 max-w-xs leading-relaxed">
              Sign in securely using our Telegram Bot. No passwords or emails required.
            </p>

            <Button
              onClick={handleCheckToLogin}
              disabled={loading}
              className="w-full h-12 text-base font-semibold bg-[#0088cc] hover:bg-[#007bb6] text-white rounded-xl shadow-lg shadow-[#0088cc]/10 transition-all duration-200 flex items-center justify-center gap-2 border-0"
            >
              {loading ? (
                <>
                  <Loader2 className="w-5 h-5 animate-spin" />
                  Generating session...
                </>
              ) : (
                <>
                  Check to Login
                  <ExternalLink className="w-4 h-4" />
                </>
              )}
            </Button>

            <div className="mt-8 flex items-center gap-2 justify-center text-xs text-slate-500">
              <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 animate-ping"></span>
              Secure end-to-end encryption
            </div>
          </div>
        ) : (
          <div>
            <button
              onClick={handleBackToStart}
              className="flex items-center gap-1.5 text-xs text-slate-400 hover:text-white transition-colors mb-6 border-0 bg-transparent cursor-pointer p-0"
            >
              <ArrowLeft className="w-4 h-4" />
              Go Back
            </button>

            <div className="flex flex-col items-center mb-6">
              <div className="w-14 h-14 rounded-full bg-slate-800 text-slate-300 flex items-center justify-center mb-3">
                <KeyRound className="w-6 h-6" />
              </div>
              <h1 className="text-xl font-bold text-white mb-1">Telegram Verification</h1>
              <p className="text-xs text-slate-400 text-center">
                Awaiting your action in the Telegram App
              </p>
            </div>

            <div className="space-y-4 mb-6">
              <div className="p-4 rounded-xl border border-slate-800 bg-slate-950/40 text-sm space-y-3">
                {botStatus === "pending" ? (
                  <div className="flex items-start gap-3">
                    <Loader2 className="w-5 h-5 text-[#0088cc] animate-spin mt-0.5 shrink-0" />
                    <div>
                      <p className="font-medium text-slate-200">Waiting for bot activation...</p>
                      <p className="text-xs text-slate-400 mt-1">
                        Please open Telegram and click the{" "}
                        <strong className="text-white">Start</strong> button in your conversation
                        with <span className="text-[#0088cc]">@FLEX_PAY_ROBOT</span>.
                      </p>
                    </div>
                  </div>
                ) : (
                  <div className="flex items-start gap-3">
                    <CheckCircle2 className="w-5 h-5 text-emerald-500 mt-0.5 shrink-0" />
                    <div>
                      <p className="font-medium text-emerald-400">Bot Activated!</p>
                      {telegramUsername && (
                        <p className="text-xs text-slate-300 mt-0.5">
                          Detected user: <strong className="text-white">@{telegramUsername}</strong>
                        </p>
                      )}
                      <p className="text-xs text-slate-400 mt-1">
                        We sent a 6-digit code to your Telegram chat. Enter it below to sign in.
                      </p>
                    </div>
                  </div>
                )}
              </div>

              <Button
                variant="outline"
                className="w-full h-10 text-xs border-slate-800 hover:bg-slate-800 hover:text-white"
                onClick={() => window.open(`https://t.me/FLEX_PAY_ROBOT?start=${token}`, "_blank")}
              >
                Open Telegram Bot Chat
                <ExternalLink className="w-3.5 h-3.5 ml-1.5" />
              </Button>
            </div>

            <form onSubmit={handleVerifyOtp} className="space-y-4">
              <div className="space-y-1.5">
                <Label htmlFor="otp" className="text-slate-300 text-xs font-semibold">
                  6-Digit OTP Code
                </Label>
                <Input
                  id="otp"
                  type="text"
                  maxLength={6}
                  required
                  value={otp}
                  onChange={(e) => setOtp(e.target.value.replace(/\D/g, ""))}
                  placeholder="e.g. 123456"
                  disabled={botStatus === "pending" || loading}
                  className="h-12 text-center text-xl font-bold tracking-widest bg-slate-950 border-slate-800 text-white rounded-xl placeholder:tracking-normal placeholder:text-sm placeholder:font-normal"
                />
              </div>

              <Button
                type="submit"
                disabled={botStatus === "pending" || loading || otp.length < 6}
                className="w-full h-12 text-base font-semibold bg-emerald-600 hover:bg-emerald-500 disabled:bg-slate-800 disabled:text-slate-500 text-white rounded-xl transition-all duration-200 border-0"
              >
                {loading ? (
                  <>
                    <Loader2 className="w-5 h-5 animate-spin mr-2" />
                    Verifying...
                  </>
                ) : (
                  "Verify & Login"
                )}
              </Button>
            </form>
          </div>
        )}
      </div>

      {(showTroubleshooting || isIframe) && (
        <div className="w-full max-w-md p-5 rounded-2xl border border-slate-800 bg-slate-900/40 backdrop-blur-md text-xs space-y-3">
          <div className="flex items-center gap-1.5 text-slate-300 font-semibold uppercase tracking-wider text-[10px]">
            <Info className="w-3.5 h-3.5 text-[#0088cc]" />
            Authentication Troubleshooting Guide
          </div>
          <ul className="space-y-2 text-slate-400 list-disc list-inside">
            <li>
              <span className="text-slate-200 font-medium">Why "Failed to fetch" happens:</span>{" "}
              Browsers enforce strict cross-site request forgery and cookie policies on websites
              loaded inside frames (like the Google AI Studio preview window).
            </li>
            <li>
              <span className="text-slate-200 font-medium">The Direct Solution:</span> Open this
              application directly in its own tab by clicking the{" "}
              <span className="text-emerald-400 font-semibold">Open in New Tab</span> button above
              or in the top-right corner of the workspace preview.
            </li>
            <li>
              <span className="text-slate-200 font-medium">Server Booting:</span> If you just made
              changes, the backend server might take 5-10 seconds to compile and restart. Please
              reload and try again.
            </li>
          </ul>
        </div>
      )}
    </div>
  );
}
