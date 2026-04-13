import { WebSocketServer, WebSocket } from "ws";

const PORT = 3001;
const wss = new WebSocketServer({ port: PORT });

/** @type {Map<WebSocket, {id: number, name: string, status: string, gameId: string|null}>} */
const players = new Map();
/** @type {Map<string, {hostWs: WebSocket, guestWs: WebSocket, seed: number}>} */
const games = new Map();
let nextId = 1;

function broadcast(data) {
  const msg = JSON.stringify(data);
  for (const [ws] of players) {
    if (ws.readyState === WebSocket.OPEN) ws.send(msg);
  }
}

function sendLobbyUpdate() {
  const list = [];
  for (const [, p] of players) {
    list.push({ id: p.id, name: p.name, status: p.status });
  }
  broadcast({ type: "lobby_update", players: list });
}

function sendTo(ws, data) {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(data));
  }
}

function relayToOpponent(ws, gameId, data) {
  const game = games.get(gameId);
  if (!game) return;
  const opponentWs = game.hostWs === ws ? game.guestWs : game.hostWs;
  sendTo(opponentWs, data);
}

wss.on("connection", (ws) => {
  const id = nextId++;
  const name = `Player ${id}`;
  players.set(ws, { id, name, status: "idle", gameId: null });

  ws.send(JSON.stringify({ type: "welcome", id, name }));
  sendLobbyUpdate();

  ws.on("message", (raw) => {
    let data;
    try {
      data = JSON.parse(String(raw));
    } catch {
      return;
    }

    const player = players.get(ws);
    if (!player) return;

    switch (data.type) {
      case "set_name": {
        player.name = String(data.name).slice(0, 20);
        sendLobbyUpdate();
        break;
      }

      case "invite": {
        for (const [targetWs, p] of players) {
          if (p.id === data.targetId && targetWs.readyState === WebSocket.OPEN) {
            targetWs.send(
              JSON.stringify({
                type: "invite_received",
                from: { id: player.id, name: player.name },
              })
            );
            player.status = "inviting";
            sendLobbyUpdate();
            break;
          }
        }
        break;
      }

      case "accept_invite": {
        for (const [inviterWs, p] of players) {
          if (p.id === data.fromId) {
            const gameId = `game_${Date.now()}`;
            const seed = Math.floor(Math.random() * 2147483647);

            games.set(gameId, { hostWs: inviterWs, guestWs: ws, seed });

            p.status = "in_game";
            p.gameId = gameId;
            player.status = "in_game";
            player.gameId = gameId;

            sendTo(inviterWs, {
              type: "game_start",
              gameId,
              seed,
              opponent: { id: player.id, name: player.name },
              role: "host",
            });
            sendTo(ws, {
              type: "game_start",
              gameId,
              seed,
              opponent: { id: p.id, name: p.name },
              role: "guest",
            });

            sendLobbyUpdate();
            break;
          }
        }
        break;
      }

      case "decline_invite": {
        for (const [inviterWs, p] of players) {
          if (
            p.id === data.fromId &&
            inviterWs.readyState === WebSocket.OPEN
          ) {
            inviterWs.send(
              JSON.stringify({
                type: "invite_declined",
                by: { id: player.id, name: player.name },
              })
            );
            p.status = "idle";
            sendLobbyUpdate();
            break;
          }
        }
        break;
      }

      // In-game relay messages
      case "game_move":
      case "game_aim":
      case "game_fire":
      case "game_turn_start":
      case "game_end_turn": {
        if (player.gameId) {
          relayToOpponent(ws, player.gameId, data);
        }
        break;
      }
    }
  });

  ws.on("close", () => {
    const p = players.get(ws);
    if (p && p.gameId) {
      const game = games.get(p.gameId);
      if (game) {
        const opponentWs = game.hostWs === ws ? game.guestWs : game.hostWs;
        sendTo(opponentWs, { type: "opponent_disconnected" });
        games.delete(p.gameId);
        const opp = players.get(opponentWs);
        if (opp) {
          opp.status = "idle";
          opp.gameId = null;
        }
      }
    }
    players.delete(ws);
    sendLobbyUpdate();
  });
});

console.log(`Artillery lobby server running on ws://localhost:${PORT}`);
