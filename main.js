import { loadModel, isReady, classify } from './yamnet.js';

// ── DOM refs ────────────────────────────────────────────────────
const $ = id => document.getElementById(id);
const micSelect = $('mic-select'), gainSlider = $('gain-slider'), gainValue = $('gain-value');
const highpassSlider = $('highpass-slider'), highpassValue = $('highpass-value');
const lowpassSlider = $('lowpass-slider'), lowpassValue = $('lowpass-value');
const thresholdSlider = $('threshold-slider'), thresholdValue = $('threshold-value');
const alertSlider = $('alert-slider'), alertValue = $('alert-value');
const monitorToggle = $('monitor-toggle'), alertsToggle = $('alerts-toggle'), startBtn = $('start-btn'), statusDot = $('status-dot');
const breathStatusCard = $('breath-status-card'), breathIcon = $('breath-icon');
const breathLabel = $('breath-label'), breathDetail = $('breath-detail');
const breathMeterBar = $('breath-meter-bar'), breathThresholdLine = $('breath-threshold-line');
const bpmValue = $('bpm-value'), lastBreathValue = $('last-breath-value'), silenceValue = $('silence-value');
const alertOverlay = $('alert-overlay'), alertMessage = $('alert-message'), dismissAlertBtn = $('dismiss-alert-btn');
const autodetectBtn = $('autodetect-btn'), autodetectHint = $('autodetect-hint');
const autodetectProgress = $('autodetect-progress'), autodetectBar = $('autodetect-bar');
const presetSelect = $('preset-select'), loadPresetBtn = $('load-preset-btn');
const savePresetBtn = $('save-preset-btn'), deletePresetBtn = $('delete-preset-btn');
const cryToggle = $('cry-toggle'), cryDurationSlider = $('cry-duration-slider'), cryDurationValue = $('cry-duration-value');
const cryStatusCard = $('cry-status-card'), cryIcon = $('cry-icon'), cryLabel = $('cry-label'), cryDetail = $('cry-detail'), cryMeterBar = $('cry-meter-bar');
const modelBadge = $('model-badge');
const crySensitivitySlider = $('cry-sensitivity-slider'), crySensitivityValue = $('cry-sensitivity-value');
const sleepStageCard = $('sleep-stage-card'), sleepIcon = $('sleep-icon'), sleepLabel = $('sleep-label'), sleepDetail = $('sleep-detail');
const avgBpmValue = $('avg-bpm-value'), avgIntervalValue = $('avg-interval-value'), breathVariabilityValue = $('breath-variability-value');
const waveformCanvas = $('waveform-canvas'), spectrumCanvas = $('spectrum-canvas'), historyCanvas = $('history-canvas');
const wCtx = waveformCanvas.getContext('2d'), sCtx = spectrumCanvas.getContext('2d'), hCtx = historyCanvas.getContext('2d');

// ── State ───────────────────────────────────────────────────────
let audioContext=null, mediaStream=null, sourceNode=null, gainNode=null;
let highpassFilter=null, lowpassFilter=null, analyserFiltered=null, analyserRaw=null;
let isRunning=false, animationId=null, historyInterval=null;
let lastBreathTime=0, breathTimestamps=[], breathHistory=[], isCurrentlyBreathing=false;
let alertFired=false, alertOscillator=null, alertGainNode=null;
let cryAlertFired=false;
const HISTORY_LENGTH = 600;
const STORAGE_KEY = 'bbm_presets';
let sleepInterval = null;

// ── YAMNet state ────────────────────────────────────────────────
let rawAudioBuffer = null, rawBufferPos = 0, rawSampleRate = 48000;
let scriptNode = null, silentGainNode = null, yamnetInterval = null;
let consecutiveCryFrames = 0;
const YAMNET_INTERVAL_MS = 1500;
let wakeLockSentinel = null;
// Moving average: store detected breath timestamps for 5-min window
// Sleep stage is estimated every 10s from this data

// ── Canvas resize ───────────────────────────────────────────────
function resizeAllCanvases() {
  [waveformCanvas, spectrumCanvas, historyCanvas, trendCanvas].forEach(c => {
    const dpr = window.devicePixelRatio || 1;
    c.width = c.clientWidth * dpr; c.height = c.clientHeight * dpr;
    c.getContext('2d').scale(dpr, dpr);
  });
}
window.addEventListener('resize', resizeAllCanvases);

// ── Devices ─────────────────────────────────────────────────────
async function getDevices() {
  try {
    const s = await navigator.mediaDevices.getUserMedia({ audio: true });
    const devs = (await navigator.mediaDevices.enumerateDevices()).filter(d => d.kind === 'audioinput');
    micSelect.innerHTML = '';
    devs.forEach((d,i) => { const o = document.createElement('option'); o.value = d.deviceId; o.text = d.label || `Mic ${i+1}`; micSelect.appendChild(o); });
    s.getTracks().forEach(t => t.stop());
  } catch(e) { micSelect.innerHTML = '<option value="">Permissão negada</option>'; }
}

// ── Slider bindings ─────────────────────────────────────────────
gainSlider.oninput = e => { gainValue.textContent = `${parseFloat(e.target.value)}x`; if(gainNode) gainNode.gain.setTargetAtTime(parseFloat(e.target.value), audioContext.currentTime, 0.02); };
highpassSlider.oninput = e => { highpassValue.textContent = `${e.target.value} Hz`; if(highpassFilter) highpassFilter.frequency.setTargetAtTime(parseInt(e.target.value), audioContext.currentTime, 0.02); };
lowpassSlider.oninput = e => { lowpassValue.textContent = `${e.target.value} Hz`; if(lowpassFilter) lowpassFilter.frequency.setTargetAtTime(parseInt(e.target.value), audioContext.currentTime, 0.02); };
thresholdSlider.oninput = e => { thresholdValue.textContent = e.target.value; updateThresholdLine(); };
alertSlider.oninput = e => { alertValue.textContent = `${e.target.value}s`; };
monitorToggle.onchange = e => { if(!gainNode||!audioContext) return; if(e.target.checked) gainNode.connect(audioContext.destination); else try{gainNode.disconnect(audioContext.destination);}catch(_){} };
cryDurationSlider.oninput = e => { cryDurationValue.textContent = `${e.target.value}s`; };
crySensitivitySlider.oninput = e => { crySensitivityValue.textContent = `${e.target.value}%`; };
function getCrySensitivity() { return parseInt(crySensitivitySlider.value) / 100; }
function updateThresholdLine() { breathThresholdLine.style.left = `${Math.min((parseInt(thresholdSlider.value)/40)*100,100)}%`; }

