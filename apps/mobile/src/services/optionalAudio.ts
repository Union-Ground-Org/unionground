type AudioModuleType = typeof import('expo-audio');
let audioModuleCache: AudioModuleType | null | undefined;

// Older development clients still support text capture when audio is absent.
export function loadAudioModule(): AudioModuleType | null {
  if (audioModuleCache === undefined) {
    try {
      audioModuleCache = require('expo-audio') as AudioModuleType;
    } catch {
      audioModuleCache = null;
    }
  }
  return audioModuleCache;
}
