import express from 'express';
import Stripe from 'stripe';
import { requireAuth } from './auth.js';
import { pool } from './db.js';
import { config } from './config.js';

function getStripe() {
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) return null;
  return new Stripe(key);
}

export function billingRouter() {
  const router = express.Router();

  // Get current plan + available plans
  router.get('/plans', (req, res) => {
    const plans = Object.entries(config.plans).map(([id, p]) => ({
      id,
      name: p.name,
      maxBots: p.maxBots === -1 ? 'Unlimited' : p.maxBots,
      features: p.features,
      stripePriceId: p.priceId,
    }));
    res.json({ plans });
  });

  // Get current user's subscription status
  router.get('/status', requireAuth, async (req, res) => {
    try {
      const result = await pool.query('SELECT plan, stripe_customer_id FROM users WHERE id = $1', [req.user.id]);
      const user = result.rows[0];
      res.json({ plan: user.plan });
    } catch (err) {
      res.status(500).json({ error: 'Failed to fetch subscription' });
    }
  });

  // Create checkout session
  router.post('/checkout', requireAuth, async (req, res) => {
    const { planId } = req.body || {};
    const plan = config.plans[planId];
    if (!plan || !plan.priceId) {
      return res.status(400).json({ error: 'Invalid plan or plan not configured for billing' });
    }

    const stripe = getStripe();
    if (!stripe) {
      return res.status(503).json({ error: 'Stripe is not configured. Contact the administrator.' });
    }

    try {
      const userResult = await pool.query('SELECT email, stripe_customer_id FROM users WHERE id = $1', [req.user.id]);
      const user = userResult.rows[0];

      let customerId = user.stripe_customer_id;
      if (!customerId) {
        const customer = await stripe.customers.create({
          email: user.email,
          metadata: { userId: String(req.user.id) },
        });
        customerId = customer.id;
        await pool.query('UPDATE users SET stripe_customer_id = $1 WHERE id = $2', [customerId, req.user.id]);
      }

      const session = await stripe.checkout.sessions.create({
        customer: customerId,
        mode: 'subscription',
        line_items: [{ price: plan.priceId, quantity: 1 }],
        success_url: `${req.protocol}://${req.get('host')}/dashboard?upgrade=success`,
        cancel_url: `${req.protocol}://${req.get('host')}/dashboard?upgrade=cancelled`,
        metadata: { userId: String(req.user.id), planId },
      });

      res.json({ url: session.url });
    } catch (err) {
      console.error('Checkout error:', err.message);
      res.status(500).json({ error: 'Failed to create checkout session' });
    }
  });

  // Stripe webhook (raw body needed — mounted separately in index.js)
  return router;
}

export async function handleStripeWebhook(req, res) {
  const stripe = getStripe();
  if (!stripe) {
    return res.status(503).send('Stripe not configured');
  }

  const sig = req.headers['stripe-signature'];
  let event;
  try {
    event = stripe.webhooks.constructEvent(req.rawBody, sig, process.env.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    console.error('Webhook signature failed:', err.message);
    return res.status(400).send('Invalid signature');
  }

  try {
    switch (event.type) {
      case 'checkout.session.completed': {
        const session = event.data.object;
        const userId = session.metadata?.userId;
        const planId = session.metadata?.planId;
        if (userId && planId) {
          await pool.query(
            'UPDATE users SET plan = $1, stripe_customer_id = $2 WHERE id = $3',
            [planId, session.customer, userId],
          );
          console.log(`💳 User ${userId} upgraded to ${planId}`);
        }
        break;
      }
      case 'customer.subscription.deleted': {
        const subscription = event.data.object;
        await pool.query(
          'UPDATE users SET plan = $1 WHERE stripe_customer_id = $2',
          ['free', subscription.customer],
        );
        console.log(`💳 Subscription cancelled for customer ${subscription.customer}`);
        break;
      }
    }
    res.json({ received: true });
  } catch (err) {
    console.error('Webhook handler error:', err.message);
    res.status(500).send('Webhook handler failed');
  }
}
