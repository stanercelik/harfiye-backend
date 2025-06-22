import express from 'express';
import { createServer } from 'http';
import { Server } from 'socket.io';
import cors from 'cors';
import fs from 'fs';
import path from 'path';

const app = express();
const server = createServer(app);
const io = new Server(server, {
  cors: {
    origin: [
      "http://localhost:3000", 
      "http://localhost:5001",
      "http://192.168.1.123:3000", // IP adresi desteği
      /^http:\/\/192\.168\.1\.\d+:3000$/, // Tüm 192.168.1.x ağı için regex
      /^http:\/\/10\.\d+\.\d+\.\d+:3000$/, // 10.x.x.x ağları için
      /^http:\/\/172\.(1[6-9]|2[0-9]|3[0-1])\.\d+\.\d+:3000$/ // 172.16.x.x - 172.31.x.x ağları için
    ],
    methods: ["GET", "POST"],
    allowedHeaders: ["*"],
    credentials: true
  },
  transports: ['websocket', 'polling'], // Fallback transport desteği
  allowEIO3: true // Engine.IO v3 uyumluluğu
});

const PORT = process.env.PORT || 3002;

// Türkçe kelime listelerini yükle
const WORDS_5: string[] = JSON.parse(fs.readFileSync(path.join(__dirname, '../words_tr_5.json'), 'utf8'));
const WORDS_6: string[] = JSON.parse(fs.readFileSync(path.join(__dirname, '../words_tr_6.json'), 'utf8'));
const WORDS_7: string[] = JSON.parse(fs.readFileSync(path.join(__dirname, '../words_tr_7.json'), 'utf8'));

// Kelime listelerini bir map'te tut
const WORD_LISTS = new Map<number, string[]>([
  [5, WORDS_5],
  [6, WORDS_6],
  [7, WORDS_7]
]);

// Oyun durumu interface'leri
interface PlayerState {
  id: string;
  name: string;
  guesses: {
    guess: string;
    feedback: ('correct' | 'present' | 'absent')[];
  }[];
  timeRemaining: number;
  isReady: boolean;
  isTimedOut: boolean;
}

interface GameState {
  roomId: string;
  players: PlayerState[];
  maxPlayers: number;
  wordLength: number; // Kelime uzunluğu (5, 6, veya 7)
  timeLimit: number | null; // Saniye cinsinden zaman sınırı, null ise sınırsız
  status: 'waiting' | 'playing' | 'finished';
  solution: string;
  createdAt: number;
  rematchRequest?: {
    requesterId: string;
    requested: boolean;
    accepted?: boolean;
  };
}

// Aktif oyun odaları
const gameRooms = new Map<string, GameState>();

// Zamanlayıcı yönetimi
const gameTimers = new Map<string, Map<string, NodeJS.Timeout>>();

// Yardımcı fonksiyonlar
function generateRoomId(): string {
  return Math.random().toString(36).substring(2, 8).toUpperCase();
}

/**
 * Şapkalı harfleri normal harflere dönüştürür (â→a, î→i, û→u)
 */
function normalizeAccentedChars(text: string): string {
  const accentMap: Record<string, string> = {
    'â': 'a', 'Â': 'a',
    'î': 'i', 'Î': 'i',
    'û': 'u', 'Û': 'u'
  };
  
  return text.split('').map(char => accentMap[char] || char).join('');
}

function getRandomWord(wordLength: number): string {
  const words = WORD_LISTS.get(wordLength);
  if (words && words.length > 0) {
    return words[Math.floor(Math.random() * words.length)];
  }
  throw new Error(`${wordLength} harfli kelime listesi bulunamadı`);
}

function isValidWord(word: string): boolean {
  const normalizedWord = normalizeAccentedChars(word).toLowerCase();
  const wordLength = word.length;
  const words = WORD_LISTS.get(wordLength);
  if (words) {
    return words.some(w => normalizeAccentedChars(w).toLowerCase() === normalizedWord);
  }
  return false;
}

