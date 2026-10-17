// 시안 전용 가짜 데이터. 실제 계정·대화와 무관하다.
window.MOCK = {
  rooms: [
    { id: 'minji', name: '김민지', preview: '사진 잘 받았어! 내일 봐', time: '오후 6:42', unread: 0, pinned: true, kind: 'direct', color: '#f2a65a' },
    { id: 'family', name: '우리 가족', preview: '엄마: 저녁 먹고 들어와~', time: '오후 6:30', unread: 3, pinned: true, kind: 'group', members: 4, color: '#7bb07a' },
    { id: 'office', name: '회사 동기들', preview: '이번 주 금요일 회식 장소 투표해 주세요', time: '오후 5:58', unread: 12, kind: 'group', members: 9, color: '#6f8fe0' },
    { id: 'study', name: '프론트엔드 스터디', preview: '다음 주 발표 순서 공유합니다', time: '오후 4:10', unread: 0, kind: 'open', members: 87, color: '#b58ad8' },
    { id: 'seojun', name: '박서준', preview: 'ㅋㅋㅋ 그거 진짜 웃기다', time: '오후 2:21', unread: 1, kind: 'direct', color: '#e57d8a' },
    { id: 'memo', name: '나와의 채팅', preview: '장보기: 우유, 계란, 두부', time: '오전 11:05', unread: 0, kind: 'memo', color: '#8fa3b3' },
    { id: 'club', name: '사진 동아리 공지', preview: '10월 출사 일정 안내', time: '어제', unread: 0, kind: 'group', members: 32, color: '#4fb3a9' },
    { id: 'doyun', name: '이도윤', preview: '자료 메일로 보냈어요', time: '10월 15일', unread: 0, kind: 'direct', color: '#d9a441' }
  ],
  messages: {
    minji: [
      { day: '2026년 10월 17일 토요일' },
      { from: '김민지', text: '오늘 전시 어땠어?', time: '오후 6:20' },
      { from: '김민지', text: '나 다음 주에 가보려고 하는데 사람 많았는지 궁금해', time: '오후 6:20' },
      { mine: true, text: '생각보다 한산했어. 평일 오후면 더 여유로울 듯', time: '오후 6:31', read: 0 },
      { mine: true, photo: true, time: '오후 6:32', read: 0 },
      { from: '김민지', quote: { author: '나', text: '생각보다 한산했어. 평일 오후면 더 여유로울 듯' }, text: '오 그럼 수요일에 가야겠다', time: '오후 6:40' },
      { from: '김민지', text: '사진 잘 받았어! 내일 봐', time: '오후 6:42' },
      { mine: true, text: '응 내일 2시에 역 앞에서 만나자', time: '오후 6:44', read: 1 }
    ],
    study: [
      { day: '2026년 10월 17일 토요일' },
      { from: '운영진', text: '다음 주 발표 순서 공유합니다\n1. 상태 관리\n2. 접근성\n3. 성능 측정', time: '오후 4:10' }
    ]
  },
  fallback: [
    { day: '2026년 10월 17일 토요일' },
    { from: '상대방', text: '불러온 메시지가 여기에 표시됩니다.', time: '오후 1:00' },
    { mine: true, text: '시안 화면이라 예시 메시지만 있어요.', time: '오후 1:01', read: 0 }
  ]
};
MOCK.history = id => MOCK.messages[id] || MOCK.fallback;
MOCK.initial = name => name.replace(/^(나와의 )/, '').slice(0, 1);
MOCK.esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
// 방 목록 필터·검색 (세 시안 공통)
MOCK.filter = (mode, q) => MOCK.rooms.filter(r =>
  (mode === 'all' || (mode === 'unread' && r.unread) || (mode === 'pinned' && r.pinned)) &&
  r.name.toLowerCase().includes(q.trim().toLowerCase()));
MOCK.subtitle = r => r.kind === 'open' ? `오픈채팅 · ${r.members}명 · 읽기 전용`
  : r.kind === 'group' ? `${r.members}명` : r.kind === 'memo' ? '나만 보는 방' : '1:1 대화';
