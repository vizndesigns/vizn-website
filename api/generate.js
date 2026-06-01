// ─────────────────────────────────────────────────────────────
//  VIZN — Vercel Serverless Function
//  Images:      gpt-image-1 (OpenAI) → FLUX Dev fallback
//  BG removal:  fal.ai imageutils/rembg  (fast, reliable)
//  Video:       fal.ai Kling Video 1.6   (hype clips)
// ─────────────────────────────────────────────────────────────

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST')   return res.status(405).json({ error: 'Method not allowed' });

  const REPLICATE_KEY = process.env.REPLICATE_API_KEY;
  const OPENAI_KEY    = process.env.OPENAI_API_KEY;
  const FAL_KEY       = process.env.FAL_KEY;
  const GOOGLE_KEY    = process.env.GOOGLE_API_KEY;

  try {
    const { action, predictionId, jobId, image, prompt, width, height } = req.body;

    // ── Poll FLUX prediction ──────────────────────────────────
    if (action === 'poll' && predictionId) {
      if (!REPLICATE_KEY) return res.status(500).json({ error: 'REPLICATE_API_KEY not configured' });
      const r   = await fetch(`https://api.replicate.com/v1/predictions/${predictionId}`,
        { headers: { 'Authorization': `Bearer ${REPLICATE_KEY}` } });
      const d   = await r.json();
      const url = Array.isArray(d.output) ? d.output[0] : d.output;
      if (d.status === 'succeeded' && url) return res.status(200).json({ status: 'succeeded', imageUrl: url });
      if (d.status === 'failed')           return res.status(500).json({ status: 'failed', error: d.error });
      return res.status(200).json({ status: 'processing', predictionId });
    }

    // ── Background removal — fal.ai rembg ────────────────────
    if (action === 'remove-bg' && image) {
      if (!FAL_KEY) return res.status(500).json({ error: 'FAL_KEY not configured' });

      // fal.ai needs a public URL — upload base64 to fal storage first
      const match    = image.match(/^data:([^;]+);base64,(.+)$/);
      if (!match) return res.status(400).json({ error: 'Invalid image format' });
      const mimeType = match[1];
      const ext      = mimeType.includes('png') ? 'png' : 'jpg';
      const buffer   = Buffer.from(match[2], 'base64');

      // Step 1: get presigned upload URL
      const initRes  = await fetch('https://rest.fal.ai/storage/upload/initiate', {
        method:  'POST',
        headers: { 'Authorization': `Key ${FAL_KEY}`, 'Content-Type': 'application/json' },
        body:    JSON.stringify({ content_type: mimeType, file_name: `athlete.${ext}` })
      });
      if (!initRes.ok) return res.status(500).json({ error: `Upload init failed: ${initRes.status}` });
      const { file_url, upload_url } = await initRes.json();

      // Step 2: PUT the image binary to the presigned URL
      const putRes = await fetch(upload_url, {
        method:  'PUT',
        headers: { 'Content-Type': mimeType },
        body:    buffer
      });
      if (!putRes.ok) return res.status(500).json({ error: `Upload failed: ${putRes.status}` });

      // Step 3: run rembg with the public CDN URL
      const rmbgRes  = await fetch('https://fal.run/fal-ai/imageutils/rembg', {
        method:  'POST',
        headers: { 'Authorization': `Key ${FAL_KEY}`, 'Content-Type': 'application/json' },
        body:    JSON.stringify({ image_url: file_url })
      });
      const rmbgData = await rmbgRes.json();

      if (!rmbgRes.ok) {
        return res.status(rmbgRes.status).json({
          error: `BG removal failed (${rmbgRes.status}): ${rmbgData.detail || JSON.stringify(rmbgData).slice(0, 200)}`
        });
      }

      const outputUrl = rmbgData.image?.url;
      if (!outputUrl) return res.status(500).json({ error: 'No output from rmbg', raw: JSON.stringify(rmbgData).slice(0, 200) });

      // Fetch result and return as base64 (avoids browser canvas CORS)
      const outBuf = await (await fetch(outputUrl)).arrayBuffer();
      const b64    = 'data:image/png;base64,' + Buffer.from(outBuf).toString('base64');
      return res.status(200).json({ status: 'succeeded', imageUrl: b64 });
    }

    // ── Video generation — fal.ai Kling Video 1.6 ─────────────
    if (action === 'generate-video' && prompt) {
      if (!FAL_KEY) return res.status(500).json({ error: 'FAL_KEY not configured' });

      const falRes = await fetch(
        'https://queue.fal.run/fal-ai/kling-video/v1.6/standard/text-to-video',
        {
          method:  'POST',
          headers: { 'Authorization': `Key ${FAL_KEY}`, 'Content-Type': 'application/json' },
          body:    JSON.stringify({ prompt, duration: '5', aspect_ratio: '9:16' })
        }
      );

      const falData = await falRes.json();

      if (!falRes.ok) {
        return res.status(falRes.status).json({
          error: `Video generation failed (${falRes.status}): ${falData.detail || JSON.stringify(falData).slice(0, 200)}`
        });
      }

      const requestId = falData.request_id;
      if (!requestId) return res.status(500).json({ error: 'No request_id from fal.ai', raw: JSON.stringify(falData).slice(0, 200) });

      return res.status(202).json({ status: 'processing', jobId: requestId });
    }

    // ── Poll video job — fal.ai Kling ─────────────────────────
    if (action === 'poll-video' && jobId) {
      if (!FAL_KEY) return res.status(500).json({ error: 'FAL_KEY not configured' });

      const pollRes  = await fetch(
        `https://queue.fal.run/fal-ai/kling-video/v1.6/standard/text-to-video/requests/${jobId}`,
        { headers: { 'Authorization': `Key ${FAL_KEY}` } }
      );
      const pollData = await pollRes.json();

      if (pollData.status === 'COMPLETED') {
        const videoUrl = pollData.output?.video?.url;
        if (videoUrl) return res.status(200).json({ status: 'succeeded', videoUrl });
        return res.status(500).json({ error: 'No video URL in response', raw: JSON.stringify(pollData).slice(0, 300) });
      }
      if (pollData.status === 'FAILED') {
        return res.status(500).json({ status: 'failed', error: pollData.error || 'Kling generation failed' });
      }

      return res.status(200).json({ status: 'processing', jobId, soraStatus: pollData.status });
    }

    // ── Image generation — Gemini → gpt-image-1 → FLUX ───────
    if (!prompt) return res.status(400).json({ error: 'prompt is required' });

    // Primary: Gemini 3.1 Flash Image (fastest, great text rendering)
    if (GOOGLE_KEY) {
      try {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 45000); // 45s cap

        const geminiRes = await fetch(
          `https://generativelanguage.googleapis.com/v1beta/models/gemini-3.1-flash-image:generateContent?key=${GOOGLE_KEY}`,
          {
            method:  'POST',
            headers: { 'Content-Type': 'application/json' },
            signal:  controller.signal,
            body:    JSON.stringify({
              contents: [{ parts: [{ text: prompt }] }],
              generationConfig: { responseModalities: ['IMAGE', 'TEXT'] }
            })
          }
        );
        clearTimeout(timer);

        if (geminiRes.ok) {
          const geminiData = await geminiRes.json();
          const parts   = geminiData.candidates?.[0]?.content?.parts || [];
          const imgPart = parts.find(p => p.inlineData?.mimeType?.startsWith('image/'));
          if (imgPart?.inlineData) {
            const { mimeType, data } = imgPart.inlineData;
            return res.status(200).json({
              status:   'succeeded',
              imageUrl: `data:${mimeType};base64,${data}`,
              engine:   'gemini-3.1-flash-image'
            });
          }
        } else {
          const err = await geminiRes.json().catch(() => ({}));
          console.warn('Gemini error, falling back:', err.error?.message || geminiRes.status);
        }
      } catch(e) {
        console.warn('Gemini timed out or failed, falling back to gpt-image-1:', e.message);
      }
    }

    // Secondary: gpt-image-1 (ChatGPT image engine)
    if (OPENAI_KEY) {
      const size = (width === height) ? '1024x1024'
                 : (width  > height)  ? '1536x1024'
                 :                      '1024x1536';

      const imgRes  = await fetch('https://api.openai.com/v1/images/generations', {
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

      const b64      = imgData.data[0].b64_json;
      const url      = imgData.data[0].url;
      const imageUrl = url || (b64 ? `data:image/png;base64,${b64}` : null);
      if (!imageUrl) return res.status(500).json({ error: 'No image in response' });
      return res.status(200).json({ status: 'succeeded', imageUrl, engine: 'gpt-image-1' });
    }

    // Fallback: FLUX Dev
    if (!REPLICATE_KEY) return res.status(500).json({ error: 'No AI key configured. Add OPENAI_API_KEY or REPLICATE_API_KEY.' });

    const fluxRes = await fetch(
      'https://api.replicate.com/v1/models/black-forest-labs/flux-dev/predictions',
      {
        method:  'POST',
        headers: { 'Authorization': `Bearer ${REPLICATE_KEY}`, 'Content-Type': 'application/json', 'Prefer': 'wait=55' },
        body:    JSON.stringify({ input: { prompt, width: width||832, height: height||1024, num_outputs: 1, num_inference_steps: 28, guidance: 3.5, output_format: 'png', output_quality: 90 } })
      }
    );

    if (!fluxRes.ok) {
      const err = await fluxRes.json();
      return res.status(fluxRes.status).json({ error: err.detail || `Replicate error ${fluxRes.status}` });
    }

    const prediction = await fluxRes.json();
    if (prediction.status === 'succeeded' && prediction.output?.[0]) {
      return res.status(200).json({ status: 'succeeded', imageUrl: prediction.output[0], engine: 'flux' });
    }
    return res.status(202).json({ status: 'processing', predictionId: prediction.id, engine: 'flux' });

  } catch (err) {
    console.error('VIZN /api/generate error:', err.message);
    return res.status(500).json({ error: err.message || 'Internal server error' });
  }
}
