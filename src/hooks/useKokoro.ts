import { useState, useCallback, useEffect } from 'react';
import { KokoroTTS } from 'kokoro-js';
import { encodeWAV } from '../utils/convertWav';

export interface KokoroHook {
  tts: KokoroTTS | null;
  loading: boolean;
  error: string | null;
  init: () => Promise<void>;
  generate: (text: string, voice?: any) => Promise<HTMLAudioElement | null>;
}

// Global state so the TTS model is only downloaded and initialized once
let globalTtsInstance: KokoroTTS | null = null;
let globalInitPromise: Promise<void> | null = null;

export function useKokoro(): KokoroHook {
  const [tts, setTts] = useState<KokoroTTS | null>(globalTtsInstance);
  const [loading, setLoading] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);

  const init = useCallback(async () => {
    // If already initialized, just update local state
    if (globalTtsInstance) {
      setTts(globalTtsInstance);
      return;
    }
    
    // If initialization is already in progress somewhere else, wait for it
    if (globalInitPromise) {
      setLoading(true);
      try {
        await globalInitPromise;
        setTts(globalTtsInstance);
      } catch (err) {
        setError(String(err));
      } finally {
        setLoading(false);
      }
      return;
    }
    
    setLoading(true);
    setError(null);
    
    globalInitPromise = (async () => {
      try {
        if (!(navigator as any).gpu) {
          throw new Error("WebGPU is not supported by your browser.");
        }

        const model_id = "onnx-community/Kokoro-82M-v1.0-ONNX";
        globalTtsInstance = await KokoroTTS.from_pretrained(model_id, {
          dtype: "fp32", // fp32 is required for WebGPU compatibility
          device: "webgpu",
        });
      } catch (err) {
        console.error('Failed to initialize Kokoro:', err);
        throw err;
      }
    })();

    try {
      await globalInitPromise;
      setTts(globalTtsInstance);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      globalInitPromise = null; // reset so we can try again
    } finally {
      setLoading(false);
    }
  }, []);

  const generate = useCallback(async (text: string, voice: any = "af_heart"): Promise<HTMLAudioElement | null> => {
    const instance = globalTtsInstance || tts;
    if (!instance) {
      throw new Error("TTS not initialized. Please wait for the model to load.");
    }
    
    try {
      // kokoro-js generate returns a RawAudio object containing { audio: Float32Array, sampling_rate: number }
      const rawAudio = await instance.generate(text, { voice });
      if (!rawAudio || !rawAudio.audio) return null;
      
      const wavBlob = encodeWAV(rawAudio.audio, rawAudio.sampling_rate);
      const url = URL.createObjectURL(wavBlob);
      const audioEl = new Audio(url);
      return audioEl;
    } catch (err) {
      console.error('Failed to generate audio:', err);
      throw err;
    }
  }, [tts]);

  // Sync state if it was initialized outside this component
  useEffect(() => {
    if (globalTtsInstance && !tts) {
      setTts(globalTtsInstance);
    }
  }, [tts]);

  return { tts: globalTtsInstance || tts, loading, error, init, generate };
}
