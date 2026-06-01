// ─────────────────────────────────────────────────────────────
//  VIZN — Vercel Serverless Function: Replicate Proxy
//  Model: FLUX Dev (black-forest-labs/flux-dev)
// ─────────────────────────────────────────────────────────────

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

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

    // ── Poll mode ────────────────────────────────────────────
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

    // ── Generate mode ─────────────────────────────────────────
    if (!prompt) return res.status(400).json({ error: 'prompt is required' });

    const input = {
      prompt,
      width:               width || 1024,
      height:              height || 1024,
      num_outputs:         1,
      num_inference_steps: 28,
      guidance:            3.5,
      output_format:       'png',
      output_quality:      90,
    };

    // img2img: include uploaded reference image if provided
    if (image) {
      input.image = image;
      input.prompt_strength = 0.75;
    }

    // FLUX Dev — no version hash, uses model routing endpoint
    const startRes = await fetch(
      'https://api.replicate.com/v1/models/black-forest-labs/flux-dev/predictions',
      {
        method: 'POST',
        headers: {
          'Authorization':  `Bearer ${REPLICATE_KEY}`,
          'Content-Type':   'application/json',
          'Prefer':         'wait=55'
        },
        body: JSON.stringify({ input })
      }
    );

    if (!startRes.ok) {
      const err = await startRes.json();
      return res.status(startRes.status).json({
        error: err.detail || `Replicate API error ${startRes.status}`,
        hint: startRes.status === 401
          ? 'Invalid API key — get one at replicate.com/account/api-tokens'
          : startRes.status === 422
          ? 'Invalid parameters sent to Replicate'
          : 'Check your REPLICATE_API_KEY in Vercel environment variables'
      });
    }

    const prediction = await startRes.json();

    if (prediction.status === 'succeeded' && prediction.output?.[0]) {
      return res.status(200).json({
        status: 'succeeded',
        imageUrl: prediction.output[0],
        predictionId: prediction.id
      });
    }

    return res.status(202).json({
      status: 'processing',
      predictionId: prediction.id
    });

  } catch (err) {
    console.error('VIZN /api/generate error:', err);
    return res.status(500).json({ error: err.message || 'Internal server error' });
  }
}
