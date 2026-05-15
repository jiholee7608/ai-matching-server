import express from "express";
import http from "http";
import cors from "cors";
import dotenv from "dotenv";
import { Server } from "socket.io";
import crypto from "crypto";
import { analyzeEmotion } from "./openaiEmotion.js";

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json());

const server = http.createServer(app);

const io = new Server(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"],
  },
});

// 매칭 대기열
let waitingQueue = [];

// 현재 만들어진 채팅방 목록
const activeRooms = new Map();

io.on("connection", (socket) => {
  console.log("사용자 연결:", socket.id);

  socket.emit("connected", {
    message: "서버에 연결되었습니다.",
    socketId: socket.id,
  });

  // 매칭 요청
  socket.on("matching:request", async (data) => {
    try {
      const nickname = data.nickname || "익명";
      const text = data.text;

      if (!text || text.trim().length < 2) {
        socket.emit("matching:error", {
          message: "고민 내용을 입력해주세요.",
        });
        return;
      }

      console.log(`${nickname} 매칭 요청:`, text);

      // 감정 분석
      const aiResult = await analyzeEmotion(text);

      const requester = {
        userId: socket.id,
        nickname,
        socketId: socket.id,
        text,
        emotion: aiResult.emotion,
        intensity: aiResult.intensity,
        tags: aiResult.tags,
        summary: aiResult.summary,
        createdAt: Date.now(),
      };

      // 같은 사용자가 중복으로 대기열에 들어가는 것 방지
      removeFromQueue(socket.id);

      // 대기열에서 가장 잘 맞는 사람 찾기
      const matchedUser = findBestMatch(requester);

      // 맞는 사람이 없으면 대기열에 넣기
      if (!matchedUser) {
        waitingQueue.push(requester);

        socket.emit("matching:waiting", {
          message: "감정 분석 후 매칭 대기 중입니다.",
          aiResult,
        });

        console.log("현재 대기열:", waitingQueue);
        return;
      }

      // 맞는 사람이 있으면 대기열에서 제거
      removeFromQueue(matchedUser.userId);

      // 채팅방 생성
      const roomId = createRoomId();

      socket.join(roomId);

      const matchedSocket = io.sockets.sockets.get(matchedUser.socketId);

      if (!matchedSocket) {
        socket.emit("matching:error", {
          message: "상대방 연결이 끊어졌습니다.",
        });
        return;
      }

      matchedSocket.join(roomId);

      const roomData = {
        roomId,
        users: [
          {
            userId: requester.userId,
            nickname: requester.nickname,
            emotion: requester.emotion,
            tags: requester.tags,
          },
          {
            userId: matchedUser.userId,
            nickname: matchedUser.nickname,
            emotion: matchedUser.emotion,
            tags: matchedUser.tags,
          },
        ],
        createdAt: Date.now(),
      };

      activeRooms.set(roomId, roomData);

      io.to(roomId).emit("matching:success", {
        message: "감정과 고민 주제가 비슷한 상대와 매칭되었습니다.",
        roomId,
        users: roomData.users,
      });

      console.log("매칭 성공:", roomData);
    } catch (error) {
      console.error("매칭 오류:", error);

      socket.emit("matching:error", {
        message: "매칭 중 오류가 발생했습니다.",
      });
    }
  });

  // 채팅 메시지
  socket.on("chat:message", (data) => {
    const { roomId, nickname, message } = data;

    if (!roomId || !message) {
      socket.emit("chat:error", {
        message: "roomId와 message가 필요합니다.",
      });
      return;
    }

    io.to(roomId).emit("chat:message", {
      roomId,
      senderId: socket.id,
      nickname: nickname || "익명",
      message,
      createdAt: new Date().toISOString(),
    });
  });

  // 매칭 취소
  socket.on("matching:cancel", () => {
    removeFromQueue(socket.id);

    socket.emit("matching:cancelled", {
      message: "매칭이 취소되었습니다.",
    });
  });

  // 연결 종료
  socket.on("disconnect", () => {
    console.log("사용자 연결 종료:", socket.id);

    removeFromQueue(socket.id);

    for (const [roomId, room] of activeRooms.entries()) {
      const isUserInRoom = room.users.some((user) => user.userId === socket.id);

      if (isUserInRoom) {
        io.to(roomId).emit("chat:system", {
          message: "상대방 연결이 끊어졌습니다.",
        });

        activeRooms.delete(roomId);
      }
    }
  });
});

// 가장 잘 맞는 사용자 찾기
function findBestMatch(requester) {
  let bestUser = null;
  let bestScore = 0;

  for (const candidate of waitingQueue) {
    if (candidate.userId === requester.userId) continue;

    const score = calculateMatchScore(requester, candidate);

    console.log("매칭 점수:", {
      requester: requester.nickname,
      candidate: candidate.nickname,
      score,
    });

    if (score > bestScore) {
      bestScore = score;
      bestUser = candidate;
    }
  }

  // 45점 이상일 때만 매칭
  if (bestScore < 45) {
    return null;
  }

  return bestUser;
}

// 매칭 점수 계산
function calculateMatchScore(userA, userB) {
  const tagsA = new Set(userA.tags);
  const tagsB = new Set(userB.tags);

  let sameTagCount = 0;

  for (const tag of tagsA) {
    if (tagsB.has(tag)) {
      sameTagCount++;
    }
  }

  const maxTagCount = Math.max(tagsA.size, tagsB.size, 1);

  // 태그 유사도 최대 50점
  const tagScore = (sameTagCount / maxTagCount) * 50;

  // 감정이 같으면 30점
  const emotionScore = userA.emotion === userB.emotion ? 30 : 0;

  // 감정 강도가 비슷하면 최대 20점
  const intensityDiff = Math.abs(userA.intensity - userB.intensity);
  const intensityScore = Math.max(0, 20 - intensityDiff * 0.2);

  const totalScore = tagScore + emotionScore + intensityScore;

  return Math.round(totalScore);
}

// 대기열에서 사용자 제거
function removeFromQueue(userId) {
  waitingQueue = waitingQueue.filter((user) => user.userId !== userId);
}

// 채팅방 ID 생성
function createRoomId() {
  return `room_${crypto.randomUUID()}`;
}

app.get("/", (req, res) => {
  res.send("AI Matching Socket Server is running");
});

app.get("/health", (req, res) => {
  res.json({
    status: "ok",
    waitingCount: waitingQueue.length,
    activeRoomCount: activeRooms.size,
  });
});

const PORT = process.env.PORT || 4000;

server.listen(PORT, () => {
  console.log(`서버 실행 중: http://localhost:${PORT}`);
});