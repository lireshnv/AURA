# Deploying AURA (free, always-on demo)

**Live now:**
- Website: https://aura-lireshnv.netlify.app
- Backend: https://aura-backend-pg9r.onrender.com (check `/health`)

| Part | Host | Plan |
|---|---|---|
| Database | Supabase (Postgres, ap-south-1) | Free |
| Backend (FastAPI) | Render web service `aura-backend` (Singapore) | Free, 512 MB RAM |
| Frontend (React) | Netlify site `aura-lireshnv` | Free |
| Keep-awake | Netlify scheduled function `keepalive` | Free, every 10 min |

## How it fits together

- **Backend** deploys automatically on every push to `main` on GitHub. Render
  runs `pip install -r backend/requirements-lite.txt`, then
  `uvicorn app.main:app`. Configuration lives in Render → aura-backend →
  **Environment** (never in the repo). `render.yaml` documents the same setup.
- **Lite profile:** Render's free 512 MB can't fit TensorFlow/DeepFace or
  MediaPipe, so `requirements-lite.txt` leaves them out. Camera face-emotion
  analysis reports "unavailable"; everything else works. `backend/Dockerfile`
  + `requirements.txt` is the full-feature build for a bigger host.
- **Frontend** is built with `VITE_API_BASE` pointing at the backend, which is
  baked in at build time.
- **Keep-awake:** `frontend/netlify/functions/keepalive.mjs` calls the
  backend's `/health` every 10 minutes. Render's free plan sleeps after 15 idle
  minutes, and `/health` runs a real database query, so this also stops the
  free Supabase project from pausing.

## Redeploying the frontend

From `frontend/`:
```
set VITE_API_BASE=https://aura-backend-pg9r.onrender.com
npm run build
npx netlify-cli deploy --prod --dir dist --functions netlify/functions --site aura-lireshnv
```
(`netlify login` once first.) Add `dist/_redirects` containing
`/*  /index.html  200` if the build doesn't already include it, so page
refreshes work.

## Changing a backend setting or secret

Render dashboard → **aura-backend** → **Environment** → edit → **Save, rebuild
and deploy**. Settings in use: `DATABASE_URL` (must start with
`postgresql+psycopg2://`, and `@`/`#` in the password must be written as
`%40`/`%23`), `AURA_JWT_SECRET`, `AURA_ENV=production`, `AURA_CORS_ORIGINS`,
`AURA_FRONTEND_URL`, `AURA_ADMIN_EMAIL`, `AURA_ADMIN_PASSWORD`,
`ELEVENLABS_API_KEY`, `GROQ_API_KEY`, `GEMINI_API_KEY`, `GOOGLE_CLIENT_ID`,
`GOOGLE_CLIENT_SECRET`, `SESSION_SECRET`, `PYTHON_VERSION=3.12.7`.

## Demo limitations

- **Sign in with email + password.** Google and one-time-code sign-in use
  cookies that browsers won't send between netlify.app and onrender.com.
- **Session history, SOS log, audit log, the wellbeing "twin" and uploaded
  document files** live on Render's disk and reset on every redeploy.
  Accounts, cases, calendar events and interventions are in Supabase and persist.
- Camera face-emotion analysis is off (lite profile, see above).
- Demo only. Real survivor data needs a paid, backed-up, encrypted setup and a
  privacy review first.
