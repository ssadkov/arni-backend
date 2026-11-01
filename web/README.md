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
YANDEX_SEARCH_API_KEY=
YANDEX_SEARCH_FOLDER_ID=
```

Register both callback URLs on the Yandex and VK apps:

- `https://api.arnion.ru/api/web/auth/yandex/callback`
- `https://api.arnion.ru/api/web/auth/vk/callback`

Apply `deploy/web-chat/20261101-web-chat.sql` once to the existing Postgres before the API deployment starts writing chats.

`VK_CLIENT_ID` is already used by the desktop exchange. Search stays disabled until both Yandex Search variables are set, and the chat still answers without them.
