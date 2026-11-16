// POST /api/chat
// The app sends the last 15 chat messages + the user's data (goal, what they ate today, meal times...).
// Gemini answers like a nutritionist, can show meal cards, and can ask the app to log a meal.
//
// Request: {
//   messages: [{ role: "user" | "bot", text, meals? }],   (the last one is the user's new message)
//   user: { name, goal, calorieGoal, macroGoals, eatenToday, todayMeals, currentKg, goalKg, mealTimes, now, ... },
//   image?: "<base64>", mimeType?: "image/jpeg"            (a photo sent in the chat)
// }
// Answers:
//   200 -> { reply, meals: [...], action, model }
//          action: { type: "none" } | { type: "add_meal", mealIndex, mealType, time }
//                | { type: "add_to_meal", mealIndex, mealId, added: { name, calories, protein, carbs, fats } }
//                  ("and also an apple" -> add only `added` to the meal that's already logged)
//   400 -> missing or wrong data
//   429 -> no AI requests left (with resetAt) or too many in one minute
//   502 -> the AI's answer was broken, or the AI isn't available

import { Router } from 'express';

import { AIError, askGemini } from '../lib/gemini.js';
import { chatInstructions, chatSchema } from '../lib/prompts.js';
import { validateChat } from '../lib/validate.js';

const router = Router();

const MAX_MESSAGES = 15;
const MAX_TEXT = 1000; // characters in one message
const PHOTO_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif'];
const MAX_PHOTO_CHARS = 4_400_000;

const number = (value, fallback = 0) => (Number.isFinite(Number(value)) ? Math.round(Number(value)) : fallback);
const text = (value, max = 100) => String(value ?? '').trim().slice(0, max);

// The user's data, cleaned (so nothing strange goes into the AI's instructions)
function cleanUser(user = {}) {
  const eaten = user.eatenToday ?? {};
  const macros = user.macroGoals ?? {};
  const times = user.mealTimes ?? {};
  return {
    name: text(user.name, 40) || 'there',
    goal: ['lose', 'maintain', 'gain'].includes(user.goal) ? user.goal : 'maintain',
    calorieGoal: number(user.calorieGoal, 2000),
    macroGoals: { protein: number(macros.protein), carbs: number(macros.carbs), fats: number(macros.fats) },
    eatenToday: { calories: number(eaten.calories), protein: number(eaten.protein), carbs: number(eaten.carbs), fats: number(eaten.fats) },
    todayMeals: (Array.isArray(user.todayMeals) ? user.todayMeals : []).slice(0, 20).map((meal) => ({
      id: text(meal.id, 40),
      name: text(meal.name, 60),
      type: text(meal.type, 10),
      calories: number(meal.calories),
      protein: number(meal.protein),
      carbs: number(meal.carbs),
      fats: number(meal.fats),
      time: text(meal.time, 8),
      source: text(meal.source, 12), // where it was logged from: Scan, Search, Build, Chat...
    })),
    currentKg: number(user.currentKg),
    goalKg: number(user.goalKg),
    mealTimes: { breakfast: text(times.breakfast, 5) || '09:00', lunch: text(times.lunch, 5) || '14:00', dinner: text(times.dinner, 5) || '20:00' },
    now: text(user.now, 40) || new Date().toISOString(),
    conditions: Array.isArray(user.conditions) ? user.conditions.slice(0, 5).map((item) => text(item, 40)) : [],
    allergies: text(user.allergies, 120),
    diet: text(user.diet, 60),
  };
}

// The chat history in Gemini's format: user -> "user", bot -> "model".
// Meal cards the bot showed are added as text, so "log it" knows which meal it was.
function toContents(messages) {
  const contents = [];
  for (const message of messages) {
    const role = message.role === 'user' ? 'user' : 'model';
    let content = text(message.text, MAX_TEXT);
    if (Array.isArray(message.meals) && message.meals.length) {
      const cards = message.meals
        .slice(0, 3)
        .map((meal, index) => `${index + 1}) ${text(meal.name, 60)} (${text(meal.type, 10)}): ${number(meal.calories)} kcal, P ${number(meal.protein)} C ${number(meal.carbs)} F ${number(meal.fats)}`)
        .join('; ');
      content += `\n[Meal cards shown: ${cards}]`;
    }
    if (!content) continue;
    // Gemini wants turns to take turns: join two messages in a row from the same side
    const last = contents[contents.length - 1];
    if (last?.role === role) last.parts[0].text += `\n${content}`;
    else contents.push({ role, parts: [{ text: content }] });
  }
  while (contents[0]?.role === 'model') contents.shift(); // the chat must start with the user
  return contents;
}

