import { useState, useEffect } from 'react';
import { db } from './services/db';
import type { Book, Progress } from './services/db';
import { extractContent } from './services/contentParser';
import { Reader } from './components/Reader';
import { useKokoro } from './hooks/useKokoro';
import { BookOpen, Plus, Loader2, Trash2, Clock } from 'lucide-react';

function App() {
  const [books, setBooks] = useState<Book[]>([]);
  const [activeBook, setActiveBook] = useState<Book | null>(null);
  const [activeProgress, setActiveProgress] = useState<Progress | undefined>();
  const [isImporting, setIsImporting] = useState(false);
  const { init: initTTS, loading: ttsLoading, error: ttsError } = useKokoro();

  useEffect(() => {
    loadBooks();
    initTTS();
  }, []);

  const loadBooks = async () => {
    const allBooks = await db.books.orderBy('lastReadAt').reverse().toArray();
    setBooks(allBooks);
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
    } catch (err) {
      console.error('Import error:', err);
      alert('Failed to import book');
    } finally {
      setIsImporting(false);
    }
  };

  const openBook = async (book: Book) => {
    const progress = await db.progress.get(book.id!);
    setActiveProgress(progress);
    setActiveBook(book);
    
    // Update last read time
    await db.books.update(book.id!, { lastReadAt: Date.now() });
  };

  const deleteBook = async (id: number) => {
    if (confirm('Delete this book?')) {
      await db.books.delete(id);
      await db.progress.delete(id);
      loadBooks();
    }
  };

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
    <div className="min-h-screen bg-zinc-950 text-zinc-100 p-6 md:p-12">
      <div className="max-w-6xl mx-auto">
        <header className="flex justify-between items-center mb-12">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 bg-blue-600 rounded-lg flex items-center justify-center">
              <BookOpen size={24} />
            </div>
            <h1 className="text-2xl font-bold tracking-tight">Lue Web</h1>
          </div>

          <div className="flex items-center gap-4">
            {ttsLoading && (
              <div className="flex items-center gap-2 text-sm text-zinc-400">
                <Loader2 className="animate-spin" size={16} />
                <span>Initializing WebGPU TTS...</span>
              </div>
            )}
            <label className="flex items-center gap-2 bg-blue-600 hover:bg-blue-500 text-white px-4 py-2 rounded-lg cursor-pointer transition-colors">
              <Plus size={20} />
              <span>Import Book</span>
              <input type="file" className="hidden" accept=".epub,.pdf,.docx,.md,.txt" onChange={handleFileUpload} />
            </label>
          </div>
        </header>

        {ttsError && (
          <div className="mb-8 p-4 bg-red-900/20 border border-red-900/50 rounded-lg text-red-200 text-sm">
            WebGPU Error: {ttsError}. Make sure your browser supports WebGPU and it is enabled.
          </div>
        )}

        {isImporting && (
          <div className="mb-8 p-12 border-2 border-dashed border-zinc-800 rounded-2xl flex flex-col items-center justify-center gap-4">
            <Loader2 className="animate-spin text-blue-500" size={48} />
            <p className="text-zinc-400">Processing your book...</p>
          </div>
        )}

        {books.length === 0 && !isImporting ? (
          <div className="text-center py-24 border-2 border-dashed border-zinc-800 rounded-2xl">
            <BookOpen className="mx-auto text-zinc-700 mb-4" size={64} />
            <h2 className="text-xl font-medium mb-2">Your library is empty</h2>
            <p className="text-zinc-500">Import an EPUB, PDF, or TXT file to start reading</p>
          </div>
        ) : (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-6">
            {books.map(book => (
              <div 
                key={book.id}
                className="group relative bg-zinc-900 border border-zinc-800 rounded-xl overflow-hidden hover:border-zinc-700 transition-all hover:shadow-2xl hover:shadow-blue-900/10"
              >
                <div 
                  className="aspect-[3/4] p-6 flex flex-col justify-end cursor-pointer"
                  onClick={() => openBook(book)}
                >
                  <div className="absolute top-4 right-4 opacity-0 group-hover:opacity-100 transition-opacity">
                    <button 
                      onClick={(e) => {
                        e.stopPropagation();
                        deleteBook(book.id!);
                      }}
                      className="p-2 bg-zinc-800 text-zinc-400 hover:text-red-400 rounded-lg"
                    >
                      <Trash2 size={18} />
                    </button>
                  </div>
                  
                  <div className="w-12 h-1 bg-blue-600 mb-4 rounded-full" />
                  <h3 className="text-lg font-semibold leading-tight mb-2 line-clamp-3">{book.title}</h3>
                  <div className="flex items-center gap-2 text-xs text-zinc-500">
                    <Clock size={12} />
                    <span>{new Date(book.lastReadAt).toLocaleDateString()}</span>
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

export default App;
