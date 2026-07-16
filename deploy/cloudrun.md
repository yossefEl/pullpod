# Deploying PullPod to Google Cloud Run

PullPod is a **shared team service**, so it runs as an always-on deployment with a stable
HTTPS URL — not a laptop tunnel. Cloud Run fits: managed TLS, a stable URL, and (with the two
flags below) a continuously-running container for the pg-boss worker and cron jobs.

## Why the two non-default flags matter

The container isn't just an HTTP server — it also runs the queue worker and `node-cron`. By
default Cloud Run scales to zero and throttles CPU between requests, which would freeze that
background work. So we deploy with:

- `--min-instances=1` — always one instance alive, so cron fires and the worker drains.
- `--no-cpu-throttling` — CPU stays allocated outside request handling.

## Prerequisites

- `gcloud` CLI installed and authed: `gcloud auth login && gcloud config set project <PROJECT_ID>`
- Enable APIs: `gcloud services enable run.googleapis.com cloudbuild.googleapis.com secretmanager.googleapis.com`
- **Postgres**: Supabase (already in `.env`) or Cloud SQL. This is the *only* datastore —
  the job queue (pg-boss) lives in the same database, so **there is no Redis to provision.**

## 1. Store secrets in Secret Manager

Keep the sensitive values out of the deploy command and revision history:

```bash
printf '%s' 'xoxb-...'                 | gcloud secrets create SLACK_BOT_TOKEN        --data-file=-
printf '%s' '<slack signing secret>'   | gcloud secrets create SLACK_SIGNING_SECRET   --data-file=-
printf '%s' '<base64 pem>'             | gcloud secrets create GITHUB_APP_PRIVATE_KEY --data-file=-
printf '%s' '<webhook secret>'         | gcloud secrets create GITHUB_WEBHOOK_SECRET  --data-file=-
printf '%s' '<supabase url>'           | gcloud secrets create DATABASE_URL           --data-file=-
```

(To update one later: `printf '%s' 'newval' | gcloud secrets versions add <NAME> --data-file=-`.)

## 2. Deploy from source

Cloud Build reads the `Dockerfile` automatically. Non-sensitive config goes as env vars;
secrets are mounted from Secret Manager:

```bash
gcloud run deploy pullpod \
  --source . \
  --region europe-west1 \
  --min-instances=1 \
  --no-cpu-throttling \
  --allow-unauthenticated \
  --set-env-vars "GITHUB_APP_ID=<id>,GITHUB_INSTALLATION_ID=<id>,GITHUB_ORG=flufylabs,TZ=Europe/Budapest,LOG_LEVEL=info,NODE_ENV=production" \
  --set-secrets "SLACK_BOT_TOKEN=SLACK_BOT_TOKEN:latest,SLACK_SIGNING_SECRET=SLACK_SIGNING_SECRET:latest,GITHUB_APP_PRIVATE_KEY=GITHUB_APP_PRIVATE_KEY:latest,GITHUB_WEBHOOK_SECRET=GITHUB_WEBHOOK_SECRET:latest,DATABASE_URL=DATABASE_URL:latest"
```

`--allow-unauthenticated` is required: Slack and GitHub call the endpoints without GCP IAM
credentials. The endpoints are secured by Slack's signing-secret check and GitHub's
`X-Hub-Signature-256` verification, not by Cloud Run auth.

The command prints a **Service URL** like `https://pullpod-xxxxx-ew.a.run.app`. That's your
stable public URL.

## 3. Run database migrations

The runtime image doesn't carry the migration tooling, so apply migrations from your machine
against the production database (one-off, and after any schema change):

```bash
DATABASE_URL='<supabase url>' npm run db:migrate
```

## 4. Point the apps at the Service URL

- **GitHub App** → *General → Webhook URL* = `https://<service-url>/webhooks/github`
  (webhook secret must equal `GITHUB_WEBHOOK_SECRET`).
- **Slack app** → set all three to `https://<service-url>/slack/events`:
  *Event Subscriptions* request URL, *Interactivity* request URL, and the `/pullpod`
  slash-command URL. Slack re-verifies the Events URL on save, so deploy first.

## 5. Verify

```bash
curl https://<service-url>/healthz          # -> {"ok":true}
gcloud run services logs read pullpod --region europe-west1 --limit 50
```

Then open a test PR in a watched repo and confirm the pod channel appears.

## Updating later

Re-run the `gcloud run deploy --source .` command; it builds a new revision and shifts traffic.
The webhook URLs never change, so you don't touch the GitHub/Slack configs on redeploys.
