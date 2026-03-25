import Dexie, { type Table } from 'dexie';

export interface Book {
  id?: number;
  title: string;
  author?: string;
  file: File;
  content: string[][];
  addedAt: number;
  lastReadAt: number;
}

export interface Progress {
  bookId: number;
  chapterIndex: number;
  paragraphIndex: number;
  sentenceIndex: number;
  updatedAt: number;
}

export interface Settings {
  key: string;
  value: any;
}

export class Read4Database extends Dexie {
  books!: Table<Book>;
  progress!: Table<Progress>;
  settings!: Table<Settings>;

  constructor() {
    super('Read4Database');
    this.version(1).stores({
      books: '++id, title, lastReadAt',
      progress: 'bookId',
      settings: 'key'
    });
  }
}

export const db = new Read4Database();
