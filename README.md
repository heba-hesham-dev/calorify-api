# Calorify API

The backend for [Calorify](https://github.com/heba-hesham-dev/calorify-app), an AI-powered nutrition tracking app.
It turns meal photos and food descriptions into calories and macros with **Google Gemini**, and powers the app's AI nutritionist chat.

**[Live demo of the app](https://calorify-app-rho.vercel.app)** · Frontend: [calorify-app](https://github.com/heba-hesham-dev/calorify-app)

## Endpoints

| Method | Path | What it does |
| --- | --- | --- |
| GET | `/api/health` | Checks the server is running |
| POST | `/api/scan` | A meal photo (+ optional details) → each food with calories, macros and a range when amounts aren't clear |
| POST | `/api/chat` | The chat history + the user's goal and today's meals → a reply, meal cards, and an action (log a meal, or add food to a logged meal) |
| POST | `/api/custom-food` | A food name + what's in it → calories, macros and a food category |

## How it works

- **Structured answers:** every Gemini request asks for JSON in an exact shape (a JSON schema), so the app always gets the same fields.
- **Checked by code:** the answers are validated before they're sent, for example totals are recalculated, and food described with exact amounts never gets a range.
- **Backup model:** if the main model is busy or out of requests, the request moves to a backup model.
- **Clear errors:** each failure has its own code (`quota`, `busy`, `timeout`, `not_food`...), so the app can show the right message or use its own estimate instead.
- **The API key stays on the server:** the app never sees it.

## Tech stack

- Node.js and **Express 5**
- **Google Gemini** through the `@google/genai` SDK
- Deployed on **Vercel**

## Project structure

```
src/
  index.js        the server: routes, errors, size limits
  routes/         scan.js, chat.js, customFood.js
  lib/
    gemini.js     sends requests to Gemini, backup model, error handling
    prompts.js    the instructions and JSON shapes for each feature
    validate.js   checks and cleans the AI's answers
scripts/          quick tests from the terminal
```

## Run locally

1. Get a free Gemini API key from [Google AI Studio](https://aistudio.google.com).
2. Copy `.env.example` to `.env` and add your key:
   ```
   GEMINI_API_KEY=your-key
   PORT=3000
   ```
3. Install and start:
   ```
   npm install
   npm run dev
   ```
4. Open `http://localhost:3000/api/health`.

## Tests without using AI requests

Set `AI_TEST_ERROR` in `.env` to `quota`, `busy`, `unavailable`, `timeout` or `bad_response` to see how the app handles each error without calling Gemini. Leave it empty for the real AI.

Built by **Heba Hesham**.
