// ==========================================
// 1. 무료 실시간 동기화 설정 (Supabase Broadcast)
// ==========================================
const REALTIME_CONFIG = {
  enabled: true,
  supabaseUrl: "", // 예: "https://xxxxxxxxxxxx.supabase.co"
  supabaseAnonKey: "", // 예: "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9..."
  sendIntervalMs: 60, // 약 16fps 전송 (무료 한도 절약용)
};

// 매번 초대 링크를 보내지 않고 함께 머무는 고정 방 기본값
const DEFAULT_ROOM_ID = "our-night-room";

const clientId =
  "user_" +
  Math.random().toString(36).slice(2, 8) +
  "_" +
  Date.now().toString(36);
const roomId = resolveRoomId();

let realtimeChannel = null;
let peerConnected = false;
let peerLampLit = false;
let lastPeerSeenTime = 0;
let lastBroadcastTime = 0;

// ==========================================
// 2. 카메라 & 손 관절 상태 (조명 상태와 연동)
// ==========================================
let videoEl = null;
let cameraStream = null;
let handsModel = null;
let cameraEnabled = false;
let isProcessingFrame = false;

let rawLandmarks = null;
let smoothLandmarks = null;
let lastHandSeenTime = 0;

// 오프스크린 단일 그림자 레이어
let shadowLayer;

// 3분 조명 상태: 처음엔 꺼진 상태로 시작
let lampOn = false;
let lampStartTime = 0;
const SESSION_DURATION = 180 * 1000;

// 기본 모드: 'alone' ('together' | 'alone')
let appMode = "alone";
let savedTrail = [];
let fadingTrail = false;
let trailAlpha = 0;
let manualPointingActive = false;

// 무드보드 감성 입자 & 친구 손 상태
let dustParticles = [];
let lightRays = [];
let prevCenter = null;

// 주먹 쥐기 & 온기 전달 인터랙션 상태
let fistCharge = 0;
let wasFistClosed = false;
let manualFistHeld = false;
let warmthBridge = 0;
let friendWarmthGlow = 0;
let lastWarmthHandPos = null;

// 상대방 손(원격 수신 시 부드럽게 lerp, 미접속 시 은은한 부유)
let friendHand = {
  x: 0,
  y: 0,
  targetX: 0,
  targetY: 0,
  t: 0,
  hasRemote: false,
  fistCharge: 0,
};
let overlapPulse = 0;
let overlapHold = 0;
let wasOverlapping = false;
let lampHoverGlow = 0;
let peerPresenceGlow = 0;

// ==========================================
// 3. 비동기 안부 남기기(녹화) & 다시 재생
// ==========================================
const NOD_STORAGE_KEY = `shadow_nod_clip_${roomId}`;
const MAX_RECORD_FRAMES = 180; // 약 6초 분량(30fps 기준)

let isRecordingNod = false;
let isReplayingNod = false;
let recordedClip = [];
let replayIndex = 0;
let lastReplayFrameTime = 0;
let autoReplayedForPeer = false;

function resolveRoomId() {
  const params = new URLSearchParams(window.location.search);
  let room = params.get("room");
  if (!room) {
    room = DEFAULT_ROOM_ID;
    const nextUrl = new URL(window.location.href);
    nextUrl.searchParams.set("room", room);
    window.history.replaceState({}, "", nextUrl.toString());
  }
  return room;
}

function setup() {
  let cnv = createCanvas(windowWidth, windowHeight);
  cnv.parent("canvas-container");

  // 캔버스 우클릭 시 테스트용 주먹 쥐기 허용
  cnv.elt.addEventListener("contextmenu", (e) => {
    e.preventDefault();
  });

  friendHand.x = width * 0.55;
  friendHand.y = height * 0.48;
  friendHand.targetX = friendHand.x;
  friendHand.targetY = friendHand.y;

  recordedClip = loadSavedNodClip();

  shadowLayer = createGraphics(windowWidth, windowHeight);
  shadowLayer.pixelDensity(pixelDensity());

  for (let i = 0; i < 65; i++) {
    dustParticles.push({
      x: random(width),
      y: random(height),
      r: random(0.8, 2.4),
      alpha: random(25, 95),
      driftX: random(-0.15, 0.15),
      driftY: random(-0.2, 0.05),
      twinkle: random(TWO_PI),
    });
  }

  initMediaPipeHands();
  initRealtimeRoom();

  // 시작 시 불은 꺼진 상태 유지
  lampOn = false;
  cameraEnabled = false;
}

// ==========================================
// 4. 조명 & 후면 카메라 연동 제어
// ==========================================
async function turnLampOn(options = { broadcast: true }) {
  lampOn = true;
  lampStartTime = millis();
  fadingTrail = false;
  savedTrail = [];
  setWhisper("lit");

  await syncCameraWithLamp(true);

  if (options && options.broadcast) {
    broadcastLampLit();
  }
}

function turnLampOff(reasonWhisper = "quiet night") {
  if (!lampOn) return;
  lampOn = false;
  fistCharge = 0;
  wasFistClosed = false;
  warmthBridge = 0;
  friendWarmthGlow = 0;
  syncCameraWithLamp(false);

  if (appMode === "alone" && savedTrail.length > 0) {
    fadingTrail = true;
    trailAlpha = 180;
  }
  setWhisper(reasonWhisper);
}

async function syncCameraWithLamp(shouldEnable) {
  if (shouldEnable) {
    if (!cameraEnabled) {
      cameraEnabled = true;
      await startRearCamera();
    }
  } else {
    cameraEnabled = false;
    stopCameraStream();
  }
}

function initMediaPipeHands() {
  videoEl = document.createElement("video");
  videoEl.setAttribute("playsinline", "");
  videoEl.setAttribute("autoplay", "");
  videoEl.muted = true;
  videoEl.style.display = "none";
  document.body.appendChild(videoEl);

  if (typeof Hands === "undefined") return;

  handsModel = new Hands({
    locateFile: (file) =>
      `https://cdn.jsdelivr.net/npm/@mediapipe/hands/${file}`,
  });

  handsModel.setOptions({
    maxNumHands: 1,
    modelComplexity: 1,
    minDetectionConfidence: 0.58,
    minTrackingConfidence: 0.58,
  });

  handsModel.onResults((results) => {
    if (results.multiHandLandmarks && results.multiHandLandmarks.length > 0) {
      rawLandmarks = results.multiHandLandmarks[0];
      lastHandSeenTime = millis();
    } else {
      rawLandmarks = null;
    }
  });

  requestAnimationFrame(processVideoFrame);
}

