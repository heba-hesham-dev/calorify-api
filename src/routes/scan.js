// POST /api/scan
// The app sends a food photo (and a description if the user wrote one).
// We ask Gemini what's in it, check the answer, and send back the foods with their calories.
//
// Request:  { image: "<base64>", mimeType: "image/jpeg", description?: "with 1 tbsp oil" }
// Answers:
//   200 -> { title, confidence, exact, items: [{ name, grams, calories, caloriesMin, caloriesMax, protein, carbs, fats }],
//            total, note, tip, model }
//          exact = false -> calories are a best guess inside a range, and tip asks for the grams
//   400 -> the request is missing something (no photo, wrong type, too big)
//   422 -> the photo isn't food
//   429 -> no AI requests left (with resetAt) or too many in one minute
//   502 -> the AI's answer was broken, or the AI isn't available

import { Router } from 'express';

import { AIError, askGemini } from '../lib/gemini.js';
import { SCAN_INSTRUCTIONS, scanSchema } from '../lib/prompts.js';
import { validateScan } from '../lib/validate.js';

const router = Router();

const PHOTO_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif'];
const MAX_PHOTO_CHARS = 4_400_000; // about 3.3 MB of photo (Vercel's limit is 4.5 MB per request)

router.post('/', async (req, res, next) => {
  try {
    // 1. Check what the app sent
    let { image, mimeType = 'image/jpeg', description = '' } = req.body ?? {};
    if (typeof image !== 'string' || image.length < 100) {
      throw new AIError(400, 'no_photo', 'Send a photo to scan.');
    }
    image = image.replace(/^data:[^;]+;base64,/, ''); // "data:image/jpeg;base64,..." -> just the photo
    if (image.length > MAX_PHOTO_CHARS) {
      throw new AIError(400, 'photo_too_big', 'The photo is too big. Try a smaller one.');
    }
    if (!PHOTO_TYPES.includes(mimeType)) {
      throw new AIError(400, 'bad_photo_type', 'Use a JPG, PNG, WEBP or HEIC photo.');
    }
    description = typeof description === 'string' ? description.trim().slice(0, 300) : '';

    // 2. Ask Gemini (main model first, backup if needed)
    const started = Date.now();
    const { data, model } = await askGemini('scan', {
      systemInstruction: SCAN_INSTRUCTIONS,
      schema: scanSchema,
      contents: [
        {
          role: 'user',
          parts: [
            { inlineData: { mimeType, data: image } },
            { text: description ? `The user says: "${description}"` : 'No description from the user.' },
          ],
        },
      ],
    });

    // 3. Check the answer
    const result = validateScan(data);
    console.log(`[scan] ${model} · ${Date.now() - started} ms · ${result.items.length} items`);
    if (!result.isFood) {
      throw new AIError(422, 'not_food', "This photo doesn't look like food. Try another photo.");
    }

    // 4. Send it to the app
    res.json({ ...result, model });
  } catch (error) {
    if (error instanceof AIError) return res.status(error.status).json(error.toJSON());
    next(error);
  }
});

export default router;
