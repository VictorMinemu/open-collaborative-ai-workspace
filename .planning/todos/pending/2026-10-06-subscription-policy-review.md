---
created: 2026-10-06
title: Review subscription use in Work Zone (Claude) and bots (single ChatGPT seat) against provider policies
area: compliance
---

## Problem
Phase 5 research found Anthropic's published policy forbids routing Free/Pro/Max plan credentials through third-party
apps "including the Agent SDK"; the Work Zone drives Claude Code via the Agent SDK with each member's own login on
their device. Bots in the OpenClaw cell use one org-wide ChatGPT sign-in (one seat for everyone, `backend-api` route).

## Solution
Research the exact policy texts and options (Claude Code CLI unmodified, org API keys, per-member ChatGPT plan via the
official Sign in with ChatGPT route for bots too), then propose an ADR to the owner.