async function startRearCamera() {
  if (!cameraEnabled) return;
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    setWhisper("no camera · touch fallback");
    return;
  }

  stopCameraStream();

  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      video: {
        facingMode: { ideal: "environment" },
        width: { ideal: 640 },
        height: { ideal: 480 },
      },
      audio: false,
    });
    if (!cameraEnabled) {
      stream.getTracks().forEach((track) => track.stop());
      return;
    }
    cameraStream = stream;
    videoEl.srcObject = stream;
    await videoEl.play();
    setWhisper(`rear cam · ${roomId}`);
  } catch (err) {
    cameraEnabled = false;
    setWhisper("cam blocked · touch/mouse");
  }
}

function stopCameraStream() {
  if (cameraStream) {
    cameraStream.getTracks().forEach((track) => track.stop());
    cameraStream = null;
  }
  if (videoEl && videoEl.srcObject) {
    videoEl.srcObject = null;
  }
  rawLandmarks = null;
  smoothLandmarks = null;
}

async function processVideoFrame() {
  if (
    lampOn &&
    cameraEnabled &&
    videoEl &&
    videoEl.readyState >= 2 &&
    handsModel &&
    !isProcessingFrame
  ) {
    isProcessingFrame = true;
    try {
      await handsModel.send({ image: videoEl });
    } catch (e) {}
    isProcessingFrame = false;
  }
  requestAnimationFrame(processVideoFrame);
}

// ==========================================
// 5. 무료 실시간 방 동기화 (Supabase Broadcast)
// ==========================================
function initRealtimeRoom() {
  if (
    !REALTIME_CONFIG.enabled ||
    !REALTIME_CONFIG.supabaseUrl ||
    !REALTIME_CONFIG.supabaseAnonKey ||
    typeof supabase === "undefined"
  ) {
    return;
  }

  const sbClient = supabase.createClient(
    REALTIME_CONFIG.supabaseUrl,
    REALTIME_CONFIG.supabaseAnonKey,
  );

  realtimeChannel = sbClient.channel(`shadow-nod:${roomId}`, {
    config: { broadcast: { self: false } },
  });

  realtimeChannel
    .on("broadcast", { event: "hand_update" }, ({ payload }) => {
      if (!payload || payload.sender === clientId) return;
      const wasDisconnected = !peerConnected;
      peerConnected = true;
      peerLampLit = Boolean(payload.lampOn);
      lastPeerSeenTime = millis();

      if (typeof payload.nx === "number" && typeof payload.ny === "number") {
        friendHand.hasRemote = true;
        friendHand.targetX = constrain(payload.nx, 0, 1) * width;
        friendHand.targetY = constrain(payload.ny, 0, 1) * height;
      }

      if (typeof payload.fistCharge === "number") {
        friendHand.fistCharge = constrain(payload.fistCharge, 0, 1);
        friendWarmthGlow = max(friendWarmthGlow, friendHand.fistCharge * 0.75);
      }

      if (payload.gesture === "wave") {
        spawnSandCluster(friendHand.targetX, friendHand.targetY, 5, 1);
        setWhisper("friend waved");
      } else if (payload.gesture === "overlap") {
        overlapPulse = max(overlapPulse, 0.9);
      } else if (payload.gesture === "fist_release") {
        spawnSandCluster(friendHand.targetX, friendHand.targetY, 10, 1);
        friendWarmthGlow = max(friendWarmthGlow, 0.85);
        overlapPulse = max(overlapPulse, 0.65);
        setWhisper("friend opened palm");
      } else if (payload.gesture === "warmth_share") {
        friendWarmthGlow = 1.0;
        spawnSandCluster(friendHand.targetX, friendHand.targetY, 6, 1);
        setWhisper("warmth shared");
      }

      if (wasDisconnected && !autoReplayedForPeer) {
        autoReplayedForPeer = true;
        playSavedNod();
      }
    })
    .on("broadcast", { event: "lamp_sync" }, ({ payload }) => {
      if (!payload || payload.sender === clientId) return;
      peerConnected = true;
      peerLampLit = Boolean(payload.lampOn);
      lastPeerSeenTime = millis();
      if (payload.lampOn) {
        setWhisper("friend lit lamp");
      }
    })
    .subscribe((status) => {
      if (status === "SUBSCRIBED") {
        setWhisper(`room · ${roomId}`);
      }
    });
}

function broadcastHandState(hand, gestureName = null) {
  if (!realtimeChannel || !hand || !hand.center) return;
  const now = millis();
  if (
    !gestureName &&
    now - lastBroadcastTime < REALTIME_CONFIG.sendIntervalMs
  ) {
    return;
  }
  lastBroadcastTime = now;

  realtimeChannel.send({
    type: "broadcast",
    event: "hand_update",
    payload: {
      sender: clientId,
      nx: constrain(hand.center.x / max(1, width), 0, 1),
      ny: constrain(hand.center.y / max(1, height), 0, 1),
      lampOn: lampOn,
      fistCharge: fistCharge,
      gesture: gestureName,
    },
  });
}

function broadcastLampLit() {
  if (!realtimeChannel) return;
  realtimeChannel.send({
    type: "broadcast",
    event: "lamp_sync",
    payload: {
      sender: clientId,
      lampOn: true,
    },
  });
}

function copyRoomLink() {
  const url = window.location.href;
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(url).then(() => {
      setWhisper("link copied");
    });
  } else {
    setWhisper(roomId);
  }
}

