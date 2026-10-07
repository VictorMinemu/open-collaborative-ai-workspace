---
created: 2026-10-06
title: ai-chat-list rename/archive spec fails only under --repeat-each on mobile
area: e2e
---
Single runs pass (7/7 twice). With `--repeat-each=3`, "/chat/ai groups the member's chats and lets them rename and
archive" fails on mobile with a focus/element-not-found error, likely because earlier repeats' chats accumulate in the
same list. Make it independent of prior chats (scope locators to the chat created in that run).
