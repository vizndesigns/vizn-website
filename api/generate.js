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

    // ── Fast team background — Gemini only, 30s timeout, no retries ─────
    // Used by team composite path so it never hits gpt-image-1 (too slow)
    if (action === 'team-bg' && prompt) {
      if (GOOGLE_KEY) {
        try {
          const ctrl  = new AbortController();
          const timer = setTimeout(() => ctrl.abort(), 30000);
          const gRes  = await fetch(
            `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash-preview-image-generation:generateContent?key=${GOOGLE_KEY}`,
            {
              method:  'POST',
              headers: { 'Content-Type': 'application/json' },
              signal:  ctrl.signal,
              body:    JSON.stringify({
                contents: [{ parts: [{ text: prompt }] }],
                generationConfig: { responseModalities: ['IMAGE', 'TEXT'], temperature: 0.35 }
              })
            }
          );
          clearTimeout(timer);
          if (gRes.ok) {
            const gData   = await gRes.json();
            const parts   = gData.candidates?.[0]?.content?.parts || [];
            const imgPart = parts.find(p => p.inlineData?.mimeType?.startsWith('image/'));
            if (imgPart?.inlineData) {
              const { mimeType, data } = imgPart.inlineData;
              return res.status(200).json({ status: 'succeeded', imageUrl: `data:${mimeType};base64,${data}`, engine: 'gemini-team' });
            }
          } else {
            const err = await gRes.json().catch(() => ({}));
            console.warn('team-bg Gemini error:', err.error?.message || gRes.status);
          }
        } catch(e) {
          console.warn('team-bg Gemini failed:', e.message);
        }
      }
      // Signal frontend to use local canvas background
      return res.status(200).json({ status: 'use-canvas' });
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

            const editCtrl = new AbortController();
            const editTimer = setTimeout(() => editCtrl.abort(), 55000);
            const editRes  = await fetch('https://api.openai.com/v1/images/edits', {
              method:  'POST',
              headers: { 'Authorization': `Bearer ${OPENAI_KEY}` },
              signal:  editCtrl.signal,
              body:    form
            });
            clearTimeout(editTimer);
            const editData = await editRes.json();

            if (editRes.ok) {
              const b64      = editData.data?.[0]?.b64_json;
              const url      = editData.data?.[0]?.url;
              // Prefer b64 (permanent) over URL (expires)
              const imageUrl = b64 ? `data:image/png;base64,${b64}` : url;
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
      const styleGuide = {
        aggressive: 'ultra-bold condensed Impact/Bebas Neue, ALL CAPS, heavy 4-6px black stroke outlines, dramatic italic lean',
        modern:     'clean geometric sans (Montserrat/Futura), tight letter-spacing, no strokes, razor-sharp letterforms',
        collegiate: 'bold slab serif (Rockwell/Clarendon), mixed-case headline with all-caps subhead, 0-2px baseline stroke',
        minimal:    'ultra-light sans (Helvetica Neue UltraLight), wide tracking, no stroke, precise baseline grid',
        hype:       'bold extended display (Industry/Azonix), gradient fills from primary to secondary color, outer glow, electric energy',
        retro:      'vintage block letters (Chunk Five/Alfa Slab), worn edge texture, distressed ink treatment, halftone dot overlay'
      };
      const compositionGuide = {
        'recruiting':   "low angle worm's-eye view, athlete dominant left two-thirds, typographic lockup right third, stadium depth-of-field background blur",
        'commitment':   'bilateral symmetry, centered athlete, school logo above head, player name as cinematic super-title',
        'player-card':  '3/4 portrait fills upper 60%, stats grid lower 40%, diagonal foil-stripe divides zones',
        'schedule':     'grid-based information design, modular schedule rows, team mark anchoring upper-left',
        'team-poster':  'wide-angle establishing shot, team color fills 70%, player name runs full-width as display banner',
        'senior-night': 'warm spotlight vignette, athlete centered in circle of light, celebratory particles',
        'mvp':          'award podium perspective, athlete elevated, trophy casting dramatic shadow, gold foil award typography',
        'championship': 'victory panorama, full-bleed team color, confetti and streamers, trophy in foreground'
      };
      const sport  = req.body.sport  || 'sports';
      const style  = req.body.style  || 'aggressive';
      const type   = req.body.type   || 'recruiting';
      const width  = parseInt(req.body.width)  || 1024;
      const height = parseInt(req.body.height) || 1536;
      const orientation = width > height ? 'LANDSCAPE' : width < height ? 'PORTRAIT' : 'SQUARE';

      const refinePrompt = `You are a professional sports graphic retoucher making ONE SURGICAL EDIT to a finished design. Your job is precision — change only exactly what is asked, nothing else.

ORIGINAL DESIGN CONTEXT:
- Sport: ${sport.toUpperCase()}
- Design type: ${type}
- Visual style: ${style} — ${styleGuide[style] || styleGuide.aggressive}
- Composition: ${compositionGuide[type] || compositionGuide['recruiting']}
- Canvas orientation: ${orientation} (${width}×${height})

REQUESTED CHANGE: "${req.body.prompt}"

PRESERVATION RULES — every item below must remain PIXEL-PERFECT identical to the input:
✓ All text (player names, numbers, school/team names, dates, stats) — exact wording, exact position on canvas, exact size
✓ Athlete/subject (if present) — exact position, exact size, exact pose, exact crop
✓ Overall layout structure and composition — nothing moves
✓ Color palette — exact same colors as input UNLESS the request explicitly says to change colors
✓ All background textures, graphic shapes, geometric elements, borders NOT mentioned in the request
✓ Canvas size, crop, and framing

DO NOT REPOSITION: Do not move, nudge, shift, or resize ANY element that is not part of the requested change.
DO NOT REDESIGN: Do not improve, clean up, or optimize anything not mentioned in the request.

SAFE ZONE RULE: Every element in the output — every letter, logo, shape — must be 100% contained within the image. Nothing may be cut off or touch any edge. If applying the change would push any element toward an edge, scale it down until it fits completely within the canvas with at least 10% padding from all edges.

APPLY ONLY THE ONE CHANGE. The output must look identical to the input with only that single element visibly different.`;

      // Normalize image: if a URL was passed instead of a data URI, convert it
      let imageDataUrl = req.body.imageDataUrl;
      if (imageDataUrl && !imageDataUrl.startsWith('data:')) {
        try {
          const fetchRes = await fetch(imageDataUrl);
          if (fetchRes.ok) {
            const arrayBuf = await fetchRes.arrayBuffer();
            const mimeType = (fetchRes.headers.get('content-type') || 'image/jpeg').split(';')[0];
            imageDataUrl = `data:${mimeType};base64,${Buffer.from(arrayBuf).toString('base64')}`;
          }
        } catch(e) { console.warn('Image URL fetch for refine failed:', e.message); }
      }

      if (GOOGLE_KEY) {
        try {
          const match = imageDataUrl && imageDataUrl.match(/^data:([^;]+);base64,(.+)$/);
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
                  generationConfig: { responseModalities: ['IMAGE', 'TEXT'], temperature: 0.15 }
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
          const match = imageDataUrl && imageDataUrl.match(/^data:([^;]+);base64,(.+)$/);
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

    // ── Parse prompt → structured text elements ───────────────
    if (action === 'parse-prompt-text' && prompt) {
      const fallback = [
        {text:'PLAYER NAME', role:'headline'},
        {text:'#00',         role:'number'},
        {text:'TEAM NAME',   role:'school'}
      ];
      if (!GOOGLE_KEY) return res.status(200).json({ texts: fallback });
      try {
        const r = await fetch(
          `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${GOOGLE_KEY}`,
          {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              contents: [{ parts: [{ text:
`Extract every text element from this sports graphic design prompt. Assign each a role.

Roles:
- "headline": player name or primary title (e.g. "JAMES WEBB", "CHAMPIONSHIP")
- "number": jersey or player number (e.g. "#13", "13")
- "school": school, team, or program name (e.g. "ALABAMA", "CRIMSON TIDE")
- "subtitle": secondary descriptor (e.g. "WIDE RECEIVER", "CLASS OF 2025")
- "detail": small text, dates, stats, taglines

Prompt: "${prompt}"

Return ONLY a raw JSON array, no markdown, no explanation:
[{"text":"EXACT TEXT AS IT SHOULD APPEAR","role":"headline"},...]`
              }]}],
              generationConfig: { temperature: 0.1, maxOutputTokens: 400 }
            })
          }
        );
        if (r.ok) {
          const d = await r.json();
          const raw = d.candidates?.[0]?.content?.parts?.[0]?.text?.trim() || '[]';
          const cleaned = raw.replace(/^```json\n?/,'').replace(/```\s*$/,'').trim();
          const texts = JSON.parse(cleaned);
          if (Array.isArray(texts) && texts.length) return res.status(200).json({ texts });
        }
      } catch(e) { console.warn('parse-prompt-text failed:', e.message); }
      return res.status(200).json({ texts: fallback });
    }

    if (action === 'expand-prompt' && prompt) {
      const systemMsg = `You are a professional sports graphic design director who creates Nike, ESPN, and Jordan Brand level graphics.

Rewrite the user's design description into a rich, detailed 2–4 sentence brief that an AI image generator can execute with total precision.

STRICT RULES:
- Preserve EVERY name, jersey number, school, team, color, stat, GPA, height, weight, date EXACTLY as written — do not invent or alter facts
- Add professional design vocabulary: dramatic lighting, composition depth, typography hierarchy, atmosphere
- Name concrete visual elements: jersey texture, stadium lighting, color blocking, typographic treatment
- If effects are mentioned (motion blur, glow, lens flare), describe how they should appear
- Match the energy level of the original (aggressive wording → explosive design language)
- Return ONLY the expanded brief. No labels, no quotes, no preamble.`;

      // Primary: GPT-4o — best sports context and design vocabulary
      if (OPENAI_KEY) {
        try {
          const ctrl = new AbortController();
          const timer = setTimeout(() => ctrl.abort(), 9000);
          const r = await fetch('https://api.openai.com/v1/chat/completions', {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${OPENAI_KEY}`, 'Content-Type': 'application/json' },
            signal: ctrl.signal,
            body: JSON.stringify({
              model: 'gpt-4o',
              messages: [{ role: 'system', content: systemMsg }, { role: 'user', content: prompt }],
              max_tokens: 400,
              temperature: 0.65
            })
          });
          clearTimeout(timer);
          if (r.ok) {
            const d = await r.json();
            const expanded = d.choices?.[0]?.message?.content?.trim();
            if (expanded) return res.status(200).json({ expanded });
          }
        } catch(e) { console.warn('GPT-4o expansion failed, trying Gemini:', e.message); }
      }

      // Fallback: Gemini Flash
      if (GOOGLE_KEY) {
        try {
          const ctrl = new AbortController();
          setTimeout(() => ctrl.abort(), 7000);
          const expandRes = await fetch(
            `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${GOOGLE_KEY}`,
            {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              signal: ctrl.signal,
              body: JSON.stringify({
                contents: [{ parts: [{ text: systemMsg + '\n\nUser brief: ' + prompt }] }],
                generationConfig: { temperature: 0.65, maxOutputTokens: 400 }
              })
            }
          );
          if (expandRes.ok) {
            const expandData = await expandRes.json();
            const expanded   = expandData.candidates?.[0]?.content?.parts?.[0]?.text?.trim();
            if (expanded) return res.status(200).json({ expanded });
          }
        } catch(e) { console.warn('Gemini expansion failed:', e.message); }
      }

      return res.status(200).json({ expanded: prompt });
    }

    // ── Image generation — gpt-image-1 → Gemini → FLUX ───────
    if (!prompt) return res.status(400).json({ error: 'prompt is required' });

    // Helper: call gpt-image-1 with timeout and return base64 data URI
    async function tryGptImage(sz) {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 55000);
      try {
        const imgRes = await fetch('https://api.openai.com/v1/images/generations', {
          method:  'POST',
          headers: { 'Authorization': `Bearer ${OPENAI_KEY}`, 'Content-Type': 'application/json' },
          signal:  ctrl.signal,
          body:    JSON.stringify({ model: 'gpt-image-1', prompt, n: 1, size: sz, quality: 'high' })
        });
        clearTimeout(timer);
        const imgData = await imgRes.json();
        if (!imgRes.ok) {
          const code = imgData.error?.code || imgData.error?.type || imgRes.status;
          throw Object.assign(new Error(imgData.error?.message || 'gpt-image-1 error'), { code, status: imgRes.status });
        }
        const b64 = imgData.data?.[0]?.b64_json;
        const url = imgData.data?.[0]?.url;
        // Prefer b64 (permanent) over URL (expires in 1 hour)
        const imageUrl = b64 ? `data:image/png;base64,${b64}` : url;
        if (!imageUrl) throw new Error('gpt-image-1 returned no image');
        return imageUrl;
      } catch(e) {
        clearTimeout(timer);
        throw e;
      }
    }

    // Primary: gpt-image-1 — best instruction adherence; retry once on transient errors
    if (OPENAI_KEY) {
      const size = (width === height) ? '1024x1024'
                 : (width  > height)  ? '1536x1024'
                 :                      '1024x1536';
      let lastErr;
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          const imageUrl = await tryGptImage(size);
          return res.status(200).json({ status: 'succeeded', imageUrl, engine: 'gpt-image-1' });
        } catch(e) {
          lastErr = e;
          const isTransient = e.status === 429 || e.status === 500 || e.status === 503 || e.name === 'AbortError';
          if (!isTransient || attempt === 1) break;
          await new Promise(r => setTimeout(r, 1500));
        }
      }
      console.warn('gpt-image-1 failed after retries, falling back to Gemini:', lastErr?.message);
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