// ==========================================
// 6. 안부 녹화 & 재생 함수
// ==========================================
function loadSavedNodClip() {
  try {
    const raw = localStorage.getItem(NOD_STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch (e) {
    return [];
  }
}

function saveNodClipToStorage(clip) {
  try {
    localStorage.setItem(NOD_STORAGE_KEY, JSON.stringify(clip));
  } catch (e) {}
}

function toggleRecordNod() {
  if (!lampOn) {
    turnLampOn({ broadcast: true });
  }

  if (!isRecordingNod) {
    isRecordingNod = true;
    isReplayingNod = false;
    recordedClip = [];
    updateRecordButtonUI(true);
    setWhisper("recording nod...");
  } else {
    finishRecordingNod();
  }
}

function finishRecordingNod() {
  isRecordingNod = false;
  updateRecordButtonUI(false);

  if (recordedClip.length >= 5) {
    saveNodClipToStorage(recordedClip);
    setWhisper("nod saved");
  } else {
    recordedClip = [];
    setWhisper("too short");
  }
}

function captureNodFrame(hand, didWave) {
  if (!isRecordingNod || !hand || !hand.center) return;
  if (frameCount % 2 !== 0 && !didWave) return;

  let tilt = 0;
  if (hand.points && hand.points[0] && hand.points[9]) {
    let dx = hand.points[9].x - hand.points[0].x;
    let dy = hand.points[9].y - hand.points[0].y;
    tilt = atan2(dy, dx) + HALF_PI;
  }

  recordedClip.push({
    nx: constrain(hand.center.x / max(1, width), 0, 1),
    ny: constrain(hand.center.y / max(1, height), 0, 1),
    tilt: tilt,
    wave: Boolean(didWave),
  });

  if (recordedClip.length >= MAX_RECORD_FRAMES) {
    finishRecordingNod();
  }
}

function playSavedNod() {
  const clip = recordedClip.length > 0 ? recordedClip : loadSavedNodClip();
  if (!clip || clip.length === 0) {
    setWhisper("no saved nod");
    return;
  }

  if (!lampOn) {
    turnLampOn({ broadcast: true });
  }
  recordedClip = clip;
  isRecordingNod = false;
  updateRecordButtonUI(false);
  isReplayingNod = true;
  replayIndex = 0;
  lastReplayFrameTime = millis();
  setWhisper("replaying nod");
}

function updateReplayNod(ratio) {
  if (!isReplayingNod || ratio <= 0) return;
  if (!recordedClip || recordedClip.length === 0) {
    isReplayingNod = false;
    return;
  }

  const frame = recordedClip[replayIndex];
  const px = frame.nx * width;
  const py = frame.ny * height;
  const pts = buildFallbackHand(px, py, frame.tilt || 0, false);
  const center = p5.Vector.lerp(pts[0], pts[9], 0.52);

  renderTrueHandShadow({ points: pts, center: center }, 0.72 * ratio, false);

  if (frameCount % 2 === 0) {
    savedTrail.push({
      x: px,
      y: py,
      spread: random(4, 14),
    });
    if (savedTrail.length > 70) savedTrail.shift();
  }
  drawSandTrail(savedTrail, 165 * ratio);

  if (frame.wave) {
    spawnSandCluster(px, py, 4, ratio);
  }

  if (millis() - lastReplayFrameTime >= 33) {
    lastReplayFrameTime = millis();
    replayIndex++;
    if (replayIndex >= recordedClip.length) {
      isReplayingNod = false;
      setWhisper("nod ended");
    }
  }
}

function updateRecordButtonUI(recording) {
  const btn = document.getElementById("btn-record");
  if (!btn) return;
  btn.classList.toggle("active", recording);
  btn.innerText = recording ? "저장하기" : "안부 남기기";
}

// ==========================================
// 7. 메인 렌더링 루프
// ==========================================
function draw() {
  background(7, 11, 20);

  if (peerConnected && millis() - lastPeerSeenTime > 6000) {
    peerConnected = false;
    peerLampLit = false;
    friendHand.fistCharge = 0;
  }

  const breath = 0.5 + 0.5 * sin(frameCount * 0.032);
  const targetPeerGlow = peerConnected
    ? (peerLampLit ? 1.0 : 0.55) * (0.72 + 0.28 * breath)
    : 0;
  peerPresenceGlow = lerp(peerPresenceGlow, targetPeerGlow, 0.08);
  friendWarmthGlow = max(friendHand.fistCharge * 0.7, friendWarmthGlow - 0.015);

  let ratio = 0;
  if (lampOn) {
    let elapsed = millis() - lampStartTime;
    ratio = constrain(1 - elapsed / SESSION_DURATION, 0, 1);
    if (ratio <= 0) {
      turnLampOff("quiet night");
      ratio = 0;
    }
  }

  drawAmbientSky(ratio);
  drawMoonlightGlow(ratio);
  drawCornerLamp(ratio);
  drawFriendPresenceDot();

  let hand = getSmoothHandData();

  if (appMode === "together" && lampOn) {
    updateFriendShadow(ratio);
    if (hand) {
      lastWarmthHandPos = hand.center.copy();
      renderTrueHandShadow(hand, 0.85 * ratio, true);
      let didWave = runGestures(hand, ratio);
      captureNodFrame(hand, didWave);
      broadcastHandState(hand);
    } else {
      fistCharge = max(0, fistCharge - 0.05);
      warmthBridge = max(0, warmthBridge - 0.045);
      wasFistClosed = false;
    }
    drawWarmthBridge(ratio);
    drawEncounterGlow(ratio);
  } else if (appMode === "alone") {
    overlapHold = max(0, overlapHold - 0.04);
    warmthBridge = max(0, warmthBridge - 0.05);
    if (lampOn && hand) {
      renderTrueHandShadow(hand, 0.85 * ratio, true);
      let didWave = runGestures(hand, ratio);
      captureNodFrame(hand, didWave);
      broadcastHandState(hand);

      // 검지 손가락을 폈을 때 검지 끝(pts[8])에서 직접 노란 그라디언트 선을 이어 그림
      if (isIndexPointing(hand)) {
        let trailPos = getPointingTrailPos(hand);
        if (frameCount % 2 === 0) {
          savedTrail.push({
            x: trailPos.x,
            y: trailPos.y,
            spread: random(3, 11),
          });
          if (savedTrail.length > 95) savedTrail.shift();
        }
      }
      drawSandTrail(savedTrail, 210 * ratio);
    } else {
      fistCharge = max(0, fistCharge - 0.05);
      wasFistClosed = false;
      if (fadingTrail) {
        trailAlpha -= 2.0;
        drawSandTrail(savedTrail, max(0, trailAlpha));
        if (trailAlpha <= 0) {
          fadingTrail = false;
          savedTrail = [];
          setWhisper("faded");
        }
      }
    }
  }

  updateReplayNod(ratio);
  updateLightRays();
  updateSandDust();
}

function isIndexPointing(hand) {
  if (!hand || !hand.points || hand.points.length < 21) {
    return manualPointingActive;
  }
  if (!hand.isWebcam) {
    return manualPointingActive;
  }

  let pts = hand.points;
  let wrist = pts[0];
  let palmSize = max(1, dist(wrist.x, wrist.y, pts[9].x, pts[9].y));
  let dIndex = dist(wrist.x, wrist.y, pts[8].x, pts[8].y) / palmSize;
  let dMiddle = dist(wrist.x, wrist.y, pts[12].x, pts[12].y) / palmSize;
  let dRing = dist(wrist.x, wrist.y, pts[16].x, pts[16].y) / palmSize;
  let dPinky = dist(wrist.x, wrist.y, pts[20].x, pts[20].y) / palmSize;

  return dIndex > 1.48 && dMiddle < 1.28 && dRing < 1.28 && dPinky < 1.32;
}

function getPointingTrailPos(hand) {
  if (hand && hand.points && hand.points[8]) {
    return hand.points[8];
  }
  if (hand && hand.center) {
    return hand.center;
  }
  return createVector(mouseX, mouseY);
}

function getSmoothHandData() {
  if (
    lampOn &&
    cameraEnabled &&
    rawLandmarks &&
    millis() - lastHandSeenTime < 250
  ) {
    let mapped = rawLandmarks.map((lm) => {
      let x = lm.x * width;
      let y = lm.y * height;
      return createVector(x, y);
    });

    if (!smoothLandmarks || smoothLandmarks.length !== mapped.length) {
      smoothLandmarks = mapped.map((v) => v.copy());
    } else {
      for (let i = 0; i < mapped.length; i++) {
        smoothLandmarks[i].lerp(mapped[i], 0.55);
      }
    }

    let center = p5.Vector.lerp(smoothLandmarks[0], smoothLandmarks[9], 0.52);
    return { points: smoothLandmarks, center: center, isWebcam: true };
  }

  smoothLandmarks = null;

  if (
    lampOn &&
    mouseX > 0 &&
    mouseY > 0 &&
    (mouseIsPressed ||
      touches.length > 0 ||
      !cameraEnabled ||
      manualPointingActive)
  ) {
    let vx = mouseX - (prevCenter ? prevCenter.x : mouseX);
    let vy = mouseY - (prevCenter ? prevCenter.y : mouseY);
    let tilt = constrain(vx * 0.012 + vy * 0.004, -0.35, 0.35);
    let pts = buildFallbackHand(mouseX, mouseY, tilt, manualFistHeld);
    let center = p5.Vector.lerp(pts[0], pts[9], 0.52);
    return { points: pts, center: center, isWebcam: false };
  }

  return null;
}

function buildFallbackHand(cx, cy, tilt, isFist = false) {
  let pts = new Array(21);
  function rot(dx, dy) {
    let rx = dx * cos(tilt) - dy * sin(tilt);
    let ry = dx * sin(tilt) + dy * cos(tilt);
    return createVector(cx + rx, cy + ry);
  }

  pts[0] = rot(0, 48);
  pts[1] = rot(-24, 28);
  pts[2] = rot(-44, 10);
  pts[3] = rot(-52, -4);
  pts[4] = rot(isFist ? -32 : -68, isFist ? -16 : -22);

  let fingers = isFist
    ? [
        { s: 5, bx: -22, by: -12, tx: -20, ty: -30 },
        { s: 9, bx: -7, by: -15, tx: -6, ty: -34 },
        { s: 13, bx: 9, by: -13, tx: 10, ty: -31 },
        { s: 17, bx: 23, by: -9, tx: 22, ty: -26 },
      ]
    : [
        { s: 5, bx: -24, by: -14, tx: -30, ty: -68 },
        { s: 9, bx: -8, by: -18, tx: -8, ty: -78 },
        { s: 13, bx: 10, by: -16, tx: 14, ty: -72 },
        { s: 17, bx: 25, by: -10, tx: 34, ty: -56 },
      ];

  for (let f of fingers) {
    for (let k = 0; k < 4; k++) {
      let t = k / 3;
      pts[f.s + k] = rot(lerp(f.bx, f.tx, t), lerp(f.by, f.ty, t));
    }
  }
  return pts;
}

function renderTrueHandShadow(hand, alphaScale, withRimLight) {
  if (alphaScale <= 0) return;
  let pts = hand.points;

  let handScale = dist(pts[0].x, pts[0].y, pts[9].x, pts[9].y);
  handScale = constrain(handScale, 45, 240);

  shadowLayer.clear();
  shadowLayer.push();
  shadowLayer.fill(5, 8, 16, 255);
  shadowLayer.noStroke();

  let palmPoints = [pts[0], pts[1], pts[2], pts[5], pts[9], pts[13], pts[17]];
  let hull = computeConvexHull(palmPoints);
  if (hull.length >= 3) {
    shadowLayer.beginShape();
    for (let p of hull) {
      shadowLayer.vertex(p.x, p.y);
    }
    shadowLayer.endShape(CLOSE);
  }

  let palmMid = p5.Vector.lerp(pts[0], pts[9], 0.5);
  shadowLayer.ellipse(palmMid.x, palmMid.y, handScale * 0.72, handScale * 0.78);

  let wrist = pts[0];
  let armVec = p5.Vector.sub(wrist, palmMid).normalize();
  let forearmTip = p5.Vector.add(
    wrist,
    p5.Vector.mult(armVec, handScale * 0.65),
  );
  drawSmoothBone(
    shadowLayer,
    wrist,
    forearmTip,
    handScale * 0.44,
    handScale * 0.36,
  );

  let chains = [
    [0, 1, 2, 3, 4],
    [5, 6, 7, 8],
    [9, 10, 11, 12],
    [13, 14, 15, 16],
    [17, 18, 19, 20],
  ];

  for (let cIdx = 0; cIdx < chains.length; cIdx++) {
    let chain = chains[cIdx];
    let rStart = cIdx === 0 ? handScale * 0.23 : handScale * 0.17;
    let rEnd = cIdx === 0 ? handScale * 0.13 : handScale * 0.095;

    for (let i = 0; i < chain.length - 1; i++) {
      let a = pts[chain[i]];
      let b = pts[chain[i + 1]];
      let w1 = map(i, 0, chain.length - 1, rStart, rEnd);
      let w2 = map(i + 1, 0, chain.length - 1, rStart, rEnd);
      drawSmoothBone(shadowLayer, a, b, w1, w2);
    }
  }
  shadowLayer.pop();

  let blurPx = withRimLight ? 15 : 20;

  push();
  if (withRimLight) {
    drawingContext.shadowColor = `rgba(246, 231, 193, ${0.22 * alphaScale})`;
    drawingContext.shadowBlur = 18;
  }
  drawingContext.filter = `blur(${blurPx}px)`;
  tint(255, (withRimLight ? 215 : 145) * alphaScale);
  image(shadowLayer, 0, 0);
  drawingContext.filter = "none";
  drawingContext.shadowBlur = 0;
  noTint();
  pop();
}

function drawSmoothBone(pg, p1, p2, w1, w2) {
  let d = dist(p1.x, p1.y, p2.x, p2.y);
  if (d < 0.5) return;

  let nx = -(p2.y - p1.y) / d;
  let ny = (p2.x - p1.x) / d;

  pg.noStroke();
  pg.quad(
    p1.x + nx * w1 * 0.5,
    p1.y + ny * w1 * 0.5,
    p2.x + nx * w2 * 0.5,
    p2.y + ny * w2 * 0.5,
    p2.x - nx * w2 * 0.5,
    p2.y - ny * w2 * 0.5,
    p1.x - nx * w1 * 0.5,
    p1.y - ny * w1 * 0.5,
  );
  pg.circle(p1.x, p1.y, w1);
  pg.circle(p2.x, p2.y, w2);
}

function computeConvexHull(points) {
  let pts = points
    .slice()
    .sort((a, b) => (a.x === b.x ? a.y - b.y : a.x - b.x));
  if (pts.length <= 2) return pts;

  const cross = (o, a, b) =>
    (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);

  let lower = [];
  for (let p of pts) {
    while (
      lower.length >= 2 &&
      cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0
    ) {
      lower.pop();
    }
    lower.push(p);
  }

  let upper = [];
  for (let i = pts.length - 1; i >= 0; i--) {
    let p = pts[i];
    while (
      upper.length >= 2 &&
      cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0
    ) {
      upper.pop();
    }
    upper.push(p);
  }

  upper.pop();
  lower.pop();
  return lower.concat(upper);
}

function updateFriendShadow(ratio) {
  friendHand.t += 0.012;

  if (friendHand.hasRemote && millis() - lastPeerSeenTime < 6000) {
    friendHand.x = lerp(friendHand.x, friendHand.targetX, 0.22);
    friendHand.y = lerp(friendHand.y, friendHand.targetY, 0.22);
  } else {
    friendHand.hasRemote = false;
    friendHand.x = width / 2 + cos(friendHand.t) * 60;
    friendHand.y = height / 2 + sin(friendHand.t * 0.85) * 42;
  }

  let fPts = buildFallbackHand(
    friendHand.x,
    friendHand.y,
    PI + sin(friendHand.t * 0.7) * 0.2,
    friendHand.fistCharge > 0.35,
  );
  let fCenter = p5.Vector.lerp(fPts[0], fPts[9], 0.5);
  renderTrueHandShadow({ points: fPts, center: fCenter }, 0.65 * ratio, false);

  if (friendWarmthGlow > 0.02 && ratio > 0) {
    push();
    const ctx = drawingContext;
    const fgR = min(width, height) * (0.12 + 0.1 * friendWarmthGlow);
    const fGrad = ctx.createRadialGradient(
      friendHand.x,
      friendHand.y,
      3,
      friendHand.x,
      friendHand.y,
      fgR,
    );
    fGrad.addColorStop(
      0,
      `rgba(255, 244, 212, ${0.24 * friendWarmthGlow * ratio})`,
    );
    fGrad.addColorStop(
      0.48,
      `rgba(238, 204, 134, ${0.11 * friendWarmthGlow * ratio})`,
    );
    fGrad.addColorStop(1, "rgba(7, 11, 20, 0)");
    ctx.save();
    ctx.fillStyle = fGrad;
    ctx.fillRect(0, 0, width, height);
    ctx.restore();
    pop();
  }
}

function drawWarmthBridge(ratio) {
  if (ratio <= 0 || warmthBridge <= 0.02 || !lastWarmthHandPos) return;

  push();
  const ctx = drawingContext;
  const ax = lastWarmthHandPos.x;
  const ay = lastWarmthHandPos.y;
  const bx = friendHand.x;
  const by = friendHand.y;
  const mx = (ax + bx) * 0.5;
  const my = (ay + by) * 0.5;
  const span = max(40, dist(ax, ay, bx, by));

  const bridgeR = span * 0.65 + min(width, height) * 0.1;
  const grad = ctx.createRadialGradient(mx, my, 6, mx, my, bridgeR);
  grad.addColorStop(0, `rgba(255, 245, 214, ${0.25 * warmthBridge * ratio})`);
  grad.addColorStop(
    0.45,
    `rgba(240, 206, 134, ${0.13 * warmthBridge * ratio})`,
  );
  grad.addColorStop(1, "rgba(7, 11, 20, 0)");

  ctx.save();
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, width, height);
  ctx.restore();

  noStroke();
  for (let i = 0; i < 5; i++) {
    let travel = (frameCount * 0.016 + i * 0.2) % 1;
    let px = lerp(ax, bx, travel);
    let py =
      lerp(ay, by, travel) + sin(travel * PI + frameCount * 0.05 + i) * 8;
    let pAlpha = sin(travel * PI) * 175 * warmthBridge * ratio;
    fill(255, 244, 210, pAlpha);
    circle(px, py, 2.2 + sin(travel * PI) * 1.6);
  }
  pop();
}

function drawEncounterGlow(ratio) {
  if (ratio <= 0) return;
  overlapPulse = max(0, overlapPulse - 0.025);
  const intensity = max(overlapHold * 0.75, overlapPulse);
  if (intensity <= 0.01) return;

  push();
  const ctx = drawingContext;
  const mx = (width * 0.5 + friendHand.x) * 0.5;
  const my = (height * 0.48 + friendHand.y) * 0.5;
  const radius = min(width, height) * (0.18 + 0.16 * intensity);

  const grad = ctx.createRadialGradient(mx, my, 4, mx, my, radius);
  grad.addColorStop(0, `rgba(255, 244, 212, ${0.22 * intensity * ratio})`);
  grad.addColorStop(0.45, `rgba(238, 206, 138, ${0.1 * intensity * ratio})`);
  grad.addColorStop(1, "rgba(7, 11, 20, 0)");

  ctx.save();
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, width, height);
  ctx.restore();
  pop();
}

