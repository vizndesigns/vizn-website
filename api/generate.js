// ─────────────────────────────────────────────────────────────
//  VIZN — Vercel Serverless Function: Replicate Proxy
//  File: api/generate.js
//
//  SETUP (one-time, 2 minutes):
//  1. Go to vercel.com → your project → Settings → Environment Variables
//  2. Add: REPLICATE_API_KEY = r8_your_key_here
//  3. Redeploy — done. AI generation will work for all users.
// ─────────────────────────────────────────────────────────────

export default async function handler(req, res) {
  // CORS headers — allow requests from your own site
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  // Handle preflight
  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  // Only allow POST
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  // Get API key from Vercel environment variables (never exposed to browser)
  const REPLICATE_KEY = process.env.REPLICATE_API_KEY;

  if (!REPLICATE_KEY) {
    return res.status(500).json({
      error: 'REPLICATE_API_KEY not configured',
      hint: 'Go to Vercel Dashboard → your project → Settings → Environment Variables → Add REPLICATE_API_KEY'
    });
  }

  try {
    const body = req.body;
    const { prompt, width, height, action, predictionId, image } = body;

    // ── Poll mode: check existing prediction status ──────────
    if (action === 'poll' && predictionId) {
      const pollRes = await fetch(
        `https://api.replicate.com/v1/predictions/${predictionId}`,
        { headers: { 'Authorization': `Bearer ${REPLICATE_KEY}` } }
      );
      const data = await pollRes.json();

      if (data.status === 'succeeded' && data.output?.[0]) {
        return res.status(200).json({ status: 'succeeded', imageUrl: data.output[0] });
      }
      if (data.status === 'failed') {
        return res.status(500).json({ status: 'failed', error: data.error || 'Generation failed' });
      }
      return res.status(200).json({ status: 'processing', predictionId });
    }

    // ── Generate mode: start a new prediction ────────────────
    if (!prompt) {
      return res.status(400).json({ error: 'prompt is required' });
    }

    // Start prediction with Prefer: wait to get result immediately if fast enough
    const startRes = await fetch('https://api.replicate.com/v1/predictions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${REPLICATE_KEY}`,
        'Content-Type': 'application/json',
        'Prefer': 'wait=55'  // wait up to 55s for result (Vercel max ~60s)
      },
      body: JSON.stringify({
        version: 'ac732df83cea7fff18b8472768c88ad041fa750ff7682a21affe81863cbe77e4',
        input: {
          prompt: prompt,
          negative_prompt: 'blurry, low quality, amateur, watermark, generic clip-art, cartoon, text overlay, ugly, deformed',
          width: width || 1024,
          height: height || 768,
          num_inference_steps: 35,
          guidance_scale: 8,
          num_outputs: 1,
          scheduler: 'K_EULER',
          ...(image ? { image, prompt_strength: 0.8 } : {})
        }
      })
    });

    if (!startRes.ok) {
      const err = await startRes.json();
      return res.status(startRes.status).json({
        error: err.detail || `Replicate API error ${startRes.status}`,
        hint: startRes.status === 401
          ? 'Invalid API key. Get a fresh one at replicate.com/account/api-tokens'
          : startRes.status === 422
          ? 'Invalid parameters sent to Replicate'
          : 'Check your REPLICATE_API_KEY in Vercel environment variables'
      });
    }

    const prediction = await startRes.json();

    // If Prefer: wait worked and we got a result immediately
    if (prediction.status === 'succeeded' && prediction.output?.[0]) {
      return res.status(200).json({
        status: 'succeeded',
        imageUrl: prediction.output[0],
        predictionId: prediction.id
      });
    }

    // Still processing — return ID for client polling
    return res.status(202).json({
      status: 'processing',
      predictionId: prediction.id
    });

  } catch (err) {
    console.error('VIZN /api/generate error:', err);
    return res.status(500).json({ error: err.message || 'Internal server error' });
  }
}