// ── Wake Lock (keep screen on) ─────────────────────────────────
async function requestWakeLock() {
  if (!('wakeLock' in navigator)) return;
  try { wakeLockSentinel = await navigator.wakeLock.request('screen'); } catch(_) {}
}
async function releaseWakeLock() {
  if (wakeLockSentinel) { await wakeLockSentinel.release().catch(()=>{}); wakeLockSentinel = null; }
}
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && isRunning) requestWakeLock();
});

// ── Notifications ───────────────────────────────────────────
async function requestNotificationPermission() {
  if ('Notification' in window && Notification.permission === 'default') {
    await Notification.requestPermission();
  }
}
function sendSystemNotification(title, body) {
  if ('Notification' in window && Notification.permission === 'granted') {
    try { new Notification(title, { body, icon: '/icon-192.png', tag: 'baby-alert', renotify: true }); } catch(_) {}
  }
}

// ── Start / Stop ────────────────────────────────────────────────
startBtn.onclick = () => isRunning ? stopAudio() : startAudio();
dismissAlertBtn.onclick = () => { dismissAlert(); };

function dismissAlert() {
  alertOverlay.classList.remove('visible');
  stopAlertSound();
  alertFired = false;
  lastBreathTime = performance.now();
}

async function startAudio() {
  const deviceId = micSelect.value;
  if(!deviceId) { alert('Selecione um microfone primeiro.'); return; }
  try {
    mediaStream = await navigator.mediaDevices.getUserMedia({ audio: { deviceId:{exact:deviceId}, echoCancellation:false, noiseSuppression:false, autoGainControl:false } });
    audioContext = new (window.AudioContext||window.webkitAudioContext)();
    sourceNode = audioContext.createMediaStreamSource(mediaStream);
    highpassFilter = audioContext.createBiquadFilter(); highpassFilter.type='highpass'; highpassFilter.frequency.value=parseInt(highpassSlider.value); highpassFilter.Q.value=0.7;
    lowpassFilter = audioContext.createBiquadFilter(); lowpassFilter.type='lowpass'; lowpassFilter.frequency.value=parseInt(lowpassSlider.value); lowpassFilter.Q.value=0.7;
    gainNode = audioContext.createGain(); gainNode.gain.value=parseFloat(gainSlider.value);
    analyserFiltered = audioContext.createAnalyser(); analyserFiltered.fftSize=2048; analyserFiltered.smoothingTimeConstant=0.85;
    analyserRaw = audioContext.createAnalyser(); analyserRaw.fftSize=4096; analyserRaw.smoothingTimeConstant=0.8;
    sourceNode.connect(highpassFilter); highpassFilter.connect(lowpassFilter); lowpassFilter.connect(gainNode); gainNode.connect(analyserFiltered); sourceNode.connect(analyserRaw);
    if(monitorToggle.checked) gainNode.connect(audioContext.destination);

    // Raw audio buffer for YAMNet (2 seconds circular buffer)
    rawSampleRate = audioContext.sampleRate;
    rawAudioBuffer = new Float32Array(rawSampleRate * 2);
    rawBufferPos = 0;
    scriptNode = audioContext.createScriptProcessor(4096, 1, 1);
    sourceNode.connect(scriptNode);
    silentGainNode = audioContext.createGain();
    silentGainNode.gain.value = 0;
    scriptNode.connect(silentGainNode);
    silentGainNode.connect(audioContext.destination);
    scriptNode.onaudioprocess = (e) => {
      const inp = e.inputBuffer.getChannelData(0);
      for (let i = 0; i < inp.length; i++) {
        rawAudioBuffer[rawBufferPos] = inp[i];
        rawBufferPos = (rawBufferPos + 1) % rawAudioBuffer.length;
      }
    };

    isRunning=true; lastBreathTime=performance.now(); breathTimestamps=[]; breathHistory=new Array(HISTORY_LENGTH).fill(0); alertFired=false;
    cryAlertFired=false; consecutiveCryFrames=0;
    startBtn.textContent='⏹ Parar Monitoramento'; startBtn.classList.add('active'); statusDot.classList.add('active');
    autodetectBtn.disabled=false;
    resizeAllCanvases(); updateThresholdLine(); drawLoop();
    historyInterval = setInterval(()=>{ if(!isRunning||!analyserFiltered) return; breathHistory.push(getFilteredAmplitude()); if(breathHistory.length>HISTORY_LENGTH) breathHistory.shift(); }, 100);
    sleepInterval = setInterval(() => { updateSleepStage(); updateTrend(); }, 10000);
    yamnetInterval = setInterval(runYamnetInference, YAMNET_INTERVAL_MS);

    // Keep screen on + request notifications
    requestWakeLock();
    requestNotificationPermission();
  } catch(e) { alert('Não foi possível iniciar: '+e.message); }
}

function stopAudio() {
  if(mediaStream) mediaStream.getTracks().forEach(t=>t.stop());
  if(scriptNode) { scriptNode.disconnect(); scriptNode = null; }
  if(silentGainNode) { silentGainNode.disconnect(); silentGainNode = null; }
  if(audioContext) audioContext.close();
  if(animationId) cancelAnimationFrame(animationId);
  if(historyInterval) clearInterval(historyInterval);
  if(sleepInterval) clearInterval(sleepInterval);
  if(yamnetInterval) { clearInterval(yamnetInterval); yamnetInterval = null; }
  stopAlertSound(); isRunning=false;
  startBtn.textContent='▶ Iniciar Monitoramento'; startBtn.classList.remove('active'); statusDot.classList.remove('active');
  autodetectBtn.disabled=true;
  breathStatusCard.className='card breath-status-card'; breathIcon.textContent='😴'; breathLabel.textContent='Parado'; breathDetail.textContent='Pressione Iniciar para começar';
  breathMeterBar.style.width='0%'; bpmValue.textContent='—'; lastBreathValue.textContent='—'; silenceValue.textContent='—';
  cryStatusCard.className='card cry-status-card'; cryIcon.textContent='🤫'; cryLabel.textContent='Silencioso'; cryDetail.textContent='Nenhum choro detectado'; cryMeterBar.style.width='0%';
  consecutiveCryFrames = 0;
  releaseWakeLock();
}

