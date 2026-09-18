/**
 * Pure Web Audio API Sound Synthesizer for Real-Time Telecom Notifications.
 * Generates custom soundwaves without external audio files or network latency.
 */

export type NotificationSoundType = "critical" | "warning" | "success" | "info";

let audioCtx: AudioContext | null = null;

function getAudioContext(): AudioContext | null {
  if (typeof window === "undefined") return null;
  if (!audioCtx) {
    const AudioContextClass = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    if (AudioContextClass) {
      audioCtx = new AudioContextClass();
    }
  }
  if (audioCtx && audioCtx.state === "suspended") {
    audioCtx.resume().catch(() => {});
  }
  return audioCtx;
}

export function playNotificationSound(type: NotificationSoundType, volume = 0.5): void {
  try {
    const ctx = getAudioContext();
    if (!ctx) return;

    const clampedVol = Math.max(0, Math.min(1, volume));
    if (clampedVol === 0) return;

    const now = ctx.currentTime;
    const gainNode = ctx.createGain();
    gainNode.gain.setValueAtTime(clampedVol * 0.3, now);
    gainNode.connect(ctx.destination);

    switch (type) {
      case "critical": {
        // Urgent dual-tone alarm chord (square wave)
        const osc1 = ctx.createOscillator();
        const osc2 = ctx.createOscillator();
        osc1.type = "sawtooth";
        osc2.type = "sine";

        osc1.frequency.setValueAtTime(880, now);
        osc1.frequency.exponentialRampToValueAtTime(440, now + 0.25);
        osc2.frequency.setValueAtTime(980, now);
        osc2.frequency.exponentialRampToValueAtTime(520, now + 0.25);

        gainNode.gain.setValueAtTime(clampedVol * 0.4, now);
        gainNode.gain.exponentialRampToValueAtTime(0.001, now + 0.4);

        osc1.connect(gainNode);
        osc2.connect(gainNode);

        osc1.start(now);
        osc2.start(now);
        osc1.stop(now + 0.45);
        osc2.stop(now + 0.45);
        break;
      }
      case "warning": {
        // Double ping chime (sine wave)
        const osc = ctx.createOscillator();
        osc.type = "sine";
        osc.frequency.setValueAtTime(587.33, now); // D5
        osc.frequency.setValueAtTime(659.25, now + 0.12); // E5

        gainNode.gain.setValueAtTime(clampedVol * 0.3, now);
        gainNode.gain.exponentialRampToValueAtTime(0.001, now + 0.35);

        osc.connect(gainNode);
        osc.start(now);
        osc.stop(now + 0.38);
        break;
      }
      case "success": {
        // Ascending major chord (C5 -> E5 -> G5)
        const freqs = [523.25, 659.25, 783.99];
        freqs.forEach((freq, idx) => {
          const osc = ctx.createOscillator();
          const noteGain = ctx.createGain();
          const startTime = now + idx * 0.08;

          osc.type = "sine";
          osc.frequency.setValueAtTime(freq, startTime);

          noteGain.gain.setValueAtTime(clampedVol * 0.25, startTime);
          noteGain.gain.exponentialRampToValueAtTime(0.001, startTime + 0.3);

          osc.connect(noteGain);
          noteGain.connect(ctx.destination);

          osc.start(startTime);
          osc.stop(startTime + 0.32);
        });
        break;
      }
      case "info":
      default: {
        // Gentle single ping (triangle wave)
        const osc = ctx.createOscillator();
        osc.type = "triangle";
        osc.frequency.setValueAtTime(880, now);
        osc.frequency.exponentialRampToValueAtTime(440, now + 0.2);

        gainNode.gain.setValueAtTime(clampedVol * 0.2, now);
        gainNode.gain.exponentialRampToValueAtTime(0.001, now + 0.22);

        osc.connect(gainNode);
        osc.start(now);
        osc.stop(now + 0.25);
        break;
      }
    }
  } catch {
    // AudioContext failure gracefully handled (e.g. autoplay policy)
  }
}
