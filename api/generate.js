// ─────────────────────────────────────────────────────────────
//  VIZN — Vercel Serverless Function
//  Actions:
//    remove-bg  → strips background from athlete photo (rembg)
//    generate   → creates design background (FLUX Dev)
//    poll       → polls an in-progress prediction
// ─────────────────────────────────────────────────────────────

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST')   return res.status(405).json({ error: 'Method not allowed' });

  const REPLICATE_KEY = process.env.REPLICATE_API_KEY;
  if (!REPLICATE_KEY) {
    return res.status(500).json({
      error: 'REPLICATE_API_KEY not configured',
      hint: 'Vercel Dashboard → Settings → Environment Variables → Add REPLICATE_API_KEY'
    });
  }

  try {
    const { action, predictionId, image, prompt, width, height } = req.body;

    // ── Poll existing prediction ──────────────────────────────
    if (action === 'poll' && predictionId) {
      const r = await fetch(`https://api.replicate.com/v1/predictions/${predictionId}`,
        { headers: { 'Authorization': `Bearer ${REPLICATE_KEY}` } });
      const d = await r.json();
      if (d.status === 'succeeded' && d.output?.[0]) return res.status(200).json({ status: 'succeeded', imageUrl: d.output[0] });
      if (d.status === 'failed')                      return res.status(500).json({ status: 'failed', error: d.error || 'Generation failed' });
      return res.status(200).json({ status: 'processing', predictionId });
    }

    // ── Remove background from athlete photo ──────────────────
    if (action === 'remove-bg' && image) {
      const rbRes = await fetch('https://api.replicate.com/v1/models/cjwbw/rembg/predictions', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${REPLICATE_KEY}`,
          'Content-Type':  'application/json',
          'Prefer':        'wait=30'
        },
        body: JSON.stringify({ input: { image } })
      });

      if (!rbRes.ok) {
        const e = await rbRes.json();
        return res.status(rbRes.status).json({ error: e.detail || 'Background removal failed' });
      }

      const rb = await rbRes.json();

      // Completed immediately
      if (rb.status === 'succeeded' && rb.output) {
        return res.status(200).json({ status: 'succeeded', imageUrl: rb.output });
      }

      // Needs polling — wait inline (rembg is fast, usually 3-8s)
      if (rb.id) {
        for (let i = 0; i < 15; i++) {
          await new Promise(r => setTimeout(r, 2000));
          const p = await fetch(`https://api.replicate.com/v1/predictions/${rb.id}`,
            { headers: { 'Authorization': `Bearer ${REPLICATE_KEY}` } });
          const pd = await p.json();
          if (pd.status === 'succeeded' && pd.output) return res.status(200).json({ status: 'succeeded', imageUrl: pd.output });
          if (pd.status === 'failed') break;
        }
      }

      return res.status(500).json({ error: 'Background removal failed — try again' });
    }

    // ── Generate design background with FLUX Dev ──────────────
    if (!prompt) return res.status(400).json({ error: 'prompt is required' });

    const startRes = await fetch(
      'https://api.replicate.com/v1/models/black-forest-labs/flux-dev/predictions',
      {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${REPLICATE_KEY}`,
          'Content-Type':  'application/json',
          'Prefer':        'wait=55'
        },
        body: JSON.stringify({
          input: {
            prompt,
            width:               width  || 832,
            height:              height || 1024,
            num_outputs:         1,
            num_inference_steps: 28,
            guidance:            3.5,
            output_format:       'png',
            output_quality:      90
          }
        })
      }
    );

    if (!startRes.ok) {
      const err = await startRes.json();
      return res.status(startRes.status).json({
        error: err.detail || `Replicate API error ${startRes.status}`,
        hint: startRes.status === 401 ? 'Invalid API key' : 'Check REPLICATE_API_KEY in Vercel env vars'
      });
    }

    const prediction = await startRes.json();

    if (prediction.status === 'succeeded' && prediction.output?.[0]) {
      return res.status(200).json({ status: 'succeeded', imageUrl: prediction.output[0], predictionId: prediction.id });
    }

    return res.status(202).json({ status: 'processing', predictionId: prediction.id });

  } catch (err) {
    console.error('VIZN /api/generate error:', err);
    return res.status(500).json({ error: err.message || 'Internal server error' });
  }
}
