require("dotenv").config();

const express = require("express");
const http = require("http");
const cors = require("cors");
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);

const PORT = process.env.PORT || 4000;

// -----------------------------
// 기본 미들웨어 설정
// -----------------------------
app.use(cors({
  origin: "*", // 모든 주소 허용
}));

app.use(express.json());

// -----------------------------
// Socket.io 서버 설정
// -----------------------------
const io = new Server(server, {
  cors: {
    origin: "*", // 소켓 통신도 무조건 허용
    methods: ["GET", "POST"]
  },
});

let openai = null;

if (process.env.OPENAI_API_KEY) {
  const OpenAI = require("openai");
  const OpenAIClient = OpenAI.default || OpenAI;
  openai = new OpenAIClient({ apiKey: process.env.OPENAI_API_KEY });
  console.log("OpenAI API 연결 준비 완료");
} else {
  console.log("OpenAI API 키 없음 → 키워드 기반 감정 분석 사용");
}

const waitingUsers = [];
const rooms = new Map();

app.get("/", (req, res) => res.send("AI Matching Socket Server is running"));
app.get("/health", (req, res) => res.json({ ok: true, waitingUserCount: waitingUsers.length, roomCount: rooms.size }));

// -----------------------------
// Socket.io 연결 처리
// -----------------------------
io.on("connection", (socket) => {
  console.log("사용자 접속:", socket.id);

  // 사용자가 매칭 대기열에 들어올 때
  socket.on("join_queue", async (payload) => {
    try {
      const nickname = payload?.nickname || "익명";
      const text = payload?.text || "";
      const tags = Array.isArray(payload?.tags) ? payload.tags : [];

      if (!text.trim()) {
        socket.emit("queue_error", { message: "감정이나 고민 내용을 입력해주세요." });
        return;
      }

      const emotionData = await analyzeEmotion(text);

      const currentUser = {
        socketId: socket.id,
        nickname,
        text,
        tags,
        emotion: emotionData.emotion,
        intensity: emotionData.intensity,
        topic: emotionData.topic,
        confidence: emotionData.confidence ?? 0.7,
        joinedAt: Date.now(),
      };

      const validation = validateMatchingRequest(currentUser);

      if (!validation.ok) {
        socket.emit("queue_error", { message: validation.message, analysis: { emotion: currentUser.emotion, intensity: currentUser.intensity, topic: currentUser.topic } });
        console.log("매칭 요청 거절:", validation.reason, currentUser);
        return;
      }

      console.log("매칭 대기 요청:", currentUser);
      const matchedUser = findBestMatch(currentUser);

      if (matchedUser) {
        removeWaitingUser(matchedUser.socketId);
        const roomId = createRoomId();

        socket.join(roomId);

        const matchedSocket = io.sockets.sockets.get(matchedUser.socketId);
        if (matchedSocket) matchedSocket.join(roomId);

        const roomInfo = {
          roomId,
          users: [
            { socketId: currentUser.socketId, nickname: currentUser.nickname, emotion: currentUser.emotion, topic: currentUser.topic },
            { socketId: matchedUser.socketId, nickname: matchedUser.nickname, emotion: matchedUser.emotion, topic: matchedUser.topic },
          ],
          createdAt: Date.now(),
        };

        rooms.set(roomId, roomInfo);

        io.to(roomId).emit("matched", { message: "매칭이 완료되었습니다.", room: roomInfo });
        console.log("매칭 완료:", roomInfo);
      } else {
        waitingUsers.push(currentUser);
        socket.emit("waiting", { message: "비슷한 감정의 사용자를 기다리는 중입니다.", user: { nickname: currentUser.nickname, emotion: currentUser.emotion, intensity: currentUser.intensity, topic: currentUser.topic } });
        console.log("대기열 추가:", waitingUsers.length);
      }
    } catch (error) {
      console.error("join_queue 오류:", error);
      socket.emit("queue_error", { message: "매칭 처리 중 오류가 발생했습니다." });
    }
  });

  // ★ 추가: 방 재입장
  socket.on("join_room", (payload) => {
    if (payload && payload.roomId) {
      socket.join(payload.roomId);
      console.log(`사용자 방 재입장 완료: ${payload.roomId} (소켓: ${socket.id})`);
    }
  });

  // ★ 수정: 채팅 메시지 전송 (나를 포함한 방 안의 모두에게 1번만 쏜다)
  socket.on("send_message", (payload) => {
    const { roomId, message, nickname } = payload || {};

    if (!roomId || !message) {
      socket.emit("chat_error", { message: "roomId와 message가 필요합니다." });
      return;
    }

    const chatMessage = {
      roomId,
      nickname: nickname || "익명",
      message,
      sentAt: new Date().toISOString(),
    };

    io.to(roomId).emit("receive_message", chatMessage);
  });

  socket.on("cancel_queue", () => {
    removeWaitingUser(socket.id);
    socket.emit("queue_cancelled", { message: "매칭 대기를 취소했습니다." });
    console.log("대기 취소:", socket.id);
  });

  socket.on("disconnect", () => {
    console.log("사용자 연결 종료:", socket.id);
    removeWaitingUser(socket.id);

    for (const [roomId, roomInfo] of rooms.entries()) {
      const isInRoom = roomInfo.users.some((user) => user.socketId === socket.id);
      if (isInRoom) {
        io.to(roomId).emit("partner_disconnected", { message: "상대방이 연결을 종료했습니다." });
        rooms.delete(roomId);
      }
    }
  });
});

