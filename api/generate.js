// ─────────────────────────────────────────────────────────────
//  VIZN — Vercel Serverless Function
//  Primary:  DALL-E 3 (OpenAI) — if OPENAI_API_KEY is set
//  Fallback: FLUX Dev (Replicate)
//  BG removal: 851-labs/background-remover (Replicate)
// ─────────────────────────────────────────────────────────────

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST')   return res.status(405).json({ error: 'Method not allowed' });

  const REPLICATE_KEY = process.env.REPLICATE_API_KEY;
  const OPENAI_KEY    = process.env.OPENAI_API_KEY;

  try {
    const { action, predictionId, image, prompt, width, height } = req.body;

    // ── Poll FLUX prediction ──────────────────────────────────
    if (action === 'poll' && predictionId) {
      if (!REPLICATE_KEY) return res.status(500).json({ error: 'REPLICATE_API_KEY not configured' });
      const r  = await fetch(`https://api.replicate.com/v1/predictions/${predictionId}`,
        { headers: { 'Authorization': `Bearer ${REPLICATE_KEY}` } });
      const d  = await r.json();
      const url = Array.isArray(d.output) ? d.output[0] : d.output;
      if (d.status === 'succeeded' && url) return res.status(200).json({ status: 'succeeded', imageUrl: url });
      if (d.status === 'failed')           return res.status(500).json({ status: 'failed', error: d.error });
      return res.status(200).json({ status: 'processing', predictionId });
    }

    // ── Background removal (Replicate 851-labs) ───────────────
    if (action === 'remove-bg' && image) {
      if (!REPLICATE_KEY) return res.status(500).json({ error: 'REPLICATE_API_KEY not configured' });

      const rbRes = await fetch(
        'https://api.replicate.com/v1/models/851-labs/background-remover/predictions',
        {
          method:  'POST',
          headers: { 'Authorization': `Bearer ${REPLICATE_KEY}`, 'Content-Type': 'application/json', 'Prefer': 'wait=30' },
          body:    JSON.stringify({ input: { image } })
        }
      );

      if (!rbRes.ok) {
        const e = await rbRes.json();
        return res.status(rbRes.status).json({ error: `BG removal failed (${rbRes.status}): ${e.detail || JSON.stringify(e)}` });
      }

      const rb    = await rbRes.json();
      const getUrl = d => Array.isArray(d.output) ? d.output[0] : d.output;

      async function toBase64(url) {
        const r   = await fetch(url);
        const buf = await r.arrayBuffer();
        return 'data:image/png;base64,' + Buffer.from(buf).toString('base64');
      }

      if (rb.status === 'succeeded' && getUrl(rb)) {
        return res.status(200).json({ status: 'succeeded', imageUrl: await toBase64(getUrl(rb)) });
      }

      if (rb.id) {
        for (let i = 0; i < 15; i++) {
          await new Promise(r => setTimeout(r, 2500));
          const pd = await (await fetch(`https://api.replicate.com/v1/predictions/${rb.id}`,
            { headers: { 'Authorization': `Bearer ${REPLICATE_KEY}` } })).json();
          if (pd.status === 'succeeded' && getUrl(pd)) return res.status(200).json({ status: 'succeeded', imageUrl: await toBase64(getUrl(pd)) });
          if (pd.status === 'failed') return res.status(500).json({ error: pd.error || 'BG removal failed' });
        }
      }

      return res.status(500).json({ error: 'BG removal timed out' });
    }

    // ── Image generation ──────────────────────────────────────
    if (!prompt) return res.status(400).json({ error: 'prompt is required' });

    // ── gpt-image-1 (primary — same engine as ChatGPT image generation) ──
    if (OPENAI_KEY) {
      // gpt-image-1 supports: 1024x1024, 1024x1536 (portrait), 1536x1024 (landscape)
      const size = (width === height) ? '1024x1024'
                 : (width  > height)  ? '1536x1024'
                 :                      '1024x1536';

      const imgRes = await fetch('https://api.openai.com/v1/images/generations', {
        method:  'POST',
        headers: { 'Authorization': `Bearer ${OPENAI_KEY}`, 'Content-Type': 'application/json' },
        body:    JSON.stringify({ model: 'gpt-image-1', prompt, n: 1, size, quality: 'high' })
      });

      const imgData = await imgRes.json();

      if (!imgRes.ok) {
        return res.status(imgRes.status).json({
          error: imgData.error?.message || 'gpt-image-1 error',
          hint:  imgRes.status === 401 ? 'Invalid OpenAI API key'
               : imgRes.status === 400 ? 'Prompt rejected — rephrase it'
               : 'Check OPENAI_API_KEY in Vercel env vars'
        });
      }

      // gpt-image-1 returns base64 — convert to data URI
      const b64 = imgData.data[0].b64_json;
      const url = imgData.data[0].url;
      const imageUrl = url || (b64 ? `data:image/png;base64,${b64}` : null);
      if (!imageUrl) return res.status(500).json({ error: 'No image in response' });

      return res.status(200).json({ status: 'succeeded', imageUrl, engine: 'gpt-image-1' });
    }

    // ── FLUX Dev fallback (if no OpenAI key) ──────────────────
    if (!REPLICATE_KEY) return res.status(500).json({ error: 'No AI API key configured. Add OPENAI_API_KEY or REPLICATE_API_KEY to Vercel env vars.' });

    const fluxRes = await fetch(
      'https://api.replicate.com/v1/models/black-forest-labs/flux-dev/predictions',
      {
        method:  'POST',
        headers: { 'Authorization': `Bearer ${REPLICATE_KEY}`, 'Content-Type': 'application/json', 'Prefer': 'wait=55' },
        body:    JSON.stringify({ input: { prompt, width: width || 832, height: height || 1024, num_outputs: 1, num_inference_steps: 28, guidance: 3.5, output_format: 'png', output_quality: 90 } })
      }
    );

    if (!fluxRes.ok) {
      const err = await fluxRes.json();
      return res.status(fluxRes.status).json({ error: err.detail || `Replicate error ${fluxRes.status}` });
    }

    const prediction = await fluxRes.json();
    if (prediction.status === 'succeeded' && prediction.output?.[0]) {
      return res.status(200).json({ status: 'succeeded', imageUrl: prediction.output[0], predictionId: prediction.id, engine: 'flux' });
    }
    return res.status(202).json({ status: 'processing', predictionId: prediction.id, engine: 'flux' });

  } catch (err) {
    console.error('VIZN /api/generate error:', err);
    return res.status(500).json({ error: err.message || 'Internal server error' });
  }
}
