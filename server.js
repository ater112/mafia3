const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);

const io = new Server(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"],
    credentials: true
  }
});

app.use(express.static('public'));

const rooms = {};

function generateRoomCode() {
  return Math.random().toString(36).substring(2, 8).toUpperCase();
}

io.on('connection', (socket) => {
  let currentRoom = null;
  let userName = '';

  // 1. 방 만들기
  socket.on('createRoom', ({ nickname, settings }) => {
    const roomCode = generateRoomCode();
    currentRoom = roomCode;
    userName = nickname;

    socket.join(roomCode);

    rooms[roomCode] = {
      code: roomCode,
      host: socket.id,
      settings: {
        discussionTime: parseInt(settings.discussionTime) || 60,
        voteTime: parseInt(settings.voteTime) || 30,
        nightTime: parseInt(settings.nightTime) || 30,
        mafiaCount: parseInt(settings.mafiaCount) || 1,
        doctorCount: parseInt(settings.doctorCount) || 1,
        policeCount: parseInt(settings.policeCount) || 1
      },
      phase: 'lobby',
      timer: null,
      timeLeft: 0,
      players: {},
      actions: { mafiaTarget: null, doctorTarget: null },
      votes: {}
    };

    rooms[roomCode].players[socket.id] = {
      id: socket.id,
      name: nickname,
      role: null,
      alive: true
    };

    socket.emit('roomCreated', { roomCode, isHost: true });
    updateRoomState(roomCode);
    sendSysMsg(roomCode, `${nickname}님이 방을 생성하셨습니다.`);
  });

  // 2. 방 참가하기
  socket.on('joinRoom', ({ roomCode, nickname }) => {
    if (!roomCode) return socket.emit('errorMsg', '방 코드가 올바르지 않습니다.');
    
    const code = roomCode.toUpperCase();
    const room = rooms[code];

    // 방이 존재하지 않는 경우
    if (!room) {
      return socket.emit('errorMsg', '방 코드가 올바르지 않습니다.');
    }
    if (room.phase !== 'lobby') {
      return socket.emit('errorMsg', '이미 게임이 진행 중인 방입니다.');
    }

    currentRoom = code;
    userName = nickname;
    socket.join(code);

    room.players[socket.id] = {
      id: socket.id,
      name: nickname,
      role: null,
      alive: true
    };

    socket.emit('roomJoined', { roomCode: code, isHost: room.host === socket.id });
    updateRoomState(code);
    sendSysMsg(code, `${nickname}님이 참가하셨습니다.`);
  });

  // 3. 게임 시작
  socket.on('startGame', () => {
    const room = rooms[currentRoom];
    if (!room || room.host !== socket.id) return;

    const playerList = Object.values(room.players);
    const totalNeededRoles = room.settings.mafiaCount + room.settings.doctorCount + room.settings.policeCount;

    if (playerList.length <= totalNeededRoles) {
      return socket.emit('errorMsg', `특수 직업 합계(${totalNeededRoles}명)보다 전체 인원이 더 많아야 합니다 (최소 1명 이상의 시민 필요).`);
    }

    let roles = [];
    for (let i = 0; i < room.settings.mafiaCount; i++) roles.push('마피아');
    for (let i = 0; i < room.settings.doctorCount; i++) roles.push('의사');
    for (let i = 0; i < room.settings.policeCount; i++) roles.push('경찰');
    while (roles.length < playerList.length) roles.push('시민');

    roles.sort(() => Math.random() - 0.5);

    Object.keys(room.players).forEach((id, idx) => {
      room.players[id].role = roles[idx];
      room.players[id].alive = true;
      io.to(id).emit('assignedRole', roles[idx]);
    });

    startPhase(currentRoom, 'day');
  });

  // 4. 채팅
  socket.on('sendMessage', (text) => {
    if (!currentRoom || !rooms[currentRoom]) return;
    const room = rooms[currentRoom];
    const player = room.players[socket.id];

    if (player && !player.alive) {
      return socket.emit('chat', { sender: '시스템', text: '사망자는 채팅에 참여할 수 없습니다.' });
    }

    io.to(currentRoom).emit('chat', { sender: userName, text });
  });

  // 5. 밤 능력 사용
  socket.on('nightAction', ({ targetId }) => {
    const room = rooms[currentRoom];
    if (!room || room.phase !== 'night') return;
    const player = room.players[socket.id];
    if (!player || !player.alive) return;

    if (player.role === '마피아') {
      room.actions.mafiaTarget = targetId;
      socket.emit('sysMsg', '마피아 표적을 선택했습니다.');
    } else if (player.role === '의사') {
      room.actions.doctorTarget = targetId;
      socket.emit('sysMsg', '지목한 대상을 밤동안 보호합니다.');
    } else if (player.role === '경찰') {
      const target = room.players[targetId];
      if (target) {
        const isMafia = target.role === '마피아' ? '마피아입니다!' : '마피아가 아닙니다.';
        socket.emit('sysMsg', `[조사 결과] ${target.name}님은 ${isMafia}`);
      }
    }
  });

  // 6. 낮 투표
  socket.on('castVote', ({ targetId }) => {
    const room = rooms[currentRoom];
    if (!room || room.phase !== 'vote') return;
    const player = room.players[socket.id];
    if (!player || !player.alive) return;

    room.votes[socket.id] = targetId;
    socket.emit('sysMsg', '투표를 완료했습니다.');

    const aliveCount = Object.values(room.players).filter(p => p.alive).length;
    if (Object.keys(room.votes).length >= aliveCount) {
      processVoteResult(currentRoom);
    }
  });

  // 퇴장 처리
  socket.on('disconnect', () => {
    if (currentRoom && rooms[currentRoom]) {
      delete rooms[currentRoom].players[socket.id];
      if (Object.keys(rooms[currentRoom].players).length === 0) {
        clearInterval(rooms[currentRoom].timer);
        delete rooms[currentRoom];
      } else {
        updateRoomState(currentRoom);
        sendSysMsg(currentRoom, `${userName}님이 퇴장하셨습니다.`);
      }
    }
  });
});

