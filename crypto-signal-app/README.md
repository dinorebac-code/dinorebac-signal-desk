# Signal Desk Frontend

Signal Desk is a static dashboard for SOL and EUR/USD trade setups.

## What it does

- shows daily setups from Supabase
- tracks trigger confirmation status
- stores and displays trade history
- keeps learning separate per market
- shows auto SL/TP logic after entry confirmation
- supports email alerts through Resend on the server side

## Local setup

Open `index.html` directly in the browser.

Then fill in `config.js` locally with:
- `supabaseUrl`
- `supabaseAnonKey`
- optional `twelveDataApiKey`
- `notificationEmail`

## Notes

The frontend should not contain real secrets in GitHub.
Use Supabase Edge Function secrets for sensitive values like:
- `TWELVE_DATA_API_KEY`
- `RESEND_API_KEY`
- `RESEND_FROM_EMAIL`
- `SUPABASE_SERVICE_ROLE_KEY`
