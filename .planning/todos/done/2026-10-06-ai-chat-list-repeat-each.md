---
created: 2026-10-06
title: ai-chat-list rename/archive spec fails only under --repeat-each on mobile
area: e2e
---
Single runs pass (7/7 twice). With `--repeat-each=3`, "/chat/ai groups the member's chats and lets them rename and
archive" fails on mobile with a focus/element-not-found error, likely because earlier repeats' chats accumulate in the
same list. Make it independent of prior chats (scope locators to the chat created in that run).

**Done (05-14, 832549c).** Two causes, both in the spec: the list pages by 30, so after repeats the week/older chats
were on page 2 (now "Load more" until the row shows), and the header title was clicked while the loading header (same
test id, not renamable) was still on screen (now it waits for the chat's title). `--repeat-each=3` on desktop + mobile
for ai-chat-list, ai-chat-stop and ai-chat-plan-errors: 79/79.
