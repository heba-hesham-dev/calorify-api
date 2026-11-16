// A test tool for us (not part of the server): a chat with the AI nutritionist in the terminal.
// It acts like the Calorify app: it keeps the last 15 messages and sends them with a sample user.
//
// Use it in a new terminal tab while the server is running (npm run dev):
//   node scripts/test-chat.js
// Then type messages. Special commands:
//   /photo ~/Downloads/food.jpg what is this?   -> sends a photo with your message
//   /today                                       -> shows the meals "logged" in this test
//   /exit                                        -> stops
// Each message uses 1 of the day's AI requests (flash-lite: 500 a day).

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import readline from 'node:readline/promises';

const API_URL = process.env.API_URL || 'http://localhost:3000';
const pad = (value) => String(value).padStart(2, '0');

// A sample user, like the app would send
const todayMeals = [];
function sampleUser() {
  const now = new Date();
  const eaten = todayMeals.reduce(
    (sum, meal) => ({ calories: sum.calories + meal.calories, protein: sum.protein + meal.protein, carbs: sum.carbs + meal.carbs, fats: sum.fats + meal.fats }),
    { calories: 0, protein: 0, carbs: 0, fats: 0 },
  );
  return {
    name: 'Heba',
    goal: 'lose',
    calorieGoal: 1800,
    macroGoals: { protein: 120, carbs: 190, fats: 50 },
    eatenToday: eaten,
    todayMeals: todayMeals.map((meal) => ({
      id: meal.id, name: meal.name, type: meal.type, calories: meal.calories,
      protein: meal.protein, carbs: meal.carbs, fats: meal.fats, time: meal.time, source: 'Chat',
    })),
    currentKg: 72,
    goalKg: 65,
    mealTimes: { breakfast: '12:00', lunch: '17:00', dinner: '22:00' },
    now: `${now.toDateString()} ${pad(now.getHours())}:${pad(now.getMinutes())}`,
  };
}

const types = { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp', '.heic': 'image/heic' };
const messages = [{ role: 'bot', text: "Hi Heba! I'm your AI nutritionist. Ask me anything about food, calories or your goal." }];

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
console.log(`Chat with Calorify's AI (${API_URL}). Type /exit to stop.\n`);
console.log(`AI: ${messages[0].text}\n`);

while (true) {
  let input = (await rl.question('You: ')).trim();
  if (!input) continue;
  if (input === '/exit') break;
  if (input === '/today') {
    console.log(todayMeals.length ? todayMeals.map((meal) => `  [${meal.id}] ${meal.time} ${meal.type}: ${meal.name} (${meal.calories} kcal)`).join('\n') : '  Nothing logged yet.');
    continue;
  }

  // A photo with the message
  let image;
  let mimeType;
  if (input.startsWith('/photo ')) {
    const [, file, ...rest] = input.split(' ');
    const fullPath = file.replace(/^~/, process.env.HOME);
    mimeType = types[path.extname(fullPath).toLowerCase()];
    try {
      image = (await readFile(fullPath)).toString('base64');
    } catch {
      console.log(`  Couldn't find the photo: ${file}\n`);
      continue;
    }
    input = rest.join(' ');
  }

  messages.push({ role: 'user', text: input });
  let response;
  try {
    response = await fetch(`${API_URL}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ messages: messages.slice(-15), user: sampleUser(), image, mimeType }),
    });
  } catch {
    console.log("  Couldn't reach the server. Is it running? (npm run dev in another tab)\n");
    messages.pop();
    continue;
  }
  const body = await response.json();

  if (!response.ok) {
    console.log(`  Error ${response.status} (${body.error}): ${body.message}\n`);
    messages.pop();
    continue;
  }

  console.log(`\nAI: ${body.reply}`);
  body.meals.forEach((meal, index) => {
    const range = meal.caloriesMin === meal.caloriesMax ? '' : ` (${meal.caloriesMin}-${meal.caloriesMax})`;
    console.log(`  [Card ${index + 1}] ${meal.name} · ${meal.type} · ${meal.source} · ~${meal.calories} kcal${range} · P ${meal.protein} C ${meal.carbs} F ${meal.fats}`);
    if (meal.description) console.log(`           ${meal.description}`);
  });

  // The app would log the meal (or ask "what time?" if there's no time and it isn't that meal's time)
  if (body.action.type === 'add_meal') {
    const meal = body.meals[body.action.mealIndex];
    const now = new Date();
    const time = body.action.time ?? `${pad(now.getHours())}:${pad(now.getMinutes())}`;
    todayMeals.push({ ...meal, id: `m${todayMeals.length + 1}`, type: body.action.mealType, time });
    console.log(`  >> The app logs: ${meal.name} as ${body.action.mealType} at ${time}${body.action.time ? ' (the time you said)' : ' (the time of logging)'}`);
  }
  // "and also an apple" -> added to a meal that's already logged
  if (body.action.type === 'add_to_meal') {
    const added = body.action.added; // only the new food (the server makes sure)
    const target = todayMeals.find((meal) => meal.id === body.action.mealId);
    if (target) {
      for (const key of ['calories', 'protein', 'carbs', 'fats']) target[key] += added[key];
      target.name = `${target.name} + ${added.name}`;
      console.log(`  >> The app adds ${added.name} (${added.calories} kcal) to your ${target.type}: now ${target.calories} kcal`);
    }
  }
  console.log(`  (${body.model})\n`);
  messages.push({ role: 'bot', text: body.reply, meals: body.meals });
}
rl.close();
