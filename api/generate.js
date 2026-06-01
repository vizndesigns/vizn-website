// ─────────────────────────────────────────────────────────────
//  VIZN — Vercel Serverless Function
//  remove-bg → 851-labs/background-remover (Replicate)
//  generate  → FLUX Dev background generation
//  poll      → polls an in-progress prediction
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
      hint: 'Vercel Dashboard → Settings → Environment Variables'
    });
  }

  try {
    const { action, predictionId, image, prompt, width, height } = req.body;

    // ── Poll ──────────────────────────────────────────────────
    if (action === 'poll' && predictionId) {
      const r = await fetch(`https://api.replicate.com/v1/predictions/${predictionId}`,
        { headers: { 'Authorization': `Bearer ${REPLICATE_KEY}` } });
      const d = await r.json();
      if (d.status === 'succeeded') {
        const url = Array.isArray(d.output) ? d.output[0] : d.output;
        if (url) return res.status(200).json({ status: 'succeeded', imageUrl: url });
      }
      if (d.status === 'failed') return res.status(500).json({ status: 'failed', error: d.error || 'Failed' });
      return res.status(200).json({ status: 'processing', predictionId });
    }

    // ── Background removal ────────────────────────────────────
    if (action === 'remove-bg' && image) {
      const rbRes = await fetch(
        'https://api.replicate.com/v1/models/851-labs/background-remover/predictions',
        {
          method:  'POST',
          headers: {
            'Authorization': `Bearer ${REPLICATE_KEY}`,
            'Content-Type':  'application/json',
            'Prefer':        'wait=30'
          },
          body: JSON.stringify({ input: { image } })
        }
      );

      if (!rbRes.ok) {
        const e = await rbRes.json();
        console.error('rmbg error:', e);
        return res.status(rbRes.status).json({
          error: `BG removal failed (${rbRes.status}): ${e.detail || JSON.stringify(e)}`
        });
      }

      const rb = await rbRes.json();

      // Helper: fetch output URL → base64 data URI (eliminates browser CORS)
      async function toBase64(url) {
        const r = await fetch(url);
        const buf = await r.arrayBuffer();
        return 'data:image/png;base64,' + Buffer.from(buf).toString('base64');
      }

      const getUrl = (d) => Array.isArray(d.output) ? d.output[0] : d.output;

      if (rb.status === 'succeeded' && getUrl(rb)) {
        return res.status(200).json({ status: 'succeeded', imageUrl: await toBase64(getUrl(rb)) });
      }

      // Poll inline (background removal is fast, ~5-10s)
      if (rb.id) {
        for (let i = 0; i < 15; i++) {
          await new Promise(r => setTimeout(r, 2500));
          const p  = await fetch(`https://api.replicate.com/v1/predictions/${rb.id}`,
            { headers: { 'Authorization': `Bearer ${REPLICATE_KEY}` } });
          const pd = await p.json();
          if (pd.status === 'succeeded' && getUrl(pd)) {
            return res.status(200).json({ status: 'succeeded', imageUrl: await toBase64(getUrl(pd)) });
          }
          if (pd.status === 'failed') {
            return res.status(500).json({ error: pd.error || 'BG removal failed' });
          }
        }
      }

      return res.status(500).json({ error: 'BG removal timed out — try again' });
    }

    // ── Generate background (FLUX Dev) ────────────────────────
    if (!prompt) return res.status(400).json({ error: 'prompt is required' });

    const startRes = await fetch(
      'https://api.replicate.com/v1/models/black-forest-labs/flux-dev/predictions',
      {
        method:  'POST',
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
        error: err.detail || `Replicate error ${startRes.status}`,
        hint: startRes.status === 401 ? 'Invalid API key' : 'Check REPLICATE_API_KEY'
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