// ── Breath detection ────────────────────────────────────────────
function getFilteredAmplitude() {
  const buf = analyserFiltered.frequencyBinCount, data = new Uint8Array(buf); analyserFiltered.getByteTimeDomainData(data);
  let s=0; for(let i=0;i<buf;i++){const v=(data[i]-128)/128; s+=v*v;} return Math.sqrt(s/buf)*100;
}

function processBreathDetection(amp) {
  const thr=parseInt(thresholdSlider.value), now=performance.now(), alertSec=parseInt(alertSlider.value);
  breathMeterBar.style.width=`${Math.min((amp/40)*100,100)}%`;
  if(amp>thr) { breathMeterBar.style.background='var(--accent-green)'; if(!isCurrentlyBreathing){isCurrentlyBreathing=true;lastBreathTime=now;breathTimestamps.push(now);breathTimestamps=breathTimestamps.filter(t=>now-t<60000);} }
  else { breathMeterBar.style.background='var(--text-dim)'; if(isCurrentlyBreathing&&amp<thr*0.6) isCurrentlyBreathing=false; }
  const bpm=breathTimestamps.filter(t=>now-t<60000).length; bpmValue.textContent=bpm>0?bpm:'—';
  const ago=(now-lastBreathTime)/1000; lastBreathValue.textContent=ago<1?'agora':`${ago.toFixed(0)}s atrás`; silenceValue.textContent=`${ago.toFixed(0)}s`;
  if(ago<alertSec*0.5){breathStatusCard.className='card breath-status-card ok';breathIcon.textContent='😴';breathLabel.textContent='Respiração OK';breathDetail.textContent=`${bpm} respirações no último minuto`;if(alertFired){dismissAlert();}}
  else if(ago<alertSec){breathStatusCard.className='card breath-status-card warn';breathIcon.textContent='😐';breathLabel.textContent='Ficando silencioso...';breathDetail.textContent=`Sem respirar há ${ago.toFixed(0)}s`;}
  else{breathStatusCard.className='card breath-status-card danger';breathIcon.textContent='🚨';breathLabel.textContent='Respiração não detectada!';breathDetail.textContent=`Silêncio por ${ago.toFixed(0)}s`;if(!alertFired){alertFired=true;if(alertsToggle.checked)triggerAlert(alertSec);}}
}

// ── Cry detection (YAMNet AI) ────────────────────────────────────
// Uses Google YAMNet (AudioSet) for accurate baby cry classification.
// Runs every 1.5s on raw audio. Falls back to amplitude if model unavailable.
let lastCryScore = 0;

function getRawAudioChunk(seconds) {
  if (!rawAudioBuffer) return null;
  const numSamples = Math.floor(rawSampleRate * seconds);
  const result = new Float32Array(numSamples);
  for (let i = 0; i < numSamples; i++) {
    const idx = (rawBufferPos - numSamples + i + rawAudioBuffer.length) % rawAudioBuffer.length;
    result[i] = rawAudioBuffer[idx];
  }
  return result;
}

async function runYamnetInference() {
  if (!isRunning || !cryToggle.checked) return;
  const chunk = getRawAudioChunk(1.5);
  if (!chunk) return;

  if (isReady()) {
    const result = await classify(chunk, rawSampleRate);
    if (!result) return;
    lastCryScore = result.score;
    const pct = Math.min(result.score * 100 / 0.5, 100);
    cryMeterBar.style.width = `${pct}%`;

    if (result.score > getCrySensitivity()) {
      consecutiveCryFrames++;
      const requiredFrames = Math.ceil(parseInt(cryDurationSlider.value) / (YAMNET_INTERVAL_MS / 1000));
      if (consecutiveCryFrames >= requiredFrames) {
        cryStatusCard.className = 'card cry-status-card crying';
        cryIcon.textContent = '😭';
        cryLabel.textContent = 'Bebê chorando!';
        const secs = Math.round(consecutiveCryFrames * YAMNET_INTERVAL_MS / 1000);
        cryDetail.textContent = `${result.label} — ${(result.bestRaw*100).toFixed(0)}% conf. — ${secs}s`;
        if (!cryAlertFired && alertsToggle.checked) {
          cryAlertFired = true;
          alertMessage.textContent = `Bebê chorando! ${result.label} detectado por ${secs}s+ (confiança: ${(result.bestRaw*100).toFixed(0)}%)`;
          alertOverlay.classList.add('visible');
          playAlertSound();
          sendSystemNotification('😭 Bebê chorando!', `${result.label} — ${(result.bestRaw*100).toFixed(0)}% confiança — ${secs}s`);
        }
      } else {
        cryStatusCard.className = 'card cry-status-card';
        cryIcon.textContent = '👶';
        cryLabel.textContent = 'Possível choro...';
        const remaining = Math.ceil((requiredFrames - consecutiveCryFrames) * YAMNET_INTERVAL_MS / 1000);
        cryDetail.textContent = `${result.label} (${(result.bestRaw*100).toFixed(0)}%) — confirmando em ${remaining}s`;
      }
    } else {
      if (cryAlertFired) { dismissAlert(); }
      consecutiveCryFrames = 0;
      cryAlertFired = false;
      cryStatusCard.className = 'card cry-status-card';
      cryIcon.textContent = '🤫';
      cryLabel.textContent = 'Silencioso';
      cryDetail.textContent = `Nenhum choro — IA: ${(result.score*100).toFixed(1)}%`;
    }
  } else {
    // Fallback: amplitude-based
    processCryFallback();
  }
}

