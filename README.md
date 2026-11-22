# Pulse Crash live room

A small, single-room social crash game. The server generates each crash result before the round begins, and everyone in the room watches the same round. The host has a separate room console, can manage invites, and can approve or decline play-coin requests.

## Play coins

Coins are for play only. They cannot be bought, withdrawn, exchanged, or redeemed. Players start with 1,200 coins and can ask the host for more. The host starts with a 12,000-coin room reserve.

## Run locally

Use Node.js 20 or newer. Set a private `HOST_PASSCODE` with at least 16 characters, then run:

```sh
npm start
```

The server listens on the `PORT` environment variable, or port 3000 locally. Optional settings are `ROOM_NAME` and `ROOM_CODE` (default `Moonlight Lounge` and `MOON26`). Share the deployed address with `?room=MOON26` so friends get the room code prefilled.

## Host access

Open the room address and choose **Host sign in**. Set `HOST_PASSCODE` as a private environment variable on the server. Never commit a real passcode or `.env` file.

## Deployment notes

The app serves its own page and game API from one Node web service. It uses server-sent events to keep the room in sync. Run a single server instance: balances, room membership, requests, and history are stored in memory and reset when the server restarts. Add persistent storage before using it for longer-running rooms.

This starter does not process payments or provide real-money gambling features.

