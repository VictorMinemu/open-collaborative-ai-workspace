# Security policy

This project runs AI agents with access to company chats, code and tools, so we take security reports seriously.

## Reporting a vulnerability

**Do not open a public issue.** Report it privately through GitHub:
**Security › Report a vulnerability** on this repository (private vulnerability reporting).

Please include:

- what an attacker can do, and the affected component (API, web, desktop, local runtime, OpenClaw plugin, sandbox,
  installer…);
- the steps or a proof of concept, against your own instance;
- the version (commit or tag).

We acknowledge reports within 5 working days and keep you updated until a fix ships. With your permission, we credit
you in the advisory.

## Scope

In scope: this repository and an instance installed from it, in the documented configurations
([`docs/INSTALL.md`](docs/INSTALL.md)).

Of particular interest:

- tenant isolation;
- permission and approval bypasses;
- an agent escaping the Agent Channel API or its sandbox;
- prompt injection that leads to an unapproved side effect;
- secret or host-path disclosure.

Out of scope:

- third-party services (model providers, OpenClaw upstream, Docker images) unless our integration makes them unsafe;
- denial of service through resource exhaustion on an instance you control;
- findings that require an already-compromised server or admin account.

Please do not test against instances you do not own, and do not access or keep other people's data.

## Supported versions

The project is pre-1.0. Fixes land on `main`, and self-hosted instances get them by upgrading
([`docs/self-hosting/backup-restore.md`](docs/self-hosting/backup-restore.md#upgrading)).
