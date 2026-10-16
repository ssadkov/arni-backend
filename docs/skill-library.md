# Public profession library

`GET /api/skills/library` serves a generic, versioned pack for Arni desktop. No authentication, database, user data, credentials, uploads or inference calls. The checked-in JSON is imported by the route, so Vercel includes it in the deployment. ETag is the content revision; matching requests receive 304. The Russian proxy forwards the same route to arni-backend.vercel.app.

Current pack: 11 skills (green screen, common media toolkit, trimming, audio, screencast, subtitles, inserts, reframing, transcript-based edit, export verification and content editor), plus two agent profiles. No CapCut integration or publishing adapters. ASR uses an independently installed local whisper.cpp executable/model and a validated local transcript cache; the general chat model does not transcribe audio by itself.

Source is the client repository. Regenerate explicitly after editing source skills:

```text
node scripts/export-skill-library.mjs <backend-worktree>/src/lib/skills/library.json
```

Run that command from the client checkout. Do not edit the generated JSON by hand or export company/personal profiles. Per-file SHA-256 covers UTF-8 text with LF endings; revision is SHA-256 of JSON.stringify of the sorted `[path, sha256]` pairs. Schema version 1 has a two-MiB client body limit, bounded file count/size, allowed relative paths and no archive extraction. These hashes check integrity, not a separate publisher signature: trust comes from the fixed first-party HTTPS endpoint and the user's explicit update action. Helpers are downloaded as text; the endpoint never executes them.

Desktop 1.0.6 introduces the loader; older installations need one application update. Then `Арни: Обновить библиотеку навыков` downloads a new immutable version and offers window reload. Running chats retain their discovered paths. Corrupt/unavailable cache falls back to bundled resources. Editable project copies have priority and are never overwritten by library updates. Python, FFmpeg and Whisper/model installation remain local setup, not backend work.

Checks: `node scripts/test-skills.mjs <base-url>` validates anonymous HTTP, hashes, revision, ETag 304, CORS and expected generic content. Client tests additionally cover unsafe paths, code tampering, interrupted/offline update behavior and preservation of editable copies. Local HTTP testing in a worktree with linked node_modules uses `next dev --webpack`; Turbopack rejects dependencies outside its root. Production installs dependencies normally and does not need that workaround.
