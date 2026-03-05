const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const admin = require("firebase-admin");
const cors = require("cors");
const { verifyToken } = require("./middleware/authMiddleware");

// ─── Firebase Admin Init ───────────────────────────────────────────────────────
const serviceAccount = process.env.FIREBASE_SERVICE_ACCOUNT
  ? JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT)
  : require("./serviceAccountKey.json");
admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
const db = admin.firestore();

// ─── Express + Socket.IO Setup ────────────────────────────────────────────────
const app = express();
app.use(cors());
const httpServer = http.createServer(app);
const io = new Server(httpServer, {
  cors: { origin: "*", methods: ["GET", "POST"] },
});

// ─── Routes ───────────────────────────────────────────────────────────────────
app.get("/", (req, res) => {
  res.json({
    message: "🚀 Comet Chat Server is running",
    status: "online",
    timestamp: new Date().toISOString(),
  });
});

// ─── In-memory online users ────────────────────────────────────────────────────
// { socketId: { uid, name, photoUrl, email } }
const onlineUsers = new Map();

// ─── Helper: broadcast updated user list ──────────────────────────────────────
function broadcastUserList() {
  const users = Array.from(onlineUsers.values());
  io.emit("users_list", users);
}

// ─── Socket Events ────────────────────────────────────────────────────────────
io.on("connection", (socket) => {
  console.log("Socket connected:", socket.id);

  // 1️⃣ AUTH — verify Firebase token
  socket.on("auth", async ({ idToken }) => {
    const user = await verifyToken(idToken);
    if (!user) {
      socket.emit("auth_error", "Invalid token");
      socket.disconnect();
      return;
    }

    // Attach user info to socket
    socket.user = {
      uid: user.uid,
      name: user.name || "Unknown",
      email: user.email,
      photoUrl: user.picture || "",
    };

    onlineUsers.set(socket.id, socket.user);
    socket.emit("auth_success", socket.user);
    broadcastUserList(); // notify all clients
    console.log(`✅ Authenticated: ${socket.user.name}`);
  });

  // 2️⃣ JOIN ROOM — for 1:1 chat
  socket.on("join_room", (roomId) => {
    socket.join(roomId);
    console.log(`${socket.user?.name} joined room: ${roomId}`);
  });

  // 3️⃣ SEND MESSAGE
  socket.on("send_message", async ({ roomId, text }) => {
    if (!socket.user) return;

    const message = {
      text,
      senderId: socket.user.uid,
      senderName: socket.user.name,
      timestamp: new Date().toISOString(),
      read: false,
    };

    // Relay to room (real-time)
    io.to(roomId).emit("receive_message", message);

    // Persist to Firestore
    try {
      await db
        .collection("chats")
        .doc(roomId)
        .collection("messages")
        .add(message);
    } catch (e) {
      console.error("Firestore save error:", e);
    }
  });

  // 4️⃣ TYPING INDICATOR
  socket.on("typing", ({ roomId, isTyping }) => {
    socket.to(roomId).emit("user_typing", {
      uid: socket.user?.uid,
      name: socket.user?.name,
      isTyping,
    });
  });

  // 5️⃣ DISCONNECT
  socket.on("disconnect", () => {
    if (socket.user) {
      console.log(`❌ Disconnected: ${socket.user.name}`);
    }
    onlineUsers.delete(socket.id);
    broadcastUserList();
  });
});

// ─── Start Server ─────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
httpServer.listen(PORT, () => {
  console.log(`🚀 Server running on http://localhost:${PORT}`);
});
