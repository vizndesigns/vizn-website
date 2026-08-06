// ─────────────────────────────────────────────────────────────
//  VIZN — Vercel Serverless Function
//  Images:      gpt-image-2 (OpenAI) → FLUX Kontext Pro → Gemini 3 Pro Image fallback
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

  // ── gpt-image-2 direct — Images API (generations for text-only, edits for photos) ──
  // GPT-5.5 + the Responses API "image_generation" tool was tried twice (90s then 150s
  // timeout) and failed 100% of the time in production — every single request aborted
  // without completing, silently falling through to the fallback engines, which is what
  // was actually producing the garbled text/fake badges. Not viable for this workload
  // at any reasonable timeout. Back to the direct API for good.
  async function callGptImage({ promptText, images = [], size = 'auto', quality = 'high', timeoutMs = 45000 }) {
    const ctrl  = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      let res;
      if (images.length > 0) {
        const match = images[0].match(/^data:([^;]+);base64,(.+)$/);
        if (!match) throw new Error('Invalid image format');
        const [, mimeType, b64data] = match;
        const buffer = Buffer.from(b64data, 'base64');
        const ext    = mimeType.includes('png') ? 'png' : 'jpg';
        const form   = new FormData();
        form.append('image', new File([buffer], `image.${ext}`, { type: mimeType }));
        form.append('prompt', promptText);
        form.append('model', 'gpt-image-2');
        form.append('size', size);
        form.append('quality', quality);
        form.append('n', '1');
        res = await fetch('https://api.openai.com/v1/images/edits', {
          method: 'POST', headers: { 'Authorization': `Bearer ${OPENAI_KEY}` },
          signal: ctrl.signal, body: form
        });
      } else {
        res = await fetch('https://api.openai.com/v1/images/generations', {
          method:  'POST',
          headers: { 'Authorization': `Bearer ${OPENAI_KEY}`, 'Content-Type': 'application/json' },
          signal:  ctrl.signal,
          body:    JSON.stringify({ model: 'gpt-image-2', prompt: promptText, n: 1, size, quality })
        });
      }
      clearTimeout(timer);
      const data = await res.json();
      if (!res.ok) {
        throw Object.assign(new Error(data.error?.message || 'gpt-image-2 error'), { status: res.status, code: data.error?.code });
      }
      const b64 = data.data?.[0]?.b64_json;
      const url = data.data?.[0]?.url;
      const imageUrl = b64 ? `data:image/png;base64,${b64}` : url;
      if (!imageUrl) throw new Error('gpt-image-2 returned no image');
      return imageUrl;
    } catch(e) {
      clearTimeout(timer);
      throw e;
    }
  }

  try {
    const { action, predictionId, jobId, image, prompt, width, height, athleteImage, style, query } = req.body;

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

    // ── Web photo search for named real people — Gemini Google Search grounding ──
    // Finds candidate source pages via Gemini's search grounding tool (no new API key —
    // reuses GOOGLE_KEY already configured for the other Gemini calls in this file), then
    // scrapes each page's og:image/twitter:image meta tag server-side to get an actual photo.
    // Never auto-applied: the frontend requires the user to pick + confirm rights before use.
    if (action === 'search-photo' && query) {
      if (!GOOGLE_KEY) return res.status(500).json({ error: 'GOOGLE_KEY not configured' });

      async function fetchWithTimeout(url, opts = {}, timeoutMs = 5000) {
        const ctrl  = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), timeoutMs);
        try {
          return await fetch(url, { ...opts, signal: ctrl.signal });
        } finally {
          clearTimeout(timer);
        }
      }

      function extractImageMeta(html) {
        const patterns = [
          /<meta[^>]+property=["']og:image(?::secure_url)?["'][^>]*content=["']([^"']+)["']/i,
          /<meta[^>]+content=["']([^"']+)["'][^>]*property=["']og:image(?::secure_url)?["']/i,
          /<meta[^>]+name=["']twitter:image(?::src)?["'][^>]*content=["']([^"']+)["']/i,
          /<meta[^>]+content=["']([^"']+)["'][^>]*name=["']twitter:image(?::src)?["']/i,
        ];
        for (const re of patterns) {
          const m = html.match(re);
          if (m) return m[1];
        }
        return null;
      }

      // Step 1: grounded search for candidate source pages
      let chunks = [];
      try {
        const searchRes = await fetchWithTimeout(
          `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${GOOGLE_KEY}`,
          {
            method:  'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              contents: [{ parts: [{ text:
                `Search the web for a clear, current photo of this real person: "${query}". ` +
                `Prefer official team/school rosters, ESPN, MaxPreps, 247Sports, Rivals, Wikipedia, ` +
                `or verified news outlets. Reply with a one-line confirmation only.`
              }] }],
              tools: [{ google_search: {} }]
            })
          },
          15000
        );
        const searchData = await searchRes.json();
        chunks = searchData.candidates?.[0]?.groundingMetadata?.groundingChunks || [];
      } catch(e) {
        console.warn('search-photo: grounding search failed:', e.message);
      }

      const pageUrls = [...new Set(chunks.map(c => c.web?.uri).filter(Boolean))].slice(0, 8);
      if (!pageUrls.length) return res.status(200).json({ candidates: [] });

      // Step 2: scrape each candidate page for an og:image/twitter:image
      const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';
      const scraped = await Promise.allSettled(pageUrls.map(async pageUrl => {
        const pageRes = await fetchWithTimeout(pageUrl, { headers: { 'User-Agent': UA } }, 5000);
        if (!pageRes.ok) throw new Error(`page ${pageRes.status}`);
        const html   = await pageRes.text();
        const imgUrl = extractImageMeta(html);
        if (!imgUrl) throw new Error('no og:image');
        const resolved = new URL(imgUrl, pageUrl).href;
        const chunk     = chunks.find(c => c.web?.uri === pageUrl);
        return { imgUrl: resolved, sourceUrl: pageUrl, sourceTitle: chunk?.web?.title || new URL(pageUrl).hostname };
      }));

      const found    = scraped.filter(r => r.status === 'fulfilled').map(r => r.value);
      const seenImg  = new Set();
      const deduped  = found.filter(f => {
        if (seenImg.has(f.imgUrl)) return false;
        seenImg.add(f.imgUrl);
        return true;
      }).slice(0, 4);

      // Step 3: fetch + base64-encode each image so the frontend never hits CORS/hotlink issues
      const settled = await Promise.allSettled(deduped.map(async f => {
        const imgRes = await fetchWithTimeout(f.imgUrl, { headers: { 'User-Agent': UA } }, 6000);
        if (!imgRes.ok) throw new Error(`image ${imgRes.status}`);
        const contentType = imgRes.headers.get('content-type') || 'image/jpeg';
        if (!contentType.startsWith('image/')) throw new Error('not an image');
        const buf = Buffer.from(await imgRes.arrayBuffer());
        if (buf.length > 8 * 1024 * 1024) throw new Error('image too large');
        const sourceDomain = new URL(f.sourceUrl).hostname.replace(/^www\./, '');
        return {
          image:       `data:${contentType};base64,${buf.toString('base64')}`,
          sourceUrl:   f.sourceUrl,
          sourceTitle: f.sourceTitle,
          sourceDomain
        };
      }));

      const candidates = settled.filter(r => r.status === 'fulfilled').map(r => r.value);
      return res.status(200).json({ candidates });
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

    // ── Fast team background — FLUX → gpt-image-2 → Gemini → canvas ────
    // FLUX 1.1 Pro is primary: fastest + best atmospheric quality for sports BGs.
    // gpt-image-2 / Gemini as fallbacks. Canvas as last resort.
    if (action === 'team-bg' && prompt) {
      const bgWidth  = req.body.width  || 1024;
      const bgHeight = req.body.height || 1280;
      const bgSize   = bgHeight > bgWidth ? '1024x1536' : bgWidth > bgHeight ? '1536x1024' : '1024x1024';
      const refImage = req.body.referenceImage || null;

      const refPrefix = refImage ? 'Match the color palette, lighting style, and visual atmosphere of the reference image provided. Generate a NEW background — do not copy the reference exactly. ' : '';
      // This background gets a real photo and real canvas-drawn text composited onto it
      // afterward — it must be a clean atmosphere-only plate, or the AI's own people/text/
      // scoreboards collide with the real ones layered on top (ghosted duplicate faces,
      // doubled headlines, unreadable overlapping scoreboards).
      const fullBgPrompt = `${refPrefix}Generate ONLY a cinematic sports-arena atmosphere background plate — lighting, color, gradient, depth, and mood. Context for color/mood only, do not depict literally: "${prompt}"

ABSOLUTE RULES — this is a blank stage, not a finished graphic:
- ZERO humans, athletes, faces, silhouettes, crowds, or any body parts, anywhere
- ZERO text, letters, numbers, words, or scoreboards of any kind
- ZERO logos, crests, badges, or team marks of any kind
Pure atmosphere and lighting only.`;

      // ── Primary: FLUX 1.1 Pro — fastest + cinematic atmospheric quality ─
      if (REPLICATE_KEY) {
        try {
          const fluxCtrl  = new AbortController();
          const fluxTimer = setTimeout(() => fluxCtrl.abort(), 55000);

          const fluxW = Math.min(parseInt(bgWidth)  || 1024, 1440);
          const fluxH = Math.min(parseInt(bgHeight) || 1280, 1440);

          const fluxRes = await fetch(
            'https://api.replicate.com/v1/models/black-forest-labs/flux-1.1-pro/predictions',
            {
              method:  'POST',
              headers: {
                'Authorization': `Bearer ${REPLICATE_KEY}`,
                'Content-Type': 'application/json',
                'Prefer': 'wait=50'
              },
              signal: fluxCtrl.signal,
              body: JSON.stringify({
                input: {
                  prompt:           fullBgPrompt,
                  width:            fluxW,
                  height:           fluxH,
                  output_format:    'jpeg',
                  output_quality:   95,
                  safety_tolerance: 6,
                  prompt_upsampling: true
                }
              })
            }
          );
          clearTimeout(fluxTimer);

          if (fluxRes.ok) {
            const fluxData = await fluxRes.json();
            const imgUrl   = typeof fluxData.output === 'string' ? fluxData.output
                           : Array.isArray(fluxData.output)      ? fluxData.output[0]
                           : null;
            if (imgUrl && imgUrl.startsWith('http')) {
              const imgBuf = await (await fetch(imgUrl)).arrayBuffer();
              const b64    = 'data:image/jpeg;base64,' + Buffer.from(imgBuf).toString('base64');
              return res.status(200).json({ status: 'succeeded', imageUrl: b64, engine: 'flux-bg' });
            }
          } else {
            const fe = await fluxRes.json().catch(() => ({}));
            console.warn('FLUX team-bg failed:', fe.detail || fluxRes.status);
          }
        } catch(e) { console.warn('FLUX team-bg error:', e.message); }
      }

      // ── Secondary: gpt-image-2 ───────────────────────────────────────
      if (OPENAI_KEY) {
        try {
          const imageUrl = await callGptImage({
            promptText: fullBgPrompt,
            images: refImage ? [refImage] : [],
            size: bgSize,
            quality: 'high',
            timeoutMs: 45000
          });
          return res.status(200).json({ status: 'succeeded', imageUrl, engine: 'gpt-bg' });
        } catch(e) { console.warn('GPT team-bg error:', e.message); }
      }

      // ── Secondary: Gemini — free fallback ───────────────────────────
      if (GOOGLE_KEY) {
        try {
          const ctrl  = new AbortController();
          const timer = setTimeout(() => ctrl.abort(), 55000);

          const bgParts = [];
          if (refImage) {
            const refMatch = refImage.match(/^data:([^;]+);base64,(.+)$/);
            if (refMatch) {
              bgParts.push({ text: 'REFERENCE IMAGE — draw from this image\'s color palette and atmosphere to inform a NEW background, not a copy of it:' });
              bgParts.push({ inline_data: { mime_type: refMatch[1], data: refMatch[2] } });
            }
          }
          bgParts.push({ text: prompt });

          const gRes = await fetch(
            `https://generativelanguage.googleapis.com/v1beta/models/gemini-3-pro-image:generateContent?key=${GOOGLE_KEY}`,
            {
              method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: ctrl.signal,
              body: JSON.stringify({
                contents: [{ parts: bgParts }],
                generationConfig: { responseModalities: ['IMAGE', 'TEXT'], temperature: 0.35, imageConfig: { aspectRatio: '2:3' } }
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
              return res.status(200).json({ status: 'succeeded', imageUrl: `data:${mimeType};base64,${data}`, engine: 'gemini-bg' });
            }
          } else {
            const err = await gRes.json().catch(() => ({}));
            console.warn('team-bg Gemini error:', err.error?.message || gRes.status);
          }
        } catch(e) { console.warn('team-bg Gemini failed:', e.message); }
      }

      // Signal frontend to use local canvas background
      return res.status(200).json({ status: 'use-canvas' });
    }

    // ── Vision-based generation — athlete photo → sports graphic ──────────────
    // Model priority: gpt-image-2 edits → FLUX Kontext Pro → Gemini 3 Pro Image multimodal
    // FLUX Kontext is the identity-preservation specialist if gpt-image-2 fails; GPT/Gemini
    // treat uploaded photos more as style hints. (FLUX.2 Pro Edit was tried here briefly —
    // its stricter real-person-face moderation rejected a legitimate athlete-photo edit in
    // production with a content_policy_violation. Kontext has a long proven track record on
    // this exact use case with zero content-policy failures, so it's back.)
    const refImage = req.body.referenceImage || null;
    if (action === 'generate-with-image' && (athleteImage || refImage) && prompt) {
      const size = (width === height) ? '1024x1024'
                 : (width  > height)  ? '1536x1024'
                 :                      '1024x1536';

      // ── Upload helper — push base64 to fal.ai CDN, get a public URL back ──
      async function uploadToFal(base64DataUrl, filename = 'image.jpg') {
        const m = base64DataUrl.match(/^data:([^;]+);base64,(.+)$/);
        if (!m) return null;
        const [, mime, b64] = m;
        const buf = Buffer.from(b64, 'base64');
        const ext = mime.includes('png') ? 'png' : mime.includes('webp') ? 'webp' : 'jpg';
        const initR = await fetch('https://rest.fal.ai/storage/upload/initiate', {
          method: 'POST',
          headers: { 'Authorization': `Key ${FAL_KEY}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ content_type: mime, file_name: filename.replace(/\.[^.]+$/, `.${ext}`) })
        });
        if (!initR.ok) return null;
        const { file_url, upload_url } = await initR.json();
        const putR = await fetch(upload_url, { method: 'PUT', headers: { 'Content-Type': mime }, body: buf });
        return putR.ok ? file_url : null;
      }

      // ── PRIMARY: gpt-image-2 edits — best text rendering, best identity, when it finishes ──
      // Runs whenever either image is present, passing both when both exist. Fires TWO
      // independent gpt-image-2 requests in parallel and uses whichever succeeds first —
      // this is a real reliability lever, not just a timeout tweak: it roughly doubles the
      // odds of getting gpt-image-2's quality instead of falling to a weaker fallback, at
      // the cost of ~2x OpenAI spend per generation. Chosen deliberately for a paid product
      // where a customer seeing FLUX Kontext's garbled text is worse than the extra cost.
      if (OPENAI_KEY && (athleteImage || refImage)) {
        const images = [athleteImage, refImage].filter(Boolean);
        try {
          const imageUrl = await Promise.any([
            callGptImage({ promptText: prompt, images, size, quality: 'high', timeoutMs: 90000 }),
            callGptImage({ promptText: prompt, images, size, quality: 'high', timeoutMs: 90000 })
          ]);
          return res.status(200).json({ status: 'succeeded', imageUrl, engine: 'gpt-image-2-edit' });
        } catch(e) {
          const detail = e?.errors ? e.errors.map(err => err.message).join(' | ') : e.message;
          console.warn('gpt-image-2 edit failed (both parallel attempts):', detail);
        }
      }

      // ── SECONDARY: FLUX Kontext Pro — identity-preserving image editor ──
      // Kontext's API takes a single edit-target image: prefer the athlete photo
      // (identity preservation matters more there) and fall back to the reference
      // image as the edit target when that's all that was uploaded.
      if (FAL_KEY && (athleteImage || refImage)) {
        try {
          const kontextSource = athleteImage || refImage;
          const falImageUrl = await uploadToFal(kontextSource, athleteImage ? 'athlete.jpg' : 'reference.jpg');
          if (falImageUrl) {
            const kontextPrompt = athleteImage
              ? `Transform this athlete photo into a professional sports graphic.
Keep the person in this photo exactly as they appear — same face, same body, same pose, same clothing. Do not change them at all.
${prompt}
ESPN / Nike / Jordan Brand quality. All text pixel-sharp and fully legible. Nothing cropped at any edge.`
              : `Use this image only as creative inspiration — its color palette, composition, or typography style — to build a NEW, distinct sports graphic. Do not reproduce it.
${prompt}
ESPN / Nike / Jordan Brand quality. All text pixel-sharp and fully legible. Nothing cropped at any edge.`;
            const kCtrl = new AbortController();
            const kTimer = setTimeout(() => kCtrl.abort(), 60000);
            const kRes = await fetch('https://fal.run/fal-ai/flux-pro/kontext', {
              method: 'POST',
              headers: { 'Authorization': `Key ${FAL_KEY}`, 'Content-Type': 'application/json' },
              signal: kCtrl.signal,
              body: JSON.stringify({ image_url: falImageUrl, prompt: kontextPrompt, num_inference_steps: 28, guidance_scale: 2.5, output_format: 'jpeg', output_quality: 95, num_images: 1 })
            });
            clearTimeout(kTimer);
            if (kRes.ok) {
              const kData = await kRes.json();
              const imgUrl = kData.images?.[0]?.url;
              if (imgUrl) {
                const imgRes  = await fetch(imgUrl);
                const imgBuf  = await imgRes.arrayBuffer();
                const imgMime = (imgRes.headers.get('content-type') || 'image/png').split(';')[0];
                const b64 = `data:${imgMime};base64,` + Buffer.from(imgBuf).toString('base64');
                return res.status(200).json({ status: 'succeeded', imageUrl: b64, engine: 'flux-kontext' });
              }
            } else {
              const kerr = await kRes.json().catch(() => ({}));
              console.warn('FLUX Kontext error:', kerr.detail || kerr.message || kRes.status);
            }
          }
        } catch(e) { console.warn('FLUX Kontext failed:', e.message); }
      }

      // ── TERTIARY: Gemini multimodal ──
      if (GOOGLE_KEY) {
        try {
          const geminiParts = [];
          if (refImage) {
            const refMatch = refImage.match(/^data:([^;]+);base64,(.+)$/);
            if (refMatch) {
              geminiParts.push({ text: 'REFERENCE IMAGE — use specific elements of this image (color palette, typography, layout, mood) as creative inspiration for a NEW, distinct design. Do not reproduce this image:' });
              geminiParts.push({ inline_data: { mime_type: refMatch[1], data: refMatch[2] } });
            }
          }
          if (athleteImage) {
            const m = athleteImage.match(/^data:([^;]+);base64,(.+)$/);
            if (m) {
              geminiParts.push({ text: 'ATHLETE — use this exact person in the design:' });
              geminiParts.push({ inline_data: { mime_type: m[1], data: m[2] } });
            }
          }
          geminiParts.push({ text: prompt });
          const gCtrl  = new AbortController();
          const gTimer = setTimeout(() => gCtrl.abort(), 50000);
          const gRes   = await fetch(
            `https://generativelanguage.googleapis.com/v1beta/models/gemini-3-pro-image:generateContent?key=${GOOGLE_KEY}`,
            { method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: gCtrl.signal,
              body: JSON.stringify({ contents: [{ parts: geminiParts }], generationConfig: { responseModalities: ['IMAGE', 'TEXT'], imageConfig: { aspectRatio: '2:3' } } }) }
          );
          clearTimeout(gTimer);
          if (gRes.ok) {
            const gData   = await gRes.json();
            const parts   = gData.candidates?.[0]?.content?.parts || [];
            const imgPart = parts.find(p => p.inlineData?.mimeType?.startsWith('image/'));
            if (imgPart?.inlineData) {
              const { mimeType: mt, data } = imgPart.inlineData;
              return res.status(200).json({ status: 'succeeded', imageUrl: `data:${mt};base64,${data}`, engine: 'gemini-vision' });
            }
          } else {
            const gerr = await gRes.json().catch(() => ({}));
            console.warn('Gemini vision error:', gerr.error?.message || gRes.status);
          }
        } catch(e) { console.warn('Gemini vision failed:', e.message); }
      }

      console.warn('All vision paths failed for an uploaded photo — erroring instead of silently generating a generic image that ignores it');
      return res.status(502).json({ error: 'Could not generate from your photo — every image engine failed or timed out. Please try again.' });
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
      const sport  = req.body.sport  || 'sports';
      const style  = req.body.style  || 'aggressive';
      const width  = parseInt(req.body.width)  || 1024;
      const height = parseInt(req.body.height) || 1536;
      const orientation = width > height ? 'LANDSCAPE' : width < height ? 'PORTRAIT' : 'SQUARE';

      const refinePrompt = `You are a professional sports graphic retoucher making ONE SURGICAL EDIT to a finished design. Your job is precision — change only exactly what is asked, nothing else.

ORIGINAL DESIGN CONTEXT:
- Sport: ${sport.toUpperCase()}
- Visual style: ${style} — ${styleGuide[style] || styleGuide.aggressive}
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
              `https://generativelanguage.googleapis.com/v1beta/models/gemini-3-pro-image:generateContent?key=${GOOGLE_KEY}`,
              {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                  contents: [{ parts: [
                    { inlineData: { mimeType: mime, data: b64 } },
                    { text: refinePrompt }
                  ]}],
                  generationConfig: { responseModalities: ['IMAGE', 'TEXT'], temperature: 0.15, imageConfig: { aspectRatio: '2:3' } }
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

      if (OPENAI_KEY && imageDataUrl && imageDataUrl.startsWith('data:')) {
        try {
          const imageUrl = await callGptImage({
            promptText: refinePrompt,
            images: [imageDataUrl],
            timeoutMs: 60000
          });
          return res.status(200).json({ url: imageUrl, engine: 'gpt-image-2-edit' });
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
          `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${GOOGLE_KEY}`,
          {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              contents: [{ parts: [{ text:
`Extract every text element from this sports graphic design prompt. Assign each a role.

Roles:
- "headline": the ATHLETE'S OWN personal name — an actual person's first + last name (e.g.
  "AVA BARTLETT", "JAMES WEBB") — if one is named anywhere in the prompt. A person's name
  ALWAYS wins this role over a school/team/mascot name, even when the team name appears
  first, in bold, or more prominently. Only fall back to a primary design title (e.g.
  "CHAMPIONSHIP", "GAME DAY") when no specific person is named at all.
- "number": jersey or player number (e.g. "#13", "13")
- "school": school, team, or program name, including any mascot word (e.g. "ALABAMA CRIMSON
  TIDE", "ADDISON BULLDOGS") — this is NEVER a person's name, even if it's listed first.
- "subtitle": secondary descriptor — position, class year, or the sport name when it's given
  as its own separate line/label distinct from the school name (e.g. "WIDE RECEIVER",
  "CLASS OF 2025", "VOLLEYBALL")
- "detail": small text, dates, stats, taglines
- "score": the game score line, ONLY if the prompt explicitly states a score and/or an
  opponent team — format exactly as "TEAM 118 - TEAM 110" (or "118 - 110" if no team names
  given). Do NOT invent a score or opponent that isn't explicitly in the prompt — omit this
  role entirely rather than guess.

Many prompts list team name, sport, player name, and jersey number as separate lines, in
that order — e.g. "ADDISON BULLDOGS / VOLLEYBALL / AVA BARTLETT / #32". In that pattern:
school = "ADDISON BULLDOGS", subtitle = "VOLLEYBALL", headline = "AVA BARTLETT" (the actual
person, not the team, even though the team is listed first), number = "#32". Do not swap
headline and school.

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

Rewrite the user's design description into a richer, more detailed brief that an AI image generator can execute with total precision.

STRICT RULES:
- Preserve EVERY name, jersey number, school, team, color, stat, GPA, height, weight, date, and instruction EXACTLY as written — do not invent, alter, or drop a single fact
- There is no length cap — if the original already lists many distinct facts or instructions, keep every one of them explicitly, even if that makes the brief long. Never summarize or compress away a detail to keep the brief short.
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
            `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${GOOGLE_KEY}`,
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

    // ── Analyze reference image for style extraction ───────────
    if (action === 'analyze-reference' && req.body.referenceImage) {
      if (!GOOGLE_KEY) return res.status(500).json({ error: 'GOOGLE_KEY not configured' });

      const match = req.body.referenceImage.match(/^data:([^;]+);base64,(.+)$/);
      if (!match) return res.status(400).json({ error: 'Invalid image format' });
      const [, mimeType, b64Data] = match;

      const ctrl  = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 15000);
      try {
        const geminiRes = await fetch(
          `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${GOOGLE_KEY}`,
          {
            method:  'POST',
            headers: { 'Content-Type': 'application/json' },
            signal:  ctrl.signal,
            body:    JSON.stringify({
              contents: [{
                parts: [
                  { inlineData: { mimeType, data: b64Data } },
                  { text: `You are a sports graphic design analyst. Analyze this sports graphic and describe its visual style in exactly 5 bullet points:
• COLOR PALETTE: List the exact colors (hex values if visible, or precise descriptive names)
• TYPOGRAPHY: Font style (bold/condensed/light), weight, size hierarchy, effects (glow/stroke/italic/shadow)
• LAYOUT & COMPOSITION: How subjects are arranged, framing, negative space, focal hierarchy
• VISUAL EFFECTS: Gradients, glows, overlays, textures, vignettes, light rays, grain
• MOOD & ENERGY: Overall tone, intensity level, aesthetic direction (aggressive/clean/vintage/electric)

Be specific. This analysis will guide generation of a new sports graphic with a similar aesthetic.` }
                ]
              }],
              generationConfig: { temperature: 0.2, maxOutputTokens: 400 }
            })
          }
        );
        clearTimeout(timer);
        if (geminiRes.ok) {
          const geminiData = await geminiRes.json();
          const analysis   = geminiData.candidates?.[0]?.content?.parts?.[0]?.text?.trim();
          if (analysis) return res.status(200).json({ analysis });
        }
      } catch(e) { clearTimeout(timer); console.warn('Reference analysis failed:', e.message); }

      return res.status(200).json({ analysis: '' });
    }

    // ── Image generation — gpt-image-2 → Gemini → FLUX ───────
    if (!prompt) return res.status(400).json({ error: 'prompt is required' });

    // Primary: gpt-image-2 — best instruction adherence
    // Two parallel requests, first success wins — same reliability trade as the photo-upload
    // path (roughly 2x OpenAI spend per generation, roughly 2x the odds of avoiding the
    // weaker Gemini/FLUX fallback). Deliberate choice for a paid product.
    if (OPENAI_KEY) {
      const size = (width === height) ? '1024x1024'
                 : (width  > height)  ? '1536x1024'
                 :                      '1024x1536';
      try {
        const imageUrl = await Promise.any([
          callGptImage({ promptText: prompt, size, quality: 'high', timeoutMs: 90000 }),
          callGptImage({ promptText: prompt, size, quality: 'high', timeoutMs: 90000 })
        ]);
        return res.status(200).json({ status: 'succeeded', imageUrl, engine: 'gpt-image-2' });
      } catch(e) {
        const detail = e?.errors ? e.errors.map(err => err.message).join(' | ') : e.message;
        console.warn('gpt-image-2 failed (both parallel attempts), falling back to Gemini:', detail);
      }
    }

    // Secondary: Gemini (fallback when OpenAI unavailable)
    if (GOOGLE_KEY) {
      try {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 70000);

        const geminiRes = await fetch(
          `https://generativelanguage.googleapis.com/v1beta/models/gemini-3-pro-image:generateContent?key=${GOOGLE_KEY}`,
          {
            method:  'POST',
            headers: { 'Content-Type': 'application/json' },
            signal:  controller.signal,
            body:    JSON.stringify({
              contents: [{ parts: [{ text: prompt }] }],
              generationConfig: { responseModalities: ['IMAGE', 'TEXT'], temperature: 0.4, imageConfig: { aspectRatio: '2:3' } }
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

    // Fallback: FLUX 1.1 Pro — higher quality than FLUX Dev, same tier used for backgrounds
    if (!REPLICATE_KEY) return res.status(500).json({ error: 'No AI key configured. Add OPENAI_API_KEY or REPLICATE_API_KEY.' });

    const fluxW = Math.min(parseInt(width)  || 832,  1440);
    const fluxH = Math.min(parseInt(height) || 1024, 1440);

    const fluxRes = await fetch(
      'https://api.replicate.com/v1/models/black-forest-labs/flux-1.1-pro/predictions',
      {
        method:  'POST',
        headers: { 'Authorization': `Bearer ${REPLICATE_KEY}`, 'Content-Type': 'application/json', 'Prefer': 'wait=45' },
        body:    JSON.stringify({ input: {
          prompt,
          width:             fluxW,
          height:            fluxH,
          output_format:     'png',
          output_quality:    95,
          safety_tolerance:  6,
          prompt_upsampling: true
        } })
      }
    );

    if (!fluxRes.ok) {
      const err = await fluxRes.json();
      return res.status(fluxRes.status).json({ error: err.detail || `Replicate error ${fluxRes.status}` });
    }

    const prediction = await fluxRes.json();
    const fluxOut = typeof prediction.output === 'string' ? prediction.output
                  : Array.isArray(prediction.output)      ? prediction.output[0]
                  : null;
    if (prediction.status === 'succeeded' && fluxOut) {
      return res.status(200).json({ status: 'succeeded', imageUrl: fluxOut, engine: 'flux-pro' });
    }
    return res.status(202).json({ status: 'processing', predictionId: prediction.id, engine: 'flux-pro' });

  } catch (err) {
    console.error('VIZN /api/generate error:', err.message);
    return res.status(500).json({ error: err.message || 'Internal server error' });
  }
}