async function analyzeEmotion(text) {
  if (openai) {
    try {
      const response = await openai.chat.completions.create({
        model: "gpt-4o-mini",
        messages: [
          { role: "system", content: "너는 사용자의 감정 상태를 분석하는 도우미다. 반드시 JSON만 출력해라. 형식: { \"emotion\": \"기쁨 | 슬픔 | 분노 | 불안 | 외로움 | 스트레스 | 평온 | 기타\", \"intensity\": 1부터 10 사이 숫자, \"topic\": \"연애 | 가족 | 학교 | 취업 | 친구 | 건강 | 일상 | 기타\" }" },
          { role: "user", content: text },
        ],
        temperature: 0.2,
      });
      const parsed = JSON.parse(response.choices[0].message.content);
      return { emotion: parsed.emotion || "기타", intensity: Number(parsed.intensity) || 5, topic: parsed.topic || "기타" };
    } catch (error) {
      return keywordEmotionAnalysis(text);
    }
  }
  return keywordEmotionAnalysis(text);
}

function keywordEmotionAnalysis(text) {
  const lowerText = text.toLowerCase();
  const emotionKeywords = {
    기쁨: ["기쁘", "행복", "좋아", "신나", "설레", "웃", "재밌", "기분 좋"],
    슬픔: ["슬프", "눈물", "우울", "힘들", "괴로", "상처", "무기력"],
    분노: ["화나", "짜증", "열받", "빡", "분노", "억울"],
    불안: ["불안", "걱정", "무서", "두려", "초조", "긴장"],
    외로움: ["외롭", "혼자", "쓸쓸", "고독"],
    스트레스: ["스트레스", "압박", "지침", "피곤", "번아웃"],
    평온: ["괜찮", "편안", "평온", "차분"],
  };
  const topicKeywords = {
    연애: ["연애", "남친", "여친", "헤어", "이별", "썸", "고백", "짝사랑"],
    가족: ["가족", "엄마", "아빠", "부모", "형", "누나", "동생"],
    학교: ["학교", "과제", "시험", "교수", "수업", "학점"],
    취업: ["취업", "면접", "회사", "직장", "알바", "진로"],
    친구: ["친구", "우정", "배신", "관계"],
    건강: ["건강", "아파", "병원", "운동", "잠"],
  };

  const emotionScores = {};
  for (const [emotion, keywords] of Object.entries(emotionKeywords)) {
    emotionScores[emotion] = 0;
    for (const keyword of keywords) {
      if (lowerText.includes(keyword)) emotionScores[emotion] += 1;
    }
  }

  const negativePriority = ["불안", "슬픔", "외로움", "스트레스", "분노"];
  for (const emotion of negativePriority) {
    if (emotionScores[emotion] > 0) {
      let detectedTopic = "기타";
      for (const [topic, keywords] of Object.entries(topicKeywords)) {
        if (keywords.some((k) => lowerText.includes(k))) { detectedTopic = topic; break; }
      }
      return { emotion, intensity: estimateIntensity(text), topic: detectedTopic, confidence: 0.8 };
    }
  }

  let detectedEmotion = emotionScores["기쁨"] > 0 ? "기쁨" : (emotionScores["평온"] > 0 ? "평온" : "기타");
  let detectedTopic = "기타";
  for (const [topic, keywords] of Object.entries(topicKeywords)) {
    if (keywords.some((k) => lowerText.includes(k))) { detectedTopic = topic; break; }
  }

  return { emotion: detectedEmotion, intensity: estimateIntensity(text), topic: detectedTopic, confidence: detectedEmotion === "기타" ? 0.3 : 0.7 };
}

