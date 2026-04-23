const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const bcrypt = require('bcryptjs');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  pingInterval: 10000,
  pingTimeout: 5000,
});

const PORT = process.env.PORT || 3000;
const QUESTIONS_DIR = path.join(__dirname, 'questions');
const RESERVE_QUESTIONS_DIR = path.join(__dirname, 'reserve');
const ADMIN_PASSWORD = '123admin123';
const NEXT_QUESTION_DELAY = 5000;
const CORRECT_BASE = 500;
const SPEED_BONUS_MAX = 500;

// ── Database ────────────────────────────────────────────────────
const db = new Database(path.join(__dirname, 'litquiz.db'));
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

// ── Migrations ──────────────────────────────────────────────────
const migrations = [
  `ALTER TABLE games ADD COLUMN config_snapshot TEXT`,
  `ALTER TABLE answer_history ADD COLUMN work TEXT DEFAULT ''`,
  `ALTER TABLE game_config ADD COLUMN question_source TEXT DEFAULT 'main'`,
  `CREATE TABLE IF NOT EXISTS game_config (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    question_count INTEGER DEFAULT 15,
    question_time INTEGER DEFAULT 30,
    question_source TEXT DEFAULT 'main',
    works_config TEXT DEFAULT '{}',
    updated_at INTEGER DEFAULT (unixepoch())
  )`,
  `INSERT OR IGNORE INTO game_config (id) VALUES (1)`,
];
for (const sql of migrations) {
  try { db.exec(sql); } catch (e) {
    if (!e.message.includes('duplicate column') && !e.message.includes('already exists')) {
      console.warn('Migration warning:', e.message);
    }
  }
}


db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE COLLATE NOCASE,
    password_hash TEXT NOT NULL,
    created_at INTEGER DEFAULT (unixepoch()),
    total_games INTEGER DEFAULT 0,
    total_correct INTEGER DEFAULT 0,
    total_wrong INTEGER DEFAULT 0,
    total_score INTEGER DEFAULT 0,
    best_score INTEGER DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS games (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    started_at INTEGER DEFAULT (unixepoch()),
    finished_at INTEGER,
    question_count INTEGER DEFAULT 0,
    player_count INTEGER DEFAULT 0,
    config_snapshot TEXT
  );

  CREATE TABLE IF NOT EXISTS game_results (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    game_id INTEGER REFERENCES games(id) ON DELETE CASCADE,
    user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
    score INTEGER DEFAULT 0,
    correct INTEGER DEFAULT 0,
    wrong INTEGER DEFAULT 0,
    avg_time REAL,
    rank INTEGER
  );

  CREATE TABLE IF NOT EXISTS answer_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    game_id INTEGER REFERENCES games(id) ON DELETE CASCADE,
    user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
    question_index INTEGER,
    question_text TEXT,
    author TEXT,
    work TEXT,
    correct INTEGER,
    elapsed REAL,
    points INTEGER,
    chosen_index INTEGER,
    correct_index INTEGER
  );

  CREATE TABLE IF NOT EXISTS game_config (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    question_count INTEGER DEFAULT 15,
    question_time INTEGER DEFAULT 30,
    question_source TEXT DEFAULT 'main',
    works_config TEXT DEFAULT '{}',
    updated_at INTEGER DEFAULT (unixepoch())
  );

  INSERT OR IGNORE INTO game_config (id) VALUES (1);
