-- Add reaction column to messages table
ALTER TABLE public.messages
  ADD COLUMN IF NOT EXISTS reaction text;