function evaluateGuess(guess: string, solution: string): ('correct' | 'present' | 'absent')[] {
  const feedback: ('correct' | 'present' | 'absent')[] = [];
  const solutionArray = normalizeAccentedChars(solution).toLowerCase().split('');
  const guessArray = normalizeAccentedChars(guess).toLowerCase().split('');
  const wordLength = solution.length;
  
  // İlk geçişte doğru pozisyondaki harfleri işaretle
  for (let i = 0; i < wordLength; i++) {
    if (guessArray[i] === solutionArray[i]) {
      feedback[i] = 'correct';
      solutionArray[i] = '*'; // İşaretlendi olarak kabul et
    }
  }
  
  // İkinci geçişte yanlış pozisyondaki harfleri kontrol et
  for (let i = 0; i < wordLength; i++) {
    if (feedback[i] === undefined) {
      const letterIndex = solutionArray.indexOf(guessArray[i]);
      if (letterIndex !== -1) {
        feedback[i] = 'present';
        solutionArray[letterIndex] = '*'; // İşaretlendi olarak kabul et
      } else {
        feedback[i] = 'absent';
      }
    }
  }
  
  return feedback;
}

function checkGameEnd(gameState: GameState): { isEnd: boolean; winnerId?: string } {
  // Kazanan var mı kontrol et
  for (const player of gameState.players) {
    const lastGuess = player.guesses[player.guesses.length - 1];
    if (lastGuess && lastGuess.feedback.every(f => f === 'correct')) {
      return { isEnd: true, winnerId: player.id };
    }
  }
  
  // Zaman aşımı durumu kontrolü - sadece tüm oyuncular zaman aşımına uğradıysa berabere
  const timedOutPlayers = gameState.players.filter(p => p.isTimedOut);
  if (timedOutPlayers.length === gameState.players.length) {
    return { isEnd: true };
  }
  
  // Tüm oyuncular 6 hakkını kullandı mı veya zaman aşımına uğradı mı
  const allPlayersFinished = gameState.players.every(p => p.guesses.length >= 6 || p.isTimedOut);
  if (allPlayersFinished) {
    return { isEnd: true };
  }
  
  return { isEnd: false };
}

function sanitizeGameStateForClient(gameState: GameState): any {
  // İstemciye gönderilecek oyun durumunu hazırla (gizli kelimeyi çıkar)
  const { solution, ...clientGameState } = gameState;
  return clientGameState;
}

// Zamanlayıcı yönetimi fonksiyonları
function startPlayerTimer(roomId: string, playerId: string, gameState: GameState) {
  const player = gameState.players.find(p => p.id === playerId);
  if (!player || player.isTimedOut) return;

  // Zaman sınırı yoksa timer başlatma
  if (gameState.timeLimit === null) {
    player.timeRemaining = -1; // Sınırsız zaman
    return;
  }

  // Mevcut timer'ı temizle
  clearPlayerTimer(roomId, playerId);

  // Yeni timer başlat
  if (!gameTimers.has(roomId)) {
    gameTimers.set(roomId, new Map());
  }

  const roomTimers = gameTimers.get(roomId)!;
  
  player.timeRemaining = gameState.timeLimit; // Belirlenen zaman sınırı
  
  const timer = setInterval(() => {
    player.timeRemaining--;
    
    // Zaman güncellemesini sadece ilgili oyuncuya gönder
    io.to(playerId).emit('timer_update', { 
      playerId, 
      timeRemaining: player.timeRemaining 
    });

    if (player.timeRemaining <= 0) {
      clearPlayerTimer(roomId, playerId);
      handlePlayerTimeout(roomId, playerId, gameState);
    }
  }, 1000);

  roomTimers.set(playerId, timer);
}

function clearPlayerTimer(roomId: string, playerId: string) {
  const roomTimers = gameTimers.get(roomId);
  if (roomTimers?.has(playerId)) {
    clearInterval(roomTimers.get(playerId)!);
    roomTimers.delete(playerId);
  }
}

