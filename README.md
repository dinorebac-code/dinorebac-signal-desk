# Signal Desk

Signal Desk is a lightweight web app for daily SOL and EUR/USD trade setups with:
- separate learning per market
- automatic setup generation
- trigger monitoring during the watch window
- automatic win/loss resolution after entry
- email alerts through Resend
- a premium static dashboard frontend

## Project structure

- `crypto-signal-app/index.html`: main dashboard
- `crypto-signal-app/styles.css`: premium UI styling
- `crypto-signal-app/app.js`: frontend logic and Supabase hydration
- `crypto-signal-app/config.js`: local config template
- `crypto-signal-app/supabase-schema.sql`: database schema
- `crypto-signal-app/supabase/functions/`: Edge Functions used by Supabase

## Before use

Fill in `crypto-signal-app/config.js` locally with your own values.
Do not commit real API keys or secrets.

## Supabase secrets

Recommended secrets:
- `TWELVE_DATA_API_KEY`
- `ALERT_EMAIL`
- `RESEND_API_KEY`
- `RESEND_FROM_EMAIL`

## Notes

The setup and trigger watch window is configured for `16:30-17:30 Europe/Oslo`.
Cron schedules in Supabase must be adjusted if daylight saving changes and you want to keep the exact same local time.
