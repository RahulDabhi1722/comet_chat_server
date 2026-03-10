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
  pingTimeout: 60000,
  pingInterval: 25000,
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
      console.log(`❌ Authentication failed for socket: ${socket.id}`);
      socket.emit("auth_error", "Invalid token");
      socket.disconnect();
      return;
    }

    // 1. Fetch existing profile for 'about' field
    let about = "Available";
    try {
      const userDoc = await db.collection("users").doc(user.uid).get();
      if (userDoc.exists) {
        about = userDoc.data().about || "Available";
      }
    } catch (e) {
      console.error(`❌ Error fetching profile for ${user.uid}:`, e.message);
    }

    // 2. Sync basic profile info to Firestore (name, email, photo)
    const displayName = user.name || user.email?.split("@")[0] || "User";
    try {
      await db.collection("users").doc(user.uid).set({
        uid: user.uid,
        name: displayName,
        email: user.email || "",
        photoUrl: user.picture || "",
      }, { merge: true });
    } catch (e) {
      console.error(`❌ Error syncing profile for ${user.uid}:`, e.message);
    }

    // Attach user info to socket
    socket.user = {
      uid: user.uid,
      name: displayName,
      email: user.email || "",
      photoUrl: user.picture || "",
      about: about,
    };

    // 6️⃣ RECENT CHATS — fetch from Firestore
    try {
      console.log(`🔍 Fetching recent chats for UID: ${user.uid}`);
      const recentChatsSnap = await db
        .collection("users")
        .doc(user.uid)
        .collection("recent_chats")
        .orderBy("timestamp", "desc")
        .get();
      
      const recentChats = recentChatsSnap.docs.map(doc => doc.data());
      socket.emit("recent_chats", recentChats);
      console.log(`✅ Emitted ${recentChats.length} recent chats for ${user.uid}`);
    } catch (e) {
      console.error(`❌ Error fetching recent chats for ${user.uid}:`, e);
    }

    onlineUsers.set(socket.id, socket.user);
    socket.emit("auth_success", socket.user);
    broadcastUserList();
    console.log(`✅ Authenticated [${socket.id}]: ${socket.user.name} (${about})`);
  });

  // 2️⃣ JOIN ROOM — for 1:1 chat
  socket.on("join_room", (roomId) => {
    socket.join(roomId);
    console.log(`${socket.user?.name} joined room: ${roomId}`);
    
    // Auto-fetch history when joining a room
    fetchChatHistory(socket, roomId);
  });

  // 3️⃣ SEND MESSAGE
  socket.on("send_message", async ({ roomId, text }) => {
    if (!socket.user) return;

    const timestamp = new Date().toISOString();
    const message = {
      text,
      senderId: socket.user.uid,
      senderName: socket.user.name,
      timestamp,
      read: false,
    };

    // Relay to room in real-time
    io.to(roomId).emit("receive_message", message);

    // Persist to Firestore (message)
    try {
      await db
        .collection("chats")
        .doc(roomId)
        .collection("messages")
        .add(message);
      
      // Update Recent Chats for both users
      const uids = roomId.split("_");
      const senderUid = socket.user.uid;
      const receiverUid = uids.find(id => id !== senderUid);

      if (receiverUid) {
        // Update sender's recent_chats list
        await updateRecentChat(senderUid, receiverUid, text, timestamp);
        // Update receiver's recent_chats list
        await updateRecentChat(receiverUid, senderUid, text, timestamp);
      }

    } catch (e) {
      console.error("Firestore save error:", e);
    }
  });

  // 4️⃣ FETCH HISTORY
  socket.on("get_chat_history", (roomId) => {
    fetchChatHistory(socket, roomId);
  });

  // Helper: Fetch history from Firestore
  async function fetchChatHistory(socket, roomId) {
    try {
      const messagesSnap = await db
        .collection("chats")
        .doc(roomId)
        .collection("messages")
        .orderBy("timestamp", "asc")
        .limit(50)
        .get();
      
      const history = messagesSnap.docs.map(doc => doc.data());
      socket.emit("chat_history", { roomId, messages: history });
    } catch (e) {
      console.error("Error fetching history:", e);
    }
  }

  // Helper: Update recent_chats collection
  async function updateRecentChat(ownerUid, otherUid, lastMsg, timestamp) {
    try {
      // Get other user's current profile info (name/photo)
      const otherUserRef = await db.collection("users").doc(otherUid).get();
      const otherData = otherUserRef.exists ? otherUserRef.data() : {};

      const fallbackName = otherData.email ? otherData.email.split("@")[0] : "User";

      await db.collection("users").doc(ownerUid).collection("recent_chats").doc(otherUid).set({
        otherUid,
        name: otherData.name || fallbackName,
        photoUrl: otherData.photoUrl || "",
        about: otherData.about || "Available",
        lastMessage: lastMsg,
        timestamp: timestamp,
      }, { merge: true });

      // If owner is online, push updated list
      const ownerSockets = Array.from(io.sockets.sockets.values()).filter(s => s.user && s.user.uid === ownerUid);
      for (const s of ownerSockets) {
        const recentSnap = await db.collection("users").doc(ownerUid).collection("recent_chats").orderBy("timestamp", "desc").get();
        s.emit("recent_chats", recentSnap.docs.map(doc => doc.data()));
      }
    } catch (e) {
      console.error("Error updating recent chat:", e);
    }
  }

  // 5️⃣ TYPING INDICATOR
  socket.on("typing", ({ roomId, isTyping }) => {
    socket.to(roomId).emit("user_typing", {
      uid: socket.user?.uid,
      name: socket.user?.name,
      isTyping,
    });
  });

  // DISCONNECT
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
httpServer.listen(PORT, "0.0.0.0", () => {
  console.log(`🚀 Server running on port ${PORT} (all interfaces)`);
});