function clearAllRoomTimers(roomId: string) {
  const roomTimers = gameTimers.get(roomId);
  if (roomTimers) {
    roomTimers.forEach(timer => clearInterval(timer));
    gameTimers.delete(roomId);
  }
}

function handlePlayerTimeout(roomId: string, playerId: string, gameState: GameState) {
  const player = gameState.players.find(p => p.id === playerId);
  if (!player) return;

  player.isTimedOut = true;
  console.log(`Oyuncu ${player.name} zaman aşımına uğradı: ${roomId}`);

  // Zaman aşımı mesajını gönder
  io.to(playerId).emit('player_timeout', { message: 'Süreniz doldu! Tahmin yapamazsınız artık.' });

  // Oyun bitti mi kontrol et
  const gameEnd = checkGameEnd(gameState);
  if (gameEnd.isEnd) {
    gameState.status = 'finished';
    clearAllRoomTimers(roomId);
    
    io.to(roomId).emit('game_over', {
      winnerId: gameEnd.winnerId || null,
      solution: gameState.solution,
      gameState: sanitizeGameStateForClient(gameState)
    });

    // Odayı temizle (5 dakika sonra)
    setTimeout(() => {
      gameRooms.delete(roomId);
      console.log(`Oda temizlendi: ${roomId}`);
    }, 5 * 60 * 1000);
  } else {
    // Güncel durumu gönder
    io.to(roomId).emit('update_state', { gameState: sanitizeGameStateForClient(gameState) });
  }
}

// Middleware
app.use(cors({
  origin: ["http://localhost:3000", "http://localhost:5001"],
  methods: ["GET", "POST"]
}));
app.use(express.json());

// Static dosyalar için (test sayfası)
app.use(express.static(__dirname + '/../'));

// Test endpoint
app.get('/', (req, res) => {
  res.json({ 
            message: 'Harfiye Server is running!',
    totalWords: WORDS_5.length + WORDS_6.length + WORDS_7.length,
    activeRooms: gameRooms.size
  });
});

