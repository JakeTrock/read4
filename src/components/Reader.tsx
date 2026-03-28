import React, { useState, useEffect, useCallback, useRef } from 'react';
import { createPortal } from 'react-dom';
import { db } from '../services/db';
import type { Book, Progress } from '../services/db';
import { useKokoro } from '../hooks/useKokoro';
import { splitIntoSentences, sanitizeTextForTTS } from '../utils/textProcessing';

interface ReaderProps {
  book: Book;
  initialProgress?: Progress;
  voice: string;
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

export const Reader: React.FC<ReaderProps> = ({ book, initialProgress, voice, onExit }) => {
  const [chapterIdx, setChapterIdx] = useState(initialProgress?.chapterIndex || 0);
  const [paraIdx, setParaIdx] = useState(initialProgress?.paragraphIndex || 0);
  const [sentenceIdx, setSentenceIdx] = useState(initialProgress?.sentenceIndex || 0);
  const [wordIdx, setWordIdx] = useState(-1);
  const [isPlaying, setIsPlaying] = useState(false);
  const [playbackSpeed, setPlaybackSpeed] = useState(1.0);
  const [uiMode, setUiMode] = useState(2); // 0: Minimal, 1: Medium, 2: Full
  const [autoScroll, setAutoScroll] = useState(true);
  const [pipWindow, setPipWindow] = useState<Window | null>(null);

  const [isSearchOpen, setIsSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState<{c: number, p: number, s: number}[]>([]);
  const [searchIdx, setSearchIdx] = useState(0);
  const searchInputRef = useRef<HTMLInputElement>(null);
  
  const { generate, loading: ttsLoading } = useKokoro();
  const currentAudio = useRef<HTMLAudioElement | null>(null);
  const currentAudioTextRef = useRef<string | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  
  const generationIdRef = useRef(0);
  const wordUpdateTimerRef = useRef<number | null>(null);
  const audioBufferQueueRef = useRef<{
    id: string, 
    audio: HTMLAudioElement, 
    text: string,
    chapterIdx: number,
    paraIdx: number,
    sentenceIdx: number
  }[]>([]);
  
  const isBufferingRef = useRef(false);

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

  useEffect(() => {
    if (book.id) {
      db.progress.put({
        bookId: book.id,
        chapterIndex: chapterIdx,
        paragraphIndex: paraIdx,
        sentenceIndex: sentenceIdx,
        updatedAt: Date.now()
      }).catch(e => console.error("Failed to save progress", e));
    }
  }, [chapterIdx, paraIdx, sentenceIdx, book.id]);

  const stopWordTimer = useCallback(() => {
    if (wordUpdateTimerRef.current !== null) {
      cancelAnimationFrame(wordUpdateTimerRef.current);
      wordUpdateTimerRef.current = null;
    }
  }, []);

  const fillBuffer = useCallback(async () => {
    if (isBufferingRef.current || !isPlayingRef.current) return;
    isBufferingRef.current = true;

    try {
      const BUFFER_SIZE = 5;
      const needed = BUFFER_SIZE - audioBufferQueueRef.current.length;
      if (needed <= 0) return;

      let currC = chapterIdx, currP = paraIdx, currS = sentenceIdx + 1;
      if (audioBufferQueueRef.current.length > 0) {
        const last = audioBufferQueueRef.current[audioBufferQueueRef.current.length - 1];
        currC = last.chapterIdx;
        currP = last.paraIdx;
        currS = last.sentenceIdx + 1;
      }

      const toFetch: {text: string, c: number, p: number, s: number}[] = [];
      while (toFetch.length < needed) {
        const chapter = book.content[currC];
        if (!chapter) break;
        const para = chapter[currP];
        if (!para) { currC++; currP = 0; currS = 0; continue; }
        const sentences = splitIntoSentences(para);
        if (currS >= sentences.length) { currP++; currS = 0; continue; }
        
        toFetch.push({ text: sentences[currS], c: currC, p: currP, s: currS });
        currS++;
      }

      for (const item of toFetch) {
        if (!isPlayingRef.current) break;
        const sanitized = sanitizeTextForTTS(item.text);
        if (!sanitized) continue;
        const audio = await generate(sanitized, voice);
        if (audio) {
          audio.playbackRate = playbackSpeedRef.current;
          audio.preload = "auto";
          audioBufferQueueRef.current.push({
            id: `${item.c}-${item.p}-${item.s}`,
            audio,
            text: item.text,
            chapterIdx: item.c,
            paraIdx: item.p,
            sentenceIdx: item.s
          });
        }
      }
    } finally {
      isBufferingRef.current = false;
    }
  }, [book.content, chapterIdx, paraIdx, sentenceIdx, generate, voice]);

  const startWordTimer = useCallback((audio: HTMLAudioElement, text: string) => {
    stopWordTimer();
    const totalChars = text.length;
    if (totalChars === 0) return;
    const wordBoundaries: number[] = [];
    const tokens = text.match(/\S+|\s+/g) || [];
    let charCount = 0;
    tokens.forEach(token => {
      if (/\S/.test(token)) wordBoundaries.push(charCount + token.length);
      charCount += token.length;
    });
    const updateWordIdx = () => {
      if (!audio || audio.paused || audio.ended) { stopWordTimer(); return; }
      const progress = audio.currentTime / audio.duration;
      const currentCharPos = progress * totalChars;
      let foundIdx = 0;
      for (let i = 0; i < wordBoundaries.length; i++) {
        if (currentCharPos <= wordBoundaries[i]) { foundIdx = i; break; }
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

  const playSentence = useCallback(async (text: string, forceRegenerate = false) => {
    if (!text) { if (isPlayingRef.current) handleNextSentenceRef.current(); return; }
    if (!forceRegenerate && currentAudio.current && currentAudioTextRef.current === text) {
      try {
        currentAudio.current.playbackRate = playbackSpeedRef.current;
        await currentAudio.current.play();
        startWordTimer(currentAudio.current, text);
        fillBuffer();
        return;
      } catch (e) {}
    }
    const currentGenId = ++generationIdRef.current;
    try {
      if (currentAudio.current) { releaseAudio(currentAudio.current); currentAudio.current = null; currentAudioTextRef.current = null; }
      stopWordTimer();
      setWordIdx(-1);
      let audio: HTMLAudioElement | null = null;
      if (audioBufferQueueRef.current.length > 0) {
        const head = audioBufferQueueRef.current[0];
        if (head.chapterIdx === chapterIdx && head.paraIdx === paraIdx && head.sentenceIdx === sentenceIdx) {
          audio = head.audio;
          audioBufferQueueRef.current.shift();
        }
      }
      if (!audio) {
        audioBufferQueueRef.current.forEach(item => releaseAudio(item.audio));
        audioBufferQueueRef.current = [];
        const sanitized = sanitizeTextForTTS(text);
        if (!sanitized) { if (isPlayingRef.current) handleNextSentenceRef.current(); return; }
        audio = await generate(sanitized, voice);
      }
      if (currentGenId !== generationIdRef.current || !isPlayingRef.current) { releaseAudio(audio); return; }
      if (audio) {
        audio.playbackRate = playbackSpeedRef.current;
        currentAudio.current = audio;
        currentAudioTextRef.current = text;
        audio.onended = () => {
          stopWordTimer();
          setWordIdx(-1);
          if (isPlayingRef.current) {
            if (audioBufferQueueRef.current.length > 0) {
              const next = audioBufferQueueRef.current[0];
              setChapterIdx(next.chapterIdx);
              setParaIdx(next.paraIdx);
              setSentenceIdx(next.sentenceIdx);
            } else {
              handleNextSentenceRef.current();
            }
          }
        };
        await audio.play();
        startWordTimer(audio, text);
        fillBuffer();
      } else if (isPlayingRef.current) {
        handleNextSentenceRef.current();
      }
    } catch (err) {
      console.error('Playback error:', err);
      if (currentGenId === generationIdRef.current) setIsPlaying(false);
    }
  }, [generate, voice, chapterIdx, paraIdx, sentenceIdx, stopWordTimer, startWordTimer, fillBuffer]);

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
      audioBufferQueueRef.current.forEach(item => releaseAudio(item.audio));
      if (currentAudio.current) releaseAudio(currentAudio.current);
    };
  }, [stopWordTimer]);

  const skipNextScrollRef = useRef(false);

  const jumpView = useCallback((offset: number) => {
    if (!containerRef.current) return;
    const container = containerRef.current;
    
    container.scrollBy({ top: offset, behavior: 'auto' });
    
    requestAnimationFrame(() => {
      const containerRect = container.getBoundingClientRect();
      const targetY = containerRect.top + 30; // slightly below top edge
      
      const elements = Array.from(document.querySelectorAll('.sentence-el'));
      let bestEl = null;
      let minDiff = Infinity;
      
      for (const el of elements) {
        const rect = el.getBoundingClientRect();
        // Check vertical distance to targetY
        const diff = Math.abs(rect.top - targetY);
        if (diff < minDiff) {
          minDiff = diff;
          bestEl = el;
        }
      }
      
      if (bestEl) {
        const pIdx = parseInt(bestEl.getAttribute('data-para') || '0', 10);
        const sIdx = parseInt(bestEl.getAttribute('data-sent') || '0', 10);
        skipNextScrollRef.current = true;
        setParaIdx(pIdx);
        setSentenceIdx(sIdx);
      }
    });
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

  const executeSearch = useCallback(() => {
    if (!searchQuery.trim()) {
      setSearchResults([]);
      setIsSearchOpen(false);
      return;
    }
    const query = searchQuery.toLowerCase();
    const results: {c: number, p: number, s: number}[] = [];
    for (let c = 0; c < book.content.length; c++) {
      for (let p = 0; p < book.content[c].length; p++) {
        const sentences = splitIntoSentences(book.content[c][p]);
        for (let s = 0; s < sentences.length; s++) {
          if (sentences[s].toLowerCase().includes(query)) {
            results.push({c, p, s});
          }
        }
      }
    }
    setSearchResults(results);
    if (results.length > 0) {
      let closestIdx = 0;
      for (let i = 0; i < results.length; i++) {
        const r = results[i];
        if (r.c > chapterIdx || (r.c === chapterIdx && r.p > paraIdx) || (r.c === chapterIdx && r.p === paraIdx && r.s >= sentenceIdx)) {
          closestIdx = i;
          break;
        }
      }
      setSearchIdx(closestIdx);
      setChapterIdx(results[closestIdx].c);
      setParaIdx(results[closestIdx].p);
      setSentenceIdx(results[closestIdx].s);
      skipNextScrollRef.current = false;
    }
    setIsSearchOpen(false);
  }, [searchQuery, book.content, chapterIdx, paraIdx, sentenceIdx]);

  const togglePip = useCallback(async () => {
    if (pipWindow) {
      pipWindow.close();
      setPipWindow(null);
      return;
    }

    if (!('documentPictureInPicture' in window)) {
      alert("Document Picture-in-Picture is not supported in your browser. (Try Chrome or Edge desktop)");
      return;
    }

    try {
      const pip = await (window as any).documentPictureInPicture.requestWindow({
        width: 600,
        height: 250,
      });

      // Copy styles over so Tailwind works in the new window
      [...document.styleSheets].forEach((styleSheet) => {
        try {
          const cssRules = [...styleSheet.cssRules].map((rule) => rule.cssText).join('');
          const style = document.createElement('style');
          style.textContent = cssRules;
          pip.document.head.appendChild(style);
        } catch (e) {
          if (styleSheet.href) {
            const link = document.createElement('link');
            link.rel = 'stylesheet';
            link.href = styleSheet.href;
            pip.document.head.appendChild(link);
          }
        }
      });

      pip.addEventListener('pagehide', () => {
        setPipWindow(null);
      });

      setPipWindow(pip);
    } catch (err) {
      console.error(err);
      alert("Failed to open PiP window.");
    }
  }, [pipWindow]);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.ctrlKey || e.metaKey || e.altKey) return;

      if (isSearchOpen) {
        if (e.key === 'Escape') {
          setIsSearchOpen(false);
          setSearchQuery('');
          setSearchResults([]);
        } else if (e.key === 'Enter') {
          executeSearch();
        }
        return;
      }

      const scrollAmt = window.innerHeight * 0.8;
      switch (e.key.toLowerCase()) {
        case '/': e.preventDefault(); setIsSearchOpen(true); setTimeout(() => searchInputRef.current?.focus(), 10); break;
        case 'escape':
          if (searchResults.length > 0) {
            e.preventDefault();
            setSearchResults([]);
            setSearchQuery('');
          }
          break;
        case 'p':
        case ' ': e.preventDefault(); setIsPlaying(p => !p); break;
        case 'a': e.preventDefault(); setAutoScroll(a => !a); break;
        case 'o': e.preventDefault(); togglePip(); break;
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
        case 'i': e.preventDefault(); jumpView(-scrollAmt); break;
        case 'm': e.preventDefault(); jumpView(scrollAmt); break;
        case 'u': 
          e.preventDefault(); 
          if (searchResults.length > 0) {
            const prevIdx = (searchIdx - 1 + searchResults.length) % searchResults.length;
            setSearchIdx(prevIdx);
            setChapterIdx(searchResults[prevIdx].c); setParaIdx(searchResults[prevIdx].p); setSentenceIdx(searchResults[prevIdx].s);
            skipNextScrollRef.current = false;
          } else {
            jumpView(-100); 
          }
          break;
        case 'n': 
          e.preventDefault(); 
          if (searchResults.length > 0) {
            const nextIdx = (searchIdx + 1) % searchResults.length;
            setSearchIdx(nextIdx);
            setChapterIdx(searchResults[nextIdx].c); setParaIdx(searchResults[nextIdx].p); setSentenceIdx(searchResults[nextIdx].s);
            skipNextScrollRef.current = false;
          } else {
            jumpView(100); 
          }
          break;
        case 'y': e.preventDefault(); setChapterIdx(0); setParaIdx(0); setSentenceIdx(0); skipNextScrollRef.current = false; break;
        case 'b': e.preventDefault(); setChapterIdx(book.content.length - 1); setParaIdx(book.content[book.content.length - 1].length - 1); setSentenceIdx(0); skipNextScrollRef.current = false; break;
        case 'q': e.preventDefault(); onExit(); break;
        case 'v': e.preventDefault(); setUiMode(m => (m + 1) % 3); break;
        case ',': e.preventDefault(); setPlaybackSpeed(s => Math.max(0.5, s - 0.25)); break;
        case '.': e.preventDefault(); setPlaybackSpeed(s => Math.min(3.0, s + 0.25)); break;
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    if (pipWindow) pipWindow.addEventListener('keydown', handleKeyDown);
    
    return () => {
      window.removeEventListener('keydown', handleKeyDown);
      if (pipWindow) pipWindow.removeEventListener('keydown', handleKeyDown);
    };
  }, [handleNextSentence, handlePrevSentence, onExit, paraIdx, chapterIdx, book.content, currentChapter.length, jumpView, togglePip, pipWindow, isSearchOpen, searchResults, searchIdx, executeSearch]);

  useEffect(() => {
    if (autoScroll && !skipNextScrollRef.current) {
      const activeElement = document.querySelector('.active-sentence');
      if (activeElement) activeElement.scrollIntoView({ behavior: 'auto', block: 'center' });
    }
    skipNextScrollRef.current = false;
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
                      <span key={sIdx} data-para={pIdx} data-sent={sIdx} className="sentence-el bg-purple-800 text-white font-bold active-sentence px-1 rounded-sm">
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
                      data-para={pIdx}
                      data-sent={sIdx}
                      onClick={() => { setParaIdx(pIdx); setSentenceIdx(sIdx); setIsPlaying(true); }}
                      className="sentence-el inline cursor-pointer leading-relaxed text-lg hover:text-white"
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
               <div className={pipWindow ? "text-purple-500" : "text-blue-500"}>
                 <span className="text-white mr-1">[O]</span> PiP
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
            <div className="flex gap-1 items-center"><span className="text-white">/</span> <span className="ml-1 uppercase">Find</span></div>
            <div className="flex gap-1 items-center"><span className="text-white">,⸱.</span> <span className="ml-1 uppercase">Speed</span></div>
            <div className="flex gap-1 items-center"><span className="text-white">V</span> <span className="ml-1 uppercase">UI</span></div>
          </div>
        </div>
      )}

      {isSearchOpen && (
        <div className="absolute bottom-0 left-0 w-full bg-blue-900 text-white font-bold px-4 py-2 flex items-center gap-2 z-50">
          <span className="text-blue-300">/</span>
          <input
            ref={searchInputRef}
            value={searchQuery}
            onChange={e => setSearchQuery(e.target.value)}
            className="bg-transparent border-none outline-none w-full text-white font-mono placeholder-blue-400/50"
            placeholder="Search..."
          />
        </div>
      )}
      {!isSearchOpen && searchResults.length > 0 && (
        <div className="absolute bottom-10 right-4 bg-blue-900 text-white text-xs px-3 py-1 font-bold z-40 shadow-lg border border-blue-700">
          <span className="text-blue-300">/</span>{searchQuery} [{searchIdx + 1}/{searchResults.length}] <span className="text-blue-400 ml-2">U/N: NAV | ESC: CLR</span>
        </div>
      )}

      {pipWindow && createPortal(
        <div className="h-screen w-screen bg-black text-zinc-300 font-mono p-4 md:p-8 flex flex-col justify-center items-center overflow-hidden selection:bg-purple-900/50">
           <div className="text-xl md:text-2xl leading-relaxed text-center w-full max-w-3xl bg-purple-900/30 p-6 md:p-10 border-l-4 border-purple-500 shadow-2xl">
             {currentSentence.split(/(\s+)/).map((w, wIdx) => {
                if (/\S/.test(w)) {
                  const activeWordIndex = currentSentence.slice(0, currentSentence.indexOf(w, currentSentence.split(/(\s+)/).slice(0, wIdx).join('').length)).split(/\s+/).filter(x => x).length;
                  const isWordActive = activeWordIndex === wordIdx;
                  return (
                    <span key={wIdx} className={isWordActive ? "text-yellow-400 bg-black px-1 font-bold" : "text-white font-bold"}>
                      {w}
                    </span>
                  );
                }
                return <span key={wIdx}>{w}</span>;
             })}
           </div>
           <div className="absolute bottom-4 flex gap-6 text-[10px] text-zinc-500 uppercase font-bold tracking-widest">
             <span className={isPlaying ? "text-green-500" : "text-yellow-500"}><span className="text-white mr-1">[P]</span>{isPlaying ? "PLAYING" : "PAUSED"}</span>
             <span><span className="text-white mr-1">[J/K]</span>SENTENCE</span>
             <span><span className="text-white mr-1">[O]</span>CLOSE</span>
           </div>
        </div>,
        pipWindow.document.body
      )}
    </div>
  );
};