function processCryFallback() {
  if (!analyserRaw) return;
  const bufLen = analyserRaw.frequencyBinCount;
  const data = new Uint8Array(bufLen);
  analyserRaw.getByteFrequencyData(data);
  const sr = audioContext.sampleRate, ny = sr / 2;
  const binLow = Math.floor((350 / ny) * bufLen);
  const binHigh = Math.floor((2500 / ny) * bufLen);
  let sum = 0, count = 0;
  for (let i = binLow; i < binHigh && i < bufLen; i++) { sum += data[i]; count++; }
  const amp = count > 0 ? sum / count : 0;
  cryMeterBar.style.width = `${Math.min((amp / 180) * 100, 100)}%`;
  if (amp > 120) {
    consecutiveCryFrames++;
    const requiredFrames = Math.ceil(parseInt(cryDurationSlider.value) / (YAMNET_INTERVAL_MS / 1000));
    if (consecutiveCryFrames >= requiredFrames) {
      cryStatusCard.className = 'card cry-status-card crying';
      cryIcon.textContent = '😭'; cryLabel.textContent = 'Bebê chorando!';
      cryDetail.textContent = 'Modo amplitude (IA indisponível)';
      if (!cryAlertFired && alertsToggle.checked) {
        cryAlertFired = true;
        alertMessage.textContent = 'Bebê chorando! Choro contínuo detectado.';
        alertOverlay.classList.add('visible'); playAlertSound();
        sendSystemNotification('😭 Bebê chorando!', 'Choro contínuo detectado (modo amplitude)');
      }
    } else {
      cryIcon.textContent = '👶'; cryLabel.textContent = 'Som alto...';
    }
  } else {
    if (cryAlertFired) { dismissAlert(); }
    consecutiveCryFrames = 0; cryAlertFired = false;
    cryStatusCard.className = 'card cry-status-card';
    cryIcon.textContent = '🤫'; cryLabel.textContent = 'Silencioso'; cryDetail.textContent = 'Nenhum choro detectado';
  }
}

// Called from drawLoop — just updates UI for disabled state
function processCryDetection() {
  if (!cryToggle.checked) {
    cryStatusCard.className = 'card cry-status-card';
    cryIcon.textContent = '🤫'; cryLabel.textContent = 'Desativado'; cryDetail.textContent = 'Detecção de choro desligada';
    cryMeterBar.style.width = '0%'; consecutiveCryFrames = 0; cryAlertFired = false;
  }
}

// ── Sleep Stage Estimation ──────────────────────────────────────
// Friendly labels for non-technical users. Uses 5-min moving average.
// With distant mic, only deeper breaths register — BPM will be low.
function updateSleepStage() {
  const now = performance.now();
  const WINDOW = 5 * 60 * 1000;
  const recent = breathTimestamps.filter(t => now - t < WINDOW);

  if (recent.length < 4) {
    sleepStageCard.className = 'card sleep-stage-card';
    sleepIcon.textContent = '💤'; sleepLabel.textContent = 'Coletando dados...';
    sleepDetail.textContent = `${recent.length} respirações, precisa de ≥4`;
    avgBpmValue.textContent = '—'; avgIntervalValue.textContent = '—'; breathVariabilityValue.textContent = '—';
    return;
  }

  const intervals = [];
  for (let i = 1; i < recent.length; i++) {
    intervals.push((recent[i] - recent[i-1]) / 1000);
  }

  const avgInterval = intervals.reduce((a,b) => a+b, 0) / intervals.length;
  const avgBpm = Math.round(60 / avgInterval);
  const variance = intervals.reduce((a,b) => a + (b - avgInterval) ** 2, 0) / intervals.length;
  const std = Math.sqrt(variance);
  const cv = avgInterval > 0 ? std / avgInterval : 0;

  avgBpmValue.textContent = `${avgBpm}`;
  avgIntervalValue.textContent = `${avgInterval.toFixed(1)}s`;
  breathVariabilityValue.textContent = cv < 0.2 ? 'Baixa' : cv < 0.4 ? 'Média' : 'Alta';

  // 5 levels: Sono Profundo → Sono Médio → Sono Leve → Soneca → Acordando
  if (cv < 0.2 && avgBpm <= 5) {
    sleepStageCard.className = 'card sleep-stage-card deep';
    sleepIcon.textContent = '🌙'; sleepLabel.textContent = 'Sono Profundo';
    sleepDetail.textContent = `Respiração muito lenta e regular`;
  } else if (cv < 0.3 && avgBpm <= 8) {
    sleepStageCard.className = 'card sleep-stage-card deep';
    sleepIcon.textContent = '😴'; sleepLabel.textContent = 'Sono Médio';
    sleepDetail.textContent = `Respiração lenta e estável`;
  } else if (cv < 0.4 && avgBpm <= 12) {
    sleepStageCard.className = 'card sleep-stage-card light';
    sleepIcon.textContent = '💤'; sleepLabel.textContent = 'Sono Leve';
    sleepDetail.textContent = `Respiração moderada`;
  } else if (cv < 0.5 && avgBpm <= 18) {
    sleepStageCard.className = 'card sleep-stage-card active-sleep';
    sleepIcon.textContent = '👶'; sleepLabel.textContent = 'Soneca / REM';
    sleepDetail.textContent = `Respiração irregular — sonho ou transição`;
  } else {
    sleepStageCard.className = 'card sleep-stage-card active-sleep';
    sleepIcon.textContent = '👀'; sleepLabel.textContent = 'Acordando';
    sleepDetail.textContent = `Respiração rápida ou agitada`;
  }
}

// ── BPM Trend (EMA) ─────────────────────────────────────────────
// Dual exponential moving average: short (1min) vs long (5min)
// Plotted over time. Divergence = pattern change.
const trendCanvas = document.getElementById('trend-canvas');
const tCtx = trendCanvas.getContext('2d');
const trendStatus = $('trend-status'), trendIcon = $('trend-icon'), trendText = $('trend-text');
const TREND_MAX_POINTS = 180; // 30min at 1 point per 10s
let trendShort = []; // EMA short (1min)
let trendLong = [];  // EMA long (5min)
let emaBpmShort = null, emaBpmLong = null;
let lastTrendBpm = null;

