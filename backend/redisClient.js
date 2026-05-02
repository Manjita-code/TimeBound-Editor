const redis = require("redis");

const client = redis.createClient({
  socket: {
    reconnectStrategy: false
  }
});

client.on("error", (err) => {
  console.log("Redis Error:", err);
});

async function connectRedis() {
  if (!client.isOpen) {
    try {
      await client.connect();
      console.log("Connected to Redis ✅");
    } catch (err) {
      console.log("Redis unavailable, using in-memory fallback.");
    }
  }
}

connectRedis();

module.exports = client;
