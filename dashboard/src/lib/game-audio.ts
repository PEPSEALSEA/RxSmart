type SfxKind = "start" | "hold" | "miss" | "rep" | "complete" | "click";

let audioCtx: AudioContext | null = null;
let bgmNodes: { osc: OscillatorNode; gain: GainNode; lfo: OscillatorNode } | null = null;
let unlocked = false;
let muted = false;

function ctx(): AudioContext | null {
  if (typeof window === "undefined") return null;
  if (!audioCtx) {
    const AC = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    audioCtx = new AC();
  }
  return audioCtx;
}

export function isGameAudioUnlocked() {
  return unlocked;
}

export function setGameAudioMuted(next: boolean) {
  muted = next;
  if (bgmNodes) bgmNodes.gain.gain.value = muted ? 0 : 0.035;
}

export function isGameAudioMuted() {
  return muted;
}

/** Call from a user gesture (Start) to unlock autoplay. */
export async function unlockGameAudio() {
  const c = ctx();
  if (!c) return;
  if (c.state === "suspended") await c.resume();
  unlocked = true;
  startBgm();
}

function tone(
  freq: number,
  duration: number,
  type: OscillatorType,
  gain = 0.08,
  when = 0,
) {
  if (!unlocked || muted) return;
  const c = ctx();
  if (!c) return;
  const t0 = c.currentTime + when;
  const osc = c.createOscillator();
  const g = c.createGain();
  osc.type = type;
  osc.frequency.setValueAtTime(freq, t0);
  g.gain.setValueAtTime(0.0001, t0);
  g.gain.exponentialRampToValueAtTime(gain, t0 + 0.02);
  g.gain.exponentialRampToValueAtTime(0.0001, t0 + duration);
  osc.connect(g);
  g.connect(c.destination);
  osc.start(t0);
  osc.stop(t0 + duration + 0.02);
}

export function playSfx(kind: SfxKind) {
  switch (kind) {
    case "start":
      tone(220, 0.12, "triangle", 0.07);
      tone(330, 0.14, "triangle", 0.06, 0.08);
      tone(440, 0.18, "sine", 0.05, 0.16);
      break;
    case "hold":
      tone(520, 0.1, "sine", 0.07);
      tone(780, 0.12, "triangle", 0.05, 0.06);
      break;
    case "miss":
      tone(160, 0.16, "sawtooth", 0.035);
      tone(120, 0.2, "sawtooth", 0.025, 0.05);
      break;
    case "rep":
      tone(392, 0.1, "square", 0.045);
      tone(523, 0.12, "square", 0.04, 0.08);
      tone(659, 0.16, "triangle", 0.05, 0.16);
      break;
    case "complete":
      tone(523, 0.14, "triangle", 0.06);
      tone(659, 0.14, "triangle", 0.06, 0.12);
      tone(784, 0.18, "sine", 0.07, 0.24);
      tone(1046, 0.28, "sine", 0.05, 0.38);
      break;
    case "click":
      tone(640, 0.05, "square", 0.03);
      break;
  }
}

function startBgm() {
  if (!unlocked || bgmNodes) return;
  const c = ctx();
  if (!c) return;
  const osc = c.createOscillator();
  const lfo = c.createOscillator();
  const gain = c.createGain();
  const lfoGain = c.createGain();
  osc.type = "sine";
  osc.frequency.value = 110;
  lfo.frequency.value = 0.12;
  lfoGain.gain.value = 18;
  gain.gain.value = muted ? 0 : 0.035;
  lfo.connect(lfoGain);
  lfoGain.connect(osc.frequency);
  osc.connect(gain);
  gain.connect(c.destination);
  osc.start();
  lfo.start();
  bgmNodes = { osc, gain, lfo };
}

export function stopBgm() {
  if (!bgmNodes) return;
  try {
    bgmNodes.osc.stop();
    bgmNodes.lfo.stop();
  } catch {
    /* already stopped */
  }
  bgmNodes = null;
}
