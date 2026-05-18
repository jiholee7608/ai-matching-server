export async function analyzeEmotion(text) {
  const cleanText = text.replace(/\s/g, "").toLowerCase();
//임시로 만듦 나중에 바꿀 것
  const emotionKeywords = {
    anxious: ["불안", "걱정", "초조", "두려", "무섭", "압박", "긴장", "떨려"],
    sad: ["슬퍼", "우울", "힘들", "눈물", "속상", "허무", "지쳤", "괴로"],
    angry: ["화나", "짜증", "억울", "분노", "열받", "빡쳐", "싫어"],
    lonely: ["외로", "혼자", "고립", "소외", "쓸쓸", "아무도"],
    happy: ["기뻐", "좋아", "행복", "뿌듯", "설레", "감사", "신나"],
  };

  const tagKeywords = {
    진로: ["진로", "미래", "꿈", "방향"],
    취업: ["취업", "면접", "자소서", "스펙", "회사", "직장"],
    학교: ["학교", "수업", "과제", "시험", "성적", "교수", "학점"],
    연애: ["연애", "여친", "남친", "썸", "이별", "짝사랑"],
    가족: ["가족", "엄마", "아빠", "부모", "형", "누나", "동생"],
    친구: ["친구", "친한", "관계", "손절", "무리"],
    자존감: ["자존감", "자신감", "비교", "열등감", "못난"],
    스트레스: ["스트레스", "압박", "부담", "피곤", "번아웃"],
    외로움: ["외로", "혼자", "쓸쓸", "고립"],
    불안: ["불안", "걱정", "초조", "두려"],
    기쁜일: ["기뻐", "행복", "좋은일", "합격", "성공", "뿌듯"],
  };

  let emotionScores = {
    anxious: 0,
    sad: 0,
    angry: 0,
    lonely: 0,
    happy: 0,
    neutral: 0,
  };

  for (const [emotion, keywords] of Object.entries(emotionKeywords)) {
    for (const keyword of keywords) {
      if (cleanText.includes(keyword)) {
        emotionScores[emotion] += 1;
      }
    }
  }

  let emotion = "neutral";
  let maxScore = 0;

  for (const [key, score] of Object.entries(emotionScores)) {
    if (score > maxScore) {
      maxScore = score;
      emotion = key;
    }
  }

  const tags = [];

  for (const [tag, keywords] of Object.entries(tagKeywords)) {
    for (const keyword of keywords) {
      if (cleanText.includes(keyword)) {
        tags.push(tag);
        break;
      }
    }
  }

  if (tags.length === 0) {
    tags.push("고민상담");
  }

  const intensity = calculateIntensity(maxScore, text);

  return {
    emotion,
    intensity,
    tags: [...new Set(tags)].slice(0, 5),
    summary: createSummary(emotion, tags),
  };
}

function calculateIntensity(score, text) {
  let intensity = 40;

  intensity += score * 15;

  if (text.includes("너무")) intensity += 10;
  if (text.includes("진짜")) intensity += 10;
  if (text.includes("많이")) intensity += 5;

  if (intensity > 100) {
    intensity = 100;
  }

  return intensity;
}

function createSummary(emotion, tags) {
  const emotionText = {
    anxious: "불안감을 느끼고 있음",
    sad: "슬픔이나 우울감을 느끼고 있음",
    angry: "분노나 억울함을 느끼고 있음",
    lonely: "외로움이나 소외감을 느끼고 있음",
    happy: "기쁘거나 긍정적인 감정을 느끼고 있음",
    neutral: "뚜렷한 감정보다는 일반적인 고민을 표현하고 있음",
  };

  return `${tags.join(", ")} 관련 고민이며, ${emotionText[emotion]}`;
}