// Socket.IO bağlantıları
io.on('connection', (socket) => {
  console.log('Bir kullanıcı bağlandı:', socket.id);

  // Oda oluşturma
  socket.on('create_room', ({ playerName, maxPlayers, wordLength, timeLimit }: { playerName: string; maxPlayers?: number; wordLength?: number; timeLimit?: number | null }) => {
    // Maksimum oyuncu sayısını kontrol et (2-5 arası)
    const validMaxPlayers = Math.max(2, Math.min(5, maxPlayers || 2));
    
    // Kelime uzunluğunu kontrol et (5, 6, veya 7)
    const validWordLength = [5, 6, 7].includes(wordLength || 5) ? (wordLength || 5) : 5;
    
    // Zaman sınırını kontrol et (30, 35, 60, 75, 90 saniye veya null)
    const validTimeLimit = timeLimit === null ? null : 
      [30, 35, 60, 75, 90].includes(timeLimit || 30) ? (timeLimit || 30) : 30;
    
    const roomId = generateRoomId();
    const solution = getRandomWord(validWordLength);
    
    const gameState: GameState = {
      roomId,
      players: [{
        id: socket.id,
        name: playerName,
        guesses: [],
        timeRemaining: validTimeLimit || -1, // Sınırsız ise -1
        isReady: true,
        isTimedOut: false
      }],
      maxPlayers: validMaxPlayers,
      wordLength: validWordLength,
      timeLimit: validTimeLimit,
      status: 'waiting',
      solution,
      createdAt: Date.now()
    };
    
    gameRooms.set(roomId, gameState);
    socket.join(roomId);
    
    socket.emit('room_created', { roomId });
    console.log(`Oda oluşturuldu: ${roomId}, Oyuncu: ${playerName}, Max Oyuncu: ${validMaxPlayers}, Kelime Uzunluğu: ${validWordLength}, Zaman Sınırı: ${validTimeLimit ? validTimeLimit + 's' : 'Sınırsız'}, Seçilen kelime: ${solution.toUpperCase()}`);
  });

  // Odaya katılma
  socket.on('join_room', ({ roomId, playerName }: { roomId: string; playerName: string }) => {
    const gameState = gameRooms.get(roomId);
    
    if (!gameState) {
      socket.emit('error', { message: 'Oda bulunamadı!' });
      return;
    }
    
    // Oyuncu zaten odada mı kontrol et
    const existingPlayer = gameState.players.find(p => p.id === socket.id);
    if (existingPlayer) {
      // Oyuncu zaten odada, durumu güncelle ve gönder
      socket.join(roomId);
      socket.emit('room_joined', { gameState: sanitizeGameStateForClient(gameState) });
      console.log(`Oyuncu ${playerName} zaten odada: ${roomId}, durum güncellendi`);
      return;
    }
    
    if (gameState.players.length >= gameState.maxPlayers) {
      socket.emit('error', { message: 'Oda dolu!' });
      return;
    }
    
    if (gameState.status !== 'waiting') {
      socket.emit('error', { message: 'Oyun zaten başlamış!' });
      return;
    }
    
    // Yeni oyuncuyu ekle
    gameState.players.push({
      id: socket.id,
      name: playerName,
      guesses: [],
      timeRemaining: gameState.timeLimit || -1, // Sınırsız ise -1
      isReady: true,
      isTimedOut: false
    });
    
    socket.join(roomId);
    
    // Önce katılan oyuncuya room_joined gönder
    socket.emit('room_joined', { gameState: sanitizeGameStateForClient(gameState) });
    
    // Tüm odadaki diğer oyunculara yeni oyuncunun katıldığını bildir
    socket.to(roomId).emit('player_joined', { 
      gameState: sanitizeGameStateForClient(gameState),
      newPlayerName: playerName 
    });
    
    console.log(`Oyuncu ${playerName} odaya katıldı: ${roomId}. Odadaki oyuncu sayısı: ${gameState.players.length}/${gameState.maxPlayers}`);
    
    // Eğer maksimum oyuncu sayısına ulaşıldıysa oyunu başlat
    if (gameState.players.length === gameState.maxPlayers) {
      gameState.status = 'playing';
      
      // Her oyuncu için zamanlayıcıları başlat
      gameState.players.forEach(player => {
        startPlayerTimer(roomId, player.id, gameState);
      });
      
      // Oyunu başlat - TÜM ODAYA gönder (oda sahibi + katılan oyuncu)
      io.to(roomId).emit('game_start', { gameState: sanitizeGameStateForClient(gameState) });
      console.log(`Oda ${roomId} dolu! Oyun başlıyor! TÜM OYUNCULARA game_start gönderildi. Seçilen kelime: ${gameState.solution.toUpperCase()}`);
      
      // Ekstra loglama - hangi oyunculara gönderildiğini görmek için
      gameState.players.forEach(player => {
        console.log(`game_start eventi gönderildi: ${player.name} (${player.id})`);
      });
    }
  });

  // Tahmin yapma
  socket.on('make_guess', ({ guess }: { guess: string }) => {
    // Oyuncunun hangi odada olduğunu bul
    let userRoom = '';
    let gameState: GameState | undefined;
    
    for (const [roomId, state] of gameRooms.entries()) {
      if (state.players.some(p => p.id === socket.id)) {
        userRoom = roomId;
        gameState = state;
        break;
      }
    }
    
    if (!gameState || !userRoom) {
      socket.emit('error', { message: 'Oyun odası bulunamadı!' });
      return;
    }
    
    if (gameState.status !== 'playing') {
      socket.emit('error', { message: 'Oyun aktif değil!' });
      return;
    }
    
    // Kelime uzunluğu doğru mu kontrol et
    if (guess.length !== gameState.wordLength) {
      socket.emit('invalid_word', { message: `Kelime ${gameState.wordLength} harf olmalıdır!` });
      return;
    }
    
    // Kelime geçerli mi kontrol et
    if (!isValidWord(guess)) {
      socket.emit('invalid_word', { message: 'Kelime listede bulunamadı!' });
      return;
    }
    
    // Oyuncuyu bul
    const player = gameState.players.find(p => p.id === socket.id);
    if (!player) {
      socket.emit('error', { message: 'Oyuncu bulunamadı!' });
      return;
    }
    
    if (player.guesses.length >= 6) {
      socket.emit('error', { message: 'Tahmin hakkınız bitti!' });
      return;
    }
    
    if (player.isTimedOut) {
      socket.emit('error', { message: 'Süreniz doldu! Tahmin yapamazsınız.' });
      return;
    }
    
    // Tahmini değerlendir
    const feedback = evaluateGuess(guess, gameState.solution);
    player.guesses.push({ guess: guess.toLowerCase(), feedback });
    
    // Tahmin yapıldığında zamanlayıcıyı sıfırla (sadece doğru cevap verilmediyse)
    const isCorrect = feedback.every(f => f === 'correct');
    if (!isCorrect) {
      startPlayerTimer(userRoom, socket.id, gameState);
    }
    
    // Oyun bitti mi kontrol et
    const gameEnd = checkGameEnd(gameState);
    if (gameEnd.isEnd) {
      gameState.status = 'finished';
      clearAllRoomTimers(userRoom);
      
      io.to(userRoom).emit('game_over', {
        winnerId: gameEnd.winnerId || null,
        solution: gameState.solution,
        gameState: sanitizeGameStateForClient(gameState)
      });
      
      // Odayı temizle (5 dakika sonra)
      setTimeout(() => {
        gameRooms.delete(userRoom);
        console.log(`Oda temizlendi: ${userRoom}`);
      }, 5 * 60 * 1000);
    } else {
      // Güncel durumu gönder
      io.to(userRoom).emit('update_state', { gameState: sanitizeGameStateForClient(gameState) });
    }
  });

  // Rövanş talebi
  socket.on('request_rematch', () => {
    // Oyuncunun hangi odada olduğunu bul
    let userRoom = '';
    let gameState: GameState | undefined;
    
    for (const [roomId, state] of gameRooms.entries()) {
      if (state.players.some(p => p.id === socket.id)) {
        userRoom = roomId;
        gameState = state;
        break;
      }
    }
    
    if (!gameState || !userRoom) {
      socket.emit('error', { message: 'Oyun odası bulunamadı!' });
      return;
    }
    
    if (gameState.status !== 'finished') {
      socket.emit('error', { message: 'Oyun henüz bitmedi!' });
      return;
    }
    
    if (gameState.players.length !== gameState.maxPlayers) {
      socket.emit('error', { message: 'Rövanş için tüm oyuncular gerekli!' });
      return;
    }
    
    // Rövanş talebi oluştur veya güncelle
    gameState.rematchRequest = {
      requesterId: socket.id,
      requested: true
    };
    
    // Diğer oyunculara rövanş talebi gönder
    gameState.players.forEach(player => {
      if (player.id !== socket.id) {
        socket.to(player.id).emit('rematch_requested', { 
          requesterName: gameState.players.find(p => p.id === socket.id)?.name || 'Rakip' 
        });
      }
    });
    
    console.log(`Rövanş talebi oluşturuldu: ${userRoom}, Talep eden: ${socket.id}`);
  });

  // Rövanş kabul etme
  socket.on('accept_rematch', () => {
    // Oyuncunun hangi odada olduğunu bul
    let userRoom = '';
    let gameState: GameState | undefined;
    
    for (const [roomId, state] of gameRooms.entries()) {
      if (state.players.some(p => p.id === socket.id)) {
        userRoom = roomId;
        gameState = state;
        break;
      }
    }
    
    if (!gameState || !userRoom) {
      socket.emit('error', { message: 'Oyun odası bulunamadı!' });
      return;
    }
    
    if (!gameState.rematchRequest || !gameState.rematchRequest.requested) {
      socket.emit('error', { message: 'Rövanş talebi bulunamadı!' });
      return;
    }
    
    if (gameState.rematchRequest.requesterId === socket.id) {
      socket.emit('error', { message: 'Kendi rövanş talebinizi kabul edemezsiniz!' });
      return;
    }
    
    // Rövanş kabul edildi
    gameState.rematchRequest.accepted = true;
    
    // Yeni oyun için oyunu sıfırla
    const newSolution = getRandomWord(gameState.wordLength);
    gameState.solution = newSolution;
    gameState.status = 'playing';
    gameState.createdAt = Date.now();
    gameState.rematchRequest = undefined;
    
    // Oyuncuları sıfırla
    gameState.players.forEach(player => {
      player.guesses = [];
      player.timeRemaining = gameState.timeLimit || -1; // Sınırsız ise -1
      player.isReady = true;
      player.isTimedOut = false;
    });
    
    // Geri sayımı başlat
    io.to(userRoom).emit('rematch_accepted');
    
    let countdown = 3;
    const countdownInterval = setInterval(() => {
      io.to(userRoom).emit('rematch_countdown', { seconds: countdown });
      countdown--;
      
      if (countdown < 0) {
        clearInterval(countdownInterval);
        
        // Her iki oyuncu için zamanlayıcıları başlat
        gameState!.players.forEach(player => {
          startPlayerTimer(userRoom, player.id, gameState!);
        });
        
        // Oyunu başlat
        io.to(userRoom).emit('game_start', { gameState: sanitizeGameStateForClient(gameState!) });
        console.log(`Rövanş başladı: ${userRoom}. Yeni kelime: ${newSolution.toUpperCase()}`);
      }
    }, 1000);
  });

  // Rövanş reddetme
  socket.on('decline_rematch', () => {
    // Oyuncunun hangi odada olduğunu bul
    let userRoom = '';
    let gameState: GameState | undefined;
    
    for (const [roomId, state] of gameRooms.entries()) {
      if (state.players.some(p => p.id === socket.id)) {
        userRoom = roomId;
        gameState = state;
        break;
      }
    }
    
    if (!gameState || !userRoom) {
      socket.emit('error', { message: 'Oyun odası bulunamadı!' });
      return;
    }
    
    if (!gameState.rematchRequest || !gameState.rematchRequest.requested) {
      socket.emit('error', { message: 'Rövanş talebi bulunamadı!' });
      return;
    }
    
    // Talep edeni bul
    const requesterId = gameState.rematchRequest.requesterId;
    
    // Rövanş talebi reddedildi
    gameState.rematchRequest = undefined;
    
    // Talep edene bildir
    socket.to(requesterId).emit('rematch_declined');
    
    console.log(`Rövanş talebi reddedildi: ${userRoom}`);
  });

  socket.on('disconnect', () => {
    console.log('Kullanıcı ayrıldı:', socket.id);
    
    // Oyuncunun olduğu odayı bul ve temizle
    for (const [roomId, gameState] of gameRooms.entries()) {
      const playerIndex = gameState.players.findIndex(p => p.id === socket.id);
      if (playerIndex !== -1) {
        gameState.players.splice(playerIndex, 1);
        
        if (gameState.players.length === 0) {
          clearAllRoomTimers(roomId);
          gameRooms.delete(roomId);
          console.log(`Boş oda silindi: ${roomId}`);
        } else {
          // Ayrılan oyuncunun timer'ını temizle
          clearPlayerTimer(roomId, socket.id);
          // Diğer oyuncuya bildir
          io.to(roomId).emit('player_left', { gameState: sanitizeGameStateForClient(gameState) });
        }
        break;
      }
    }
  });
});

server.listen(PORT, () => {
  console.log(`Server ${PORT} portunda çalışıyor`);
  console.log(`Toplam kelime sayısı: ${WORDS_5.length + WORDS_6.length + WORDS_7.length}`);
});