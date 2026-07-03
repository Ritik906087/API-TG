
-- Drop existing chat-media policies if any
DO $$
DECLARE p record;
BEGIN
  FOR p IN SELECT policyname FROM pg_policies WHERE schemaname='storage' AND tablename='objects' AND policyname LIKE 'chat-media %'
  LOOP EXECUTE format('DROP POLICY %I ON storage.objects', p.policyname); END LOOP;
END $$;

CREATE POLICY "chat-media read authenticated" ON storage.objects
  FOR SELECT TO authenticated USING (bucket_id = 'chat-media');

CREATE POLICY "chat-media insert authenticated" ON storage.objects
  FOR INSERT TO authenticated WITH CHECK (bucket_id = 'chat-media');

CREATE POLICY "chat-media update authenticated" ON storage.objects
  FOR UPDATE TO authenticated USING (bucket_id = 'chat-media');

CREATE POLICY "chat-media delete authenticated" ON storage.objects
  FOR DELETE TO authenticated USING (bucket_id = 'chat-media');
