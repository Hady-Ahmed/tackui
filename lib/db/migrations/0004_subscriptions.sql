-- 0004_subscriptions.sql — SaaS billing subscriptions.
--
-- Tracks the per-org Stripe subscription so the plan-enforcement layer
-- (lib/plans/limits.ts) can read which plan an org is on without a
-- round-trip to Stripe on every request. The webhook handler
-- (app/api/billing/webhook/route.ts) is the sole writer — it upserts a
-- row on every checkout.session.completed / customer.subscription.updated
-- event and deletes on customer.subscription.deleted.
--
-- `org_id` is the PRIMARY KEY — an org has exactly one subscription at a
-- time. Mirrors the loose-coupling pattern used by the agents +
-- thread_metadata tables (TEXT org_id, no FK to better-auth's
-- `organization` table, which is owned by Better Auth's own migrations).
--
-- Only created under SaaS mode (`SAAS_MODE=true`); self-host deployments
-- never write to it (the runner's getPlanLimits returns the unlimited
-- sentinel when !SAAS_MODE). Safe to ship in the OSS repo — the table is
-- inert without the SaaS code paths.

CREATE TABLE IF NOT EXISTS subscriptions (
  org_id                 TEXT        PRIMARY KEY,
  stripe_customer_id     TEXT        NOT NULL,
  stripe_subscription_id TEXT        NOT NULL,
  -- 'free' | 'pro' | 'team'. 'free' rows are only written when a paid
  -- subscription is cancelled (downgrade); an org with no row at all is
  -- also treated as 'free' by getOrgPlan().
  plan                   TEXT        NOT NULL DEFAULT 'free',
  status                 TEXT        NOT NULL DEFAULT 'active',
  seats                  INTEGER     NOT NULL DEFAULT 1,
  current_period_end     TIMESTAMPTZ,
  created_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at             TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_subscriptions_stripe_customer
  ON subscriptions (stripe_customer_id);
CREATE INDEX IF NOT EXISTS idx_subscriptions_stripe_subscription
  ON subscriptions (stripe_subscription_id);