function drawFistWarmth(center, palmSize, charge, ratio) {
  if (charge <= 0.01 || ratio <= 0) return;

  push();
  const ctx = drawingContext;
  const pulse = 0.86 + 0.14 * sin(frameCount * 0.08);
  const coreR = palmSize * (0.34 + 0.32 * charge) * pulse;
  const haloR = palmSize * (0.85 + 0.9 * charge);

  const grad = ctx.createRadialGradient(
    center.x,
    center.y,
    2,
    center.x,
    center.y,
    haloR,
  );
  grad.addColorStop(0, `rgba(255, 246, 218, ${0.34 * charge * ratio})`);
  grad.addColorStop(0.35, `rgba(244, 204, 128, ${0.18 * charge * ratio})`);
  grad.addColorStop(0.75, `rgba(180, 138, 78, ${0.06 * charge * ratio})`);
  grad.addColorStop(1, "rgba(7, 11, 20, 0)");

  ctx.save();
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, width, height);
  ctx.restore();

  noStroke();
  for (let i = 0; i < 6; i++) {
    let ang = frameCount * 0.04 + (TWO_PI / 6) * i;
    let distFromCenter = (1 - charge * 0.65) * palmSize * 0.58;
    let px = center.x + cos(ang) * distFromCenter;
    let py = center.y + sin(ang) * distFromCenter;
    fill(255, 243, 205, 150 * charge * ratio);
    circle(px, py, 2.2 + charge * 1.4);
  }

  fill(255, 245, 214, 130 * charge * ratio);
  circle(center.x, center.y, coreR * 0.42);
  pop();
}

