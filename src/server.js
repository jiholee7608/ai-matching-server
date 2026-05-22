require("dotenv").config();
const express = require("express");
const http = require("http");
const cors = require("cors");
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);
const PORT = process.env.PORT || 4000;

app.use(cors({ origin: "*" }));
app.use(express.json());

const io = new Server(server, {
  cors: { origin: "*", methods: ["GET", "POST"] },
});

let openai = null;
if (process.env.OPENAI_API_KEY) {
  const OpenAI = require("openai");
  openai = new (OpenAI.default || OpenAI)({ apiKey: process.env.OPENAI_API_KEY });
  console.log("OpenAI API 연결 준비 완료");
}

const waitingUsers = [];
const rooms = new Map();

io.on("connection", (socket) => {
  console.log("사용자 접속:", socket.id);

  socket.on("join_queue", async (payload) => {
    try {
      const currentUser = {
        socketId: socket.id,
        nickname: payload?.nickname || "익명",
        text: payload?.text || "",
        tags: Array.isArray(payload?.tags) ? payload.tags : [],
        joinedAt: Date.now(),
      };

      if (!currentUser.text.trim()) {
        socket.emit("queue_error", { message: "고민 내용을 입력해주세요." });
        return;
      }

      console.log("매칭 대기 요청:", currentUser.nickname);

      // 단순 매칭 로직: 대기열에 누가 있으면 무조건 매칭!
      if (waitingUsers.length > 0) {
        const matchedUser = waitingUsers.shift();
        const roomId = `room_${Date.now()}`;

        socket.join(roomId);
        const matchedSocket = io.sockets.sockets.get(matchedUser.socketId);
        if (matchedSocket) matchedSocket.join(roomId);

        const roomInfo = {
          roomId: roomId,
          users: [
            { socketId: currentUser.socketId, nickname: currentUser.nickname },
            { socketId: matchedUser.socketId, nickname: matchedUser.nickname }
          ]
        };

        rooms.set(roomId, roomInfo);

        // ★ 프론트엔드의 방어막을 통과할 수 있게 { room: roomInfo } 형태로 전송
        io.to(roomId).emit("matched", { message: "매칭이 완료되었습니다.", room: roomInfo });
        console.log("매칭 완료! 방 번호:", roomId);
      } else {
        waitingUsers.push(currentUser);
        socket.emit("waiting", { message: "상대방을 기다리는 중입니다." });
      }
    } catch (error) {
      console.error("join_queue 오류:", error);
    }
  });

  socket.on("join_room", (payload) => {
    if (payload?.roomId) socket.join(payload.roomId);
  });

  // ★ 채팅 중복 해결의 핵심: 서버는 방 안의 '모든 사람(나 포함)'에게 딱 1번만 쏩니다!
  socket.on("send_message", (payload) => {
    const { roomId, nickname, message } = payload;
    io.to(roomId).emit("receive_message", { 
      roomId, nickname, message, sentAt: new Date().toISOString() 
    });
  });

  socket.on("disconnect", () => {
    const index = waitingUsers.findIndex((user) => user.socketId === socket.id);
    if (index !== -1) waitingUsers.splice(index, 1);
  });
});

server.listen(PORT, () => console.log(`서버 실행 중: http://localhost:${PORT}`));
