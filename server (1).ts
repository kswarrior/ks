import express from "express";
import { createServer as createViteServer } from "vite";
import path from "path";
import { spawn } from "child_process";

const app = express();
const PORT = 3000;

// Bot Configuration
let BOT_CONFIG = {
  host: "kswarrior.aternos.me",
  port: 63977,
  username: "BotWarrior",
  version: "1.20.1",
};

let bot: any = null;
let reconnectTimeout: NodeJS.Timeout | null = null;
let botIntervals: NodeJS.Timeout[] = [];
let botStatus = {
  connected: false,
  health: 20,
  food: 20,
  position: { x: 0, y: 0, z: 0 },
  logs: [] as string[],
  inventory: [] as any[],
};

function log(message: string) {
  const timestamp = new Date().toLocaleTimeString();
  const logMsg = `[${timestamp}] ${message}`;
  console.log(logMsg);
  botStatus.logs.push(logMsg);
  if (botStatus.logs.length > 100) botStatus.logs.shift();
}

function clearBotIntervals() {
  botIntervals.forEach(clearInterval);
  botIntervals = [];
}

let isStarting = false;
async function startBot() {
  if (isStarting) return;
  isStarting = true;

  try {
    if (reconnectTimeout) {
      clearTimeout(reconnectTimeout);
      reconnectTimeout = null;
    }
    
    clearBotIntervals();

    // If there's an existing bot, end it first
    if (bot) {
      log("[SYSTEM] Ending current bot session...");
      try {
        if (bot.pvp) bot.pvp.stop();
        if (bot.pathfinder) bot.pathfinder.setGoal(null);
      } catch (e) {}
      bot.removeAllListeners();
      bot.end();
      bot = null;
    }

    log(`Connecting to ${BOT_CONFIG.host}:${BOT_CONFIG.port} as ${BOT_CONFIG.username}...`);
    
    const mineflayer = await import("mineflayer");
    const createBot = mineflayer.createBot;

    const pathfinderMod = await import("mineflayer-pathfinder");
    const { pathfinder, Movements } = pathfinderMod;

    const pvpMod = await import("mineflayer-pvp");
    const pvp = pvpMod.plugin;

    const autoeatMod = await import("mineflayer-auto-eat");
    const autoeat = autoeatMod.loader;

    const armorManagerMod = await import("mineflayer-armor-manager");
    const armorManager = (armorManagerMod as any).default || armorManagerMod;

    bot = createBot({
      host: BOT_CONFIG.host,
      port: BOT_CONFIG.port,
      username: BOT_CONFIG.username,
      version: BOT_CONFIG.version,
      checkTimeoutInterval: 60000, // Increase timeout check
    });

    // Load plugins
    bot.loadPlugin(pathfinder);
    bot.loadPlugin(pvp);
    bot.loadPlugin(autoeat);
    bot.loadPlugin(armorManager);

    bot.on("spawn", () => {
      botStatus.connected = true;
      log("Bot spawned in the world!");
      log(`Server: ${bot.host}:${bot.port}`);
      log(`Version: ${bot.version}`);
      
      try {
        const defaultMove = new Movements(bot);
        bot.pathfinder.setMovements(defaultMove);
      } catch (e) {
        log("[ERROR] Failed to set movements");
      }

      const afkInterval = setInterval(() => {
        if (!botStatus.connected || !bot || !bot.entity || !bot.entity.position) return;
        try {
          const action = Math.random();
          if (action < 0.1) {
            if (typeof bot.setControlState === 'function') {
              bot.setControlState("jump", true);
              setTimeout(() => {
                if (bot && typeof bot.setControlState === 'function') bot.setControlState("jump", false);
              }, 500);
              log("Anti-AFK: Jumped");
            }
          } else if (action < 0.2) {
            if (typeof bot.setControlState === 'function') {
              bot.setControlState("forward", true);
              setTimeout(() => {
                if (bot && typeof bot.setControlState === 'function') bot.setControlState("forward", false);
              }, 1000);
              log("Anti-AFK: Moved forward");
            }
          }
        } catch (e) {
          // Ignore transient movement errors
        }
      }, 30000);
      botIntervals.push(afkInterval);

      const combatInterval = setInterval(() => {
        if (!botStatus.connected || !bot || !bot.entity || !bot.entity.position) return;
        try {
          if (!bot.pvp || typeof bot.pvp.attack !== 'function') return;
          
          const filter = (e: any) => e.type === 'mob' && e.position && bot.entity && e.position.distanceTo(bot.entity.position) < 16 && 
                                     ['zombie', 'skeleton', 'spider', 'creeper', 'drowned', 'husk'].includes(e.name);
          const entity = bot.nearestEntity(filter);
          if (entity && bot.entity && bot.pvp) {
            // Extra check for yaw error
            if (bot.entity.yaw === undefined || bot.entity.yaw === null || isNaN(bot.entity.yaw)) return;
            
            log(`Combat: Attacking ${entity.name} at ${Math.round(entity.position.distanceTo(bot.entity.position))}m`);
            bot.pvp.attack(entity);
          }
        } catch (e) {
          // Ignore transient combat errors
        }
      }, 2000);
      botIntervals.push(combatInterval);
    });

    bot.on("health", () => {
      try {
        if (!bot) return;
        botStatus.health = bot.health;
        botStatus.food = bot.food;
        if (bot.health < 10) log(`Warning: Low Health! (${bot.health})`);
      } catch (e) {}
    });

    bot.on("move", () => {
      try {
        if (!bot || !bot.entity || !bot.entity.position) return;
        botStatus.position = {
          x: Math.round(bot.entity.position.x),
          y: Math.round(bot.entity.position.y),
          z: Math.round(bot.entity.position.z),
        };
      } catch (e) {
        // Ignore transient move errors
      }
    });

    bot.on("chat", (username: string, message: string) => {
      if (username === bot.username) return;
      log(`[CHAT] <${username}> ${message}`);
    });

    bot.on("error", (err: any) => {
      log(`[ERROR] ${err.message}`);
      console.error(err);
      if (err.name === 'PartialReadError') {
        log("[SYSTEM] Protocol error detected. Reconnecting...");
        bot.end();
      }
    });
    
    bot.on("kicked", (reason: string) => {
      const reasonText = typeof reason === 'object' ? JSON.stringify(reason) : reason;
      log(`[KICKED] Reason: ${reasonText}`);
      botStatus.connected = false;
      if (bot) {
        try {
          if (bot.pvp) bot.pvp.stop();
          if (bot.pathfinder) bot.pathfinder.setGoal(null);
        } catch (e) {}
      }
    });
    
    bot.on("end", () => {
      log("[DISCONNECTED] Connection lost. Reconnecting in 10s...");
      botStatus.connected = false;
      if (bot) {
        try {
          if (bot.pvp) bot.pvp.stop();
          if (bot.pathfinder) bot.pathfinder.setGoal(null);
          bot.removeAllListeners();
        } catch (e) {}
      }
      clearBotIntervals();
      reconnectTimeout = setTimeout(startBot, 10000);
    });
  } catch (err) {
    log(`Failed to initialize bot: ${err}`);
    console.error(err);
  } finally {
    isStarting = false;
  }
}