function runGestures(hand, ratio) {
  let c = hand.center;
  let pts = hand.points;
  let didWave = false;
  let wrist = pts[0];
  let palmSize = max(1, dist(wrist.x, wrist.y, pts[9].x, pts[9].y));

  let isFistClosed = false;
  if (hand.isWebcam) {
    let dIndex = dist(wrist.x, wrist.y, pts[8].x, pts[8].y) / palmSize;
    let dMiddle = dist(wrist.x, wrist.y, pts[12].x, pts[12].y) / palmSize;
    let dRing = dist(wrist.x, wrist.y, pts[16].x, pts[16].y) / palmSize;
    let dPinky = dist(wrist.x, wrist.y, pts[20].x, pts[20].y) / palmSize;

    isFistClosed =
      dIndex < 1.15 && dMiddle < 1.15 && dRing < 1.15 && dPinky < 1.22;

    if (!isFistClosed && isIndexPointing(hand)) {
      if (frameCount % 3 === 0) {
        spawnSandCluster(pts[8].x, pts[8].y, 2, ratio);
      }
      if (appMode !== "alone") {
        setWhisper("starlight");
      }
    }
  } else {
    isFistClosed = manualFistHeld;
  }

  if (isFistClosed) {
    fistCharge = min(1.0, fistCharge + 0.055);
    wasFistClosed = true;
    drawFistWarmth(c, palmSize, fistCharge, ratio);
    setWhisper("holding warmth");
  } else {
    if (wasFistClosed && fistCharge > 0.28) {
      let burstCount = floor(8 + fistCharge * 12);
      spawnSandCluster(c.x, c.y, burstCount, ratio);
      for (let i = 0; i < 6; i++) {
        let ang = (TWO_PI / 6) * i + random(-0.25, 0.25);
        lightRays.push({
          x: c.x,
          y: c.y,
          vx: cos(ang) * random(1.1, 2.6) * (0.6 + fistCharge),
          vy: sin(ang) * random(1.1, 2.6) * (0.6 + fistCharge),
          len: random(14, 30),
          alpha: 165 * ratio * fistCharge,
        });
      }
      overlapPulse = max(overlapPulse, fistCharge * 0.65);
      setWhisper("released");
      broadcastHandState(hand, "fist_release");
    }
    wasFistClosed = false;
    fistCharge = max(0, fistCharge - 0.045);
    if (fistCharge > 0.02) {
      drawFistWarmth(c, palmSize, fistCharge, ratio);
    }
  }

  let dToFriend = dist(c.x, c.y, friendHand.x, friendHand.y);
  if (fistCharge > 0.15 && dToFriend < 175) {
    let proximity = map(dToFriend, 175, 45, 0.15, 1.0, true);
    let targetBridge = min(1.0, fistCharge * proximity * 1.15);
    warmthBridge = lerp(warmthBridge, targetBridge, 0.16);
    friendWarmthGlow = max(friendWarmthGlow, warmthBridge * 0.85);

    if (frameCount % 4 === 0) {
      spawnSandCluster(
        lerp(c.x, friendHand.x, 0.55),
        lerp(c.y, friendHand.y, 0.55),
        2,
        ratio * warmthBridge,
      );
    }

    if (dToFriend < 88 && fistCharge > 0.22) {
      let transfer = min(fistCharge * 0.04, 0.025);
      fistCharge = max(0.12, fistCharge - transfer);
      setWhisper("passing warmth");
      if (frameCount % 12 === 0) {
        broadcastHandState(hand, "warmth_share");
      }
    } else {
      setWhisper("warmth reaching");
    }
  } else {
    warmthBridge = max(0, warmthBridge - 0.045);
  }

  if (prevCenter) {
    let speed = dist(c.x, c.y, prevCenter.x, prevCenter.y);
    if (speed > 7) {
      didWave = true;
      let angle =
        atan2(c.y - prevCenter.y, c.x - prevCenter.x) + random(-0.4, 0.4);
      lightRays.push({
        x: c.x,
        y: c.y,
        vx: cos(angle) * random(1.2, 3.2),
        vy: sin(angle) * random(1.2, 3.2),
        len: random(16, 42),
        alpha: 170 * ratio,
      });
      spawnSandCluster(c.x, c.y, 3, ratio);
      if (!isFistClosed && warmthBridge <= 0.1 && !isIndexPointing(hand)) {
        setWhisper("wave");
      }
      broadcastHandState(hand, "wave");
    }
  }
  prevCenter = c.copy();

  if (dToFriend < 78) {
    overlapHold = min(1.0, overlapHold + 0.08);
    overlapPulse = max(overlapPulse, 0.55);
    spawnSandCluster(
      (c.x + friendHand.x) * 0.5,
      (c.y + friendHand.y) * 0.5,
      4,
      ratio,
    );
    if (fistCharge <= 0.15) {
      setWhisper("overlap");
    }

    if (!wasOverlapping) {
      wasOverlapping = true;
      overlapPulse = 1.0;
      if (navigator.vibrate) navigator.vibrate(40);
      broadcastHandState(hand, "overlap");
    }
  } else {
    overlapHold = max(0, overlapHold - 0.05);
    wasOverlapping = false;
  }

  return didWave;
}