// Which language to answer in, from the user's new message:
// Arabic letters, or Franco-Arabic (Latin letters with 2, 3, 5, 7 or 8 inside words, like "3esh", "ma7shy") -> Egyptian Arabic.
function replyLanguage(message) {
  if (/[\u0600-\u06FF]/.test(message)) return 'arabic';
  const franco = message
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .some((word) => /[a-z]/.test(word) && /[2357-9]/.test(word) && !/^\d+(\.\d+)?(g|kg|ml|mg|kcal|cal|x|am|pm|st|nd|rd|th|min|mins|h|hr|hrs)$/.test(word));
  return franco ? 'arabic' : 'english';
}

// ---------- "And also..." ----------
// "I had eggs and toast for breakfast" -> card. Then "and also a banana":
// - the card isn't logged yet -> one card with everything (the code makes sure, even if the AI gives the banana alone)
// - the meal is already logged -> the AI sends add_to_meal, and we add the new total to the reply

const ALSO = /\b(also|too|as well|plus)\b|وكمان|كمان|kaman|kman/i;
const mealWordsEn = { breakfast: 'breakfast', lunch: 'lunch', dinner: 'dinner', snack: 'snack' };
const mealWordsAr = { breakfast: 'فطارك', lunch: 'غداك', dinner: 'عشاك', snack: 'السناك' };

function totalLine(type, calories, arabic) {
  return arabic ? `إجمالي ${mealWordsAr[type]} دلوقتي: ${calories} سعر` : `Total for your ${mealWordsEn[type]} now: ${calories} kcal`;
}

// Two cards -> one (numbers added up)
function mergeCards(first, second) {
  const sum = (key) => (first[key] ?? 0) + (second[key] ?? 0);
  return {
    ...first,
    name: `${first.name} + ${second.name}`.slice(0, 60),
    description: [first.description, second.description].filter(Boolean).join(', ').slice(0, 200),
    exact: first.exact && second.exact,
    calories: sum('calories'),
    caloriesMin: sum('caloriesMin'),
    caloriesMax: sum('caloriesMax'),
    protein: sum('protein'),
    carbs: sum('carbs'),
    fats: sum('fats'),
  };
}

// What was added to a logged meal. The AI sometimes sends the whole meal (old food + the new food)
// instead of only the new food: then we take away the meal that's already logged, so it isn't counted twice.
function addedPart(card, target) {
  const firstWord = String(target.name ?? '').toLowerCase().split(/[\s,+]+/)[0];
  const wholeMeal = card.calories >= target.calories && firstWord && card.name.toLowerCase().includes(firstWord);
  if (!wholeMeal) {
    return { name: card.name, calories: card.calories, protein: card.protein, carbs: card.carbs, fats: card.fats };
  }
  const minus = (key) => Math.max(0, (card[key] ?? 0) - (target[key] ?? 0));
  const newName = card.name.split(/\s+(?:and|\+|&|with)\s+|,\s*/i).pop() || card.name; // "Oats, Coffee and Apple" -> "Apple"
  return { name: newName, calories: minus('calories'), protein: minus('protein'), carbs: minus('carbs'), fats: minus('fats') };
}

