# Vita — AI Health Coach 🏥

An AI-powered wellness coach that parses patient profiles, runs adaptive daily check-ins, and answers protocol-bounded questions using a comprehensive 28-day wellness protocol.

## Features

- **🔍 Profile Parsing** — Paste unstructured patient data and watch it get extracted into structured fields
- **📋 Adaptive Check-ins** — Daily questions that change based on protocol day (Day 1 onboarding vs Day 14 momentum review)
- **📖 Protocol-Grounded Q&A** — Answers come strictly from the wellness protocol document — minimal hallucination
- **💬 Session Memory** — The agent remembers your entire conversation within a session
- **🔗 URL Parameters** — Share a link with `?profile=<base64>&day=5` for instant results

## Quick Start

```bash
# 1. Install dependencies
npm install

# 2. Set up your Gemini API key
cp .env.example .env
# Edit .env and add your GEMINI_API_KEY

# 3. Start development server
npm run dev
```

Open **http://localhost:5173** in your browser.

## URL Parameters

| Parameter | Description | Example |
|-----------|-------------|---------|
| `profile` | Base64-encoded patient text | `?profile=U2FyYWgsIDM0Li4u` |
| `day` | Protocol day (1-28) | `?day=5` |

**Generate a profile parameter:**
```javascript
btoa("Sarah, 34, wants to sleep better and reduce anxiety. Sleeps 5-6 hours.")
// → "U2FyYWgsIDM0LCB3YW50cyB0byBzbGVlcCBiZXR0ZXIgYW5kIHJlZHVjZSBhbnhpZXR5LiBTbGVlcHMgNS02IGhvdXJzLg=="
```

## API Endpoints

| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/api/session/create` | Create session with profile parsing |
| POST | `/api/session/:id/checkin` | Generate adaptive daily check-in |
| POST | `/api/chat` | Send message, get protocol-grounded response |
| GET | `/api/chat/:id/history` | Get conversation history |
| GET | `/api/session/:id` | Get full session state |
| POST | `/api/profile/parse` | Quick profile parse (no session) |

## Deployment

### Railway
1. Push to GitHub
2. Connect repo in [Railway](https://railway.app)
3. Add environment variable: `GEMINI_API_KEY`
4. Deploy — Railway auto-detects the Dockerfile

### Render
1. Push to GitHub
2. Create new Web Service in [Render](https://render.com)
3. Set build command: `npm install && npm run build`
4. Set start command: `node server/index.js`
5. Add environment variable: `GEMINI_API_KEY`

### Docker
```bash
docker build -t health-coach .
docker run -p 3001:3001 -e GEMINI_API_KEY=your_key health-coach
```

## Tech Stack

- **Frontend:** Vanilla HTML/CSS/JS + Vite
- **Backend:** Node.js + Express
- **AI:** Google Gemini (gemini-2.0-flash)
- **Memory:** In-memory session store
