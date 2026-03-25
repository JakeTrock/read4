import React, { useState, useEffect, useCallback, useRef } from 'react';
import type { Book, Progress } from '../services/db';
import { useKokoro } from '../hooks/useKokoro';
import { splitIntoSentences, sanitizeTextForTTS } from '../utils/textProcessing';
import { Play, Pause, SkipBack, SkipForward, Settings as SettingsIcon, Volume2 } from 'lucide-react';

interface ReaderProps {
  book: Book;
  initialProgress?: Progress;
  onExit: () => void;
}

const releaseAudio = (audio: HTMLAudioElement | null) => {
  if (!audio) return;
  try {
    audio.pause();
    if (audio.src && audio.src.startsWith('blob:')) {
      URL.revokeObjectURL(audio.src);
    }
    audio.removeAttribute('src');
  } catch (e) {}
};

export const Reader: React.FC<ReaderProps> = ({ book, initialProgress, onExit }) => {
  const [chapterIdx, setChapterIdx] = useState(initialProgress?.chapterIndex || 0);
  const [paraIdx, setParaIdx] = useState(initialProgress?.paragraphIndex || 0);
  const [sentenceIdx, setSentenceIdx] = useState(initialProgress?.sentenceIndex || 0);
  const [isPlaying, setIsPlaying] = useState(false);
  const [playbackSpeed, setPlaybackSpeed] = useState(1.0);
  const [uiMode, setUiMode] = useState(2); // 0: Minimal, 1: Medium, 2: Full
  
  const { generate, loading: ttsLoading } = useKokoro();
  const currentAudio = useRef<HTMLAudioElement | null>(null);
  const currentAudioTextRef = useRef<string | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  
  const generationIdRef = useRef(0);
  const preloadedNextAudioRef = useRef<{ text: string, audio: HTMLAudioElement | null } | null>(null);

  const currentChapter = book.content[chapterIdx] || [];
  const currentPara = currentChapter[paraIdx] || '';
  const currentSentences = splitIntoSentences(currentPara);
  const currentSentence = currentSentences[sentenceIdx] || '';

  const isPlayingRef = useRef(isPlaying);
  useEffect(() => {
    isPlayingRef.current = isPlaying;
  }, [isPlaying]);

  const playbackSpeedRef = useRef(playbackSpeed);
  useEffect(() => {
    playbackSpeedRef.current = playbackSpeed;
    if (currentAudio.current) {
      currentAudio.current.playbackRate = playbackSpeed;
    }
  }, [playbackSpeed]);

  const handleNextSentence = useCallback(() => {
    if (sentenceIdx < currentSentences.length - 1) {
      setSentenceIdx(s => s + 1);
    } else if (paraIdx < currentChapter.length - 1) {
      setParaIdx(p => p + 1);
      setSentenceIdx(0);
    } else if (chapterIdx < book.content.length - 1) {
      setChapterIdx(c => c + 1);
      setParaIdx(0);
      setSentenceIdx(0);
    } else {
      setIsPlaying(false);
    }
  }, [sentenceIdx, currentSentences.length, paraIdx, currentChapter.length, chapterIdx, book.content.length]);

  const handleNextSentenceRef = useRef(handleNextSentence);
  useEffect(() => {
    handleNextSentenceRef.current = handleNextSentence;
  }, [handleNextSentence]);

  const prefetchNext = useCallback((nextText: string) => {
    if (!nextText) return;
    const sanitized = sanitizeTextForTTS(nextText);
    if (!sanitized) return;
    
    // Already prefetching/prefetched this exact text
    if (preloadedNextAudioRef.current?.text === nextText) return;

    // Release old prefetch if unused
    if (preloadedNextAudioRef.current?.audio) {
      releaseAudio(preloadedNextAudioRef.current.audio);
    }

    preloadedNextAudioRef.current = { text: nextText, audio: null };
    
    generate(sanitized).then(audio => {
      // If the prefetch target hasn't changed since we started generating
      if (preloadedNextAudioRef.current?.text === nextText) {
        preloadedNextAudioRef.current.audio = audio;
      } else if (audio) {
        // We generated it but the user skipped past it already, discard it
        releaseAudio(audio);
      }
    }).catch(e => console.error("Prefetch error", e));
  }, [generate]);

  const playSentence = useCallback(async (text: string) => {
    if (!text) {
      if (isPlayingRef.current) handleNextSentenceRef.current();
      return;
    }
    
    // If we are just unpausing the EXACT same sentence that is already loaded, just resume it!
    if (currentAudio.current && currentAudioTextRef.current === text) {
      try {
        currentAudio.current.playbackRate = playbackSpeedRef.current;
        await currentAudio.current.play();
        return;
      } catch (e) {
        // Fallthrough and regenerate if resume fails for some reason
      }
    }

    const currentGenId = ++generationIdRef.current;
    
    try {
      if (currentAudio.current) {
        releaseAudio(currentAudio.current);
        currentAudio.current = null;
        currentAudioTextRef.current = null;
      }
      
      const sanitized = sanitizeTextForTTS(text);
      if (!sanitized) {
         if (isPlayingRef.current) handleNextSentenceRef.current();
         return;
      }

      let audio: HTMLAudioElement | null = null;
      
      // Check if we already prefetched this sentence
      if (preloadedNextAudioRef.current?.text === text && preloadedNextAudioRef.current?.audio) {
        audio = preloadedNextAudioRef.current.audio;
        preloadedNextAudioRef.current = null; // Consume it
      } else {
        // Not prefetched, generate it on demand
        audio = await generate(sanitized);
      }
      
      // Abort if the user skipped to another sentence while we were waiting, or paused
      if (currentGenId !== generationIdRef.current || !isPlayingRef.current) {
        releaseAudio(audio);
        return;
      }
      
      if (audio) {
        audio.playbackRate = playbackSpeedRef.current;
        currentAudio.current = audio;
        currentAudioTextRef.current = text;
        
        audio.onended = () => {
          if (isPlayingRef.current) {
            handleNextSentenceRef.current();
          }
        };
        
        // Find the next sentence and prefetch it silently in the background
        let nextText = null;
        if (sentenceIdx < currentSentences.length - 1) {
          nextText = currentSentences[sentenceIdx + 1];
        } else if (paraIdx < currentChapter.length - 1) {
          const nextPara = currentChapter[paraIdx + 1];
          nextText = splitIntoSentences(nextPara)[0];
        } else if (chapterIdx < book.content.length - 1) {
          const nextChapter = book.content[chapterIdx + 1];
          nextText = splitIntoSentences(nextChapter[0] || '')[0];
        }
        
        if (nextText) {
          prefetchNext(nextText);
        }

        await audio.play();
      } else {
        // Generation failed or returned null for this text
        if (isPlayingRef.current) handleNextSentenceRef.current();
      }
    } catch (err) {
      console.error('Playback error:', err);
      // Only stop playing if we didn't skip to another sentence
      if (currentGenId === generationIdRef.current) {
        setIsPlaying(false);
      }
    }
  }, [generate, chapterIdx, paraIdx, sentenceIdx, currentSentences, currentChapter, book.content, prefetchNext]);

  useEffect(() => {
    if (isPlaying) {
      playSentence(currentSentence);
    } else if (currentAudio.current) {
      currentAudio.current.pause();
    }
  }, [isPlaying, chapterIdx, paraIdx, sentenceIdx, playSentence, currentSentence]);

  // Clean up on unmount
  useEffect(() => {
    return () => {
      if (currentAudio.current) releaseAudio(currentAudio.current);
      if (preloadedNextAudioRef.current?.audio) releaseAudio(preloadedNextAudioRef.current.audio);
    };
  }, []);

  const handlePrevSentence = useCallback(() => {
    if (sentenceIdx > 0) {
      setSentenceIdx(s => s - 1);
    } else if (paraIdx > 0) {
      const prevPara = currentChapter[paraIdx - 1];
      const prevSentences = splitIntoSentences(prevPara);
      setParaIdx(p => p - 1);
      setSentenceIdx(prevSentences.length - 1);
    } else if (chapterIdx > 0) {
      const prevChapter = book.content[chapterIdx - 1];
      const lastParaIdx = prevChapter.length - 1;
      const lastPara = prevChapter[lastParaIdx];
      const lastSentences = splitIntoSentences(lastPara);
      setChapterIdx(c => c - 1);
      setParaIdx(lastParaIdx);
      setSentenceIdx(lastSentences.length - 1);
    }
  }, [sentenceIdx, paraIdx, chapterIdx, currentChapter, book.content]);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      switch (e.key.toLowerCase()) {
        case 'p':
        case ' ':
          e.preventDefault();
          setIsPlaying(p => !p);
          break;
        case 'j':
          handleNextSentence();
          break;
        case 'k':
          handlePrevSentence();
          break;
        case 'l':
          // Next paragraph
          if (paraIdx < currentChapter.length - 1) {
            setParaIdx(p => p + 1);
            setSentenceIdx(0);
          }
          break;
        case 'h':
          // Prev paragraph
          if (paraIdx > 0) {
            setParaIdx(p => p - 1);
            setSentenceIdx(0);
          }
          break;
        case 'q':
          onExit();
          break;
        case 'v':
          setUiMode(m => (m + 1) % 3);
          break;
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [handleNextSentence, handlePrevSentence, onExit, paraIdx, currentChapter.length]);

  // Auto-scroll to active sentence
  useEffect(() => {
    const activeElement = document.querySelector('.active-sentence');
    if (activeElement) {
      activeElement.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
  }, [chapterIdx, paraIdx, sentenceIdx]);

  return (
    <div className="flex flex-col h-screen bg-black text-white font-serif overflow-hidden">
      {/* Top Bar */}
      {uiMode >= 1 && (
        <div className="flex justify-between items-center px-4 py-2 border-b border-zinc-800 bg-zinc-900 z-10">
          <div className="text-sm font-medium truncate max-w-md">{book.title}</div>
          <div className="flex items-center gap-4">
            <span className="text-xs text-zinc-400">
              Ch {chapterIdx + 1} / {book.content.length}
            </span>
            <button onClick={onExit} className="text-zinc-400 hover:text-white">
              Exit
            </button>
          </div>
        </div>
      )}

      {/* Main Content Area */}
      <div 
        ref={containerRef}
        className="flex-1 overflow-y-auto px-4 py-8 md:px-12 lg:px-24 xl:px-48"
      >
        <div className="max-w-3xl mx-auto space-y-6">
          {currentChapter.map((para, pIdx) => {
            const sentences = splitIntoSentences(para);
            const isCurrentPara = pIdx === paraIdx;
            
            return (
              <div 
                key={pIdx} 
                className={`transition-opacity duration-300 ${isCurrentPara ? 'opacity-100' : 'opacity-40 hover:opacity-70'}`}
              >
                {sentences.map((sent, sIdx) => {
                  const isActive = isCurrentPara && sIdx === sentenceIdx;
                  return (
                    <span
                      key={sIdx}
                      onClick={() => {
                        setParaIdx(pIdx);
                        setSentenceIdx(sIdx);
                        setIsPlaying(true);
                      }}
                      className={`inline cursor-pointer transition-colors duration-200 leading-relaxed text-xl
                        ${isActive ? 'bg-blue-600/30 text-blue-100 font-medium active-sentence rounded px-1' : 'hover:text-blue-300'}
                      `}
                    >
                      {sent}{' '}
                    </span>
                  );
                })}
              </div>
            );
          })}
        </div>
      </div>

      {/* Controls Bar */}
      {uiMode === 2 && (
        <div className="border-t border-zinc-800 bg-zinc-900 px-6 py-4 flex items-center justify-between">
          <div className="flex items-center gap-6">
            <button onClick={handlePrevSentence} className="p-2 hover:bg-zinc-800 rounded-full">
              <SkipBack size={24} />
            </button>
            <button 
              onClick={() => setIsPlaying(!isPlaying)}
              className="p-3 bg-white text-black rounded-full hover:bg-zinc-200"
            >
              {isPlaying ? <Pause size={28} /> : <Play size={28} className="ml-1" />}
            </button>
            <button onClick={handleNextSentence} className="p-2 hover:bg-zinc-800 rounded-full">
              <SkipForward size={24} />
            </button>
          </div>

          <div className="flex items-center gap-8">
            <div className="flex items-center gap-2">
              <Volume2 size={20} className="text-zinc-400" />
              <select 
                value={playbackSpeed} 
                onChange={(e) => setPlaybackSpeed(parseFloat(e.target.value))}
                className="bg-transparent text-sm border-none focus:ring-0 cursor-pointer"
              >
                {[1.0, 1.25, 1.5, 1.75, 2.0, 2.5, 3.0].map(s => (
                  <option key={s} value={s} className="bg-zinc-900">{s}x</option>
                ))}
              </select>
            </div>
            {ttsLoading && <div className="text-xs text-blue-400 animate-pulse">Generating audio...</div>}
            <button className="text-zinc-400 hover:text-white">
              <SettingsIcon size={20} />
            </button>
          </div>
        </div>
      )}
    </div>
  );
};
