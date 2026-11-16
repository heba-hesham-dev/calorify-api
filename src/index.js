// Calorify API: the backend for the AI parts of the app (Scan, AI Chat and Custom Food).
// The app sends a request -> this server asks Google Gemini -> sends the answer back.
// The Gemini API key stays here on the server, so nobody can see it in the app.

import cors from 'cors';
import express from 'express';

import { MODELS } from './lib/gemini.js';

import chatRouter from './routes/chat.js';
import customFoodRouter from './routes/customFood.js';
import scanRouter from './routes/scan.js';

const app = express();

// cors: lets the Calorify app (on another link) talk to this server
app.use(cors());

// express.json: reads the JSON the app sends. 4.5mb is Vercel's limit, enough for a small photo.
app.use(express.json({ limit: '4.5mb' }));

// ---------- Routes ----------

// A quick check that the server is running: GET /api/health -> { "ok": true }
app.get('/api/health', (req, res) => {
  res.json({
    ok: true,
    hasApiKey: Boolean(process.env.GEMINI_API_KEY),
    models: MODELS,
    testError: process.env.AI_TEST_ERROR?.trim() || null, // should be null, except while testing error messages
  });
});

// Each address goes to its own file in src/routes
app.use('/api/scan', scanRouter);
app.use('/api/chat', chatRouter);
app.use('/api/custom-food', customFoodRouter);

// Any other link -> 404 in JSON (not an HTML page)
app.use((req, res) => {
  res.status(404).json({ error: 'not_found', message: `No route for ${req.method} ${req.path}` });
});

// If something breaks, answer with JSON instead of crashing.
// (Vercel's docs ask for this: Express's own error pages can leave the function in a bad state.)
app.use((error, req, res, next) => {
  console.error(error);
  if (error.type === 'entity.too.large') {
    return res.status(413).json({ error: 'too_large', message: 'The photo is too big. Try a smaller one.' });
  }
  res.status(500).json({ error: 'server_error', message: 'Something went wrong on the server.' });
});

// ---------- Start ----------

// On your computer: start the server on a port (http://localhost:3000).
// On Vercel: Vercel runs the app itself, so we only export it.
if (!process.env.VERCEL) {
  const port = process.env.PORT || 3000;
  app.listen(port, () => console.log(`Calorify API running on http://localhost:${port}`));
}

export default app;
