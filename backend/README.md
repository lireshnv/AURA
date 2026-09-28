---
title: AURA Backend
emoji: 💜
colorFrom: purple
colorTo: indigo
sdk: docker
app_port: 7860
pinned: false
---

# AURA backend

FastAPI backend for AURA. Deployed as a Hugging Face Docker Space; see
`../DEPLOY.md` in the main repository for the full setup.

Configuration comes from the Space's **Settings → Variables and secrets** -
never commit a real `.env`. `.env.example` lists every setting.