function updateTrend() {
  const now = performance.now();
  // Calculate instantaneous BPM from recent breaths
  const recent2min = breathTimestamps.filter(t => now - t < 120000);
  if (recent2min.length < 2) return;

  const lastInterval = (recent2min[recent2min.length-1] - recent2min[recent2min.length-2]) / 1000;
  if (lastInterval <= 0 || lastInterval > 120) return;
  const instantBpm = 60 / lastInterval;

  // EMA: α = 2/(N+1). Short = ~6 samples (1min at 10s intervals), Long = ~30 samples (5min)
  const alphaShort = 2 / 7;
  const alphaLong = 2 / 31;

  if (emaBpmShort === null) { emaBpmShort = instantBpm; emaBpmLong = instantBpm; }
  emaBpmShort = alphaShort * instantBpm + (1 - alphaShort) * emaBpmShort;
  emaBpmLong = alphaLong * instantBpm + (1 - alphaLong) * emaBpmLong;

  trendShort.push(emaBpmShort);
  trendLong.push(emaBpmLong);
  if (trendShort.length > TREND_MAX_POINTS) { trendShort.shift(); trendLong.shift(); }

  // Pattern status
  const divergence = emaBpmLong > 0 ? Math.abs(emaBpmShort - emaBpmLong) / emaBpmLong : 0;
  if (divergence < 0.15) {
    trendStatus.className = 'trend-status stable';
    trendIcon.textContent = '✅'; trendText.textContent = `Padrão estável (${emaBpmShort.toFixed(1)} bpm)`;
  } else if (divergence < 0.35) {
    trendStatus.className = 'trend-status changing';
    trendIcon.textContent = '🔄'; trendText.textContent = `Padrão mudando (${emaBpmShort.toFixed(1)} → era ${emaBpmLong.toFixed(1)} bpm)`;
  } else {
    trendStatus.className = 'trend-status alert';
    trendIcon.textContent = '⚡'; trendText.textContent = `Mudança brusca (${emaBpmShort.toFixed(1)} vs ${emaBpmLong.toFixed(1)} bpm)`;
  }
}

function drawTrend() {
  const w = trendCanvas.clientWidth, h = trendCanvas.clientHeight;
  tCtx.fillStyle = '#0c1222'; tCtx.fillRect(0, 0, w, h);
  if (trendShort.length < 2) return;

  // Find Y scale from data
  const all = [...trendShort, ...trendLong];
  const yMin = Math.max(0, Math.min(...all) - 1);
  const yMax = Math.max(...all) + 1;
  const yRange = yMax - yMin || 1;

  const step = w / (TREND_MAX_POINTS - 1);
  const xOffset = (TREND_MAX_POINTS - trendShort.length) * step;

  // Draw grid lines
  tCtx.strokeStyle = 'rgba(255,255,255,0.05)'; tCtx.lineWidth = 1;
  for (let bpm = Math.ceil(yMin); bpm <= yMax; bpm += Math.max(1, Math.floor(yRange / 4))) {
    const y = h - ((bpm - yMin) / yRange) * h;
    tCtx.beginPath(); tCtx.moveTo(0, y); tCtx.lineTo(w, y); tCtx.stroke();
    tCtx.fillStyle = 'rgba(255,255,255,0.2)'; tCtx.font = '10px sans-serif';
    tCtx.fillText(`${bpm}`, 3, y - 3);
  }

  // Long EMA (fill)
  tCtx.beginPath(); tCtx.moveTo(xOffset, h);
  for (let i = 0; i < trendLong.length; i++) {
    const x = xOffset + i * step, y = h - ((trendLong[i] - yMin) / yRange) * h;
    tCtx.lineTo(x, y);
  }
  tCtx.lineTo(xOffset + (trendLong.length - 1) * step, h); tCtx.closePath();
  const gLong = tCtx.createLinearGradient(0, 0, 0, h);
  gLong.addColorStop(0, 'rgba(16,185,129,0.15)'); gLong.addColorStop(1, 'rgba(16,185,129,0)');
  tCtx.fillStyle = gLong; tCtx.fill();

  // Long EMA line
  tCtx.strokeStyle = '#10b981'; tCtx.lineWidth = 1.5; tCtx.beginPath();
  for (let i = 0; i < trendLong.length; i++) {
    const x = xOffset + i * step, y = h - ((trendLong[i] - yMin) / yRange) * h;
    i === 0 ? tCtx.moveTo(x, y) : tCtx.lineTo(x, y);
  } tCtx.stroke();

  // Short EMA line
  tCtx.strokeStyle = '#6366f1'; tCtx.lineWidth = 2; tCtx.beginPath();
  for (let i = 0; i < trendShort.length; i++) {
    const x = xOffset + i * step, y = h - ((trendShort[i] - yMin) / yRange) * h;
    i === 0 ? tCtx.moveTo(x, y) : tCtx.lineTo(x, y);
  } tCtx.stroke();

  // Current value dot
  const lastX = xOffset + (trendShort.length - 1) * step;
  const lastY = h - ((trendShort[trendShort.length - 1] - yMin) / yRange) * h;
  tCtx.fillStyle = '#6366f1'; tCtx.beginPath(); tCtx.arc(lastX, lastY, 3, 0, Math.PI * 2); tCtx.fill();
}

// ── Detected noise zones (updated by auto-detect) ───────────────
let detectedNoiseBands = null;

// ── Drawing ─────────────────────────────────────────────────────
function drawLoop(){if(!isRunning)return;animationId=requestAnimationFrame(drawLoop);processBreathDetection(getFilteredAmplitude());processCryDetection();drawWaveform();drawSpectrum();drawHistory();drawTrend();}

// ── Alert ───────────────────────────────────────────────────────
function triggerAlert(s){alertMessage.textContent=`Nenhuma respiração detectada por ${s} segundos.`;alertOverlay.classList.add('visible');playAlertSound();sendSystemNotification('🚨 Alerta de respiração!',`Nenhuma respiração detectada por ${s}s`);}
let alertBeepInterval = null;
function playAlertSound(){
  if(!audioContext||audioContext.state==='closed') return;
  stopAlertSound();
  function beep() {
    if(!audioContext||audioContext.state==='closed') return;
    alertOscillator = audioContext.createOscillator();
    alertGainNode = audioContext.createGain();
    alertOscillator.type='sine'; alertOscillator.frequency.value=880;
    alertGainNode.gain.value=0.3;
    alertOscillator.connect(alertGainNode); alertGainNode.connect(audioContext.destination);
    alertOscillator.start();
    alertOscillator.stop(audioContext.currentTime + 0.25);
  }
  beep();
  alertBeepInterval = setInterval(beep, 600);
}
function stopAlertSound(){
  if(alertBeepInterval){clearInterval(alertBeepInterval);alertBeepInterval=null;}
  if(alertOscillator){try{alertOscillator.stop();}catch(_){}alertOscillator=null;}
}