function startPhase(roomCode, phase) {
  const room = rooms[roomCode];
  if (!room) return;

  clearInterval(room.timer);
  room.phase = phase;

  if (phase === 'day') {
    room.timeLeft = room.settings.discussionTime;
    sendSysMsg(roomCode, `☀️ 낮이 되었습니다. ${room.timeLeft}초간 자유롭게 토론하세요.`);
  } else if (phase === 'vote') {
    room.votes = {};
    room.timeLeft = room.settings.voteTime;
    sendSysMsg(roomCode, `⚖️ 투표 시간이 되었습니다! (${room.timeLeft}초) 의심스러운 사람에게 투표하세요.`);
  } else if (phase === 'night') {
    room.actions = { mafiaTarget: null, doctorTarget: null };
    room.timeLeft = room.settings.nightTime;
    sendSysMsg(roomCode, `🌙 밤이 되었습니다. (${room.timeLeft}초) 특수 직업군은 능력을 사용하세요.`);
  }

  updateRoomState(roomCode);

  room.timer = setInterval(() => {
    room.timeLeft--;
    io.to(roomCode).emit('timerUpdate', room.timeLeft);

    if (room.timeLeft <= 0) {
      clearInterval(room.timer);
      if (phase === 'day') startPhase(roomCode, 'vote');
      else if (phase === 'vote') processVoteResult(roomCode);
      else if (phase === 'night') processNightResult(roomCode);
    }
  }, 1000);
}

function processVoteResult(roomCode) {
  const room = rooms[roomCode];
  if (!room) return;
  clearInterval(room.timer);

  const voteCounts = {};
  Object.values(room.votes).forEach(targetId => {
    if (targetId) voteCounts[targetId] = (voteCounts[targetId] || 0) + 1;
  });

  let maxVotes = 0;
  let executedId = null;
  let isTie = false;

  Object.entries(voteCounts).forEach(([targetId, count]) => {
    if (count > maxVotes) {
      maxVotes = count;
      executedId = targetId;
      isTie = false;
    } else if (count === maxVotes) {
      isTie = true;
    }
  });

  if (executedId && !isTie) {
    const executedPlayer = room.players[executedId];
    executedPlayer.alive = false;
    sendSysMsg(roomCode, `⚖️ 투표 결과, ${executedPlayer.name}님이 처형되었습니다. (직업: ${executedPlayer.role})`);
  } else {
    sendSysMsg(roomCode, `⚖️ 동수 또는 기권으로 인해 아무도 처형되지 않았습니다.`);
  }

  if (checkVictory(roomCode)) return;
  startPhase(roomCode, 'night');
}

function processNightResult(roomCode) {
  const room = rooms[roomCode];
  if (!room) return;
  clearInterval(room.timer);

  const { mafiaTarget, doctorTarget } = room.actions;

  if (mafiaTarget) {
    if (mafiaTarget === doctorTarget) {
      sendSysMsg(roomCode, `🩺 의사의 헌신적인 치료로 밤새 아무도 희생되지 않았습니다!`);
    } else {
      const victim = room.players[mafiaTarget];
      if (victim) {
        victim.alive = false;
        sendSysMsg(roomCode, `💥 어둠 속에서 마피아의 공격으로 ${victim.name}님이 사망하셨습니다.`);
      }
    }
  } else {
    sendSysMsg(roomCode, `🌙 밤새 차가운 정적만 흘렀습니다. (사망자 없음)`);
  }

  if (checkVictory(roomCode)) return;
  startPhase(roomCode, 'day');
}

function checkVictory(roomCode) {
  const room = rooms[roomCode];
  const alivePlayers = Object.values(room.players).filter(p => p.alive);
  const mafiaCount = alivePlayers.filter(p => p.role === '마피아').length;
  const citizenCount = alivePlayers.length - mafiaCount;

  if (mafiaCount === 0) {
    sendSysMsg(roomCode, `🎉 모든 마피아가 소탕되었습니다! 시민 팀의 승리입니다!`);
    room.phase = 'ended';
    updateRoomState(roomCode);
    return true;
  } else if (mafiaCount >= citizenCount) {
    sendSysMsg(roomCode, `💀 마피아의 수가 시민과 같거나 많아졌습니다. 마피아 팀의 승리입니다!`);
    room.phase = 'ended';
    updateRoomState(roomCode);
    return true;
  }
  return false;
}

function updateRoomState(roomCode) {
  const room = rooms[roomCode];
  if (room) {
    io.to(roomCode).emit('roomStateUpdate', {
      phase: room.phase,
      settings: room.settings,
      players: Object.values(room.players),
      host: room.host
    });
  }
}

function sendSysMsg(roomCode, text) {
  io.to(roomCode).emit('chat', { sender: '시스템', text });
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`서버가 포트 ${PORT}에서 작동 중입니다.`);
});
