# Deploying Qyntra Cloud

Qyntra Cloud is one Node.js process and one SQLite file. No other
services are required; Stripe and Slack are optional.

## Run it locally

```bash
npm run cloud                      # http://localhost:8080, development mode
```

Sign up at http://localhost:8080/signup, create a project, and point a
local CLI at it:

```json
"cloud": { "url": "http://localhost:8080", "project": "<slug>", "upload": "standard" }
```

```bash
export QYNTRA_TOKEN=qy_live_…      # shown once when the project was created
npx qyntra doctor                  # "Qyntra Cloud : … project …, plan free"
npx qyntra gate                    # decides, then uploads
```

## Production

| Variable | Required | Purpose |
| --- | --- | --- |
| `QYNTRA_CLOUD_URL` | yes | Public `https://` address. Enables secure cookies and HSTS |
| `QYNTRA_CLOUD_SECRET` | yes | 32+ random characters; signs CSRF tokens. The server refuses to start in production without it |
| `QYNTRA_CLOUD_DB` | no | SQLite file; default `data/qyntra-cloud.db` |
| `PORT` | no | Default 8080 |
| `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `STRIPE_PRICE_TEAM`, `STRIPE_PRICE_BUSINESS` | for billing | Without them the billing page says billing is not configured |
| `STRIPE_PRICE_PARTNER` | no | The $500/month design-partner price. Without it, an org offered the plan is told to pay by invoice |

### Fly.io (about $5/month)

```bash
fly launch --config fly.cloud.toml --no-deploy
fly volumes create qyntra_data --size 3
fly secrets set QYNTRA_CLOUD_SECRET=$(openssl rand -base64 48) QYNTRA_CLOUD_URL=https://app.yourdomain.com
fly deploy --config fly.cloud.toml
fly certs add app.yourdomain.com
```

### Any Docker host

```bash
docker build -f Dockerfile.cloud -t qyntra-cloud .
docker run -d -p 8080:8080 -v qyntra-data:/data \
  -e QYNTRA_CLOUD_URL=https://app.yourdomain.com \
  -e QYNTRA_CLOUD_SECRET="$(openssl rand -base64 48)" qyntra-cloud
```

Put it behind a TLS-terminating proxy (Fly, Caddy, nginx, a load
balancer). The process speaks plain HTTP on `PORT`.

## Stripe

1. Create the recurring prices: **Team** ($49, per unit — billed per
   project), **Business** ($299, flat) and, for pilots, **Design
   partner** ($500, flat). The partner plan is never listed publicly;
   offer it to one organization at a time from `/admin`.
2. Add a webhook endpoint `https://<your-domain>/v1/stripe/webhook` for
   `checkout.session.completed`, `customer.subscription.updated` and
   `customer.subscription.deleted`.
3. Set the `STRIPE_*` secrets and restart.

The webhook is the only thing that changes a plan, and it is verified
with the endpoint's signing secret.

## Backups

Everything is in the SQLite file (WAL mode). Back it up with:

```bash
sqlite3 /data/qyntra-cloud.db ".backup '/data/backup-$(date +%F).db'"
```

and copy the result off the machine (e.g. `fly ssh sftp get`). Retention
runs daily inside the server and deletes runs older than each project's
setting.

## Scaling

One machine handles thousands of organizations: uploads are small JSON
documents and every page is a handful of indexed queries. Before running
more than one instance, move the database to Postgres (the schema in
`cloud/db.ts` maps directly) and rate limiting to the database.
