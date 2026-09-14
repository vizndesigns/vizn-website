// ─────────────────────────────────────────────────────────────
//  VIZN — Stripe Checkout session creator
//  Plain REST calls to Stripe's API (no SDK) to match the rest of this
//  codebase. Fails open with a clear error until STRIPE_SECRET_KEY is set
//  in Vercel, so nothing breaks pre-configuration.
// ─────────────────────────────────────────────────────────────

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY;
  if (!STRIPE_SECRET_KEY) {
    return res.status(503).json({ error: 'Online payment isn’t set up yet — email design@vizn.studio to order this.' });
  }

  const { name, amount } = req.body || {};
  if (!name || typeof amount !== 'number' || !(amount > 0)) {
    return res.status(400).json({ error: 'Invalid order' });
  }

  const origin = req.headers.origin || `https://${req.headers.host}`;

  const params = new URLSearchParams();
  params.append('mode', 'payment');
  params.append('success_url', `${origin}/#custom?paid=1`);
  params.append('cancel_url', `${origin}/#pricing`);
  params.append('line_items[0][price_data][currency]', 'usd');
  params.append('line_items[0][price_data][product_data][name]', name);
  params.append('line_items[0][price_data][unit_amount]', String(Math.round(amount * 100)));
  params.append('line_items[0][quantity]', '1');

  try {
    const stripeRes = await fetch('https://api.stripe.com/v1/checkout/sessions', {
      method: 'POST',
      headers: {
        'Authorization': 'Basic ' + Buffer.from(STRIPE_SECRET_KEY + ':').toString('base64'),
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: params.toString(),
    });
    const data = await stripeRes.json();
    if (!stripeRes.ok) {
      return res.status(500).json({ error: data.error?.message || 'Stripe error' });
    }
    return res.status(200).json({ url: data.url });
  } catch (err) {
    return res.status(500).json({ error: 'Failed to start checkout' });
  }
}