function drawAmbientSky(ratio) {
  push();
  noStroke();
  for (let p of dustParticles) {
    p.x += p.driftX;
    p.y += p.driftY;
    p.twinkle += 0.02;

    if (p.x < 0) p.x = width;
    if (p.x > width) p.x = 0;
    if (p.y < 0) p.y = height;
    if (p.y > height) p.y = 0;

    let a =
      p.alpha *
      (0.55 + 0.45 * sin(p.twinkle)) *
      (0.35 + 0.65 * max(ratio, peerPresenceGlow * 0.45));
    fill(246, 231, 193, a);
    circle(p.x, p.y, p.r);
  }
  pop();
}

function drawMoonlightGlow(ratio) {
  overlapPulse = max(0, overlapPulse - 0.03);
  const ambientLevel = max(ratio, peerPresenceGlow * 0.42);
  if (ambientLevel <= 0.01) return;

  push();
  const ctx = drawingContext;
  const cx = width * 0.5;
  const cy = height * 0.47;
  const radius =
    min(width, height) * (0.48 + 0.26 * ambientLevel) + overlapPulse * 56;

  const grad = ctx.createRadialGradient(cx, cy, radius * 0.04, cx, cy, radius);
  grad.addColorStop(
    0,
    `rgba(255, 240, 200, ${0.14 * ambientLevel + overlapPulse * 0.06})`,
  );
  grad.addColorStop(
    0.32,
    `rgba(232, 198, 128, ${0.085 * ambientLevel + overlapPulse * 0.04})`,
  );
  grad.addColorStop(0.68, `rgba(42, 62, 102, ${0.045 * ambientLevel})`);
  grad.addColorStop(1, "rgba(7, 11, 20, 0)");

  ctx.save();
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, width, height);
  ctx.restore();
  pop();
}

