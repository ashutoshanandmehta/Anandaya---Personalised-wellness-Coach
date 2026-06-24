# Anandaya

**Personalised Wellness Coach**

Anandaya is a multi-profile wellness coaching application that combines protocol-grounded AI conversations with goals, reminders, check-ins, progress tracking, and safety-aware guidance. It is designed to feel warm and conversational while keeping scheduling actions and stored health context grounded in backend services rather than unsupported AI claims.

> Anandaya is a wellness coach, not a doctor. It does not diagnose conditions, prescribe treatment, or replace care from a qualified healthcare professional.

## Highlights

- **Multi-profile accounts** for the account owner and family members
- **Personalised wellness chat** informed by profile facts, goals, recent context, and approved protocol content
- **Safety routing** for urgent symptoms, medication boundaries, and escalation guidance
- **Tool-orchestrated reminders** created only after validated timing information and a successful database write
- **Warm check-ins** for sleep, hydration, nutrition, recovery, movement, stress, habits, and general wellness
- **Progress tracking** with dynamic program days, goals, and check-in outcomes
- **In-app notification bell** with scheduled, due, and completed lifecycle states
- **Protocol RAG** using local lexical retrieval with optional Hugging Face embeddings
- **Resilient AI routing** across task-specific Groq model/key pools
- **SQLite locally and Turso in production** through the same SQL-oriented data layer
- **Responsive light interface** built with vanilla HTML, CSS, and JavaScript

## Technology

| Layer | Technology |
| --- | --- |
| Frontend | Vanilla JavaScript, HTML, CSS, Vite |
| Backend | Node.js, Express |
| Database | SQLite locally, libSQL/Turso in production |
| Main AI | Groq-hosted Llama, GPT-OSS, and Qwen model pools |
| Retrieval | Approved protocol chunks, lexical search, optional HF embeddings |
| Authentication | Email/password, OTP flows, Google OAuth, cookie sessions |
| Hosting | Render with GitHub auto-deploy |

## How A Chat Turn Works

1. The authenticated user sends a message for the active profile.
2. Deterministic safety checks run before normal generation.
3. Profile facts, a compact internal summary, recent conversation history, and relevant protocol chunks are assembled.
4. Scheduling-related requests are sent to the hidden tool orchestrator.
5. The orchestrator either asks for missing information or executes a validated reminder/check-in action.
6. Normal wellness requests are sent to the main chat model pool.
7. A post-generation filter removes internal context leaks, unsafe content, and unsupported scheduling claims.
8. The final user-facing response is stored and returned to the frontend.
9. Background jobs update durable profile context only when relevant profile state changes.

The assistant cannot honestly claim that a reminder was scheduled, updated, or cancelled unless the backend tool completed the corresponding database action.

## Reminder And Check-in Lifecycle

Reminders and check-ins share the `scheduled_checkins` persistence pipeline.

- **Scheduled:** visible as upcoming and not yet openable
- **Due:** available from the notification bell
- **Opened/acknowledged:** surfaced to the user
- **Completed/logged:** response or reminder action recorded
- **Dismissed/cancelled:** no longer active

Check-ins may be scheduled independently of reminders. Anandaya asks the user for a specific check-in time and saves it only after the timing is sufficiently clear. Silent automatic engagement check-ins are disabled unless `ENABLE_AUTO_ENGAGEMENT_CHECKINS=true` is explicitly configured.

## Project Structure

```text
health-coach/
├── public/                     Static assets
├── server/
│   ├── data/                   Approved wellness protocol and knowledge chunks
│   ├── middleware/             Authentication and profile ownership checks
│   ├── routes/                 Auth, profiles, chat, reminders, uploads, programs
│   ├── scripts/                RAG embedding maintenance scripts
│   ├── services/               AI, safety, retrieval, tools, scheduler, check-ins
│   ├── db.js                   SQLite/Turso connection and schema initialization
│   └── index.js                Express entry point
├── src/
│   ├── css/styles.css          Application theme and responsive layout
│   ├── js/                     Auth, dashboard, profiles, chat, notifications
│   └── index.html              Frontend shell
├── test/                       Node test suite
├── render.yaml                 Render service definition
├── vite.config.js              Vite build and development proxy
└── package.json
```