function estimateIntensity(text) {
  let intensity = 5;
  if (text.includes("너무") || text.includes("진짜") || text.includes("완전")) intensity += 2;
  if (text.includes("죽을") || text.includes("미치") || text.includes("최악")) intensity += 2;
  if (text.includes("조금") || text.includes("약간")) intensity -= 2;
  return Math.min(Math.max(intensity, 1), 10);
}

function getEmotionGroup(emotion) {
  const negativeEmotions = ["슬픔", "불안", "외로움", "스트레스"];
  const positiveEmotions = ["기쁨", "평온"];
  const angerEmotions = ["분노"];
  if (negativeEmotions.includes(emotion)) return "negative";
  if (positiveEmotions.includes(emotion)) return "positive";
  if (angerEmotions.includes(emotion)) return "anger";
  return "unknown";
}

function getEmotionGroupsFromTags(tags) {
  const groups = new Set();
  for (const tag of tags) {
    if (tag.includes("우울") || tag.includes("불안") || tag.includes("번아웃")) groups.add("negative");
  }
  return Array.from(groups);
}

function areEmotionGroupsCompatible(groupA, groupB) { return groupA === groupB; }

function validateMatchingRequest(user) {
  const textEmotionGroup = getEmotionGroup(user.emotion);
  const tagEmotionGroups = getEmotionGroupsFromTags(user.tags);

  if (textEmotionGroup === "positive") {
    return { ok: false, reason: "POSITIVE_EMOTION_NOT_COUNSELING_TARGET", message: `현재 작성한 내용은 "${user.emotion}" 감정에 가까워 보여요. 고민 내용을 조금 더 구체적으로 작성해주세요.` };
  }
  if (tagEmotionGroups.length === 0 || textEmotionGroup === "unknown") return { ok: true };

  const hasCompatibleTag = tagEmotionGroups.some((tagGroup) => areEmotionGroupsCompatible(tagGroup, textEmotionGroup));
  if (!hasCompatibleTag) {
    return { ok: false, reason: "TAG_TEXT_EMOTION_CONFLICT", message: `선택한 태그와 작성한 내용의 감정이 달라 보여요. 내용을 수정해주세요.` };
  }
  return { ok: true };
}

function isEmotionCompatible(userA, userB) {
  const groupA = getEmotionGroup(userA.emotion);
  const groupB = getEmotionGroup(userB.emotion);

  if (userA.emotion === userB.emotion) return true;
  if (groupA === "positive" || groupB === "positive") return groupA === groupB;
  if (groupA === "anger" || groupB === "anger") return groupA === groupB;
  if (groupA === "negative" && groupB === "negative") return true;
  if (groupA === "unknown" || groupB === "unknown") {
    return userA.tags.filter((tag) => userB.tags.includes(tag)).length > 0;
  }
  return false;
}

function findBestMatch(currentUser) {
  if (waitingUsers.length === 0) return null;
  let bestMatch = null;
  let bestScore = -1;

  for (const waitingUser of waitingUsers) {
    if (!isEmotionCompatible(currentUser, waitingUser)) continue;
    const score = calculateMatchScore(currentUser, waitingUser);
    if (score > bestScore) { bestScore = score; bestMatch = waitingUser; }
  }
  return bestScore < 60 ? null : bestMatch;
}

function calculateMatchScore(userA, userB) {
  let score = 0;
  if (userA.emotion === userB.emotion) score += 70;
  else if (getEmotionGroup(userA.emotion) === getEmotionGroup(userB.emotion)) score += 45;
  if (userA.topic === userB.topic) score += 20;

  const intensityDiff = Math.abs(userA.intensity - userB.intensity);
  if (intensityDiff <= 2) score += 10;
  else if (intensityDiff <= 4) score += 5;

  const commonTags = userA.tags.filter((tag) => userB.tags.includes(tag));
  score += Math.min(commonTags.length * 5, 10);
  return score;
}

function removeWaitingUser(socketId) {
  const index = waitingUsers.findIndex((user) => user.socketId === socketId);
  if (index !== -1) waitingUsers.splice(index, 1);
}

function createRoomId() { return `room_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`; }

server.listen(PORT, () => { console.log(`서버 실행 중: http://localhost:${PORT}`); });
