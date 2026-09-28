# Deploying AURA (free, always-on demo)

| Part | Host | Free? |
|---|---|---|
| Database | Supabase (Postgres) | Yes |
| Backend (FastAPI) | Hugging Face Docker Space | Yes - 16 GB RAM CPU tier |
| Frontend (React) | Netlify | Yes |
| Keep-awake | UptimeRobot | Yes |

Do the steps in this order - each one needs a value from the one before.

---

## 1. Supabase - database

1. Sign up at https://supabase.com → **New project**. Pick a region near you and
   set a database password (save it).
2. When it's ready: **Connect** (top bar) → **Connection string** → choose
   **Session pooler** (works over IPv4, which Hugging Face needs).
3. Copy the URI. It looks like:
   ```
   postgresql://postgres.abcdefgh:[YOUR-PASSWORD]@aws-0-ap-south-1.pooler.supabase.com:5432/postgres
   ```
   Replace `[YOUR-PASSWORD]` with your password and add `?sslmode=require` on the end.
   This is your `DATABASE_URL`.

Tables are created automatically the first time the backend starts.

---

## 2. Hugging Face - backend

1. Sign up at https://huggingface.co → **New Space**.
   - Space name: `aura-backend`
   - SDK: **Docker** → **Blank**
   - Hardware: **CPU basic (free)**
   - Visibility: **Private** is fine
2. In the Space: **Settings → Variables and secrets** → add these as **Secrets**:

   | Name | Value |
   |---|---|
   | `DATABASE_URL` | from step 1 |
   | `AURA_JWT_SECRET` | run `python -c "import secrets; print(secrets.token_urlsafe(48))"` and paste the output |
   | `AURA_ADMIN_EMAIL` | the admin login you want |
   | `AURA_ADMIN_PASSWORD` | a strong password |
   | `AURA_CORS_ORIGINS` | your Netlify URL from step 3, e.g. `https://aura-demo.netlify.app` (fill in after step 3) |
   | `AURA_FRONTEND_URL` | same Netlify URL |
   | `ELEVENLABS_API_KEY` | your key (speech-to-text / voice) |
   | `GROQ_API_KEY` | your key (AI companion chat) |
   | `GEMINI_API_KEY` | optional - only for the realtime voice beta |

   Any other setting in `backend/.env.example` can be added the same way if you
   use it. Never put these values in the git repo.

3. Push the `backend` folder to the Space. From the repo root, once:
   ```
   git remote add hf https://huggingface.co/spaces/<your-hf-username>/aura-backend
   ```
   then every time you want to deploy:
   ```
   git subtree push --prefix backend hf main
   ```
   When asked for a password, use a Hugging Face **access token** with write
   access (https://huggingface.co/settings/tokens), not your account password.

4. The first build takes ~10-15 minutes (TensorFlow is large). When the Space
   shows **Running**, open:
   ```
   https://<your-hf-username>-aura-backend.hf.space/health
   ```
   You should see `"database": "ok"`. That URL (without `/health`) is your
   backend URL.

   If the Space is **Private**, the frontend can't reach it - make it **Public**
   (Settings → Change visibility). The code is visible then, but your secrets
   are not.

---

## 3. Netlify - frontend

1. Sign up at https://netlify.com → **Add new site → Import an existing project**
   → GitHub → pick `lireshnv/AURA`.
2. Settings:
   - **Base directory:** `frontend`
   - Build command and publish directory come from `frontend/netlify.toml` automatically.
3. **Environment variables** → add:
   - `VITE_API_BASE` = your backend URL from step 2, e.g.
     `https://<your-hf-username>-aura-backend.hf.space` (no trailing slash)
4. **Deploy**. Your site URL is shown when it finishes (you can rename it under
   Site configuration → Change site name).
5. Go back to the Hugging Face Space and set `AURA_CORS_ORIGINS` and
   `AURA_FRONTEND_URL` to this Netlify URL. The Space restarts automatically.

`VITE_API_BASE` is baked in at build time - if you change it, trigger a new
deploy in Netlify.

---

## 4. UptimeRobot - keep it always on

The free Hugging Face Space sleeps after 48 hours without traffic, and a free
Supabase project pauses after 7 days. One ping prevents both.

1. Sign up at https://uptimerobot.com → **Add New Monitor**.
2. Type **HTTP(s)**, URL `https://<your-hf-username>-aura-backend.hf.space/health`,
   interval **5 minutes**.

`/health` runs a real database query, so this also keeps Supabase active.

---

## Demo limitations to know

- **Sign in with email + password.** Google sign-in and one-time-code sign-in
  use cookies that browsers don't send between two different domains
  (netlify.app ↔ hf.space), so they won't work in this split setup.
- **Session history, SOS log, audit log, the wellbeing "twin" and uploaded
  document files** are stored on the container's disk. They reset whenever the
  Space restarts or you redeploy. Accounts, cases, calendar events and
  interventions are in Supabase and persist.
- Voice-tone and text-emotion AI models are not installed in the Docker image
  (to keep it small); those features show as "unavailable", same as locally.
- This is for a demo only. Real survivor data needs a paid, backed-up,
  encrypted setup and a review of privacy obligations first.
