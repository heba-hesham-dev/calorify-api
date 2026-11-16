// A test tool for us (not part of the server): acts like "Add custom food" in the app.
//
// Use it in a new terminal tab while the server is running (npm run dev):
//   node scripts/test-custom-food.js "My sandwich" "1 baladi loaf, 2 eggs with mushroom, 1 slice cheddar"
// Each try uses 1 of the day's AI requests (flash-lite: 500 a day).

const API_URL = process.env.API_URL || 'http://localhost:3000';
const [name, description] = process.argv.slice(2);

if (!name || !description) {
  console.log('Usage: node scripts/test-custom-food.js "<name>" "<what\'s in it>"');
  process.exit(1);
}

let response;
try {
  response = await fetch(`${API_URL}/api/custom-food`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, description }),
  });
} catch {
  console.log("Couldn't reach the server. Is it running? (npm run dev in another tab)");
  process.exit(1);
}
const body = await response.json();

console.log(`Status: ${response.status}`);
if (!response.ok) {
  console.log(`Error: ${body.error}`);
  console.log(body.message);
  process.exit(1);
}

const range = (min, max) => (body.exact ? '' : ` (${min}-${max})`);
console.log(`Model: ${body.model}\n`);
console.log(`${body.name}  ·  category: ${body.category}`);
console.log(`1 serving = ${body.serving}\n`);
for (const item of body.items) {
  console.log(`• ${item.name.padEnd(26)} ${item.amount.padEnd(14)} ~${item.calories} kcal${range(item.caloriesMin, item.caloriesMax)}  (P ${item.protein} · C ${item.carbs} · F ${item.fats})`);
}
console.log(`\nTotal: ~${body.calories} kcal${range(body.caloriesMin, body.caloriesMax)} · P ${body.protein}g · C ${body.carbs}g · F ${body.fats}g`);
console.log(body.exact ? 'Exact: based on your amounts' : 'Estimate: some amounts are missing');
if (body.tip) console.log(`Tip: ${body.tip}`);
