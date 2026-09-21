# /channels split fix

Overwrite src/webhook.ts in repo, commit, push.
Problem: one giant message exceeded Telegram 4096-char limit - send rejected, only "Checking chats..." appeared.
Fix: list is chunked at line boundaries (max ~3800 chars) into part X/Y messages.
