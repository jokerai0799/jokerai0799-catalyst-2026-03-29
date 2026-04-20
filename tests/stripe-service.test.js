const test = require('node:test');
const assert = require('node:assert/strict');
const { createAppContext } = require('../catalyst-server/app-context');

test('stripe billing sync fails loudly on unknown price ids', async () => {
  const writes = [];
  const ctx = createAppContext({
    config: {
      BILLING_CONFIG_ERRORS: [],
      STRIPE_PERSONAL_PRICE_ID: 'price_personal',
      STRIPE_BUSINESS_PRICE_ID: 'price_business',
      STRIPE_SECRET_KEY: 'sk_test_123',
    },
    supabaseRequest: async (...args) => {
      writes.push(args);
      return [];
    },
    helpers: {
      findWorkspaceForStripeEvent: async () => ({
        id: 'workspace_1',
        billing_plan_tier: 'personal',
        billing_status: 'inactive',
        billing_currency: 'GBP',
        stripe_customer_id: '',
        stripe_subscription_id: '',
        stripe_price_id: null,
        created_at: '2026-04-20T00:00:00.000Z',
      }),
      stripeRequest: async () => ({
        id: 'sub_1',
        customer: 'cus_1',
        status: 'active',
        currency: 'gbp',
        current_period_end: 1770000000,
        items: {
          data: [{ price: { id: 'price_unknown' } }],
        },
      }),
    },
  });

  await assert.rejects(
    () => ctx.syncStripeBillingFromEvent({
      type: 'checkout.session.completed',
      data: {
        object: {
          subscription: 'sub_1',
          customer: 'cus_1',
        },
      },
    }),
    /does not match the configured Personal or Business price ids/,
  );

  assert.equal(writes.length, 0);
});

test('stripe billing sync fails loudly when billing config is incomplete', async () => {
  const ctx = createAppContext({
    config: {
      BILLING_CONFIG_ERRORS: ['STRIPE_PERSONAL_PAYMENT_LINK is set but STRIPE_PERSONAL_PRICE_ID is missing.'],
      STRIPE_PERSONAL_PRICE_ID: '',
      STRIPE_BUSINESS_PRICE_ID: 'price_business',
      STRIPE_SECRET_KEY: 'sk_test_123',
    },
    helpers: {
      findWorkspaceForStripeEvent: async () => ({
        id: 'workspace_1',
        billing_plan_tier: 'personal',
        billing_status: 'inactive',
        billing_currency: 'GBP',
        stripe_customer_id: '',
        stripe_subscription_id: '',
        stripe_price_id: null,
        created_at: '2026-04-20T00:00:00.000Z',
      }),
      stripeRequest: async () => ({
        id: 'sub_1',
        customer: 'cus_1',
        status: 'active',
        currency: 'gbp',
        current_period_end: 1770000000,
        items: {
          data: [{ price: { id: 'price_business' } }],
        },
      }),
    },
  });

  await assert.rejects(
    () => ctx.syncStripeBillingFromEvent({
      type: 'checkout.session.completed',
      data: {
        object: {
          subscription: 'sub_1',
          customer: 'cus_1',
        },
      },
    }),
    /Stripe billing is misconfigured/,
  );
});
