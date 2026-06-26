export interface ArcConnection {
  id: string;
  name: string;
  url: string;
  token: string;
}

export class ConnectionManager {
  private static readonly STORAGE_KEY = 'arc_connections';
  private static readonly ACTIVE_KEY = 'arc_active_connection_id';

  private static generateId(): string {
    return `${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;
  }

  static getAllConnections(): ArcConnection[] {
    const stored = localStorage.getItem(this.STORAGE_KEY);
    return stored ? JSON.parse(stored) : [];
  }

  static getConnection(id: string): ArcConnection | null {
    const connections = this.getAllConnections();
    return connections.find(c => c.id === id) || null;
  }

  static getActiveConnection(): ArcConnection | null {
    const activeId = localStorage.getItem(this.ACTIVE_KEY);
    if (!activeId) return null;
    return this.getConnection(activeId);
  }

  static setActiveConnection(id: string): void {
    const connection = this.getConnection(id);
    if (connection) {
      localStorage.setItem(this.ACTIVE_KEY, id);
    }
  }

  static addConnection(conn: Omit<ArcConnection, 'id'>): ArcConnection {
    const connections = this.getAllConnections();
    const newConnection: ArcConnection = {
      ...conn,
      id: this.generateId()
    };
    connections.push(newConnection);
    localStorage.setItem(this.STORAGE_KEY, JSON.stringify(connections));
    return newConnection;
  }

  static updateConnection(id: string, updates: Partial<Omit<ArcConnection, 'id'>>): void {
    const connections = this.getAllConnections();
    const index = connections.findIndex(c => c.id === id);
    if (index !== -1) {
      connections[index] = { ...connections[index], ...updates };
      localStorage.setItem(this.STORAGE_KEY, JSON.stringify(connections));
    }
  }

  static deleteConnection(id: string): void {
    let connections = this.getAllConnections();
    connections = connections.filter(c => c.id !== id);
    localStorage.setItem(this.STORAGE_KEY, JSON.stringify(connections));

    // Clear active connection if it was deleted
    const activeId = localStorage.getItem(this.ACTIVE_KEY);
    if (activeId === id) {
      localStorage.removeItem(this.ACTIVE_KEY);
    }
  }

  static clearAllConnections(): void {
    localStorage.removeItem(this.STORAGE_KEY);
    localStorage.removeItem(this.ACTIVE_KEY);
  }

  static async validateConnection(conn: ArcConnection): Promise<boolean> {
    try {
      const response = await fetch(`${conn.url}/health`, {
        headers: {
          'Authorization': `Bearer ${conn.token}`
        }
      });
      return response.ok;
    } catch (error) {
      console.error('Connection validation failed:', error);
      return false;
    }
  }
}

// Legacy AuthManager for backward compatibility
export class AuthManager {
  static saveConnection(conn: ArcConnection): void {
    // Migration: if old single connection exists, migrate to new system
    ConnectionManager.addConnection(conn);
    ConnectionManager.setActiveConnection(conn.id);
  }

  static getConnection(): ArcConnection | null {
    return ConnectionManager.getActiveConnection();
  }

  static clearConnection(): void {
    const active = ConnectionManager.getActiveConnection();
    if (active) {
      ConnectionManager.deleteConnection(active.id);
    }
  }

  static async validateConnection(conn: ArcConnection): Promise<boolean> {
    return ConnectionManager.validateConnection(conn);
  }
}
