
ALTER TABLE public.conversations
  ADD COLUMN IF NOT EXISTS telegram_user_id bigint,
  ADD COLUMN IF NOT EXISTS telegram_username text,
  ADD COLUMN IF NOT EXISTS telegram_first_name text,
  ADD COLUMN IF NOT EXISTS telegram_last_name text,
  ADD COLUMN IF NOT EXISTS telegram_photo_url text,
  ADD COLUMN IF NOT EXISTS human_replied boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS ai_enabled boolean NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS started boolean NOT NULL DEFAULT false;

CREATE INDEX IF NOT EXISTS idx_conversations_telegram_username
  ON public.conversations (telegram_username);
