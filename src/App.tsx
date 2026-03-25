import { useState, useEffect, useRef } from 'react';
import { db } from './services/db';
import type { Book, Progress } from './services/db';
import { extractContent } from './services/contentParser';
import { Reader } from './components/Reader';
import { useKokoro } from './hooks/useKokoro';

function App() {
  const [books, setBooks] = useState<Book[]>([]);
  const [activeBook, setActiveBook] = useState<Book | null>(null);
  const [activeProgress, setActiveProgress] = useState<Progress | undefined>();
  const [isImporting, setIsImporting] = useState(false);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const fileInputRef = useRef<HTMLInputElement>(null);
  
  const { init: initTTS, loading: ttsLoading, error: ttsError } = useKokoro();

  useEffect(() => {
    loadBooks();
    initTTS();
  }, [initTTS]);

  const loadBooks = async () => {
    const allBooks = await db.books.orderBy('lastReadAt').reverse().toArray();
    setBooks(allBooks);
    setSelectedIndex(0);
  };

  const handleFileUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    setIsImporting(true);
    try {
      const content = await extractContent(file);
      const newBook: Book = {
        title: file.name.replace(/\.[^/.]+$/, ""),
        file: file,
        content: content,
        addedAt: Date.now(),
        lastReadAt: Date.now()
      };
      const id = await db.books.add(newBook);
      newBook.id = id as number;
      setBooks([newBook, ...books]);
      setSelectedIndex(0);
    } catch (err) {
      console.error('Import error:', err);
      alert('Failed to import book');
    } finally {
      setIsImporting(false);
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  };

  const openBook = async (book: Book) => {
    const progress = await db.progress.get(book.id!);
    setActiveProgress(progress);
    setActiveBook(book);
    await db.books.update(book.id!, { lastReadAt: Date.now() });
  };

  const deleteBook = async (id: number) => {
    if (confirm('Delete this book?')) {
      await db.books.delete(id);
      await db.progress.delete(id);
      await loadBooks();
    }
  };

  useEffect(() => {
    if (activeBook || isImporting) return;

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      
      switch (e.key.toLowerCase()) {
        case 'j':
        case 'arrowdown':
          e.preventDefault();
          setSelectedIndex(prev => Math.min(books.length - 1, prev + 1));
          break;
        case 'k':
        case 'arrowup':
          e.preventDefault();
          setSelectedIndex(prev => Math.max(0, prev - 1));
          break;
        case 'l':
        case 'enter':
          e.preventDefault();
          if (books.length > 0 && books[selectedIndex]) {
            openBook(books[selectedIndex]);
          }
          break;
        case 'd':
        case 'x':
        case 'backspace':
        case 'delete':
          e.preventDefault();
          if (books.length > 0 && books[selectedIndex]) {
            deleteBook(books[selectedIndex].id!);
          }
          break;
        case 'i':
          e.preventDefault();
          fileInputRef.current?.click();
          break;
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [books, selectedIndex, activeBook, isImporting]);

  if (activeBook) {
    return (
      <Reader 
        book={activeBook} 
        initialProgress={activeProgress} 
        onExit={() => {
          setActiveBook(null);
          loadBooks();
        }} 
      />
    );
  }

  return (
    <div className="min-h-screen bg-black text-zinc-300 font-mono flex flex-col items-center justify-center p-4 selection:bg-blue-900/50 uppercase tracking-wider">
      <div className="w-full max-w-4xl flex flex-col gap-6">
        
        {/* Terminal Header */}
        <div className="border border-blue-900 bg-black">
          <div className="bg-blue-900 text-white font-bold px-4 py-1 flex justify-between items-center text-sm md:text-base">
            <span className="flex gap-4"><span>READ4</span> <span className="text-blue-300 font-normal">///</span> <span>LIBRARY</span></span>
            <span className={`text-xs ${ttsLoading ? 'text-yellow-400 animate-pulse' : 'text-green-400'}`}>
              {ttsLoading ? 'INIT KOKORO-TTS...' : 'WEBGPU READY'}
            </span>
          </div>
          <div className="p-4 bg-black flex flex-wrap gap-x-6 gap-y-2 text-xs text-blue-400">
             <span><span className="text-white font-bold mr-1">[I]</span>MPORT</span>
             <span><span className="text-white font-bold mr-1">[J/K]</span> NAVIGATE</span>
             <span><span className="text-white font-bold mr-1">[L/ENTER]</span> READ</span>
             <span><span className="text-white font-bold mr-1">[D/X]</span> DELETE</span>
          </div>
        </div>

        {/* Hidden File Input */}
        <input 
          type="file" 
          className="hidden" 
          accept=".epub,.pdf,.docx,.md,.txt" 
          onChange={handleFileUpload} 
          ref={fileInputRef}
        />

        {/* Error Notification */}
        {ttsError && (
          <div className="p-4 border border-red-900 bg-red-950/30 text-red-400 text-xs">
            <span className="font-bold text-red-500 mr-2">ERR:</span> {ttsError}
          </div>
        )}

        {/* Loading State */}
        {isImporting && (
          <div className="border border-zinc-800 p-12 text-center text-yellow-500 animate-pulse flex flex-col gap-4">
            <div className="text-4xl">⧗</div>
            <div>PROCESSING DOCUMENT...</div>
          </div>
        )}

        {/* Library List */}
        {!isImporting && (
          <div className="border border-zinc-800 bg-black flex flex-col flex-1 min-h-[50vh]">
            <div className="bg-zinc-900 text-zinc-500 px-4 py-2 border-b border-zinc-800 flex justify-between text-xs font-bold">
              <span>TITLE</span>
              <span>LAST READ</span>
            </div>
            
            <div className="flex-1 p-2 flex flex-col gap-1 overflow-y-auto">
              {books.length === 0 ? (
                <div className="text-center py-24 text-zinc-600 flex flex-col gap-4 items-center">
                  <div className="text-4xl">📚</div>
                  <div>LIBRARY EMPTY. PRESS [I] TO IMPORT A BOOK.</div>
                </div>
              ) : (
                books.map((book, idx) => {
                  const isSelected = idx === selectedIndex;
                  return (
                    <div 
                      key={book.id}
                      onClick={() => setSelectedIndex(idx)}
                      onDoubleClick={() => openBook(book)}
                      className={`px-3 py-2 flex justify-between items-center cursor-pointer transition-colors text-sm
                        ${isSelected ? 'bg-blue-900/30 border-l-2 border-blue-500 text-white font-bold' : 'hover:bg-zinc-900 border-l-2 border-transparent text-zinc-400'}
                      `}
                    >
                      <div className="flex items-center gap-3 truncate pr-4">
                        <span className={isSelected ? 'text-blue-500' : 'text-zinc-600'}>
                          {isSelected ? '[*]' : '[ ]'}
                        </span>
                        <span className="truncate">{book.title}</span>
                      </div>
                      <div className={`text-xs whitespace-nowrap ${isSelected ? 'text-blue-300' : 'text-zinc-600'}`}>
                        {new Date(book.lastReadAt).toLocaleDateString()}
                      </div>
                    </div>
                  );
                })
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

export default App;