function drawWaveform(){
  const w=waveformCanvas.clientWidth,h=waveformCanvas.clientHeight,buf=analyserFiltered.frequencyBinCount,data=new Uint8Array(buf);analyserFiltered.getByteTimeDomainData(data);
  wCtx.fillStyle='#0c1222';wCtx.fillRect(0,0,w,h);wCtx.strokeStyle='#1e3055';wCtx.lineWidth=1;wCtx.beginPath();wCtx.moveTo(0,h/2);wCtx.lineTo(w,h/2);wCtx.stroke();
  const amp=getFilteredAmplitude(),thr=parseInt(thresholdSlider.value);
  wCtx.strokeStyle=amp>thr*3?'#f59e0b':amp>thr?'#10b981':'#64748b';wCtx.lineWidth=2;wCtx.beginPath();
  const sw=w/buf;let x=0;for(let i=0;i<buf;i++){const y=(data[i]/128)*(h/2);i===0?wCtx.moveTo(x,y):wCtx.lineTo(x,y);x+=sw;}wCtx.stroke();
}

function drawSpectrum(){
  const w=spectrumCanvas.clientWidth,h=spectrumCanvas.clientHeight,buf=analyserRaw.frequencyBinCount,data=new Uint8Array(buf);analyserRaw.getByteFrequencyData(data);
  sCtx.fillStyle='#0c1222';sCtx.fillRect(0,0,w,h);
  const sr=audioContext.sampleRate,ny=sr/2,maxF=4000,bins=Math.floor((maxF/ny)*buf),bw=w/bins;
  const hp=parseInt(highpassSlider.value),lp=parseInt(lowpassSlider.value);
  const BAND_W=50;

  for(let i=0;i<bins;i++){
    const f=(i/buf)*ny,bh=(data[i]/255)*h;
    let color;
    if(detectedNoiseBands) {
      // Use auto-detected classification
      const bandIdx = Math.floor(f / BAND_W);
      const band = bandIdx < detectedNoiseBands.length ? detectedNoiseBands[bandIdx] : null;
      const type = band ? band.type : 'quiet';
      if(type === 'breathing') color = `rgba(16,185,129,${0.4+data[i]/400})`;
      else if(type === 'noise') color = `rgba(249,115,22,${0.3+data[i]/400})`;
      else color = `rgba(100,116,139,${0.2+data[i]/500})`;
    } else {
      // Default: color by filter position
      color = f<hp ? `rgba(249,115,22,${0.3+data[i]/400})` : f<=lp ? `rgba(16,185,129,${0.4+data[i]/400})` : `rgba(99,102,241,${0.3+data[i]/400})`;
    }
    sCtx.fillStyle = color;
    sCtx.fillRect(i*bw,h-bh,bw>1?bw-0.5:bw,bh);
  }
  const hpX=(hp/maxF)*w,lpX=(lp/maxF)*w;sCtx.strokeStyle='#f59e0b';sCtx.lineWidth=1.5;sCtx.setLineDash([4,4]);
  sCtx.beginPath();sCtx.moveTo(hpX,0);sCtx.lineTo(hpX,h);sCtx.stroke();sCtx.beginPath();sCtx.moveTo(lpX,0);sCtx.lineTo(lpX,h);sCtx.stroke();sCtx.setLineDash([]);
}

function drawHistory(){
  const w=historyCanvas.clientWidth,h=historyCanvas.clientHeight,thr=parseInt(thresholdSlider.value);
  hCtx.fillStyle='#0c1222';hCtx.fillRect(0,0,w,h);if(breathHistory.length<2)return;
  const ty=h-(thr/40)*h;hCtx.strokeStyle='rgba(245,158,11,0.4)';hCtx.lineWidth=1;hCtx.setLineDash([4,4]);hCtx.beginPath();hCtx.moveTo(0,ty);hCtx.lineTo(w,ty);hCtx.stroke();hCtx.setLineDash([]);
  const step=w/(HISTORY_LENGTH-1);hCtx.beginPath();hCtx.moveTo(0,h);
  for(let i=0;i<breathHistory.length;i++){const x=i*step,y=h-(Math.min(breathHistory[i],40)/40)*h;hCtx.lineTo(x,y);}
  hCtx.lineTo((breathHistory.length-1)*step,h);hCtx.closePath();
  const g=hCtx.createLinearGradient(0,0,0,h);g.addColorStop(0,'rgba(16,185,129,0.5)');g.addColorStop(1,'rgba(16,185,129,0.02)');hCtx.fillStyle=g;hCtx.fill();
  hCtx.strokeStyle='#10b981';hCtx.lineWidth=1.5;hCtx.beginPath();
  for(let i=0;i<breathHistory.length;i++){const x=i*step,y=h-(Math.min(breathHistory[i],40)/40)*h;i===0?hCtx.moveTo(x,y):hCtx.lineTo(x,y);}hCtx.stroke();
}

// ── Auto-Detect Algorithm ───────────────────────────────────────
// 60s scan. analyserRaw is pre-gain so gain doesn't affect detection.
// After finding breathing band, measures filtered amplitude and
// calculates optimal gain. Mutes listen during scan.
let scanData = null;
let preAutoListenState = false;
const scanBanner = $('scan-banner'), scanBannerTitle = $('scan-banner-title');
const scanBannerDetail = $('scan-banner-detail'), scanBannerTime = $('scan-banner-time');
const scanBannerFill = $('scan-banner-fill');