function getCornerLampBounds() {
  let lx = width / 2 - min(width, height) * 0.25;
  let ly = height / 2 + min(width, height) * 0.23;
  return { x: lx, y: ly, radius: 44 };
}

function isLampHovered() {
  if (mouseY < 65) return false;
  const lamp = getCornerLampBounds();
  return dist(mouseX, mouseY, lamp.x, lamp.y - 4) <= lamp.radius;
}

function drawCornerLamp(ratio) {
  const lamp = getCornerLampBounds();
  const hovered = isLampHovered();

  lampHoverGlow = lerp(lampHoverGlow, hovered ? 1 : 0, 0.14);
  cursor(hovered ? HAND : ARROW);

  push();
  const ctx = drawingContext;

  const glowStrength = max(ratio * 0.85, lampHoverGlow * 0.55);
  if (glowStrength > 0.01) {
    const glowR =
      min(width, height) * (0.24 + 0.12 * ratio + 0.05 * lampHoverGlow);
    const lampGrad = ctx.createRadialGradient(
      lamp.x,
      lamp.y - 8,
      4,
      lamp.x,
      lamp.y - 4,
      glowR,
    );
    lampGrad.addColorStop(0, `rgba(255, 242, 204, ${0.24 * glowStrength})`);
    lampGrad.addColorStop(0.38, `rgba(236, 202, 134, ${0.11 * glowStrength})`);
    lampGrad.addColorStop(0.75, `rgba(120, 102, 74, ${0.03 * glowStrength})`);
    lampGrad.addColorStop(1, "rgba(7, 11, 20, 0)");

    ctx.save();
    ctx.fillStyle = lampGrad;
    ctx.fillRect(0, 0, width, height);
    ctx.restore();
  }

  translate(lamp.x, lamp.y);

  if (lampHoverGlow > 0.01) {
    noFill();
    stroke(246, 231, 193, 62 * lampHoverGlow);
    strokeWeight(1.1);
    circle(0, -6, 52 + lampHoverGlow * 6);
  }

  noStroke();
  let bodyAlpha = (ratio > 0 ? 82 : 34) + lampHoverGlow * 55;
  fill(246, 231, 193, min(220, bodyAlpha));
  quad(-14, -16, 14, -16, 22, 2, -22, 2);
  rect(-1.5, 2, 3, 20);
  rect(-11, 22, 22, 3, 1.5);
  pop();
}

function drawFriendPresenceDot() {
  push();
  let dx = width / 2 + min(width, height) * 0.26;
  let dy = height / 2 - min(width, height) * 0.25;
  let activePeer = appMode === "together" && peerConnected;

  if (peerPresenceGlow > 0.02) {
    const ctx = drawingContext;
    const haloR = min(width, height) * (0.09 + 0.04 * peerPresenceGlow);
    const haloGrad = ctx.createRadialGradient(dx, dy, 2, dx, dy, haloR);
    haloGrad.addColorStop(0, `rgba(255, 243, 205, ${0.22 * peerPresenceGlow})`);
    haloGrad.addColorStop(
      0.5,
      `rgba(236, 202, 134, ${0.08 * peerPresenceGlow})`,
    );
    haloGrad.addColorStop(1, "rgba(7, 11, 20, 0)");
    ctx.save();
    ctx.fillStyle = haloGrad;
    ctx.fillRect(0, 0, width, height);
    ctx.restore();
  }

  if (activePeer) {
    noStroke();
    fill(246, 224, 168, 42);
    circle(dx, dy, 28);
    fill(255, 243, 205, 220);
    circle(dx, dy, 8);
  } else {
    noFill();
    stroke(246, 231, 193, appMode === "together" ? 95 : 55);
    strokeWeight(1.2);
    circle(dx, dy, 8);
  }
  pop();
}

