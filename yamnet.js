// ── YAMNet Baby Cry Detection Module ────────────────────────
// Uses Google's YAMNet (AudioSet) via TensorFlow.js for accurate
// baby cry classification. Classes: 20=Baby cry, 19=Crying/sobbing,
// 21=Whimper, 11=Screaming.

const YAMNET_URL = 'https://tfhub.dev/google/tfjs-model/yamnet/tfjs/1';

const CRY_CLASSES = {
  20: { label: 'Choro de bebê', weight: 1.0 },
  19: { label: 'Choro/soluço', weight: 0.7 },
  21: { label: 'Choramingo', weight: 0.5 },
  11: { label: 'Grito', weight: 0.3 },
};

let model = null;
let ready = false;
let loading = false;

// ── Load YAMNet ─────────────────────────────────────────────
export async function loadModel(onStatus) {
  if (loading || ready) return;
  const tf = window.tf;
  if (!tf) { onStatus('unavailable'); return; }
  loading = true;
  onStatus('loading');
  try {
    await tf.ready();
    model = await tf.loadGraphModel(YAMNET_URL, { fromTFHub: true });
    ready = true;
    loading = false;
    onStatus('ready');
  } catch (e) {
    console.error('YAMNet load error:', e);
    loading = false;
    onStatus('error');
  }
}

export function isReady() { return ready; }

// ── Resample to 16 kHz ──────────────────────────────────────
function resampleTo16k(data, srcRate) {
  const ratio = srcRate / 16000;
  const len = Math.floor(data.length / ratio);
  const out = new Float32Array(len);
  for (let i = 0; i < len; i++) {
    const s = i * ratio;
    const lo = Math.floor(s);
    const hi = Math.min(lo + 1, data.length - 1);
    const f = s - lo;
    out[i] = data[lo] * (1 - f) + data[hi] * f;
  }
  return out;
}

// ── Classify audio buffer ───────────────────────────────────
// Returns { score, label, details[] } or null
export async function classify(rawPCM, sampleRate) {
  if (!ready || !model) return null;
  const tf = window.tf;
  if (!tf) return null;

  const pcm16k = resampleTo16k(rawPCM, sampleRate);
  if (pcm16k.length < 15600) return null; // need ≥0.975s

  let input, output;
  try {
    input = tf.tensor1d(pcm16k);
    output = model.executeAsync ? await model.executeAsync(input) : model.predict(input);

    // YAMNet returns [scores, embeddings, spectrogram]
    const scoresTensor = Array.isArray(output) ? output[0] : output;
    const scoresData = await scoresTensor.data();
    const shape = scoresTensor.shape;
    const numFrames = shape[0];
    const numClasses = shape[1] || 521;

    // Average scores across frames
    const avg = new Float32Array(numClasses);
    for (let f = 0; f < numFrames; f++) {
      for (let c = 0; c < numClasses; c++) {
        avg[c] += scoresData[f * numClasses + c] / numFrames;
      }
    }

    // Compute weighted cry score
    let bestScore = 0, bestLabel = '', details = [];
    for (const [clsStr, info] of Object.entries(CRY_CLASSES)) {
      const cls = parseInt(clsStr);
      const raw = avg[cls] || 0;
      details.push({ cls, label: info.label, raw: raw, weighted: raw * info.weight });
      if (raw > bestScore) { bestScore = raw; bestLabel = info.label; }
    }

    // Combined weighted score (sum of weighted probabilities)
    const combinedScore = details.reduce((s, d) => s + d.weighted, 0);

    return { score: combinedScore, bestRaw: bestScore, label: bestLabel, details };
  } catch (e) {
    console.error('YAMNet classify error:', e);
    return null;
  } finally {
    if (input) input.dispose();
    if (output) {
      if (Array.isArray(output)) output.forEach(t => t.dispose());
      else output.dispose();
    }
  }
}
