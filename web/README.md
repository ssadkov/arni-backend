# Arni web chat

Browser client for the account chat. It is deployed separately from the API.

## Coolify

- Repository: `arni-backend`
- Base directory: `web`
- Build: `npm install && npm run build`
- Publish directory: `dist`
- SPA fallback: serve `index.html` for unknown paths
- Public host: `https://chat.arnion.kz`

Build-time variable:

```
VITE_API_ORIGIN=https://api.arnion.ru
```

## API environment

Set these on the existing Vercel project. The browser calls `https://api.arnion.ru`.

```
WEB_APP_ORIGIN=https://chat.arnion.kz
API_PUBLIC_ORIGIN=https://api.arnion.ru
YANDEX_OAUTH_CLIENT_ID=
YANDEX_OAUTH_CLIENT_SECRET=
GOOGLE_OAUTH_CLIENT_ID=
GOOGLE_OAUTH_CLIENT_SECRET=
GOOGLE_DESKTOP_CLIENT_ID=
```

`GOOGLE_OAUTH_CLIENT_ID` and `GOOGLE_OAUTH_CLIENT_SECRET` come from a Google Cloud OAuth client of type "Web application". `GOOGLE_DESKTOP_CLIENT_ID` is the separate "Desktop app" client the editor uses; leave it empty until the editor ships Google sign-in. The exchange accepts a Google token only when it was issued to one of these two clients.

Register both callback URLs on the Yandex and VK apps:

- `https://api.arnion.ru/api/web/auth/yandex/callback`
- `https://api.arnion.ru/api/web/auth/vk/callback`

Register `https://api.arnion.ru/api/web/auth/google/callback` as an authorized redirect URI on the Google web client.

Apply `deploy/web-chat/20261101-web-chat.sql` once to the existing Postgres before the API deployment starts writing chats.

`VK_CLIENT_ID` is already used by the desktop exchange.

## Web search

Set these server-side variables in the Vercel Production environment for Exa Lite.

```
WEB_SEARCH_PROVIDER=exa
EXA_API_KEY=
```

To switch to Yandex Search API, set `WEB_SEARCH_PROVIDER=yandex`, `YANDEX_SEARCH_API_KEY`, and `YANDEX_SEARCH_FOLDER_ID`. Existing Yandex configurations also work with `WEB_SEARCH_PROVIDER` unset. Set `WEB_SEARCH_PROVIDER=off` to disable search. A missing key or unknown provider also disables search. Each request uses only the configured provider.

Redeploy the API in Vercel after changing these variables. The Coolify frontend works with either provider. Both providers return titles, URLs and snippets through the same chat flow for free OpenRouter models and Bedrock.
