import type { QueryResult } from './arcClient';

export type TabType = 'query' | 'results' | 'tokens';

export interface Tab {
  id: string;
  type: TabType;
  title: string;
  query?: string;
  result?: QueryResult;
  error?: string;
}

export class TabManager {
  private static nextId = 1;

  static createQueryTab(query: string = ''): Tab {
    return {
      id: `tab-${this.nextId++}`,
      type: 'query',
      title: `Query ${this.nextId - 1}`,
      query: query || 'SELECT * FROM system.tables LIMIT 10;'
    };
  }

  static createResultsTab(query: string, result: QueryResult | null, error: string = ''): Tab {
    return {
      id: `tab-${this.nextId++}`,
      type: 'results',
      title: 'Results',
      query,
      result: result || undefined,
      error
    };
  }

  static createTokensTab(): Tab {
    return {
      id: `tab-${this.nextId++}`,
      type: 'tokens',
      title: 'Token Management'
    };
  }

  static updateTabTitle(tab: Tab, title: string): Tab {
    return { ...tab, title };
  }
}