autodetectBtn.onclick = () => {
  if(!isRunning||!analyserRaw) return;
  const SCAN_DURATION = 60000;
  const SAMPLE_INTERVAL = 150;
  const BAND_WIDTH = 50;
  const MAX_FREQ = 3000;
  const sr = audioContext.sampleRate;
  const ny = sr / 2;
  const bufLen = analyserRaw.frequencyBinCount;
  const numBands = Math.floor(MAX_FREQ / BAND_WIDTH);

  scanData = Array.from({length: numBands}, () => []);

  // Mute listen (gain will be adjusted later, don't blast ears)
  preAutoListenState = monitorToggle.checked;
  if(preAutoListenState) {
    try { gainNode.disconnect(audioContext.destination); } catch(_) {}
    monitorToggle.checked = false;
    monitorToggle.disabled = true;
  }

  // Show banner
  scanBanner.classList.add('active');
  scanBannerTitle.textContent = '🔍 Auto-Detecção Ativa';
  scanBannerDetail.textContent = 'Analisando padrões de respiração... Áudio silenciado.';

  autodetectBtn.classList.add('scanning');
  autodetectBtn.disabled = true;
  autodetectHint.textContent = 'Escaneando espectro por respiração...';
  autodetectProgress.classList.add('active');

  const startTime = performance.now();
  const data = new Uint8Array(bufLen);

  const interval = setInterval(() => {
    const elapsed = performance.now() - startTime;
    const pct = Math.min((elapsed / SCAN_DURATION) * 100, 100);
    autodetectBar.style.width = `${pct}%`;
    scanBannerFill.style.width = `${pct}%`;

    const remaining = Math.ceil((SCAN_DURATION - elapsed) / 1000);
    autodetectBtn.textContent = `🔍 Escaneando... ${remaining}s`;
    scanBannerTime.textContent = `${remaining}s`;

    if(elapsed >= SCAN_DURATION) {
      clearInterval(interval);
      finishAutoDetect();
      return;
    }

    analyserRaw.getByteFrequencyData(data);
    for(let b = 0; b < numBands; b++) {
      const fLow = b * BAND_WIDTH;
      const fHigh = fLow + BAND_WIDTH;
      const binLow = Math.floor((fLow / ny) * bufLen);
      const binHigh = Math.floor((fHigh / ny) * bufLen);
      let sum = 0, count = 0;
      for(let i = binLow; i < binHigh && i < bufLen; i++) { sum += data[i]; count++; }
      scanData[b].push(count > 0 ? sum / count : 0);
    }
  }, SAMPLE_INTERVAL);
};

function finishAutoDetect() {
  const BAND_WIDTH_HZ = 50;

  const bandScores = scanData.map((samples, idx) => {
    if(samples.length < 5) return { idx, cv: 0, mean: 0, max: 0, type: 'quiet' };
    const mean = samples.reduce((a,b) => a+b, 0) / samples.length;
    const max = Math.max(...samples);
    const variance = samples.reduce((a,b) => a + (b - mean) ** 2, 0) / samples.length;
    const std = Math.sqrt(variance);
    return { idx, cv: mean > 0.5 ? std / mean : 0, mean, max };
  });

  const sortedMeans = bandScores.map(b => b.mean).sort((a,b) => a - b);
  const noiseFloor = sortedMeans[Math.floor(sortedMeans.length * 0.25)] || 0;
  const activeBands = bandScores.filter(b => b.mean > noiseFloor * 0.3 || b.max > noiseFloor * 2);

  const sortedByCv = [...activeBands].sort((a, b) => b.cv - a.cv);
  const topCv = sortedByCv.length > 0 ? sortedByCv[0].cv : 0;

  if(topCv < 0.03) {
    autodetectHint.textContent = '❌ Nenhum padrão rítmico encontrado. Tente aproximar o mic.';
    scanBannerDetail.textContent = '❌ Falhou — nenhum padrão encontrado';
    restoreAfterScan(); return;
  }

  const cvThreshold = topCv * 0.35;
  const activeMeans = activeBands.map(b => b.mean);
  const avgActiveMean = activeMeans.length > 0 ? activeMeans.reduce((a,b) => a+b, 0) / activeMeans.length : 0;

  detectedNoiseBands = bandScores.map(b => {
    if (b.mean <= noiseFloor * 0.3 && b.max <= noiseFloor * 2) return { ...b, type: 'quiet' };
    if (b.cv > cvThreshold) return { ...b, type: 'breathing' };
    if (b.mean > avgActiveMean * 0.4) return { ...b, type: 'noise' };
    return { ...b, type: 'quiet' };
  });

  const breathBands = detectedNoiseBands.filter(b => b.type === 'breathing').map(b => b.idx).sort((a,b) => a - b);
  if(breathBands.length === 0) {
    autodetectHint.textContent = '❌ Não foi possível isolar a respiração.';
    scanBannerDetail.textContent = '❌ Falhou — tente reposicionar o mic';
    restoreAfterScan(); return;
  }

  let bestStart = breathBands[0], bestEnd = breathBands[0], curStart = breathBands[0], curEnd = breathBands[0];
  for(let i = 1; i < breathBands.length; i++) {
    if(breathBands[i] - curEnd <= 2) { curEnd = breathBands[i]; }
    else { if(curEnd - curStart > bestEnd - bestStart) { bestStart = curStart; bestEnd = curEnd; } curStart = curEnd = breathBands[i]; }
  }
  if(curEnd - curStart > bestEnd - bestStart) { bestStart = curStart; bestEnd = curEnd; }

  let hpFreq = Math.max(50, bestStart * BAND_WIDTH_HZ - 30);
  let lpFreq = Math.min(4000, (bestEnd + 1) * BAND_WIDTH_HZ + 30);
  hpFreq = Math.max(50, Math.min(500, Math.round(hpFreq / 10) * 10));
  lpFreq = Math.max(500, Math.min(4000, Math.round(lpFreq / 50) * 50));

  // Apply filters
  highpassSlider.value = hpFreq; highpassValue.textContent = `${hpFreq} Hz`;
  if(highpassFilter) highpassFilter.frequency.setTargetAtTime(hpFreq, audioContext.currentTime, 0.05);
  lowpassSlider.value = lpFreq; lowpassValue.textContent = `${lpFreq} Hz`;
  if(lowpassFilter) lowpassFilter.frequency.setTargetAtTime(lpFreq, audioContext.currentTime, 0.05);

  // Now measure FILTERED amplitude to set optimal gain.
  // Wait 500ms for filters to settle, then sample for 10s
  // (long enough to catch at least one breath even with 20s gaps).
  scanBannerDetail.textContent = '⚙️ Calibrando ganho (10s)...';
  setTimeout(() => {
    const samples = [];
    const gainCalibInterval = setInterval(() => {
      samples.push(getFilteredAmplitude());
    }, 100);
    setTimeout(() => {
      clearInterval(gainCalibInterval);
      if(samples.length > 0) {
        // Use top 5% peaks — with distant mic, most samples are silence
        const sorted = [...samples].sort((a,b) => b - a);
        const topCount = Math.max(2, Math.floor(sorted.length * 0.05));
        const peakAvg = sorted.slice(0, topCount).reduce((a,b) => a+b, 0) / topCount;
        const currentGain = parseFloat(gainSlider.value);
        // Target: breathing peaks visible at ~10-12 on the amplitude scale
        const targetPeak = 11;
        if(peakAvg > 0.3) {
          let optimalGain = Math.round((targetPeak / peakAvg) * currentGain * 2) / 2;
          optimalGain = Math.max(1, Math.min(30, optimalGain));
          gainNode.gain.setTargetAtTime(optimalGain, audioContext.currentTime, 0.05);
          gainSlider.value = optimalGain; gainValue.textContent = `${optimalGain}x`;
        }
      }

      // Report
      const noiseBands = detectedNoiseBands.filter(b => b.type === 'noise');
      const noiseRanges = [];
      if (noiseBands.length > 0) {
        let rs = noiseBands[0].idx, re = noiseBands[0].idx;
        for (let i = 1; i < noiseBands.length; i++) {
          if (noiseBands[i].idx - re <= 1) { re = noiseBands[i].idx; } else { noiseRanges.push(`${rs*BAND_WIDTH_HZ}-${(re+1)*BAND_WIDTH_HZ}Hz`); rs = re = noiseBands[i].idx; }
        }
        noiseRanges.push(`${rs*BAND_WIDTH_HZ}-${(re+1)*BAND_WIDTH_HZ}Hz`);
      }
      const noiseInfo = noiseRanges.length > 0 ? ` | Noise: ${noiseRanges.join(', ')}` : '';
      const finalGain = parseFloat(gainSlider.value);
      autodetectHint.textContent = `✅ Respiração: ${hpFreq}–${lpFreq} Hz | Ganho: ${finalGain}x${noiseInfo}`;
      scanBannerDetail.textContent = `✅ Pronto! Filtros: ${hpFreq}–${lpFreq} Hz, Ganho: ${finalGain}x`;

      restoreAfterScan();
    }, 10000); // 10s calibration
  }, 500); // 500ms filter settle
}