`);

// ── Prepared statements ─────────────────────────────────────────
const stmts = {
  getUserByName:    db.prepare('SELECT * FROM users WHERE name = ? COLLATE NOCASE'),
  getUserById:      db.prepare('SELECT id, name, total_games, total_correct, total_wrong, total_score, best_score FROM users WHERE id = ?'),
  createUser:       db.prepare('INSERT INTO users (name, password_hash) VALUES (?, ?)'),
  updateUserStats:  db.prepare(`
    UPDATE users SET
      total_games   = total_games + 1,
      total_correct = total_correct + ?,
      total_wrong   = total_wrong + ?,
      total_score   = total_score + ?,
      best_score    = MAX(best_score, ?)
    WHERE id = ?
  `),
  createGame:       db.prepare('INSERT INTO games (question_count, player_count, config_snapshot) VALUES (?, ?, ?)'),
  finishGame:       db.prepare('UPDATE games SET finished_at = unixepoch() WHERE id = ?'),
  insertGameResult: db.prepare(`
    INSERT INTO game_results (game_id, user_id, score, correct, wrong, avg_time, rank)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `),
  insertAnswer:     db.prepare(`
    INSERT INTO answer_history
      (game_id, user_id, question_index, question_text, author, work, correct, elapsed, points, chosen_index, correct_index)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `),
  getRecentGames:   db.prepare(`
    SELECT g.id, g.started_at, g.question_count, g.player_count,
           gr.score, gr.correct, gr.wrong, gr.rank
    FROM games g
    JOIN game_results gr ON gr.game_id = g.id
    WHERE gr.user_id = ?
    ORDER BY g.started_at DESC
    LIMIT 50
  `),
  getAnswerHistory: db.prepare(`
    SELECT ah.*, g.started_at
    FROM answer_history ah
    JOIN games g ON g.id = ah.game_id
    WHERE ah.user_id = ? AND ah.game_id = ?
    ORDER BY ah.question_index
  `),
  getAllUsers:       db.prepare('SELECT id, name, total_games, total_correct, total_wrong, total_score, best_score, created_at FROM users ORDER BY total_score DESC'),
  resetUserPassword:db.prepare('UPDATE users SET password_hash = ? WHERE name = ? COLLATE NOCASE'),
  deleteUser:       db.prepare('DELETE FROM users WHERE name = ? COLLATE NOCASE'),
  deleteUserAnswers:db.prepare(`
    DELETE FROM answer_history
    WHERE user_id = (SELECT id FROM users WHERE name = ? COLLATE NOCASE)
  `),
  deleteUserResults:db.prepare(`
    DELETE FROM game_results
    WHERE user_id = (SELECT id FROM users WHERE name = ? COLLATE NOCASE)
  `),
  deleteAllAnswers: db.prepare('DELETE FROM answer_history'),
  deleteAllResults: db.prepare('DELETE FROM game_results'),
  deleteAllUsers:   db.prepare('DELETE FROM users'),
  getConfig:        db.prepare('SELECT * FROM game_config WHERE id = 1'),
  saveConfig:       db.prepare(`
    UPDATE game_config SET
      question_count = ?,
      question_time  = ?,
      question_source = ?,
      works_config   = ?,
      updated_at     = unixepoch()
    WHERE id = 1
  `),
  getAllGames: db.prepare(`
    SELECT g.id, g.started_at, g.finished_at, g.question_count, g.player_count,
           COUNT(gr.id) as result_count,
           MAX(gr.score) as top_score
    FROM games g
    LEFT JOIN game_results gr ON gr.game_id = g.id
    GROUP BY g.id
    ORDER BY g.started_at DESC
    LIMIT 100
  `),
  getGameResults: db.prepare(`
    SELECT gr.*, u.name
    FROM game_results gr
    JOIN users u ON u.id = gr.user_id
    WHERE gr.game_id = ?
    ORDER BY gr.rank
  `),
};

// ── Questions loader ────────────────────────────────────────────
function getQuestionDirs(source = 'main') {
  if (source === 'reserve') return [{ source: 'reserve', dir: RESERVE_QUESTIONS_DIR }];
  if (source === 'all') {
    return [
      { source: 'main', dir: QUESTIONS_DIR },
      { source: 'reserve', dir: RESERVE_QUESTIONS_DIR },
    ];
  }
  return [{ source: 'main', dir: QUESTIONS_DIR }];
}

function loadAllWorks(source = 'main') {
  const all = [];
  for (const entry of getQuestionDirs(source)) {
    if (!fs.existsSync(entry.dir)) fs.mkdirSync(entry.dir, { recursive: true });
    const files = fs.readdirSync(entry.dir).filter(f => f.endsWith('.json'));
    for (const file of files) {
      try {
        const data = JSON.parse(fs.readFileSync(path.join(entry.dir, file), 'utf8'));
        all.push({
          id: `${entry.source}/${file}`,
          file,
          source: entry.source,
          author: data.author,
          work: data.work || '',
          questions: data.questions || [],
        });
      } catch (e) {
        console.error('Error reading ' + file + ':', e.message);
      }
    }
  }
  return all;
}

function getWorksInfo(source = 'main') {
  return loadAllWorks(source).map(w => ({
    id:     w.id,
    file:   w.file,
    source: w.source,
    author: w.author,
    work:   w.work,
    count:  w.questions.length,
    questions: w.questions,
  }));
}

function getWorkConfig(worksConfig, work) {
  return worksConfig[work.id] || worksConfig[work.file] || null;
}

// ── Build game questions from config ────────────────────────────
function buildGameQuestions() {
  const cfg = stmts.getConfig.get();
  const totalCount   = cfg.question_count || 15;
  const questionSource = cfg.question_source || 'main';
  const worksConfig  = JSON.parse(cfg.works_config || '{}');
  const allWorks     = loadAllWorks(questionSource);

  // Determine which works are selected
  const selectedWorks = allWorks.filter(w => {
    const wc = getWorkConfig(worksConfig, w);
    // If no config at all — include all works (backward compat)
    if (!wc) return Object.keys(worksConfig).length === 0;
    return wc.selected !== false;
  });

  if (!selectedWorks.length) return [];

  let pool = [];

  for (const w of selectedWorks) {
    const wc = getWorkConfig(worksConfig, w) || {};
    let pickedQuestions;

    if (wc.questionIds && wc.questionIds.length > 0) {
      // Use specific questions, fill remainder randomly
      const specific = wc.questionIds
        .map(idx => w.questions[idx])
        .filter(Boolean);
      const remaining = w.questions
        .filter((_, i) => !wc.questionIds.includes(i))
        .sort(() => Math.random() - 0.5);
      pickedQuestions = [...specific, ...remaining];
    } else {
      pickedQuestions = [...w.questions].sort(() => Math.random() - 0.5);
    }

    for (const q of pickedQuestions) {
      pool.push({ ...q, author: w.author, work: w.work, _file: w.file, _source: w.source });
    }
  }

  // Shuffle pool and slice to totalCount
  pool = pool.sort(() => Math.random() - 0.5).slice(0, totalCount);
  return pool;
}

// ── Speed bonus ─────────────────────────────────────────────────
function calcSpeedBonus(elapsed, fastest, slowest) {
  if (fastest === slowest) return SPEED_BONUS_MAX;
  const relPos = (elapsed - fastest) / (slowest - fastest);
  return Math.round((1 - relPos) * SPEED_BONUS_MAX);
}

// ── Game state ──────────────────────────────────────────────────
let gameState = {
  status:          'lobby',
  players:         {},  // socketId -> playerObj
  questions:       [],
  currentQ:        -1,
  questionStartTime: 0,
  timer:           null,
  countdownTimer:  null,
  timeLeft:        0,
  currentGameId:   null,
  answerLog:       {},
  pendingAnswers:  {},
  stopAfterQuestion: null,
};

function getLeaderboard() {
  return Object.values(gameState.players)
    .sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      const avgA = a.answeredCount ? a.totalElapsed / a.answeredCount : Infinity;
      const avgB = b.answeredCount ? b.totalElapsed / b.answeredCount : Infinity;
      return avgA - avgB;
    })
    .map((p, i) => ({
      rank:    i + 1,
      name:    p.name,
      score:   p.score,
      correct: p.correctCount,
      wrong:   p.wrongCount,
      total:   gameState.questions.length,
      avgTime: p.answeredCount ? +(p.totalElapsed / p.answeredCount).toFixed(1) : null,
    }));
}

function checkAllAnswered() {
  const active = Object.values(gameState.players);
  return active.length > 0 && active.every(p => p.answered);
}

function fullReset() {
  if (gameState.timer)         { clearInterval(gameState.timer);         gameState.timer         = null; }
  if (gameState.countdownTimer){ clearInterval(gameState.countdownTimer); gameState.countdownTimer = null; }

  // Force-disconnect all players
  for (const sid of Object.keys(gameState.players)) {
    const sock = io.sockets.sockets.get(sid);
    if (sock) {
      sock.emit('forceDisconnect', { reason: 'reset' });
      sock.disconnect(true);
    }
  }

  gameState.players        = {};
  gameState.status         = 'lobby';
  gameState.questions      = [];
  gameState.currentQ       = -1;
  gameState.timeLeft       = 0;
  gameState.questionStartTime = 0;
  gameState.currentGameId  = null;
  gameState.answerLog      = {};
  gameState.pendingAnswers = {};
  gameState.stopAfterQuestion = null;
}

function disconnectPlayerByName(name, reason = 'account-deleted') {
  const entry = Object.entries(gameState.players).find(([, p]) => p.name === name);
  if (!entry) return false;
  const [sid] = entry;
  const sock = io.sockets.sockets.get(sid);
  if (sock) {
    sock.emit('forceDisconnect', { reason });
    sock.disconnect(true);
  }
  delete gameState.players[sid];
  return true;
}

function getCurrentQuestionNumber() {
  return gameState.currentQ >= 0 ? gameState.currentQ + 1 : 0;
}

function shouldStopAfterCurrentQuestion() {
  if (!gameState.stopAfterQuestion) return false;
  return getCurrentQuestionNumber() >= gameState.stopAfterQuestion;
}

function resetPlayersForNewGame() {
  for (const player of Object.values(gameState.players)) {
    player.score = 0;
    player.correctCount = 0;
    player.wrongCount = 0;
    player.totalElapsed = 0;
    player.answeredCount = 0;
    player.answered = false;
    player.elapsed = null;
  }
}

function endGame() {
  gameState.status = 'finished';
  gameState.stopAfterQuestion = null;
  if (gameState.timer) { clearInterval(gameState.timer); gameState.timer = null; }
  if (gameState.countdownTimer) { clearInterval(gameState.countdownTimer); gameState.countdownTimer = null; }

  const lb = getLeaderboard();

  const finishTx = db.transaction(() => {
    if (gameState.currentGameId) stmts.finishGame.run(gameState.currentGameId);
    for (const p of lb) {
      const player = Object.values(gameState.players).find(pl => pl.name === p.name);
      if (!player || !player.userId) continue;
      stmts.insertGameResult.run(
        gameState.currentGameId, player.userId,
        p.score, p.correct, p.wrong ?? 0, p.avgTime, p.rank
      );
      stmts.updateUserStats.run(
        p.correct, p.wrong ?? 0, p.score, p.score, player.userId
      );
    }
  });
  finishTx();

  io.emit('gameEnd', { leaderboard: lb });
}

function stopGameNow() {
  if (gameState.status === 'lobby' || gameState.status === 'finished') return false;
  if (gameState.timer) { clearInterval(gameState.timer); gameState.timer = null; }
  if (gameState.countdownTimer) { clearInterval(gameState.countdownTimer); gameState.countdownTimer = null; }
  endGame();
  return true;
}

function startNextQuestion() {
  gameState.currentQ++;
  if (gameState.currentQ >= gameState.questions.length) { endGame(); return; }

  for (const id in gameState.players) {
    gameState.players[id].answered = false;
    gameState.players[id].elapsed  = null;
  }

  const qIdx = gameState.currentQ;
  gameState.answerLog[qIdx]     = {};
  gameState.pendingAnswers[qIdx] = [];
  gameState.status               = 'question';

  const cfg = stmts.getConfig.get();
  gameState.timeLeft = cfg.question_time || 30;

  gameState.questionStartTime = Date.now();
  const q = gameState.questions[qIdx];

  io.emit('question', {
    questionIndex: qIdx,
    total:         gameState.questions.length,
    question:      q.q,
    options:       q.options,
    author:        q.author,
    work:          q.work,
    timeLeft:      gameState.timeLeft,
  });

  if (gameState.timer) clearInterval(gameState.timer);
  gameState.timer = setInterval(() => {
    gameState.timeLeft--;
    if (gameState.timeLeft <= 0) {
      clearInterval(gameState.timer);
      gameState.timer = null;
      io.emit('timer', { timeLeft: 0 });
      setTimeout(revealAnswer, 50);
    } else {
      io.emit('timer', { timeLeft: gameState.timeLeft });
    }
  }, 1000);
}

function revealAnswer() {
  if (gameState.status !== 'question') return;
  if (gameState.timer) { clearInterval(gameState.timer); gameState.timer = null; }

  const qIdx   = gameState.currentQ;
  const q      = gameState.questions[qIdx];
  gameState.status = 'between';

  const pending        = gameState.pendingAnswers[qIdx] || [];
  const correctAnswers = pending.filter(a => a.correct);
  let fastest = Infinity, slowest = 0;
  for (const a of correctAnswers) {
    if (a.elapsed < fastest) fastest = a.elapsed;
    if (a.elapsed > slowest) slowest = a.elapsed;
  }

  const saveAnswerTx = db.transaction(() => {
    for (const a of pending) {
      const player = Object.values(gameState.players).find(p => p.userId === a.userId);
      if (!player) continue;

      let points = 0;
      if (a.correct) {
        const speedBonus = correctAnswers.length > 1
          ? calcSpeedBonus(a.elapsed, fastest, slowest)
          : SPEED_BONUS_MAX;
        points = CORRECT_BASE + speedBonus;
        player.correctCount++;
      } else {
        player.wrongCount++;
      }

      player.score        += points;
      player.totalElapsed += a.elapsed;
      player.answeredCount++;

      gameState.answerLog[qIdx][player.name] = {
        correct:     a.correct,
        elapsed:     a.elapsed,
        points,
        chosenIndex: a.chosenIndex,
      };

      if (gameState.currentGameId) {
        stmts.insertAnswer.run(
          gameState.currentGameId, a.userId,
          qIdx, q.q, q.author, q.work || '',
          a.correct ? 1 : 0,
          a.elapsed, points, a.chosenIndex, q.answer
        );
      }

      const sockId = Object.keys(gameState.players).find(
        sid => gameState.players[sid].userId === a.userId
      );
      if (sockId) {
        io.to(sockId).emit('answerResult', {
          correct:    a.correct,
          points,
          totalScore: player.score,
          correctIndex: q.answer,
          elapsed:    a.elapsed,
          speedBonus: a.correct ? (points - CORRECT_BASE) : 0,
        });
      }
    }
  });
  saveAnswerTx();

  // Players who didn't answer
  for (const p of Object.values(gameState.players)) {
    if (!p.answered) p.wrongCount++;
  }

  io.emit('reveal', {
    correctIndex:  q.answer,
    leaderboard:   getLeaderboard(),
    questionIndex: qIdx,
    total:         gameState.questions.length,
    nextIn:        NEXT_QUESTION_DELAY,
    answerLog:     gameState.answerLog[qIdx],
  });

  setTimeout(() => {
    if (shouldStopAfterCurrentQuestion() || gameState.currentQ + 1 >= gameState.questions.length) endGame();
    else startNextQuestion();
  }, NEXT_QUESTION_DELAY);
}

// ── HTTP ────────────────────────────────────────────────────────
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json({ limit: '2mb' }));

function adminAuth(req, res) {
  const pw = req.body?.password || req.query?.password;
  if (pw !== ADMIN_PASSWORD) { res.status(403).json({ error: 'forbidden' }); return false; }
  return true;
}

// Upload questions JSON
app.post('/admin/upload', (req, res) => {
  const { filename, content } = req.body;
  if (!filename || !content)           return res.status(400).json({ error: 'filename and content required' });
  if (!filename.endsWith('.json'))     return res.status(400).json({ error: 'only .json files' });
  try {
    JSON.parse(content);
    fs.writeFileSync(path.join(QUESTIONS_DIR, path.basename(filename)), content, 'utf8');
    res.json({ ok: true });
  } catch (e) { res.status(400).json({ error: 'Invalid JSON: ' + e.message }); }
});

// Works info
app.get('/admin/questions', (req, res) => {
  res.json(getWorksInfo(req.query.source || 'main'));
});

// Users list
app.get('/admin/users', (req, res) => {
  if (!adminAuth(req, res)) return;
  res.json(stmts.getAllUsers.all());
});

// Create user (admin only)
app.post('/admin/create-user', (req, res) => {
  if (!adminAuth(req, res)) return;
  const { username, newPassword } = req.body;
  if (!username || !newPassword) return res.status(400).json({ error: 'username and newPassword required' });
  if (newPassword.length < 4)    return res.status(400).json({ error: 'password min 4 chars' });
  const existing = stmts.getUserByName.get(username.trim());
  if (existing) return res.status(409).json({ error: 'Имя уже занято' });
  const hash = bcrypt.hashSync(newPassword, 10);
  try {
    const info = stmts.createUser.run(username.trim().slice(0, 24), hash);
    res.json({ ok: true, userId: info.lastInsertRowid });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Reset password
app.post('/admin/reset-password', (req, res) => {
  if (!adminAuth(req, res)) return;
  const { username, newPassword } = req.body;
  const hash = bcrypt.hashSync(newPassword || 'qwerty123', 10);
  const info = stmts.resetUserPassword.run(hash, username);
  if (info.changes === 0) return res.status(404).json({ error: 'Пользователь не найден' });
  res.json({ ok: true });
});

// Delete user
app.post('/admin/delete-user', (req, res) => {
  if (!adminAuth(req, res)) return;
  disconnectPlayerByName(req.body.username);
  const tx = db.transaction((username) => {
    stmts.deleteUserAnswers.run(username);
    stmts.deleteUserResults.run(username);
    stmts.deleteUser.run(username);
  });
  tx(req.body.username);
  broadcastPlayerList();
  res.json({ ok: true });
});

app.post('/admin/delete-all-users', (req, res) => {
  if (!adminAuth(req, res)) return;
  fullReset();
  const tx = db.transaction(() => {
    stmts.deleteAllAnswers.run();
    stmts.deleteAllResults.run();
    stmts.deleteAllUsers.run();
  });
  tx();
  io.emit('gameReset');
  res.json({ ok: true });
});

// Get game config
app.get('/admin/config', (req, res) => {
  if (!adminAuth(req, res)) return;
  const cfg = stmts.getConfig.get();
  res.json({
    questionCount: cfg.question_count,
    questionTime:  cfg.question_time,
    questionSource: cfg.question_source || 'main',
    worksConfig:   JSON.parse(cfg.works_config || '{}'),
  });
});

// Save game config
app.post('/admin/config', (req, res) => {
  if (!adminAuth(req, res)) return;
  const { questionCount, questionTime, questionSource, worksConfig } = req.body;
  stmts.saveConfig.run(
    Math.max(1, Math.min(200, parseInt(questionCount) || 15)),
    Math.max(5, Math.min(120, parseInt(questionTime) || 30)),
    ['main', 'reserve', 'all'].includes(questionSource) ? questionSource : 'main',
    JSON.stringify(worksConfig || {})
  );
  res.json({ ok: true });
});

// All games history (admin)
app.get('/admin/games', (req, res) => {
  if (!adminAuth(req, res)) return;
  const games = stmts.getAllGames.all();
  res.json(games);
});

// Game results (admin)
app.get('/admin/game-results', (req, res) => {
  if (!adminAuth(req, res)) return;
  const { gameId } = req.query;
  if (!gameId) return res.status(400).json({ error: 'gameId required' });
  const results  = stmts.getGameResults.all(gameId);
  const answers  = db.prepare(`
    SELECT ah.*, u.name as player_name
    FROM answer_history ah
    JOIN users u ON u.id = ah.user_id
    WHERE ah.game_id = ?
    ORDER BY ah.question_index, ah.elapsed
  `).all(gameId);
  res.json({ results, answers });
});

// Player stats
app.get('/api/my-stats', (req, res) => {
  const { userId } = req.query;
  if (!userId) return res.status(400).json({ error: 'userId required' });
  const user  = stmts.getUserById.get(userId);
  if (!user)  return res.status(404).json({ error: 'not found' });
  const games = stmts.getRecentGames.all(userId);
  res.json({ user, games });
});

app.get('/api/game-history', (req, res) => {
  const { userId, gameId } = req.query;
  if (!userId || !gameId) return res.status(400).json({ error: 'userId and gameId required' });
  const answers = stmts.getAnswerHistory.all(userId, gameId);
  res.json({ answers });
});

// ── Socket.IO ───────────────────────────────────────────────────
io.on('connection', (socket) => {
  console.log('connect:', socket.id);

  // Send current state so client can sync
  const cfg = stmts.getConfig.get();
  socket.emit('stateSync', {
    status:        gameState.status,
    playerCount:   Object.keys(gameState.players).length,
    players:       Object.values(gameState.players).map(p => p.name),
    questionIndex: gameState.currentQ,
    total:         gameState.questions.length,
    timeLeft:      gameState.timeLeft,
    questionTime:  cfg.question_time || 30,
    questionSource: cfg.question_source || 'main',
    stopAfterQuestion: gameState.stopAfterQuestion,
  });

  // ── Login only (no public register) ──
  socket.on('login', ({ name, password }) => {
    const trimName = (name || '').trim();
    const trimPass = (password || '').trim();
    if (!trimName || !trimPass) { socket.emit('authError', 'Заполни все поля'); return; }
    const user = stmts.getUserByName.get(trimName);
    if (!user) { socket.emit('authError', 'Пользователь не найден. Обратись к администратору.'); return; }
    if (!bcrypt.compareSync(trimPass, user.password_hash)) { socket.emit('authError', 'Неверный пароль'); return; }
    socket.emit('authOk', { userId: user.id, name: user.name });
  });

  // ── Join lobby ──
  socket.on('join', ({ userId, name }) => {
    if (!userId || !name) { socket.emit('joinError', 'Нет данных авторизации'); return; }
    if (!['lobby', 'finished'].includes(gameState.status)) { socket.emit('joinError', 'Игра уже идёт'); return; }

    // Remove old socket entry for same userId (reconnect)
    for (const [sid, p] of Object.entries(gameState.players)) {
      if (p.userId === userId && sid !== socket.id) {
        delete gameState.players[sid];
      }
    }

    gameState.players[socket.id] = {
      userId,
      name,
      score:        0,
      correctCount: 0,
      wrongCount:   0,
      totalElapsed: 0,
      answeredCount:0,
      answered:     false,
      elapsed:      null,
    };

    socket.emit('joined', { name });
    broadcastPlayerList();
    console.log('Joined:', name);
  });

  socket.on('leave', () => {
    if (gameState.players[socket.id] && ['lobby', 'finished'].includes(gameState.status)) {
      delete gameState.players[socket.id];
      broadcastPlayerList();
    }
  });

  // ── Answer ──
  socket.on('answer', ({ optionIndex }) => {
    const player = gameState.players[socket.id];
    if (!player || gameState.status !== 'question' || player.answered) return;

    const elapsed = +((Date.now() - gameState.questionStartTime) / 1000).toFixed(2);
    player.answered = true;
    player.elapsed  = elapsed;

    const qIdx   = gameState.currentQ;
    const q      = gameState.questions[qIdx];
    const correct = optionIndex === q.answer;

    if (!gameState.pendingAnswers[qIdx]) gameState.pendingAnswers[qIdx] = [];
    gameState.pendingAnswers[qIdx].push({ userId: player.userId, name: player.name, elapsed, chosenIndex: optionIndex, correct });

    if (!gameState.answerLog[qIdx]) gameState.answerLog[qIdx] = {};
    gameState.answerLog[qIdx][player.name] = { correct, elapsed, points: null, chosenIndex: optionIndex };

    socket.emit('answerAccepted', { correct, correctIndex: q.answer, elapsed: +elapsed.toFixed(1) });

    io.emit('answerUpdate', {
      questionIndex: qIdx,
      answerLog:     gameState.answerLog[qIdx],
      totalPlayers:  Object.keys(gameState.players).length,
    });

    if (checkAllAnswered()) {
      if (gameState.timer) { clearInterval(gameState.timer); gameState.timer = null; }
      io.emit('timer', { timeLeft: 0 });
      setTimeout(revealAnswer, 300);
    }
  });

  // ── Admin: Start ──
  socket.on('adminStart', ({ password }) => {
    if (password !== ADMIN_PASSWORD) { socket.emit('adminError', 'Неверный пароль'); return; }
    if (!['lobby', 'finished'].includes(gameState.status)) { socket.emit('adminError', 'Игра уже запущена'); return; }
    if (Object.keys(gameState.players).length === 0) { socket.emit('adminError', 'Нет игроков'); return; }

    resetPlayersForNewGame();
    gameState.questions = buildGameQuestions();
    if (!gameState.questions.length) { socket.emit('adminError', 'Нет вопросов! Загрузи JSON файлы.'); return; }

    gameState.answerLog     = {};
    gameState.pendingAnswers = {};
    gameState.stopAfterQuestion = null;
    gameState.currentQ = -1;
    gameState.timeLeft = 0;
    gameState.questionStartTime = 0;

    const cfg = stmts.getConfig.get();
    const gameInfo = stmts.createGame.run(
      gameState.questions.length,
      Object.keys(gameState.players).length,
      JSON.stringify({
        questionTime: cfg.question_time,
        questionSource: cfg.question_source || 'main',
        worksConfig: JSON.parse(cfg.works_config || '{}'),
      })
    );
    gameState.currentGameId = gameInfo.lastInsertRowid;
    gameState.status = 'countdown';

    let count = 5;
    io.emit('countdown', { count });
    gameState.countdownTimer = setInterval(() => {
      count--;
      if (count <= 0) {
        clearInterval(gameState.countdownTimer);
        gameState.countdownTimer = null;
        startNextQuestion();
      } else {
        io.emit('countdown', { count });
      }
    }, 1000);

    socket.emit('adminStarted', { questionCount: gameState.questions.length });
  });

  // ── Admin: Reset ──
  socket.on('adminReset', ({ password }) => {
    if (password !== ADMIN_PASSWORD) { socket.emit('adminError', 'Неверный пароль'); return; }
    fullReset();
    io.emit('gameReset');
    socket.emit('adminResetDone');
  });

  socket.on('adminStopNow', ({ password }) => {
    if (password !== ADMIN_PASSWORD) { socket.emit('adminError', 'Неверный пароль'); return; }
    if (!stopGameNow()) { socket.emit('adminError', 'Сейчас нечего останавливать'); return; }
    socket.emit('adminStopped', { mode: 'now' });
  });

  socket.on('adminScheduleStop', ({ password, stopAfterQuestion }) => {
    if (password !== ADMIN_PASSWORD) { socket.emit('adminError', 'Неверный пароль'); return; }
    if (gameState.status === 'lobby' || gameState.status === 'finished') {
      socket.emit('adminError', 'Игра ещё не идёт');
      return;
    }

    const stopAt = parseInt(stopAfterQuestion);
    if (!Number.isInteger(stopAt) || stopAt < 1) {
      socket.emit('adminError', 'Укажи корректный номер вопроса');
      return;
    }

    const currentQuestion = getCurrentQuestionNumber();
    const alreadyPassed = currentQuestion > stopAt || (gameState.status === 'between' && currentQuestion >= stopAt);
    if (alreadyPassed && gameState.status !== 'countdown') {
      if (!stopGameNow()) socket.emit('adminError', 'Не удалось остановить игру');
      else socket.emit('adminStopped', { mode: 'scheduled-now', stopAfterQuestion: stopAt });
      return;
    }

    gameState.stopAfterQuestion = stopAt;
    io.emit('stateSync', {
      status:        gameState.status,
      playerCount:   Object.keys(gameState.players).length,
      players:       Object.values(gameState.players).map(p => p.name),
      questionIndex: gameState.currentQ,
      total:         gameState.questions.length,
      timeLeft:      gameState.timeLeft,
      questionTime:  cfg.question_time || 30,
      questionSource: cfg.question_source || 'main',
      stopAfterQuestion: gameState.stopAfterQuestion,
    });
    socket.emit('adminStopScheduled', { stopAfterQuestion: stopAt });
  });

  // ── Admin: Skip question ──
  socket.on('adminNextQuestion', ({ password }) => {
    if (password !== ADMIN_PASSWORD) return;
    if (gameState.status !== 'question') return;
    if (gameState.timer) { clearInterval(gameState.timer); gameState.timer = null; }
    revealAnswer();
  });

  // ── Admin: Kick player ──
  socket.on('adminKick', ({ name, password }) => {
    if (password !== ADMIN_PASSWORD) return;
    const entry = Object.entries(gameState.players).find(([, p]) => p.name === name);
    if (entry) {
      const [sid] = entry;
      io.to(sid).emit('kicked');
      const sock = io.sockets.sockets.get(sid);
      if (sock) sock.disconnect(true);
      delete gameState.players[sid];
      broadcastPlayerList();
    }
  });

  // ── Disconnect ──
  socket.on('disconnect', (reason) => {
    const player = gameState.players[socket.id];
    if (!player) return;

    const name = player.name;
    delete gameState.players[socket.id];
    console.log('Disconnected:', name, '(' + reason + ')');

    broadcastPlayerList();

    if (gameState.status === 'question' && checkAllAnswered()) {
      if (gameState.timer) { clearInterval(gameState.timer); gameState.timer = null; }
      io.emit('timer', { timeLeft: 0 });
      setTimeout(revealAnswer, 300);
    }
  });
});

function broadcastPlayerList() {
  io.emit('playerList', {
    status:  gameState.status,
    players: Object.values(gameState.players).map(p => p.name),
    count:   Object.keys(gameState.players).length,
  });
}

// ── Start server ────────────────────────────────────────────────
server.listen(PORT, '0.0.0.0', () => {
  const { networkInterfaces } = require('os');
  const nets = networkInterfaces();
  let localIP = 'localhost';
  for (const name of Object.keys(nets)) {
    for (const net of nets[name]) {
      if (net.family === 'IPv4' && !net.internal) localIP = net.address;
    }
  }
  console.log('\n🎮 ЛитКвиз v3 запущен!');
  console.log('   Локально:  http://localhost:' + PORT);
  console.log('   По сети:   http://' + localIP + ':' + PORT + '   <- игрокам');
  console.log('   Админка:   http://' + localIP + ':' + PORT + '/admin.html\n');
});
