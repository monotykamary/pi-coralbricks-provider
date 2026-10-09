# Changelog

## 1.0.30

- Send the pi session id to Coral on every route: the `x-coral-session` header on Chat Completions and Responses, and `prompt_cache_key` in Completions bodies, where pi-ai omits it for non-OpenAI hosts. Coral reads the session's prompt cache from either signal alone (verified live); `cacheRetention: "none"` still omits the body key.

## 1.0.29

- Add opt-in Responses parking (`"park": true` or `/coralbricks-settings`). Turns are stored and chained with `previous_response_id`, sending only new items, with a full-replay fallback when the history no longer matches or Coral lost the parent.

## 1.0.21

- Pin Pi SDK development dependencies to 1.0.0 while retaining wildcard host peers.
- Verify real manifest loading, provider catalogs, startup/shutdown and native/bundled Pi hosts offline.
- Exercise real transport adapters with Unicode text, tool calls, empty responses, usage, request hooks and cancellation; no live provider calls.

## 1.0.20

- Validate against Pi 0.99.0, including an offline real-host package-loading probe.
- Declare imported host packages as wildcard peers and pin development dependencies to Pi 0.99.0.
- Stop installing duplicate Pi AI and coding-agent runtime packages.
