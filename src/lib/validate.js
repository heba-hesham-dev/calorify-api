// Checks the AI's answer before it goes to the app.
// AIs can sometimes return odd values (text instead of a number, negative calories...).
// Here we clean them, and if the answer is broken we send a clear error instead.

import { AIError } from './gemini.js';
import { FOOD_CATEGORIES } from './prompts.js';

const badAnswer = () => new AIError(502, 'bad_response', "The AI's answer wasn't clear. Please try again.");

// Any value -> a whole number that isn't negative (or null if it isn't a number)
function toNumber(value) {
  const number = typeof value === 'string' ? Number(value.replace(/[^\d.]/g, '')) : Number(value);
  return Number.isFinite(number) && number >= 0 ? Math.round(number) : null;
}

// One food line -> clean, or null if it can't be used.
// exact = the user gave the amounts, so there's no range.
export function cleanItem(item, exact = false) {
  if (!item || typeof item !== 'object') return null;
  const name = String(item.name ?? '').trim().slice(0, 60);
  const calories = toNumber(item.calories);
  if (!name || calories === null) return null;

  // The range must make sense: min <= best guess <= max (±15% if the AI didn't give one)
  let caloriesMin = toNumber(item.caloriesMin) ?? Math.round(calories * 0.85);
  let caloriesMax = toNumber(item.caloriesMax) ?? Math.round(calories * 1.15);
  if (exact) caloriesMin = caloriesMax = calories;
  caloriesMin = Math.min(caloriesMin, calories);
  caloriesMax = Math.max(caloriesMax, calories);

  return {
    name,
    grams: toNumber(item.grams) ?? 0,
    calories,
    caloriesMin,
    caloriesMax,
    protein: toNumber(item.protein) ?? 0,
    carbs: toNumber(item.carbs) ?? 0,
    fats: toNumber(item.fats) ?? 0,
  };
}

export const EXACT_TIP = 'For exact calories, add the amount of each item (grams, spoons or pieces) in the description.';

// Adds up all the food lines
function totalOf(items) {
  return items.reduce(
    (sum, item) => ({
      calories: sum.calories + item.calories,
      caloriesMin: sum.caloriesMin + item.caloriesMin,
      caloriesMax: sum.caloriesMax + item.caloriesMax,
      protein: sum.protein + item.protein,
      carbs: sum.carbs + item.carbs,
      fats: sum.fats + item.fats,
    }),
    { calories: 0, caloriesMin: 0, caloriesMax: 0, protein: 0, carbs: 0, fats: 0 },
  );
}

// The whole Scan answer.
// Not exact (no amounts from the user) -> each food has a range, and we add a tip to add grams.
export function validateScan(data) {
  if (!data || typeof data !== 'object') throw badAnswer();
  if (data.isFood === false) return { isFood: false, title: '', confidence: 0, exact: false, items: [], total: totalOf([]), note: '', tip: '' };

  const exact = data.exact === true;
  const items = (Array.isArray(data.items) ? data.items : [])
    .map((item) => cleanItem(item, exact))
    .filter(Boolean)
    .slice(0, 15);
  if (items.length === 0) throw badAnswer();

  const confidence = Math.min(100, toNumber(data.confidence) ?? 70);
  const title = String(data.title ?? '').trim().slice(0, 80) || items.map((item) => item.name).join(', ');
  const note = String(data.note ?? '').trim().slice(0, 160);
  return { isFood: true, title, confidence, exact, items, total: totalOf(items), note, tip: exact ? '' : EXACT_TIP };
}

// ---------- AI Chat ----------

const MEAL_TYPES = ['breakfast', 'lunch', 'dinner', 'snack'];

// One meal card from the chat.
// Suggestions and exact meals get one number (the code makes sure, even if the AI forgets).
function cleanMealCard(card) {
  const source = card?.source === 'suggestion' ? 'suggestion' : 'eaten';
  const exact = source === 'suggestion' || card?.exact === true;
  const item = cleanItem(card, exact);
  if (!item) return null;
  return {
    name: item.name,
    type: MEAL_TYPES.includes(card.type) ? card.type : 'snack',
    source,
    exact,
    description: String(card.description ?? '').trim().slice(0, 200),
    calories: item.calories,
    caloriesMin: item.caloriesMin,
    caloriesMax: item.caloriesMax,
    protein: item.protein,
    carbs: item.carbs,
    fats: item.fats,
  };
}

// The whole chat answer: { reply, meals, action }
// action = { type: 'add_meal', mealIndex, mealType, time: "HH:MM" | null }
//        | { type: 'add_to_meal', mealIndex, mealId }   (add the card's food to a meal already logged today)
//        | { type: 'none' }
// todayMealIds: the ids of today's meals the app sent (add_to_meal must point to one of them)
export function validateChat(data, todayMealIds = []) {
  if (!data || typeof data !== 'object') throw badAnswer();

  const meals = (Array.isArray(data.meals) ? data.meals : []).map(cleanMealCard).filter(Boolean).slice(0, 3);
  let reply = String(data.reply ?? '').trim().slice(0, 2000);

  let action = { type: 'none' };
  const wanted = data.action ?? {};
  const index = Number(wanted.mealIndex);
  if (wanted.type === 'add_meal' && Number.isInteger(index) && meals[index]) {
    const time = /^([01]?\d|2[0-3]):[0-5]\d$/.test(String(wanted.time ?? '').trim()) ? String(wanted.time).trim().padStart(5, '0') : null;
    const mealType = MEAL_TYPES.includes(wanted.mealType) ? wanted.mealType : meals[index].type;
    meals[index].type = mealType;
    action = { type: 'add_meal', mealIndex: index, mealType, time };
  }

  const mealId = String(wanted.mealId ?? '').trim();
  if (wanted.type === 'add_to_meal' && Number.isInteger(index) && meals[index] && todayMealIds.includes(mealId)) {
    action = { type: 'add_to_meal', mealIndex: index, mealId };
  }

  if (!reply && action.type !== 'none') reply = 'Here it is:';
  if (!reply) throw badAnswer();
  return { reply, meals, action };
}

// ---------- Custom Food ----------


// The custom food answer: the totals for one serving (= the whole description), its parts, and its category
export function validateCustomFood(data, userName) {
  if (!data || typeof data !== 'object') throw badAnswer();
  if (data.isFood === false) return { isFood: false };

  const exact = data.exact === true;
  const items = (Array.isArray(data.items) ? data.items : [])
    .map((item) => {
      const clean = cleanItem(item, exact);
      return clean && { ...clean, amount: String(item.amount ?? '').trim().slice(0, 40) };
    })
    .filter(Boolean)
    .slice(0, 20);
  if (items.length === 0) throw badAnswer();

  const total = totalOf(items);
  const missing = exact ? [] : (Array.isArray(data.missing) ? data.missing : []).map((item) => String(item).trim().slice(0, 30)).filter(Boolean).slice(0, 5);
  return {
    isFood: true,
    name: String(data.name ?? '').trim().slice(0, 60) || userName,
    category: FOOD_CATEGORIES.includes(data.category) ? data.category : 'basics',
    exact,
    ...total, // calories, caloriesMin, caloriesMax, protein, carbs, fats
    items, // { name, amount, grams, calories, caloriesMin, caloriesMax, protein, carbs, fats }
    missing,
    tip: exact ? '' : `For an exact number, add the amount of: ${missing.length ? missing.join(', ') : 'each item'} (grams, spoons or pieces).`,
  };
}
