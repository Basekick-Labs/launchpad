export interface QueryHistoryEntry {
  id: string;
  sql: string;
  timestamp: number;
  executionTime?: number;
  rowCount?: number;
  success: boolean;
  error?: string;
}

export class QueryHistoryManager {
  private static readonly STORAGE_KEY = 'arc_query_history';
  private static readonly MAX_ENTRIES = 100;

  static saveQuery(entry: Omit<QueryHistoryEntry, 'id' | 'timestamp'>): void {
    const history = this.getHistory();

    const newEntry: QueryHistoryEntry = {
      ...entry,
      id: crypto.randomUUID(),
      timestamp: Date.now()
    };

    // Add to beginning of array (most recent first)
    history.unshift(newEntry);

    // Limit to MAX_ENTRIES
    const trimmedHistory = history.slice(0, this.MAX_ENTRIES);

    localStorage.setItem(this.STORAGE_KEY, JSON.stringify(trimmedHistory));
  }

  static getHistory(): QueryHistoryEntry[] {
    const stored = localStorage.getItem(this.STORAGE_KEY);
    if (!stored) return [];

    try {
      return JSON.parse(stored);
    } catch {
      return [];
    }
  }

  static clearHistory(): void {
    localStorage.removeItem(this.STORAGE_KEY);
  }

  static deleteEntry(id: string): void {
    const history = this.getHistory();
    const filtered = history.filter(entry => entry.id !== id);
    localStorage.setItem(this.STORAGE_KEY, JSON.stringify(filtered));
  }
}
