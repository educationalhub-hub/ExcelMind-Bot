// Quiz question bank — general knowledge, suitable for WhatsApp groups
export const QUIZ_QUESTIONS = [
  { question: 'What is the capital of Nigeria?', options: ['Lagos', 'Abuja', 'Kano', 'Ibadan'], correctIndex: 1 },
  { question: 'Who wrote "Things Fall Apart"?', options: ['Wole Soyinka', 'Chimamanda Adichie', 'Chinua Achebe', 'Ngugi wa Thiong\'o'], correctIndex: 2 },
  { question: 'What is 7 × 8?', options: ['54', '56', '64', '48'], correctIndex: 1 },
  { question: 'In what year did Nigeria gain independence?', options: ['1960', '1963', '1957', '1961'], correctIndex: 0 },
  { question: 'What is the chemical symbol for gold?', options: ['Go', 'Gd', 'Au', 'Ag'], correctIndex: 2 },
  { question: 'Which is the largest planet in the solar system?', options: ['Earth', 'Saturn', 'Jupiter', 'Neptune'], correctIndex: 2 },
  { question: 'What is the longest river in the world?', options: ['Amazon', 'Nile', 'Niger', 'Congo'], correctIndex: 1 },
  { question: 'Who was the first President of Nigeria?', options: ['Yakubu Gowon', 'Nnamdi Azikiwe', 'Olusegun Obasanjo', 'Abubakar Tafawa Balewa'], correctIndex: 1 },
  { question: 'What does "HTML" stand for?', options: ['Hyper Text Markup Language', 'High Tech Modern Language', 'Home Tool Markup Language', 'Hyperlink Text Mark Language'], correctIndex: 0 },
  { question: 'Which is the most populous country in Africa?', options: ['Ethiopia', 'Egypt', 'Nigeria', 'South Africa'], correctIndex: 2 },
  { question: 'What is the currency of Nigeria?', options: ['Cedi', 'Naira', 'Shilling', 'Rand'], correctIndex: 1 },
  { question: 'Which ocean borders Nigeria to the south?', options: ['Indian Ocean', 'Atlantic Ocean', 'Pacific Ocean', 'Arctic Ocean'], correctIndex: 1 },
];

const QUIZZES_BEFORE_RESULTS = 5;

export function getQuizQuestion(index) {
  return QUIZ_QUESTIONS[index % QUIZ_QUESTIONS.length];
}

export function createQuizState() {
  return {
    quizTime: '12:00',
    welcomeMessage: '👋 Welcome to the group! Please read the group rules and enjoy your stay. — *ExcelMind-Bot* 🤖',
    quizIndex: 0,
    quizzesSent: 0,
    activePolls: {}, // pollKey -> { groupJid, correctIndex, votes: { participantJid: [selectedIndexes] } }
    scores: {}, // groupJid -> { participantJid: { correct: number, total: number } }
  };
}

export { QUIZZES_BEFORE_RESULTS };
