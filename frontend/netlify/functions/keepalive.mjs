// Netlify scheduled function: pings the backend every 10 minutes so Render's
// free plan (sleeps after 15 idle minutes) stays awake. /health runs a real
// database query, so this also keeps a free Supabase project from pausing.
const HEALTH_URL = process.env.AURA_HEALTH_URL ?? "https://aura-backend-pg9r.onrender.com/health"

export default async () => {
  try {
    const res = await fetch(HEALTH_URL)
    console.log(`keepalive ${res.status} ${await res.text()}`)
  } catch (err) {
    console.log(`keepalive failed: ${err}`)
  }
}

export const config = { schedule: "*/10 * * * *" }