async function startServer() {
  // API Routes and Middleware FIRST
  app.use(express.json());

  app.get("/api/status", (req, res) => {
    res.json({
      ...botStatus,
      config: BOT_CONFIG
    });
  });

  app.post("/api/config", (req, res) => {
    const { host, port, username, version } = req.body;
    
    if (!host || !port || !username) {
      return res.status(400).json({ error: "Missing required fields" });
    }

    BOT_CONFIG = {
      host,
      port: parseInt(port),
      username,
      version: version || "1.20.1"
    };

    log(`[SYSTEM] Configuration updated.`);
    res.json({ success: true, config: BOT_CONFIG });
  });

  app.post("/api/control", (req, res) => {
    const { action } = req.body;
    
    if (action === "start") {
      if (botStatus.connected) return res.status(400).json({ error: "Bot already connected" });
      startBot();
      log("[SYSTEM] Start command received.");
    } else if (action === "stop") {
      if (reconnectTimeout) {
        clearTimeout(reconnectTimeout);
        reconnectTimeout = null;
      }
      if (bot) {
        try {
          if (bot.pvp) bot.pvp.stop();
          if (bot.pathfinder) bot.pathfinder.setGoal(null);
        } catch (e) {}
        bot.end();
        bot = null;
      }
      botStatus.connected = false;
      log("[SYSTEM] Stop command received.");
    } else if (action === "restart") {
      log("[SYSTEM] Restart command received.");
      startBot();
    } else {
      return res.status(400).json({ error: "Invalid action" });
    }
    
    res.json({ success: true });
  });

  app.post("/api/chat", (req, res) => {
    const { message } = req.body;
    if (!message) return res.status(400).json({ error: "Message required" });
    
    if (!bot || !botStatus.connected) {
      return res.status(400).json({ error: "Bot not connected" });
    }

    try {
      bot.chat(message);
      log(`[OUTGOING] ${message}`);
      res.json({ success: true });
    } catch (e) {
      res.status(500).json({ error: "Failed to send message" });
    }
  });

  // Vite middleware for development
  if (process.env.NODE_ENV !== "production") {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), "dist");
    app.use(express.static(distPath));
    app.get("*", (req, res) => {
      res.sendFile(path.join(distPath, "index.html"));
    });
  }

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`Server running on http://localhost:${PORT}`);

    // Start Cloudflare Tunnel
    const tunnel = spawn("npx", ["-y", "cloudflared", "tunnel", "--url", `http://localhost:${PORT}`, "--no-autoupdate"]);
    
    const handleData = (data: Buffer) => {
      const output = data.toString();
      const match = output.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/);
      if (match) {
        log(`[SYSTEM] Cloudflare Tunnel URL: ${match[0]}`);
        console.log(`\n\n!!! CLOUDFLARE TUNNEL URL: ${match[0]} !!!\n\n`);
      }
    };

    tunnel.stdout.on("data", handleData);
    tunnel.stderr.on("data", handleData);

    tunnel.on("error", (err) => {
      console.error("Failed to start Cloudflare tunnel:", err);
    });

    // Start bot after server is up with a small delay
    setTimeout(() => {
      startBot().catch(err => console.error("Bot start error:", err));
    }, 2000);
  });
}

process.on('uncaughtException', (err) => {
  console.error('Uncaught Exception:', err);
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('Unhandled Rejection at:', promise, 'reason:', reason);
});

startServer();
