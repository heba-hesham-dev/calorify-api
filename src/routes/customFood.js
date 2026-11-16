// POST /api/custom-food
// "Add custom food" in the app: the user writes a name and what's in it.
// We ask Gemini for the calories and macros, check the answer, and send it back.
// The app then saves it to "My foods" (the description is what 1 serving means).
//
// Request: { name: "My egg sandwich", description: "1 baladi loaf, 2 eggs with mushroom, 1 slice cheddar" }
// Answers:
//   200 -> { name, category, exact, calories, caloriesMin, caloriesMax, protein, carbs, fats,
//            items: [{ name, amount, calories, ... }], missing: [...], tip, model }
//          exact = false -> some amounts are missing: a range, and "missing" says which ones
//   400 -> no name or no description, or too long
//   422 -> the description isn't food
//   429 -> no AI requests left (with resetAt) or too many in one minute
//   502 -> the AI's answer was broken, or the AI isn't available

import { Router } from 'express';

import { AIError, askGemini } from '../lib/gemini.js';
import { CUSTOM_FOOD_INSTRUCTIONS, customFoodSchema } from '../lib/prompts.js';
import { validateCustomFood } from '../lib/validate.js';

const router = Router();

router.post('/', async (req, res, next) => {
  try {
    // 1. Check what the app sent
    const name = String(req.body?.name ?? '').trim();
    const description = String(req.body?.description ?? '').trim();
    if (!name) throw new AIError(400, 'no_name', 'Give your food a name.');
    if (!description) throw new AIError(400, 'no_description', "Write what's in it, so we can work out the calories.");
    if (name.length > 60) throw new AIError(400, 'name_too_long', 'Keep the name under 60 characters.');
    if (description.length > 300) throw new AIError(400, 'description_too_long', 'Keep the description under 300 characters.');

    // 2. Ask Gemini
    const started = Date.now();
    const { data, model } = await askGemini('customFood', {
      systemInstruction: CUSTOM_FOOD_INSTRUCTIONS,
      schema: customFoodSchema,
      contents: [{ role: 'user', parts: [{ text: `Name: ${name}\nWhat's in it: ${description}` }] }],
    });

    // 3. Check the answer and send it
    const result = validateCustomFood(data, name);
    if (!result.isFood) throw new AIError(422, 'not_food', "That doesn't look like a food. Describe what's in it, like \"2 eggs, 1 toast slice\".");
    console.log(`[custom-food] ${model} · ${Date.now() - started} ms · ${result.items.length} items · ${result.calories} kcal`);
    res.json({ ...result, serving: description, model });
  } catch (error) {
    if (error instanceof AIError) return res.status(error.status).json(error.toJSON());
    next(error);
  }
});

export default router;
