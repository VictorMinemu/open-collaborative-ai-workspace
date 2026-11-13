# Automations, webhooks, mailboxes and watched records

Bots can act without being asked: on a schedule, when a signed webhook arrives, when a mail lands in a mailbox, or
when a record someone watches changes in an outside system. People set them up in **Bots › Automations**, their digest
in **Settings › Digest**, and watched records from a board card's menu. The decisions behind this page are in
[ADR-0028](../adr/0028-automations-and-job-scheduler.md).

Nothing new runs for this: no extra container, no hosted service. Jobs live in PostgreSQL (the `pgboss` schema, through
[pg-boss](https://github.com/timgit/pg-boss)), and OpenClaw's own cron and webhooks stay off in the cell.

## What runs where

| Piece | Where | What it does |
| --- | --- | --- |
| `migrate` (one-shot) | `ocw_migrator` | Creates or upgrades the `pgboss` schema and every job queue, with the rest of the database. Runs before the API on every `docker compose up`. |
| `api` | `ocw_app` | Serves the routes and runs the job workers: a one-minute tick for schedules, mailbox polls, watched-record checks, the inbound worker, the digest and Work Zone summaries, and a daily clean-up at 03:17 UTC. It never changes the `pgboss` schema. |
| OpenClaw cell | its own container | Receives a run as the bot's turn and answers in the run card's thread. Its own cron and webhooks are off. |
| `bot_task.continue` (job) | `api` | Gives a bot's long task its next turn in its thread, as the person it runs for: after the bot's last turn of the task ended, when its timer is up, or when the sandbox command or Work Zone session it waits on ends. The job carries ids only and delivers each turn once ([ADR-0042](../adr/0042-long-running-bot-tasks.md)). |
| `bot_task.tick` (every minute) | `api` | Finds up to 100 tasks a minute that are due or stuck (a wait past its time, a turn that never reported back for 30 minutes, a task past its hours, a bot turned off) and continues or stops them. |

Long bot tasks (v0.3.2) add only these two queues: the `migrate` service creates them, and the API's workers run them.
Nothing extra to run or configure; their limits are in Settings › Bot policy › Long tasks.

**`OCW_JOBS_WORKER`** (`on` by default; `off` under `NODE_ENV=test`). With several API replicas, every replica may run
workers: each job runs once and each tick once a minute, whichever replica takes it. Set `OCW_JOBS_WORKER=off` on
replicas that should only answer requests; keep it `on` on at least one, or nothing scheduled ever runs. Stopping the
API lets jobs in flight finish (up to 8 seconds); queued jobs wait for the next start.

## Webhook URLs

A lead or an admin (the `automation.webhook` permission) creates a webhook automation and copies its URL and secret
once. The URL is built from `OCW_PUBLIC_API_URL`:

```text
https://ocw.example.com/api/v1/hooks/<26-character id>
```

- Behind Caddy (`pnpm ocw enable proxy`, see [reverse-proxy.md](reverse-proxy.md)) `/api/*` already reaches the API;
  nothing else to configure. The sending system must be able to reach that address: an instance only reachable on
  your LAN only accepts webhooks from your LAN.
- Senders sign with [Standard Webhooks](https://www.standardwebhooks.com/) (`webhook-id`, `webhook-timestamp`,
  `webhook-signature`). Requests more than 5 minutes off the server clock are refused, so keep NTP on.
- Answers the sender sees: `202` accepted, `200` duplicate (same `webhook-id`), `401` bad signature or timestamp, `404`
  unknown URL, `410` deleted (tell the sender to stop), `413` over 64 KiB, `429` over 60 calls a minute for that URL.
- Rate limits are counted in Redis for every replica. If Redis is down, each replica counts in its own memory until
  it is back: limits still apply and sign-in keeps working.
- Rotating a secret keeps the previous one valid for 24 hours.

## Mailboxes (IMAP)

A mail automation reads one folder of a mailbox, read-only: mail stays unread and is never moved or deleted.

1. Create an app password at your mail provider (Gmail, Outlook and Fastmail call it that; IMAP sign-in with OAuth is
   not supported yet).
2. **Settings › Keychain › Add key** › *Username & password*: the address as the username, the app password, and the
   mail server in **Allowed hosts** (`imap.example.com` means port 993; write `imap.example.com:143` only if your
   server needs another port).
3. **Bots › Automations › New** › When: *Mail*, pick that key, the server and the folder, **Test connection**.

The API connects with TLS to the address the egress guard checked, and refuses a server on a private address unless an
admin allowed that exact `host:port` in the private hosts card of Settings › MCP servers (as for connectors) and the
key is a unit or organization key. Polls run every 5 to 60
minutes. A wrong password shows *Sign-in failed … Update the password in Keychain.* on the automation and is retried every 30 minutes, and at once when
the key changes. Mail without a `Message-ID` is still read once; auto-replies, bulk mail, mail from the mailbox itself
and mail our own automations sent are skipped.

## Limits

These are per organization, in `app.bot_policies`, with these defaults (there is no Settings control for them yet):

| Limit | Default |
| --- | --- |
| Automations per person | 10 |
| Shortest interval between two runs | 5 minutes |
| Runs a day per automation (the most anyone may set) | 288 |
| Inbound items (webhook or mail) an hour per automation | 30 |
| Digest runs a day (schedule and test sends together) | 5 |

Existing instances whose limits were still the old defaults (15 minutes, 96 runs a day) move to the new ones on
upgrade; values an admin changed are kept.

Each bot's daily limit (Bots › a bot › Limits) applies to runs too, and the person an automation runs as pays for it.
Three failed runs in a row pause an automation as *Needs attention*; its owner resumes it.

## Retention

- Webhook payloads and mail text are cleared 30 days after they arrived (the deliveries list keeps the dates and
  results).
- Finished jobs stay in `pgboss` for two days.
- Runs, watched-record changes and audit rows stay like other workspace data. The `pgboss` schema is part of every
  backup ([backup-restore.md](backup-restore.md)).

## Troubleshooting

- **The API exits at boot with `pg-boss schema missing or outdated: run the migrate service`.** The database has not
  been migrated for this version. `docker compose up -d` runs `migrate` first; if you start services one by one, run
  `docker compose run --rm migrate`, then start the API again. Never run the API with migrator credentials to "fix" it.
- **A scheduled automation never runs.** Check that at least one API replica has `OCW_JOBS_WORKER` unset or `on`, and
  open the automation's run history: a skipped run says why (the bot left the channel, the daily limit, …).
- **Webhooks answer `401`.** The sender's clock is more than 5 minutes off, or it signs a different body than it sends
  (it must sign the exact bytes).
- **A mailbox test reads *The server's certificate isn't valid for …*.** The server's TLS certificate does not match its name or is
  self-signed. Use the provider's public IMAP host name.
- **A watched record reads *Not connected*.** The person who linked it lost their connection or stopped sharing their
  account on that board; they reconnect from the notice in their DM with the bot.