## Local Development

### Requirements

- Node.js 18 or newer
- npm
- At least one configured Groq key for AI responses

### Setup

```bash
git clone https://github.com/ashutoshanandmehta/Anandaya---Personalised-wellness-Coach.git
cd Anandaya---Personalised-wellness-Coach
npm install
cp .env.example .env
```

Add your own credentials to `.env`. Never commit that file or paste production secrets into source code.

Start the frontend and backend together:

```bash
npm run dev
```

Open:

- Frontend: [https://health-coach-ai.onrender.com/](https://health-coach-ai.onrender.com/)

Vite proxies `/api` requests to `VITE_API_PROXY_TARGET`, which defaults to the local backend.

## Environment Configuration

Use `.env.example` as the source template. The most important variables are:

### Application And Database

| Variable | Purpose |
| --- | --- |
| `PORT` | Express port; defaults to `3001` locally |
| `NODE_ENV` | `development` or `production` |
| `APP_TIMEZONE` | Application timezone; defaults to `Asia/Kolkata` |
| `SESSION_SECRET` | Strong secret used for authenticated sessions |
| `DATABASE_PATH` | Local SQLite database path |
| `TURSO_DATABASE_URL` | Production libSQL/Turso database URL |
| `TURSO_AUTH_TOKEN` | Turso database authentication token |
| `BACKEND_URL` | Public backend origin |
| `FRONTEND_URL` | Public frontend origin |

When `TURSO_DATABASE_URL` is present, Anandaya uses Turso. Otherwise it uses the local SQLite file configured by `DATABASE_PATH`.

### Groq Task Pools

The backend routes AI work by task instead of sending every request to one model/key:

- `GROQ_MAIN_*` handles wellness conversation.
- `GROQ_PLANNER_*` handles structured reminder/check-in planning and JSON extraction.
- `GROQ_SUMMARY_*` handles compact profile summaries and tool-result polishing.
- `GROQ_RESERVE_1_KEY` supplies an additional fallback slot.

Configured slots are selected using health, load, and quality signals. Planner and summary tasks may degrade to a healthy main-model slot if their dedicated pool is unavailable.

The legacy `GROQ_API_KEY` and `GROQ_MODEL` variables remain migration fallbacks, but slot-specific keys are preferred.

### Retrieval And Embeddings

| Variable | Purpose |
| --- | --- |
| `ENABLE_SEMANTIC_RAG` | Enables semantic retrieval when set to `true` |
| `HF_EMBEDDING_1_TOKEN` | First Hugging Face embedding token |
| `HF_EMBEDDING_2_TOKEN` | Second embedding fallback token |
| `HF_EMBEDDING_3_TOKEN` | Third embedding fallback token |
| `HF_EMBEDDING_MODEL` | Defaults to `sentence-transformers/all-MiniLM-L6-v2` |
| `RAG_EMBEDDING_TIMEOUT_MS` | Embedding request timeout |

If semantic retrieval is disabled or all embedding calls fail, protocol retrieval continues with lexical matching.

### Authentication

| Variable | Purpose |
| --- | --- |
| `GOOGLE_CLIENT_ID` | Google OAuth client ID |
| `GOOGLE_CLIENT_SECRET` | Google OAuth client secret |
| `GOOGLE_CALLBACK_URL` | OAuth callback URL |
| `GMAIL_SENDER_EMAIL` | Sender address for email flows |
| `GMAIL_CLIENT_ID` | Gmail OAuth client ID |
| `GMAIL_CLIENT_SECRET` | Gmail OAuth client secret |
| `GMAIL_REFRESH_TOKEN` | Gmail OAuth refresh token |
| `ALLOW_DEV_OTP_LOGGING` | Logs OTPs locally when explicitly enabled in development |

## Commands

| Command | Description |
| --- | --- |
| `npm run dev` | Run Express with nodemon and Vite together |
| `npm run dev:server` | Run only the backend |
| `npm run dev:client` | Run only the frontend |
| `npm run build` | Build production frontend assets into `dist/` |
| `npm start` | Start the production Express server |
| `npm test` | Run the Node test suite |
| `npm run rag:embed` | Backfill missing knowledge embeddings |
| `npm run rag:embed:force` | Rebuild all knowledge embeddings |

## API Overview

All protected endpoints use cookie-based authentication and enforce profile ownership where applicable.

| Area | Representative endpoints |
| --- | --- |
| Health | `GET /api/health` |
| Authentication | `/api/auth/signup`, `/login`, `/logout`, `/me`, `/account-setup`, Google OAuth and OTP routes |
| Profiles | `GET/POST /api/profiles`, activation, settings, state, messages, chat |
| Reminders | `GET /api/reminders`, status, acknowledge, dismiss |
| Check-ins | notifications, create, open, respond, and progress endpoints |
| Programs | active programs, days, tasks, and program reminders |
| Uploads | profile uploads and prescription confirmation |
| Nearby care | `POST /api/location/nearby-care` |

Refer to `server/routes/` for the complete request and response contract.

## Testing

```bash
npm test
npm run build
```

The current tests cover:

- unsupported reminder-claim filtering
- internal profile/context leak prevention
- reminder conversation context detection
- sleep alarm parsing and recurring reminder creation
- reminder persistence and listing

Before deployment, also verify login, account setup, profile switching, chat, reminder creation, due notifications, check-in responses, and the mobile layout manually.

## Deploying To Render With Turso

1. Create a Turso database and authentication token.
2. Push the repository to GitHub.
3. Create a Render Web Service or apply `render.yaml`.
4. Use the build command:

   ```bash
   npm ci --include=dev && npm run build
   ```

5. Use the start command:

   ```bash
   npm start
   ```

6. Add the environment variables from `.env.example` in Render, including Turso, session, OAuth, Groq, and optional embedding credentials.
7. Set public frontend/backend and Google callback URLs to the deployed Render origin.
8. Deploy and confirm `/api/health` returns `{"status":"ok"}`.

The production Express server serves the built Vite application from `dist/` and handles SPA fallback routing.

## Troubleshooting

### Server fails during database initialization

- Confirm `TURSO_DATABASE_URL` begins with `libsql://`.
- Generate a fresh `TURSO_AUTH_TOKEN` for the same database.
- Remove accidental quotes or whitespace from Render environment values.
- Check that URL and token belong to the same Turso database.

### Chat reports a failed or interrupted response

- Inspect Render logs for the specific Groq slot and status code.
- Confirm at least one main model key is configured and healthy.
- Verify planner keys for reminder/check-in requests.
- Run `GET /api/health` to separate application availability from AI-provider failure.

### Sidebar profile facts do not update

- Confirm the background job processor is running.
- Check logs for `update_profile_summary` or JSON extraction failures.
- Planner work automatically falls back to a healthy main pool, but at least one eligible AI slot must remain available.

### Reminder is discussed but not stored

- Ensure the request includes a usable date/time or answer the assistant's clarification.
- Check planner/tool logs and verify the database write succeeded.
- Query the reminder API instead of relying on conversational history; the database is authoritative.

## Security And Privacy

- Keep every API key, OAuth secret, database token, and session secret out of Git.
- Rotate any credential that has appeared in chat, screenshots, logs, or committed history.
- Use a long random `SESSION_SECRET` in production.
- Do not enable `ALLOW_DEV_OTP_LOGGING` in production.
- Store only the minimum health information required for the experience.
- Treat logs, uploads, profile summaries, and reminder text as sensitive data.
- Review privacy, consent, retention, and healthcare-regulatory requirements before serving real users.

## Current Scope

Anandaya currently provides in-app wellness coaching, reminders, check-ins, and progress tracking. It does not provide diagnosis, emergency monitoring, medication dosage decisions, or guaranteed push delivery outside the application. Medication reminders may reflect user-confirmed clinician or prescription instructions, but the AI must not create or alter a dose.

## License

No open-source license has been added yet. Unless a license is introduced, all rights remain with the project owner.