function restoreAfterScan() {
  // Restore listen state
  monitorToggle.disabled = false;
  if(preAutoListenState) {
    monitorToggle.checked = true;
    gainNode.connect(audioContext.destination);
  }
  resetAutoDetectUI();
  // Hide banner after 3s
  setTimeout(() => { scanBanner.classList.remove('active'); scanBannerFill.style.width = '0%'; }, 3000);
}

function resetAutoDetectUI() {
  autodetectBtn.classList.remove('scanning');
  autodetectBtn.textContent = '🔍 Auto-Detectar Respiração';
  autodetectBtn.disabled = !isRunning;
  setTimeout(() => { autodetectProgress.classList.remove('active'); autodetectBar.style.width = '0%'; }, 500);
}

// ── Presets (localStorage) ──────────────────────────────────────
function getPresets() { try { return JSON.parse(localStorage.getItem(STORAGE_KEY)) || []; } catch(_) { return []; } }
function savePresets(list) { localStorage.setItem(STORAGE_KEY, JSON.stringify(list)); }

function refreshPresetSelect() {
  const presets = getPresets();
  presetSelect.innerHTML = '<option value="" disabled selected>Carregar um preset...</option>';
  presets.forEach((p, i) => { const o = document.createElement('option'); o.value = i; o.text = p.name; presetSelect.appendChild(o); });
  loadPresetBtn.disabled = true;
  deletePresetBtn.disabled = true;
}

presetSelect.onchange = () => { loadPresetBtn.disabled = !presetSelect.value; deletePresetBtn.disabled = !presetSelect.value; };

savePresetBtn.onclick = () => {
  const name = prompt('Nome do preset:');
  if(!name || !name.trim()) return;
  const presets = getPresets();
  presets.push({
    name: name.trim(),
    highpass: parseInt(highpassSlider.value),
    lowpass: parseInt(lowpassSlider.value),
    gain: parseFloat(gainSlider.value),
    threshold: parseInt(thresholdSlider.value),
    alertSeconds: parseInt(alertSlider.value),
  });
  savePresets(presets);
  refreshPresetSelect();
};

loadPresetBtn.onclick = () => {
  const idx = parseInt(presetSelect.value);
  const presets = getPresets();
  if(isNaN(idx) || !presets[idx]) return;
  const p = presets[idx];
  highpassSlider.value = p.highpass; highpassValue.textContent = `${p.highpass} Hz`;
  lowpassSlider.value = p.lowpass; lowpassValue.textContent = `${p.lowpass} Hz`;
  gainSlider.value = p.gain; gainValue.textContent = `${p.gain}x`;
  thresholdSlider.value = p.threshold; thresholdValue.textContent = `${p.threshold}`;
  alertSlider.value = p.alertSeconds; alertValue.textContent = `${p.alertSeconds}s`;
  // Apply to live nodes
  if(highpassFilter) highpassFilter.frequency.setTargetAtTime(p.highpass, audioContext.currentTime, 0.02);
  if(lowpassFilter) lowpassFilter.frequency.setTargetAtTime(p.lowpass, audioContext.currentTime, 0.02);
  if(gainNode) gainNode.gain.setTargetAtTime(p.gain, audioContext.currentTime, 0.02);
  updateThresholdLine();
};

deletePresetBtn.onclick = () => {
  const idx = parseInt(presetSelect.value);
  const presets = getPresets();
  if(isNaN(idx) || !presets[idx]) return;
  if(!confirm(`Excluir preset "${presets[idx].name}"?`)) return;
  presets.splice(idx, 1);
  savePresets(presets);
  refreshPresetSelect();
};

// ── Init ────────────────────────────────────────────────────────
resizeAllCanvases(); getDevices(); updateThresholdLine(); refreshPresetSelect();

// Load YAMNet model in background
loadModel((status) => {
  if (!modelBadge) return;
  if (status === 'loading') { modelBadge.textContent = '⏳ Carregando IA...'; modelBadge.className = 'model-badge loading'; }
  else if (status === 'ready') { modelBadge.textContent = '🤖 YAMNet ativo'; modelBadge.className = 'model-badge ready'; }
  else if (status === 'error') { modelBadge.textContent = '⚡ Modo amplitude'; modelBadge.className = 'model-badge error'; }
  else { modelBadge.textContent = '⚡ IA indisponível'; modelBadge.className = 'model-badge error'; }
});