function keyPressed() {
  let cx = mouseX > 0 ? mouseX : width / 2;
  let cy = mouseY > 0 ? mouseY : height / 2;
  if (!lampOn) {
    turnLampOn({ broadcast: true });
  }

  if (key === "1") {
    for (let i = 0; i < 6; i++) {
      let ang = random(TWO_PI);
      lightRays.push({
        x: cx,
        y: cy,
        vx: cos(ang) * random(1.5, 3.5),
        vy: sin(ang) * random(1.5, 3.5),
        len: random(22, 48),
        alpha: 190,
      });
    }
    setWhisper("wave");
  } else if (key === "2") {
    overlapPulse = 1.0;
    spawnSandCluster(width / 2, height / 2, 18, 1);
    if (navigator.vibrate) navigator.vibrate(40);
    setWhisper("overlap");
  } else if (key === "3") {
    manualPointingActive = !manualPointingActive;
    spawnSandCluster(cx, cy, 10, 1);
    setWhisper(manualPointingActive ? "pointing trail" : "point off");
  } else if (key === "4" || key === "f" || key === "F") {
    manualFistHeld = !manualFistHeld;
    setWhisper(manualFistHeld ? "holding warmth" : "released");
  } else if (key === "m" || key === "M") {
    setMode(appMode === "together" ? "alone" : "together");
  } else if (key === "r" || key === "R") {
    turnLampOn({ broadcast: true });
  }
}

function spawnSandCluster(x, y, count, ratio) {
  for (let i = 0; i < count; i++) {
    dustParticles.push({
      x: x + random(-18, 18),
      y: y + random(-18, 18),
      r: random(1.2, 3.4),
      alpha: 220 * ratio,
      driftX: random(-0.9, 0.9),
      driftY: random(-1.4, 0.5),
      twinkle: random(TWO_PI),
    });
    if (dustParticles.length > 160) dustParticles.shift();
  }
}

function updateLightRays() {
  for (let i = lightRays.length - 1; i >= 0; i--) {
    let r = lightRays[i];
    let px = r.x;
    let py = r.y;
    r.x += r.vx;
    r.y += r.vy;
    r.alpha -= 3.2;

    push();
    stroke(248, 229, 178, max(0, r.alpha));
    strokeWeight(1.5);
    line(px, py, px - r.vx * 5, py - r.vy * 5);
    noStroke();
    fill(255, 245, 214, max(0, r.alpha));
    circle(r.x, r.y, 3);
    pop();

    if (r.alpha <= 0) lightRays.splice(i, 1);
  }
}

function updateSandDust() {
  for (let i = dustParticles.length - 1; i >= 65; i--) {
    let p = dustParticles[i];
    p.x += p.driftX;
    p.y += p.driftY;
    p.alpha -= 2.4;
    if (p.alpha <= 0) dustParticles.splice(i, 1);
  }
}

function drawSandTrail(trail, alphaVal) {
  if (trail.length < 2 || alphaVal <= 0) return;

  push();
  const ctx = drawingContext;
  const startPt = trail[0];
  const endPt = trail[trail.length - 1];
  const aNorm = constrain(alphaVal / 255, 0, 1);

  const grad = ctx.createLinearGradient(startPt.x, startPt.y, endPt.x, endPt.y);
  grad.addColorStop(0, `rgba(232, 194, 118, 0)`);
  grad.addColorStop(0.35, `rgba(244, 214, 148, ${0.32 * aNorm})`);
  grad.addColorStop(0.82, `rgba(255, 238, 188, ${0.58 * aNorm})`);
  grad.addColorStop(1, `rgba(255, 246, 214, ${0.78 * aNorm})`);

  ctx.save();
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  ctx.strokeStyle = grad;
  ctx.lineWidth = 10;
  ctx.filter = "blur(6px)";
  ctx.beginPath();
  ctx.moveTo(trail[0].x, trail[0].y);
  for (let i = 1; i < trail.length; i++) {
    ctx.lineTo(trail[i].x, trail[i].y);
  }
  ctx.stroke();
  ctx.restore();

  ctx.save();
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  ctx.strokeStyle = grad;
  ctx.lineWidth = 2.6;
  ctx.beginPath();
  ctx.moveTo(trail[0].x, trail[0].y);
  for (let i = 1; i < trail.length; i++) {
    ctx.lineTo(trail[i].x, trail[i].y);
  }
  ctx.stroke();
  ctx.restore();

  noStroke();
  for (let i = 0; i < trail.length; i++) {
    let pt = trail[i];
    let tRatio = i / max(1, trail.length - 1);
    fill(255, 244, 210, alphaVal * 0.55 * tRatio);
    circle(
      pt.x + sin(pt.x * 0.05 + i) * pt.spread * 0.45,
      pt.y + cos(pt.y * 0.05 + i) * pt.spread * 0.45,
      1.8,
    );
  }
  pop();
}

function mousePressed() {
  if (mouseY < 65) return;

  if (mouseButton === RIGHT && lampOn) {
    manualFistHeld = true;
    return;
  }

  if (isLampHovered()) {
    if (!lampOn) {
      turnLampOn({ broadcast: true });
    } else {
      turnLampOff("lamp off");
    }
    return;
  }

  if (!lampOn && appMode === "alone" && savedTrail.length > 0 && !fadingTrail) {
    fadingTrail = true;
    trailAlpha = 210;
    setWhisper("trace");
  }
}

function mouseReleased() {
  if (mouseButton === RIGHT && manualFistHeld) {
    manualFistHeld = false;
  }
}

function setMode(mode) {
  appMode = mode;
  document
    .getElementById("btn-together")
    .classList.toggle("active", mode === "together");
  document
    .getElementById("btn-alone")
    .classList.toggle("active", mode === "alone");

  if (mode === "alone" && !lampOn && savedTrail.length > 0) {
    fadingTrail = true;
    trailAlpha = 180;
  }
  setWhisper(mode === "together" ? "together" : "alone");
}

function setWhisper(txt) {
  document.getElementById("whisper-text").innerText = txt;
}

function windowResized() {
  resizeCanvas(windowWidth, windowHeight);
  shadowLayer = createGraphics(windowWidth, windowHeight);
  shadowLayer.pixelDensity(pixelDensity());
}
