import React, { useState, useEffect, useCallback, useRef } from 'react';
import type { Book, Progress } from '../services/db';
import { useKokoro } from '../hooks/useKokoro';
import { splitIntoSentences, sanitizeTextForTTS } from '../utils/textProcessing';

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
  const [wordIdx, setWordIdx] = useState(-1);
  const [isPlaying, setIsPlaying] = useState(false);
  const [playbackSpeed, setPlaybackSpeed] = useState(1.0);
  const [uiMode, setUiMode] = useState(2); // 0: Minimal, 1: Medium, 2: Full
  const [autoScroll, setAutoScroll] = useState(true);
  
  const { generate, loading: ttsLoading } = useKokoro();
  const currentAudio = useRef<HTMLAudioElement | null>(null);
  const currentAudioTextRef = useRef<string | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  
  const generationIdRef = useRef(0);
  const wordUpdateTimerRef = useRef<number | null>(null);
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

  const stopWordTimer = useCallback(() => {
    if (wordUpdateTimerRef.current !== null) {
      cancelAnimationFrame(wordUpdateTimerRef.current);
      wordUpdateTimerRef.current = null;
    }
  }, []);

  const startWordTimer = useCallback((audio: HTMLAudioElement, text: string) => {
    stopWordTimer();
    
    const totalChars = text.length;
    if (totalChars === 0) return;

    const wordBoundaries: number[] = [];
    const tokens = text.match(/\S+|\s+/g) || [];
    
    let charCount = 0;
    tokens.forEach(token => {
      if (/\S/.test(token)) {
        wordBoundaries.push(charCount + token.length);
      }
      charCount += token.length;
    });

    const updateWordIdx = () => {
      if (!audio || audio.paused || audio.ended) {
        stopWordTimer();
        return;
      }

      const progress = audio.currentTime / audio.duration;
      const currentCharPos = progress * totalChars;
      
      let foundIdx = 0;
      for (let i = 0; i < wordBoundaries.length; i++) {
        if (currentCharPos <= wordBoundaries[i]) {
          foundIdx = i;
          break;
        }
        foundIdx = i;
      }
      
      setWordIdx(foundIdx);
      wordUpdateTimerRef.current = requestAnimationFrame(updateWordIdx);
    };

    wordUpdateTimerRef.current = requestAnimationFrame(updateWordIdx);
  }, [stopWordTimer]);

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
    if (preloadedNextAudioRef.current?.text === nextText) return;
    if (preloadedNextAudioRef.current?.audio) {
      releaseAudio(preloadedNextAudioRef.current.audio);
    }
    preloadedNextAudioRef.current = { text: nextText, audio: null };
    generate(sanitized).then(audio => {
      if (preloadedNextAudioRef.current?.text === nextText) {
        preloadedNextAudioRef.current.audio = audio;
      } else if (audio) {
        releaseAudio(audio);
      }
    }).catch(e => console.error("Prefetch error", e));
  }, [generate]);

  const playSentence = useCallback(async (text: string) => {
    if (!text) {
      if (isPlayingRef.current) handleNextSentenceRef.current();
      return;
    }
    if (currentAudio.current && currentAudioTextRef.current === text) {
      try {
        currentAudio.current.playbackRate = playbackSpeedRef.current;
        await currentAudio.current.play();
        startWordTimer(currentAudio.current, text);
        return;
      } catch (e) {}
    }

    const currentGenId = ++generationIdRef.current;
    try {
      if (currentAudio.current) {
        releaseAudio(currentAudio.current);
        currentAudio.current = null;
        currentAudioTextRef.current = null;
      }
      stopWordTimer();
      setWordIdx(-1);
      
      const sanitized = sanitizeTextForTTS(text);
      if (!sanitized) {
         if (isPlayingRef.current) handleNextSentenceRef.current();
         return;
      }
      let audio: HTMLAudioElement | null = null;
      if (preloadedNextAudioRef.current?.text === text && preloadedNextAudioRef.current?.audio) {
        audio = preloadedNextAudioRef.current.audio;
        preloadedNextAudioRef.current = null;
      } else {
        audio = await generate(sanitized);
      }
      if (currentGenId !== generationIdRef.current || !isPlayingRef.current) {
        releaseAudio(audio);
        return;
      }
      if (audio) {
        audio.playbackRate = playbackSpeedRef.current;
        currentAudio.current = audio;
        currentAudioTextRef.current = text;
        audio.onended = () => {
          stopWordTimer();
          setWordIdx(-1);
          if (isPlayingRef.current) {
            handleNextSentenceRef.current();
          }
        };
        let nextText = null;
        if (sentenceIdx < currentSentences.length - 1) {
          nextText = currentSentences[sentenceIdx + 1];
        } else if (paraIdx < currentChapter.length - 1) {
          nextText = splitIntoSentences(currentChapter[paraIdx + 1])[0];
        } else if (chapterIdx < book.content.length - 1) {
          nextText = splitIntoSentences(book.content[chapterIdx + 1][0] || '')[0];
        }
        if (nextText) prefetchNext(nextText);
        await audio.play();
        startWordTimer(audio, text);
      } else if (isPlayingRef.current) {
        handleNextSentenceRef.current();
      }
    } catch (err) {
      console.error('Playback error:', err);
      if (currentGenId === generationIdRef.current) setIsPlaying(false);
    }
  }, [generate, chapterIdx, paraIdx, sentenceIdx, currentSentences, currentChapter, book.content, prefetchNext, stopWordTimer, startWordTimer]);

  useEffect(() => {
    if (isPlaying) {
      playSentence(currentSentence);
    } else if (currentAudio.current) {
      currentAudio.current.pause();
      stopWordTimer();
    }
  }, [isPlaying, chapterIdx, paraIdx, sentenceIdx, playSentence, currentSentence, stopWordTimer]);

  useEffect(() => {
    return () => {
      stopWordTimer();
      if (currentAudio.current) releaseAudio(currentAudio.current);
      if (preloadedNextAudioRef.current?.audio) releaseAudio(preloadedNextAudioRef.current.audio);
    };
  }, [stopWordTimer]);

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
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      const scrollAmt = window.innerHeight * 0.8;
      switch (e.key.toLowerCase()) {
        case 'p':
        case ' ': e.preventDefault(); setIsPlaying(p => !p); break;
        case 'a': e.preventDefault(); setAutoScroll(a => !a); break;
        case 'j': e.preventDefault(); handlePrevSentence(); break;
        case 'k': e.preventDefault(); handleNextSentence(); break;
        case 'h': e.preventDefault();
          if (paraIdx > 0) { setParaIdx(p => p - 1); setSentenceIdx(0); }
          else if (chapterIdx > 0) { setChapterIdx(c => c - 1); setParaIdx(book.content[chapterIdx - 1].length - 1); setSentenceIdx(0); }
          break;
        case 'l': e.preventDefault();
          if (paraIdx < currentChapter.length - 1) { setParaIdx(p => p + 1); setSentenceIdx(0); }
          else if (chapterIdx < book.content.length - 1) { setChapterIdx(c => c + 1); setParaIdx(0); setSentenceIdx(0); }
          break;
        case 'i': e.preventDefault(); containerRef.current?.scrollBy({ top: -scrollAmt, behavior: 'auto' }); break;
        case 'm': e.preventDefault(); containerRef.current?.scrollBy({ top: scrollAmt, behavior: 'auto' }); break;
        case 'u': e.preventDefault(); containerRef.current?.scrollBy({ top: -100, behavior: 'auto' }); break;
        case 'n': e.preventDefault(); containerRef.current?.scrollBy({ top: 100, behavior: 'auto' }); break;
        case 'y': e.preventDefault(); setChapterIdx(0); setParaIdx(0); setSentenceIdx(0); break;
        case 'b': e.preventDefault(); setChapterIdx(book.content.length - 1); setParaIdx(book.content[book.content.length - 1].length - 1); setSentenceIdx(0); break;
        case 'q': e.preventDefault(); onExit(); break;
        case 'v': e.preventDefault(); setUiMode(m => (m + 1) % 3); break;
        case ',': e.preventDefault(); setPlaybackSpeed(s => Math.max(0.5, s - 0.25)); break;
        case '.': e.preventDefault(); setPlaybackSpeed(s => Math.min(3.0, s + 0.25)); break;
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [handleNextSentence, handlePrevSentence, onExit, paraIdx, chapterIdx, book.content, currentChapter.length]);

  useEffect(() => {
    if (autoScroll) {
      const activeElement = document.querySelector('.active-sentence');
      if (activeElement) activeElement.scrollIntoView({ behavior: 'auto', block: 'center' });
    }
  }, [chapterIdx, paraIdx, sentenceIdx, autoScroll]);

  useEffect(() => {
    if ('mediaSession' in navigator) {
      navigator.mediaSession.metadata = new MediaMetadata({
        title: book.title,
        artist: 'read4 TTS',
        album: 'read4'
      });
      navigator.mediaSession.setActionHandler('play', () => setIsPlaying(true));
      navigator.mediaSession.setActionHandler('pause', () => setIsPlaying(false));
      navigator.mediaSession.setActionHandler('previoustrack', () => handlePrevSentence());
      navigator.mediaSession.setActionHandler('nexttrack', () => handleNextSentence());
    }
    return () => {
      if ('mediaSession' in navigator) {
        navigator.mediaSession.setActionHandler('play', null);
        navigator.mediaSession.setActionHandler('pause', null);
        navigator.mediaSession.setActionHandler('previoustrack', null);
        navigator.mediaSession.setActionHandler('nexttrack', null);
      }
    };
  }, [book.title, handlePrevSentence, handleNextSentence]);

  const progressPercent = Math.round(((chapterIdx * 100) / book.content.length) + ((paraIdx * 100) / (book.content.length * currentChapter.length)));

  return (
    <div className="flex flex-col h-screen bg-black text-zinc-300 font-mono overflow-hidden">
      {uiMode >= 1 && (
        <div className="px-4 py-1 border-b border-blue-900 bg-black text-xs">
          <div className="flex justify-between items-center text-blue-400 font-bold mb-1">
            <div className="truncate flex-1 uppercase tracking-tighter">
              <span className="text-blue-600 mr-2">TITLE:</span> {book.title}
            </div>
            <div className="ml-4 whitespace-nowrap">
               <span className="text-blue-600 mr-2">PROGRESS:</span> {progressPercent}% [CH {chapterIdx + 1}/{book.content.length}]
            </div>
          </div>
          <div className="w-full flex text-[8px] leading-[8px] text-blue-900">
            {Array.from({length: 100}).map((_, i) => (
              <span key={i} className={i < progressPercent ? "text-blue-500" : ""}>{i < progressPercent ? "▓" : "░"}</span>
            ))}
          </div>
        </div>
      )}

      <div ref={containerRef} className="flex-1 overflow-y-auto px-6 py-4 md:px-16 lg:px-32">
        <div className="max-w-5xl mx-auto space-y-6 pb-64">
          {currentChapter.map((para, pIdx) => {
            const sentences = splitIntoSentences(para);
            const isCurrentPara = pIdx === paraIdx;
            return (
              <div key={pIdx} className={`py-1 ${isCurrentPara ? 'bg-purple-900/30' : ''}`}>
                {sentences.map((sent, sIdx) => {
                  const isActive = isCurrentPara && sIdx === sentenceIdx;
                  if (isActive) {
                    const words = sent.split(/(\s+)/);
                    let currentWordCount = 0;
                    return (
                      <span key={sIdx} className="bg-purple-800 text-white font-bold active-sentence px-1 rounded-sm">
                        {words.map((w, wIdx) => {
                          if (/\S/.test(w)) {
                            const isWordActive = currentWordCount === wordIdx;
                            currentWordCount++;
                            return <span key={wIdx} className={isWordActive ? "text-yellow-400 bg-black px-0.5" : ""}>{w}</span>;
                          }
                          return <span key={wIdx}>{w}</span>;
                        })}
                      </span>
                    );
                  }
                  return (
                    <span
                      key={sIdx}
                      onClick={() => { setParaIdx(pIdx); setSentenceIdx(sIdx); setIsPlaying(true); }}
                      className="inline cursor-pointer leading-relaxed text-lg hover:text-white"
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

      {uiMode === 2 && (
        <div className="border-t border-blue-900 bg-black px-4 py-2">
          <div className="flex items-center justify-between text-[10px] font-bold mb-1">
            <div className="flex items-center gap-4">
               <div className={isPlaying ? "text-green-500" : "text-yellow-500"}>
                 <span className="text-white mr-1">[P]</span> {isPlaying ? "▶ PLAYING" : "⏸ PAUSED"} {playbackSpeed.toFixed(2)}x
               </div>
               <div className={autoScroll ? "text-purple-500" : "text-blue-500"}>
                 <span className="text-white mr-1">[A]</span> {autoScroll ? "▼ AUTO" : "⏹ MANUAL"}
               </div>
            </div>
            {ttsLoading && <div className="text-yellow-500 animate-pulse">GENERATING...</div>}
            <div className="text-red-500"><span className="text-white mr-1">[Q]</span> QUIT</div>
          </div>

          <div className="flex flex-wrap gap-x-4 gap-y-1 text-[9px] text-zinc-500 border-t border-zinc-900 pt-1">
            <div className="flex gap-1 items-center"><span className="text-white">H⸱J</span> <span className="text-green-500">↥</span> <span className="text-white">K⸱L</span> <span className="text-green-500">↧</span> <span className="ml-1 uppercase">Para/Sent</span></div>
            <div className="flex gap-1 items-center"><span className="text-white">U⸱N</span> <span className="text-blue-500">↑↓</span> <span className="ml-1 uppercase">Line</span></div>
            <div className="flex gap-1 items-center"><span className="text-white">I⸱M</span> <span className="text-blue-500">↑↓</span> <span className="ml-1 uppercase">Page</span></div>
            <div className="flex gap-1 items-center"><span className="text-white">Y⸱B</span> <span className="ml-1 uppercase">Top/End</span></div>
            <div className="flex gap-1 items-center"><span className="text-white">,⸱.</span> <span className="ml-1 uppercase">Speed</span></div>
            <div className="flex gap-1 items-center"><span className="text-white">V</span> <span className="ml-1 uppercase">UI</span></div>
          </div>
        </div>
      )}
    </div>
  );
};
