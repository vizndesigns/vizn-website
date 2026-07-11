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
    const { action, predictionId, jobId, image, prompt, width, height, athleteImage, style } = req.body;

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

      // Step 3: run BiRefNet (higher quality than rembg — better edges, hair, fine details)
      const rmbgRes  = await fetch('https://fal.run/fal-ai/birefnet', {
        method:  'POST',
        headers: { 'Authorization': `Key ${FAL_KEY}`, 'Content-Type': 'application/json' },
        body:    JSON.stringify({ image_url: file_url, model: 'General Use (Heavy)' })
      });
      const rmbgData = await rmbgRes.json();

      if (!rmbgRes.ok) {
        return res.status(rmbgRes.status).json({
          error: `BG removal failed (${rmbgRes.status}): ${rmbgData.detail || JSON.stringify(rmbgData).slice(0, 200)}`
        });
      }

      const outputUrl = rmbgData.image?.url;
      if (!outputUrl) return res.status(500).json({ error: 'No output from BiRefNet', raw: JSON.stringify(rmbgData).slice(0, 200) });

      // Fetch result and return as base64 (avoids browser canvas CORS)
      const outBuf = await (await fetch(outputUrl)).arrayBuffer();
      const b64    = 'data:image/png;base64,' + Buffer.from(outBuf).toString('base64');
      return res.status(200).json({ status: 'succeeded', imageUrl: b64 });
    }

    // ── Video generation — fal.ai Kling Video 1.6 ─────────────
    if (action === 'generate-video' && prompt) {
      if (!FAL_KEY) return res.status(500).json({ error: 'FAL_KEY not configured' });

      // Prefer image-to-video when a design image is available (animates the actual graphic)
      if (req.body.imageDataUrl) {
        try {
          const match = req.body.imageDataUrl.match(/^data:([^;]+);base64,(.+)$/);
          if (match) {
            const [, mimeType, b64] = match;
            const ext    = mimeType.includes('png') ? 'png' : 'jpg';
            const buffer = Buffer.from(b64, 'base64');

            const initRes = await fetch('https://rest.fal.ai/storage/upload/initiate', {
              method:  'POST',
              headers: { 'Authorization': `Key ${FAL_KEY}`, 'Content-Type': 'application/json' },
              body:    JSON.stringify({ content_type: mimeType, file_name: `design.${ext}` })
            });

            if (initRes.ok) {
              const { file_url, upload_url } = await initRes.json();
              await fetch(upload_url, { method: 'PUT', headers: { 'Content-Type': mimeType }, body: buffer });

              const falRes = await fetch(
                'https://queue.fal.run/fal-ai/kling-video/v1.6/standard/image-to-video',
                {
                  method:  'POST',
                  headers: { 'Authorization': `Key ${FAL_KEY}`, 'Content-Type': 'application/json' },
                  body:    JSON.stringify({ prompt, image_url: file_url, duration: '5', aspect_ratio: '9:16' })
                }
              );
              const falData = await falRes.json();
              if (falData.request_id) {
                return res.status(202).json({ status: 'processing', jobId: falData.request_id });
              }
            }
          }
        } catch(e) {
          console.warn('Image-to-video failed, falling back to text-to-video:', e.message);
        }
      }

      // Fallback: text-to-video
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

    // ── Vision-based generation — athlete photo + prompt → full graphic ──
    // Used when user uploads a photo: AI sees the athlete and designs around them
    if (action === 'generate-with-image' && athleteImage && prompt) {
      const size = (width === height) ? '1024x1024'
                 : (width  > height)  ? '1536x1024'
                 :                      '1024x1536';

      // Primary: Gemini multimodal (sees the photo + generates a new image)
      if (GOOGLE_KEY) {
        try {
          const match = athleteImage.match(/^data:([^;]+);base64,(.+)$/);
          if (match) {
            const [, mimeType, b64data] = match;
            const controller = new AbortController();
            const timer = setTimeout(() => controller.abort(), 50000);

            const geminiRes = await fetch(
              `https://generativelanguage.googleapis.com/v1beta/models/gemini-3.1-flash-image:generateContent?key=${GOOGLE_KEY}`,
              {
                method:  'POST',
                headers: { 'Content-Type': 'application/json' },
                signal:  controller.signal,
                body: JSON.stringify({
                  contents: [{ parts: [
                    { text: prompt },
                    { inline_data: { mime_type: mimeType, data: b64data } }
                  ]}],
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
                const { mimeType: mt, data } = imgPart.inlineData;
                return res.status(200).json({
                  status: 'succeeded',
                  imageUrl: `data:${mt};base64,${data}`,
                  engine: 'gemini-vision'
                });
              }
            } else {
              const err = await geminiRes.json().catch(() => ({}));
              console.warn('Gemini vision error:', err.error?.message || geminiRes.status);
            }
          }
        } catch(e) {
          console.warn('Gemini vision failed, trying OpenAI edits:', e.message);
        }
      }

      // Fallback: GPT-image-1 edits endpoint (image in → sports graphic out)
      if (OPENAI_KEY) {
        try {
          const match = athleteImage.match(/^data:([^;]+);base64,(.+)$/);
          if (match) {
            const [, mimeType, b64data] = match;
            const buffer = Buffer.from(b64data, 'base64');
            const ext    = mimeType.includes('png') ? 'png' : 'jpg';

            const form = new FormData();
            form.append('image', new File([buffer], `athlete.${ext}`, { type: mimeType }));
            form.append('prompt', prompt);
            form.append('model', 'gpt-image-1');
            form.append('size', size);
            form.append('quality', 'high');
            form.append('n', '1');

            const editRes  = await fetch('https://api.openai.com/v1/images/edits', {
              method:  'POST',
              headers: { 'Authorization': `Bearer ${OPENAI_KEY}` },
              body:    form
            });
            const editData = await editRes.json();

            if (editRes.ok) {
              const b64      = editData.data?.[0]?.b64_json;
              const url      = editData.data?.[0]?.url;
              const imageUrl = url || (b64 ? `data:image/png;base64,${b64}` : null);
              if (imageUrl) {
                return res.status(200).json({ status: 'succeeded', imageUrl, engine: 'gpt-image-1-edit' });
              }
            } else {
              console.warn('GPT-image-1 edits error:', editData.error?.message);
            }
          }
        } catch(e) {
          console.warn('GPT-image-1 edits failed:', e.message);
        }
      }

      // If both vision paths failed, fall through to text generation below
      // (frontend will composite the athlete cutout onto the result)
      console.warn('Vision generation failed — falling back to text generation');
    }

    // ── Prompt expansion — lightweight Gemini text call ────────
    // ── Surgical refine — image-to-image targeted edit ───────
    if (action === 'refine' && req.body.imageDataUrl && req.body.prompt) {
      const refinePrompt = `You are editing an existing professional sports graphic design.

APPLY ONLY THIS SPECIFIC CHANGE: "${req.body.prompt}"

CRITICAL RULES:
- Change ONLY the element explicitly mentioned above
- Preserve ALL other elements EXACTLY: same colors, same typography, same layout, same composition, same athlete position
- Do NOT redesign, reimagine, or improve anything not mentioned
- Result must look identical to input except for the one requested change
- All text and graphics must remain within the canvas boundaries`;

      if (GOOGLE_KEY) {
        try {
          const match = req.body.imageDataUrl.match(/^data:([^;]+);base64,(.+)$/);
          if (match) {
            const [, mime, b64] = match;
            const gemRes = await fetch(
              `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash-preview-image-generation:generateContent?key=${GOOGLE_KEY}`,
              {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                  contents: [{ parts: [
                    { inlineData: { mimeType: mime, data: b64 } },
                    { text: refinePrompt }
                  ]}],
                  generationConfig: { responseModalities: ['IMAGE', 'TEXT'], temperature: 0.3 }
                })
              }
            );
            const gd = await gemRes.json();
            const part = gd.candidates?.[0]?.content?.parts?.find(p => p.inlineData);
            if (part) {
              return res.status(200).json({
                url: `data:${part.inlineData.mimeType};base64,${part.inlineData.data}`,
                engine: 'Gemini'
              });
            }
          }
        } catch(e) { console.error('Gemini refine failed:', e.message); }
      }

      if (OPENAI_KEY) {
        try {
          const match = req.body.imageDataUrl.match(/^data:([^;]+);base64,(.+)$/);
          if (match) {
            const [, mime, b64data] = match;
            const buffer = Buffer.from(b64data, 'base64');
            const ext    = mime.includes('png') ? 'png' : 'jpg';
            const form   = new FormData();
            form.append('model', 'gpt-image-1');
            form.append('prompt', refinePrompt);
            form.append('n', '1');
            form.append('image', new File([buffer], `design.${ext}`, { type: mime }));
            const editRes = await fetch('https://api.openai.com/v1/images/edits', {
              method: 'POST', headers: { Authorization: `Bearer ${OPENAI_KEY}` }, body: form
            });
            const ed = await editRes.json();
            const b64out = ed.data?.[0]?.b64_json;
            if (b64out) {
              return res.status(200).json({ url: `data:image/png;base64,${b64out}`, engine: 'GPT-Image-1' });
            }
          }
        } catch(e) { console.error('GPT refine failed:', e.message); }
      }

      return res.status(500).json({ error: 'Refine failed — no vision engine available' });
    }

    // ── Layer extraction — GPT-4o Vision (text + shapes) ─────
    if (action === 'detect-text' && req.body.imageDataUrl) {
      if (!OPENAI_KEY) return res.status(200).json({ texts: [], shapes: [] });
      try {
        const imageUrl = req.body.imageDataUrl;
        const visionRes = await fetch('https://api.openai.com/v1/chat/completions', {
          method: 'POST',
          headers: { 'Authorization': `Bearer ${OPENAI_KEY}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            model: 'gpt-4o',
            max_tokens: 2000,
            messages: [{
              role: 'user',
              content: [
                { type: 'image_url', image_url: { url: imageUrl, detail: 'high' } },
                { type: 'text', text: `Analyze this sports graphic design. Extract ALL design layers.

TEXT ELEMENTS — every piece of visible text (headlines, names, numbers, subtitles, labels, dates):
Each text object needs: "text" (exact string), "cx" (center-x 0-1), "cy" (center-y 0-1), "w" (width fraction 0-1), "h" (line-height fraction 0-1 of total image height), "color" (hex like "#ffffff"), "bold" (true/false), "italic" (true/false), "align" ("left"/"center"/"right")

SHAPE ELEMENTS — color blocks, rectangles, diagonal overlays, gradient panels, borders, frames (NOT the athlete photo):
Each shape object needs: "cx", "cy", "w", "h" (all fractions 0-1), "color" (hex of dominant fill), "opacity" (0-1), "angle" (rotation degrees, 0 if straight)

Return ONLY this exact JSON, no markdown:
{"texts":[...],"shapes":[...]}` }
              ]
            }]
          })
        });
        if (visionRes.ok) {
          const vd = await visionRes.json();
          const raw = vd.choices?.[0]?.message?.content?.trim() || '{}';
          try {
            const cleaned = raw.replace(/^```json\n?/g,'').replace(/```\s*$/g,'').trim();
            const parsed  = JSON.parse(cleaned);
            return res.status(200).json({ texts: parsed.texts || [], shapes: parsed.shapes || [] });
          } catch(e) { console.warn('Layer parse error:', e.message, raw.slice(0,200)); }
        }
      } catch(e) { console.warn('detect-text failed:', e.message); }
      return res.status(200).json({ texts: [], shapes: [] });
    }

    if (action === 'expand-prompt' && prompt) {
      if (!GOOGLE_KEY) return res.status(200).json({ expanded: prompt });
      try {
        const expandRes = await fetch(
          `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${GOOGLE_KEY}`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              contents: [{ parts: [{ text: `You are an expert sports graphic design director. Expand this short user prompt into a detailed 2–3 sentence design brief that adds professional design vocabulary, composition specifics, and visual detail. Keep all exact names, numbers, teams, schools. Return ONLY the expanded prompt text, no preamble, no quotes.\n\nUser prompt: "${prompt}"` }] }],
              generationConfig: { temperature: 0.7, maxOutputTokens: 200 }
            })
          }
        );
        if (expandRes.ok) {
          const expandData = await expandRes.json();
          const expanded   = expandData.candidates?.[0]?.content?.parts?.[0]?.text?.trim();
          if (expanded) return res.status(200).json({ expanded });
        }
      } catch(e) { console.warn('Prompt expansion failed:', e.message); }
      return res.status(200).json({ expanded: prompt });
    }

    // ── Image generation — gpt-image-1 → Gemini → FLUX ───────
    // gpt-image-1 first: follows color/style instructions most reliably
    if (!prompt) return res.status(400).json({ error: 'prompt is required' });

    // Primary: gpt-image-1 — best color and instruction adherence
    if (OPENAI_KEY) {
      const size = (width === height) ? '1024x1024'
                 : (width  > height)  ? '1536x1024'
                 :                      '1024x1536';

      try {
        const imgRes  = await fetch('https://api.openai.com/v1/images/generations', {
          method:  'POST',
          headers: { 'Authorization': `Bearer ${OPENAI_KEY}`, 'Content-Type': 'application/json' },
          body:    JSON.stringify({ model: 'gpt-image-1', prompt, n: 1, size, quality: 'high' })
        });
        const imgData = await imgRes.json();

        if (imgRes.ok) {
          const b64      = imgData.data?.[0]?.b64_json;
          const url      = imgData.data?.[0]?.url;
          const imageUrl = url || (b64 ? `data:image/png;base64,${b64}` : null);
          if (imageUrl) return res.status(200).json({ status: 'succeeded', imageUrl, engine: 'gpt-image-1' });
        } else {
          console.warn('gpt-image-1 error, falling back to Gemini:', imgData.error?.message || imgRes.status);
        }
      } catch(e) {
        console.warn('gpt-image-1 failed, falling back to Gemini:', e.message);
      }
    }

    // Secondary: Gemini (fallback when OpenAI unavailable)
    if (GOOGLE_KEY) {
      try {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 45000);

        const geminiRes = await fetch(
          `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash-preview-image-generation:generateContent?key=${GOOGLE_KEY}`,
          {
            method:  'POST',
            headers: { 'Content-Type': 'application/json' },
            signal:  controller.signal,
            body:    JSON.stringify({
              contents: [{ parts: [{ text: prompt }] }],
              generationConfig: { responseModalities: ['IMAGE', 'TEXT'], temperature: 0.4 }
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
            return res.status(200).json({ status: 'succeeded', imageUrl: `data:${mimeType};base64,${data}`, engine: 'gemini' });
          }
        } else {
          const err = await geminiRes.json().catch(() => ({}));
          console.warn('Gemini error, falling back to FLUX:', err.error?.message || geminiRes.status);
        }
      } catch(e) {
        console.warn('Gemini failed, falling back to FLUX:', e.message);
      }
    }

    // Fallback: FLUX Dev
    if (!REPLICATE_KEY) return res.status(500).json({ error: 'No AI key configured. Add OPENAI_API_KEY or REPLICATE_API_KEY.' });

    const styleColorNeg = {
      aggressive: 'blue colors, navy, gold, yellow, purple, green, cyan',
      modern:     'red colors, crimson, scarlet, purple, green, orange',
      collegiate: 'blue, navy, purple, cyan, neon colors, orange',
      minimal:    'red, blue, purple, orange, pink, brown, warm colors',
      hype:       'red, orange, brown, green, yellow, earth tones, crimson',
      retro:      'neon colors, electric blue, purple, cyan, bright colors, green'
    };
    const colorNeg = styleColorNeg[style] || '';

    const fluxRes = await fetch(
      'https://api.replicate.com/v1/models/black-forest-labs/flux-dev/predictions',
      {
        method:  'POST',
        headers: { 'Authorization': `Bearer ${REPLICATE_KEY}`, 'Content-Type': 'application/json', 'Prefer': 'wait=55' },
        body:    JSON.stringify({ input: {
          prompt,
          negative_prompt: `watermark, blurry text, amateur design, clip art, 3D render artifact, stock photo, low quality, text cut off at edges, typography cropped at border, elements outside frame, text touching image edge, ${colorNeg}`,
          width:  width  || 832,
          height: height || 1024,
          num_outputs:         1,
          num_inference_steps: 50,
          guidance:            7.0,
          output_format:       'png',
          output_quality:      95
        } })
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