function handleAlso(result, { newText, previousBot, todayMeals, arabic }) {
  if (!ALSO.test(newText)) return result;

  // Already logged -> add_to_meal: say the new total of that meal
  if (result.action.type === 'add_to_meal') {
    const target = todayMeals.find((meal) => meal.id === result.action.mealId);
    const card = result.meals[result.action.mealIndex];
    if (target && card) {
      result.action.added = addedPart(card, target);
      result.reply += `\n\n${totalLine(target.type, target.calories + result.action.added.calories, arabic)}`;
    }
    return result;
  }

  // Not logged yet -> one card with everything
  const previous = previousBot?.meals?.length === 1 ? previousBot.meals[0] : null;
  const isLogged = previous && todayMeals.some((meal) => meal.name === previous.name && Math.abs(meal.calories - previous.calories) <= 5);
  const newIndex = result.meals.findIndex((meal) => meal.source === 'eaten');
  if (!previous || previous.source === 'suggestion' || isLogged || newIndex === -1) return result;

  const fresh = result.meals[newIndex];
  // The AI already merged them (its card has at least the old calories + more) -> keep it
  const merged = fresh.calories > previous.calories && fresh.name.includes(previous.name.split(' ')[0]) ? fresh : mergeCards(previous, fresh);
  merged.type = previous.type;
  result.meals = [merged];
  if (result.action.type === 'add_meal') result.action = { ...result.action, mealIndex: 0, mealType: merged.type };
  result.reply += `\n\n${totalLine(merged.type, merged.calories, arabic)}`;
  return result;
}

router.post('/', async (req, res, next) => {
  try {
    // 1. Check what the app sent
    const { messages, user, mimeType = 'image/jpeg' } = req.body ?? {};
    let { image } = req.body ?? {};
    if (!Array.isArray(messages) || messages.length === 0) {
      throw new AIError(400, 'no_message', 'Send a message.');
    }
    const recent = messages.slice(-MAX_MESSAGES);
    const newMessage = recent[recent.length - 1];
    if (newMessage?.role !== 'user' || (!text(newMessage.text, MAX_TEXT) && !image)) {
      throw new AIError(400, 'no_message', 'Send a message.');
    }
    if (String(newMessage.text ?? '').length > MAX_TEXT) {
      throw new AIError(400, 'message_too_long', `Keep messages under ${MAX_TEXT} characters.`);
    }

    const contents = toContents(recent);
    if (contents.length === 0 || contents[contents.length - 1].role !== 'user') contents.push({ role: 'user', parts: [{ text: '(photo)' }] });

    // A photo in the chat goes with the new message
    if (image) {
      image = String(image).replace(/^data:[^;]+;base64,/, '');
      if (image.length > MAX_PHOTO_CHARS) throw new AIError(400, 'photo_too_big', 'The photo is too big. Try a smaller one.');
      if (!PHOTO_TYPES.includes(mimeType)) throw new AIError(400, 'bad_photo_type', 'Use a JPG, PNG, WEBP or HEIC photo.');
      contents[contents.length - 1].parts.unshift({ inlineData: { mimeType, data: image } });
    }

    // 2. Ask Gemini
    const started = Date.now();
    const cleanedUser = cleanUser(user);

    // The language rule, made sure by the code (the AI sometimes forgets it)
    const language =
      replyLanguage(String(newMessage.text ?? '')) === 'arabic'
        ? '\n\nIMPORTANT: The user wrote in Arabic. Write "reply" in Egyptian Arabic (Arabic letters). Meal card names stay in English.'
        : '\n\nIMPORTANT: The user wrote in English. Write "reply" in English.';
    const { data, model } = await askGemini('chat', {
      systemInstruction: chatInstructions(cleanedUser) + language,
      schema: chatSchema,
      contents,
      temperature: 0.5, // a bit more natural than the scan
    });

    // 3. Check the answer and send it
    let result = validateChat(data, cleanedUser.todayMeals.map((meal) => meal.id).filter(Boolean));
    const previousBot = [...recent.slice(0, -1)].reverse().find((message) => message.role !== 'user');
    result = handleAlso(result, {
      newText: String(newMessage.text ?? ''),
      previousBot,
      todayMeals: cleanedUser.todayMeals,
      arabic: replyLanguage(String(newMessage.text ?? '')) === 'arabic',
    });
    console.log(`[chat] ${model} · ${Date.now() - started} ms · ${result.meals.length} meal cards · action: ${result.action.type}`);
    res.json({ ...result, model });
  } catch (error) {
    if (error instanceof AIError) return res.status(error.status).json(error.toJSON());
    next(error);
  }
});

export default router;

export { handleAlso }; // exported for quick tests
