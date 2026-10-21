CREATE TABLE "share_redemptions" (
	"share_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "share_redemptions_share_id_user_id_pk" PRIMARY KEY("share_id","user_id")
);
--> statement-breakpoint
ALTER TABLE "share_redemptions" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "shares" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"cairn_id" uuid NOT NULL,
	"grantee_email" text,
	"link_token_hash" text,
	"role" text NOT NULL,
	"visibility" text NOT NULL,
	"expires_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "shares_link_token_hash_unique" UNIQUE("link_token_hash"),
	CONSTRAINT "shares_grantee_check" CHECK (("shares"."grantee_email" is null) <> ("shares"."link_token_hash" is null)),
	CONSTRAINT "shares_email_check" CHECK ("shares"."grantee_email" = lower("shares"."grantee_email")),
	CONSTRAINT "shares_role_check" CHECK ("shares"."role" in ('viewer', 'editor')),
	CONSTRAINT "shares_visibility_check" CHECK ("shares"."visibility" in ('cited', 'sealed')),
	CONSTRAINT "shares_editor_cited_check" CHECK ("shares"."role" <> 'editor' or "shares"."visibility" = 'cited')
);
--> statement-breakpoint
ALTER TABLE "shares" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "query_log" ADD COLUMN "share_id" uuid;--> statement-breakpoint
ALTER TABLE "share_redemptions" ADD CONSTRAINT "share_redemptions_share_id_shares_id_fk" FOREIGN KEY ("share_id") REFERENCES "public"."shares"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "share_redemptions" ADD CONSTRAINT "share_redemptions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shares" ADD CONSTRAINT "shares_cairn_id_cairns_id_fk" FOREIGN KEY ("cairn_id") REFERENCES "public"."cairns"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shares" ADD CONSTRAINT "shares_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "share_redemptions_user_id_idx" ON "share_redemptions" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "shares_cairn_id_idx" ON "shares" USING btree ("cairn_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "shares_cairn_email_key" ON "shares" USING btree ("cairn_id","grantee_email") WHERE "shares"."grantee_email" is not null and "shares"."revoked_at" is null;--> statement-breakpoint
ALTER TABLE "query_log" ADD CONSTRAINT "query_log_share_id_shares_id_fk" FOREIGN KEY ("share_id") REFERENCES "public"."shares"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
-- Hand-written (drizzle-kit doesn't manage functions). Both run as the migration role (the table
-- owner), so they read shares and cairns without RLS; the policies below call cairn_access().
-- The caller's access to a cairn as one row, or no row: the owner, else their best active share
-- (editor before viewer, cited before sealed). A share covers the caller by verified email, or
-- through a redeemed link.
CREATE FUNCTION cairn_access(p_cairn_id uuid)
RETURNS TABLE (role text, visibility text, share_id uuid)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp
AS $$
  WITH me AS (SELECT nullif(current_setting('app.user_id', true), '')::uuid AS id)
  SELECT 'owner', 'cited', NULL::uuid
    FROM cairns c, me
   WHERE c.id = p_cairn_id AND c.owner_id = me.id
  UNION ALL
  (SELECT s.role, s.visibility, s.id
     FROM shares s, me
    WHERE s.cairn_id = p_cairn_id
      AND NOT EXISTS (SELECT 1 FROM cairns c WHERE c.id = p_cairn_id AND c.owner_id = me.id)
      AND s.revoked_at IS NULL
      AND (s.expires_at IS NULL OR s.expires_at > now())
      AND (s.grantee_email = (SELECT lower(u.email) FROM users u WHERE u.id = me.id)
           OR EXISTS (SELECT 1 FROM share_redemptions r WHERE r.share_id = s.id AND r.user_id = me.id))
    ORDER BY s.role = 'editor' DESC, s.visibility = 'cited' DESC, s.created_at
    LIMIT 1)
$$;
--> statement-breakpoint
-- Records that the current user opened an active link share; returns its cairn id, or no row
-- when the token matches no active link. Redeeming twice is a no-op.
CREATE FUNCTION redeem_share_link(p_token_hash text)
RETURNS TABLE (cairn_id uuid)
LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path = public, pg_temp
AS $$
  WITH me AS (SELECT nullif(current_setting('app.user_id', true), '')::uuid AS id),
  share AS (
    SELECT s.id, s.cairn_id
      FROM shares s, me
     WHERE s.link_token_hash = p_token_hash
       AND s.revoked_at IS NULL
       AND (s.expires_at IS NULL OR s.expires_at > now())
       AND me.id IS NOT NULL
  ),
  redeemed AS (
    INSERT INTO share_redemptions (share_id, user_id)
    SELECT share.id, me.id FROM share, me
    ON CONFLICT DO NOTHING
  )
  SELECT share.cairn_id FROM share
$$;
--> statement-breakpoint
DROP POLICY "cairns_owner" ON "cairns" CASCADE;--> statement-breakpoint
DROP POLICY "chunks_cairn" ON "chunks" CASCADE;--> statement-breakpoint
DROP POLICY "query_log_cairn" ON "query_log" CASCADE;--> statement-breakpoint
DROP POLICY "sources_cairn" ON "sources" CASCADE;--> statement-breakpoint
CREATE POLICY "cairns_read" ON "cairns" AS PERMISSIVE FOR SELECT TO public USING ("cairns"."owner_id" = nullif(current_setting('app.user_id', true), '')::uuid or exists (select 1 from cairn_access("cairns"."id")));--> statement-breakpoint
CREATE POLICY "cairns_insert" ON "cairns" AS PERMISSIVE FOR INSERT TO public WITH CHECK ("cairns"."owner_id" = nullif(current_setting('app.user_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "cairns_update" ON "cairns" AS PERMISSIVE FOR UPDATE TO public USING ("cairns"."owner_id" = nullif(current_setting('app.user_id', true), '')::uuid) WITH CHECK ("cairns"."owner_id" = nullif(current_setting('app.user_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "cairns_delete" ON "cairns" AS PERMISSIVE FOR DELETE TO public USING ("cairns"."owner_id" = nullif(current_setting('app.user_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "chunks_read" ON "chunks" AS PERMISSIVE FOR SELECT TO public USING (exists (select 1 from cairns c where c.id = "chunks"."cairn_id"));--> statement-breakpoint
CREATE POLICY "chunks_insert" ON "chunks" AS PERMISSIVE FOR INSERT TO public WITH CHECK (exists (select 1 from cairn_access("chunks"."cairn_id") a where a.role in ('owner', 'editor')));--> statement-breakpoint
CREATE POLICY "chunks_update" ON "chunks" AS PERMISSIVE FOR UPDATE TO public USING (exists (select 1 from cairn_access("chunks"."cairn_id") a where a.role in ('owner', 'editor'))) WITH CHECK (exists (select 1 from cairn_access("chunks"."cairn_id") a where a.role in ('owner', 'editor')));--> statement-breakpoint
CREATE POLICY "chunks_delete" ON "chunks" AS PERMISSIVE FOR DELETE TO public USING (exists (select 1 from cairn_access("chunks"."cairn_id") a where a.role in ('owner', 'editor')));--> statement-breakpoint
CREATE POLICY "query_log_read" ON "query_log" AS PERMISSIVE FOR SELECT TO public USING ("query_log"."user_id" = nullif(current_setting('app.user_id', true), '')::uuid or exists (select 1 from cairns c where c.id = "query_log"."cairn_id" and c.owner_id = nullif(current_setting('app.user_id', true), '')::uuid));--> statement-breakpoint
CREATE POLICY "query_log_insert" ON "query_log" AS PERMISSIVE FOR INSERT TO public WITH CHECK ("query_log"."user_id" = nullif(current_setting('app.user_id', true), '')::uuid and exists (select 1 from cairns c where c.id = "query_log"."cairn_id"));--> statement-breakpoint
CREATE POLICY "sources_read" ON "sources" AS PERMISSIVE FOR SELECT TO public USING (exists (select 1 from cairns c where c.id = "sources"."cairn_id"));--> statement-breakpoint
CREATE POLICY "sources_insert" ON "sources" AS PERMISSIVE FOR INSERT TO public WITH CHECK (exists (select 1 from cairn_access("sources"."cairn_id") a where a.role in ('owner', 'editor')));--> statement-breakpoint
CREATE POLICY "sources_update" ON "sources" AS PERMISSIVE FOR UPDATE TO public USING (exists (select 1 from cairn_access("sources"."cairn_id") a where a.role in ('owner', 'editor'))) WITH CHECK (exists (select 1 from cairn_access("sources"."cairn_id") a where a.role in ('owner', 'editor')));--> statement-breakpoint
CREATE POLICY "sources_delete" ON "sources" AS PERMISSIVE FOR DELETE TO public USING (exists (select 1 from cairns c where c.id = "sources"."cairn_id" and c.owner_id = nullif(current_setting('app.user_id', true), '')::uuid));--> statement-breakpoint
CREATE POLICY "share_redemptions_read" ON "share_redemptions" AS PERMISSIVE FOR SELECT TO public USING ("share_redemptions"."user_id" = nullif(current_setting('app.user_id', true), '')::uuid or exists (select 1 from shares s where s.id = "share_redemptions"."share_id"));--> statement-breakpoint
CREATE POLICY "share_redemptions_delete" ON "share_redemptions" AS PERMISSIVE FOR DELETE TO public USING ("share_redemptions"."user_id" = nullif(current_setting('app.user_id', true), '')::uuid or exists (select 1 from shares s where s.id = "share_redemptions"."share_id"));--> statement-breakpoint
CREATE POLICY "shares_owner" ON "shares" AS PERMISSIVE FOR ALL TO public USING (exists (select 1 from cairns c where c.id = "shares"."cairn_id" and c.owner_id = nullif(current_setting('app.user_id', true), '')::uuid)) WITH CHECK (exists (select 1 from cairns c where c.id = "shares"."cairn_id" and c.owner_id = nullif(current_setting('app.user_id', true), '')::uuid));