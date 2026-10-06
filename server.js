import express from 'express';
import http from 'http';
import { WebSocketServer } from 'ws';
import crypto from 'crypto';

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server });
const rooms = new Map();
const COLORS = ['RED','BLUE','GREEN','YELLOW'];
const ROUND_MS = 10000;
const BETWEEN_MS = 1800;
const TOTAL_ROUNDS = 10;

app.use(express.static('public'));
app.get('/health', (_, res) => res.json({ok:true}));

function code(){ return crypto.randomBytes(3).toString('hex').toUpperCase(); }
function send(ws, msg){ if(ws.readyState === 1) ws.send(JSON.stringify(msg)); }
function broadcast(room, msg){ for(const p of room.players.values()) send(p.ws,msg); }
function players(room){ return [...room.players.values()].map(p=>({id:p.id,name:p.name,score:p.score})); }
function snapshot(room){ return {type:'state', roomCode:room.code, status:room.status, round:room.round, totalRounds:TOTAL_ROUNDS, target:room.target, players:players(room), deadline:room.deadline}; }
function cleanName(name){ return String(name||'Player').trim().slice(0,18) || 'Player'; }
function makeRoom(){ let c; do c=code(); while(rooms.has(c)); const room={code:c,players:new Map(),host:null,status:'lobby',round:0,target:null,deadline:0,timer:null}; rooms.set(c,room); return room; }
function sendState(room){ broadcast(room,snapshot(room)); }
function startRound(room){
  room.round += 1;
  room.target = COLORS[Math.floor(Math.random()*COLORS.length)];
  room.deadline = Date.now()+ROUND_MS;
  for(const p of room.players.values()){ p.answered=false; p.answeredCorrect=false; }
  broadcast(room,{...snapshot(room),type:'round'});
  clearTimeout(room.timer);
  room.timer=setTimeout(()=>endRound(room),ROUND_MS+50);
}
function endRound(room){
  if(room.status!=='playing') return;
  room.status='between'; room.deadline=0;
  broadcast(room,{...snapshot(room),type:'roundEnd'});
  if(room.round>=TOTAL_ROUNDS){
    room.status='finished';
    const ranking=players(room).sort((a,b)=>b.score-a.score);
    broadcast(room,{type:'gameOver',players:ranking});
    return;
  }
  room.timer=setTimeout(()=>{room.status='playing'; startRound(room)},BETWEEN_MS);
}
function begin(room){ if(room.players.size<2 || room.status!=='lobby') return false; room.status='playing'; room.round=0; startRound(room); return true; }

wss.on('connection', ws=>{
  ws.on('message', raw=>{
    let m; try{m=JSON.parse(raw)}catch{return}
    if(m.type==='create'){
      const room=makeRoom(); const p={id:crypto.randomUUID(),name:cleanName(m.name),score:0,answered:false,ws}; room.players.set(p.id,p); room.host=p.id; ws.playerId=p.id; ws.roomCode=room.code;
      send(ws,{type:'joined',playerId:p.id,host:true,...snapshot(room)}); return;
    }
    if(m.type==='join'){
      const room=rooms.get(String(m.roomCode||'').toUpperCase());
      if(!room) return send(ws,{type:'error',message:'Room not found.'});
      if(room.players.size>=8) return send(ws,{type:'error',message:'This room is full (8 players maximum).'});
      if(room.status!=='lobby') return send(ws,{type:'error',message:'This game has already started.'});
      const p={id:crypto.randomUUID(),name:cleanName(m.name),score:0,answered:false,ws}; room.players.set(p.id,p); ws.playerId=p.id; ws.roomCode=room.code;
      send(ws,{type:'joined',playerId:p.id,host:false,...snapshot(room)}); sendState(room); return;
    }
    const room=rooms.get(ws.roomCode); const p=room?.players.get(ws.playerId); if(!room||!p) return;
    if(m.type==='start'){
      if(p.id!==room.host) return send(ws,{type:'error',message:'Only the host can start the game.'});
      if(!begin(room)) return send(ws,{type:'error',message:'At least 2 players are needed.'});
    } else if(m.type==='answer' && room.status==='playing' && !p.answered){
      if(Date.now()>room.deadline) return;
      p.answered=true;
      if(String(m.color).toUpperCase()===room.target){
        const correct=[...room.players.values()].filter(x=>x.answeredCorrect).length;
        const award=correct===0?5:correct===1?3:correct===2?2:1;
        p.score+=award; p.answeredCorrect=true;
        send(ws,{type:'answerResult',correct:true,points:award});
      } else { p.answeredCorrect=false; send(ws,{type:'answerResult',correct:false,points:0}); }
      sendState(room);
    }
  });
  ws.on('close',()=>{
    const room=rooms.get(ws.roomCode); if(!room) return; room.players.delete(ws.playerId);
    if(room.host===ws.playerId){ const next=room.players.values().next().value; room.host=next?.id||null; }
    if(room.players.size===0){ clearTimeout(room.timer); rooms.delete(room.code); }
    else sendState(room);
  });
});

const port=process.env.PORT||3000;
server.listen(port,()=>console.log(`Color Chase running on port ${port}`));
