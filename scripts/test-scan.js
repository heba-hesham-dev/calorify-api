// A test tool for us (not part of the server):
// it acts like the Calorify app and sends a photo to /api/scan, then prints the answer.
//
// Use it in a new terminal tab while the server is running (npm run dev):
//   node scripts/test-scan.js ~/Downloads/food.jpg
//   node scripts/test-scan.js ~/Downloads/food.jpg "cooked with 1 tbsp oil"
// Each try uses 1 of the day's AI requests.

import { readFile } from 'node:fs/promises';
import path from 'node:path';

const API_URL = process.env.API_URL || 'http://localhost:3000';
const [file, ...descriptionWords] = process.argv.slice(2);
const description = descriptionWords.join(' ');

if (!file) {
  console.log('Usage: node scripts/test-scan.js <photo> ["description"]');
  process.exit(1);
}

// The photo type from its extension
const types = { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp', '.heic': 'image/heic' };
const mimeType = types[path.extname(file).toLowerCase()];
if (!mimeType) {
  console.log('Use a .jpg, .png, .webp or .heic photo.');
  process.exit(1);
}

// 1. Read the photo and turn it into text (base64), the way the app will send it
let photo;
try {
  photo = await readFile(file);
} catch {
  console.log(`Couldn't find the photo: ${file}`);
  process.exit(1);
}
const image = photo.toString('base64');
console.log(`Photo: ${path.basename(file)} (${(photo.length / 1024 / 1024).toFixed(1)} MB)`);
if (image.length > 4_400_000) {
  console.log('This photo is too big (over ~3.3 MB). Make a smaller copy with:');
  console.log(`  sips -Z 1280 "${file}" --out ~/Downloads/food-small.jpg`);
  process.exit(1);
}

// 2. Send it to the server
console.log(`Sending to ${API_URL}/api/scan ...`);
const started = Date.now();
let response;
try {
  response = await fetch(`${API_URL}/api/scan`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ image, mimeType, description }),
  });
} catch {
  console.log("Couldn't reach the server. Is it running? (npm run dev in another tab)");
  process.exit(1);
}
const body = await response.json();
const seconds = ((Date.now() - started) / 1000).toFixed(1);

// 3. Print the answer
console.log(`\nStatus: ${response.status} · ${seconds}s`);
if (!response.ok) {
  console.log(`Error: ${body.error}`);
  console.log(body.message);
  if (body.resetAt) console.log(`Resets at: ${new Date(body.resetAt).toLocaleString()}`);
  process.exit(1);
}

console.log(`Model: ${body.model}`);
console.log(`\n${body.title} (confidence ${body.confidence}%)`);
const range = (min, max) => (body.exact ? '' : ` (${min}–${max})`);
for (const item of body.items) {
  console.log(
    `• ${item.name.padEnd(28)} ${String(item.grams).padStart(4)}g  ~${item.calories} kcal${range(item.caloriesMin, item.caloriesMax)}  (P ${item.protein} · C ${item.carbs} · F ${item.fats})`,
  );
}
const total = body.total;
console.log(`\nTotal: ~${total.calories} kcal${range(total.caloriesMin, total.caloriesMax)} · P ${total.protein}g · C ${total.carbs}g · F ${total.fats}g`);
console.log(body.exact ? 'Exact: based on your amounts' : 'Estimate: no amounts given');
if (body.note) console.log(`Note: ${body.note}`);
if (body.tip) console.log(`Tip: ${body.tip}`);
